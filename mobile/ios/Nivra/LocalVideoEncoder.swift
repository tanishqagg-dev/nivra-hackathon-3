import Foundation
import VideoToolbox
import CoreMedia

private final class LocalVideoEncodingContext {
    let store: LocalVideoStore
    let session: String
    let generation: String
    let finished: () -> Void
    init(store: LocalVideoStore, session: String, generation: String, finished: @escaping () -> Void) {
        self.store = store; self.session = session; self.generation = generation; self.finished = finished
    }
}

/// Hardware H.264 only. At most one submission can wait on the serial encoder.
/// VideoToolbox's low-latency mode handles compressed callbacks independently.
final class LocalVideoEncoder {
    private let store: LocalVideoStore
    private let queue = DispatchQueue(label: "work.tanishq.nivra.h264", qos: .userInitiated)
    private let lock = NSLock()
    private var token = ""
    private var generation = ""
    private var busy = false
    private var encoder: VTCompressionSession?
    private var contextPointer: UnsafeMutableRawPointer?
    private var dimensions = (0, 0)
    var onError: ((String) -> Void)?

    init(store: LocalVideoStore) { self.store = store }

    func reset(session: String) {
        lock.lock()
        let generation = store.reset(session: session)
        token = session; self.generation = generation; busy = false; lock.unlock()
        queue.async { [weak self] in self?.invalidate() }
    }
    func stop() {
        lock.lock(); token = ""; generation = ""; busy = false; store.stop(); lock.unlock()
        queue.async { [weak self] in self?.invalidate() }
    }
    @discardableResult
    func append(_ sampleBuffer: CMSampleBuffer, session: String) -> Bool {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return false }
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard timestamp.isValid, timestamp.isNumeric, CMTimeGetSeconds(timestamp).isFinite, CMTimeGetSeconds(timestamp) >= 0 else { return false }
        lock.lock()
        guard !session.isEmpty, session == token, !busy else { lock.unlock(); return false }
        busy = true; let generation = generation
        lock.unlock()
        queue.async { [weak self] in
            guard let self else { return }
            var submitted = false
            var activeGeneration = generation
            defer { if !submitted { self.releaseSlot(session: session, generation: activeGeneration) } }
            self.lock.lock(); let current = self.token == session && self.generation == generation; self.lock.unlock()
            guard current else { return }
            let width = CVPixelBufferGetWidth(pixelBuffer), height = CVPixelBufferGetHeight(pixelBuffer)
            guard width > 0, height > 0, max(width, height) <= 1280 else { self.onError?("Camera video size is not supported."); return }
            do {
                if self.encoder == nil || self.dimensions != (width, height) {
                    if self.encoder != nil {
                        self.lock.lock()
                        guard self.token == session && self.generation == generation else { self.lock.unlock(); return }
                        activeGeneration = self.store.reset(session: session)
                        self.generation = activeGeneration
                        self.lock.unlock()
                    }
                    self.invalidate()
                    try self.configure(width: width, height: height, session: session, generation: activeGeneration)
                }
                guard let encoder = self.encoder else { return }
                var flags = VTEncodeInfoFlags()
                let status = VTCompressionSessionEncodeFrame(encoder, imageBuffer: pixelBuffer, presentationTimeStamp: timestamp,
                    duration: CMSampleBufferGetDuration(sampleBuffer), frameProperties: nil, sourceFrameRefcon: nil, infoFlagsOut: &flags)
                if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
                submitted = true
            } catch { self.invalidate(); self.onError?("Compressed video is unavailable on this device.") }
        }
        return true
    }

    private func configure(width: Int, height: Int, session: String, generation: String) throws {
        guard #available(iOS 17.4, *) else { throw NSError(domain: "NIVRAVideo", code: 1) }
        let context = LocalVideoEncodingContext(store: store, session: session, generation: generation) { [weak self] in
            self?.releaseSlot(session: session, generation: generation)
        }
        let pointer = Unmanaged.passRetained(context).toOpaque()
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
            encoderSpecification: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { refcon, _, status, _, sample in
                guard let refcon else { return }
                let context = Unmanaged<LocalVideoEncodingContext>.fromOpaque(refcon).takeUnretainedValue()
                defer { context.finished() }
                guard status == noErr, let sample, CMSampleBufferDataIsReady(sample) else { return }
                LocalVideoEncoder.publish(sample, context: context)
            }, refcon: pointer, compressionSessionOut: &created)
        guard status == noErr, let created else {
            Unmanaged<LocalVideoEncodingContext>.fromOpaque(pointer).release()
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        encoder = created; contextPointer = pointer; dimensions = (width, height)
        let settings: [(CFString, CFTypeRef)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
            (kVTCompressionPropertyKey_MaxFrameDelayCount, 0 as CFNumber),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Main_AutoLevel),
            (kVTCompressionPropertyKey_ExpectedFrameRate, 40 as CFNumber),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, 40 as CFNumber),
            (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 1 as CFNumber),
            (kVTCompressionPropertyKey_AverageBitRate, 4_000_000 as CFNumber),
        ]
        for (key, value) in settings {
            let result = VTSessionSetProperty(created, key: key, value: value)
            if key == kVTCompressionPropertyKey_MaxFrameDelayCount && result == kVTPropertyNotSupportedErr { continue }
            guard result == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(result)) }
        }
        let prepare = VTCompressionSessionPrepareToEncodeFrames(created)
        guard prepare == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(prepare)) }
    }
    private func releaseSlot(session: String, generation: String) {
        lock.lock(); defer { lock.unlock() }
        if token == session && self.generation == generation { busy = false }
    }
    private func invalidate() {
        if let encoder {
            VTCompressionSessionCompleteFrames(encoder, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(encoder)
        }
        encoder = nil; dimensions = (0, 0)
        if let contextPointer { Unmanaged<LocalVideoEncodingContext>.fromOpaque(contextPointer).release() }
        contextPointer = nil
    }
    private static func publish(_ sample: CMSampleBuffer, context: LocalVideoEncodingContext) {
        guard let format = CMSampleBufferGetFormatDescription(sample), let block = CMSampleBufferGetDataBuffer(sample),
            let config = configuration(format) else { return }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0, length <= LocalVideoStore.byteLimit else { return }
        var data = Data(count: length)
        let result = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
        guard result == kCMBlockBufferNoErr else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        let size = CMVideoFormatDescriptionGetDimensions(format)
        context.store.append(data: data, timestampMs: CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000,
            keyframe: keyframe, codec: config.codec, description: config.description, width: Int(size.width), height: Int(size.height),
            session: context.session, generation: context.generation)
    }
    static func configuration(_ format: CMFormatDescription) -> (codec: String, description: Data)? {
        var spsPointer: UnsafePointer<UInt8>?, ppsPointer: UnsafePointer<UInt8>?
        var spsSize = 0, ppsSize = 0, count = 0
        var nalLength: Int32 = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: &spsPointer,
            parameterSetSizeOut: &spsSize, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLength) == noErr,
            let spsPointer, spsSize >= 4, count >= 2,
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 1, parameterSetPointerOut: &ppsPointer,
            parameterSetSizeOut: &ppsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
            let ppsPointer else { return nil }
        return configuration(sps: Data(bytes: spsPointer, count: spsSize), pps: Data(bytes: ppsPointer, count: ppsSize), nalLength: nalLength)
    }
    static func configuration(sps: Data, pps: Data, nalLength: Int32) -> (codec: String, description: Data)? {
        guard sps.count >= 4, sps.count <= 2048, !pps.isEmpty, pps.count <= 2048, [1, 2, 4].contains(nalLength) else { return nil }
        var description = Data([1, sps[1], sps[2], sps[3], 0xfc | UInt8(nalLength - 1), 0xe1,
            UInt8(sps.count >> 8), UInt8(sps.count & 255)])
        description.append(sps)
        description.append(contentsOf: [1, UInt8(pps.count >> 8), UInt8(pps.count & 255)])
        description.append(pps)
        guard description.count <= 4096 else { return nil }
        return (String(format: "avc1.%02x%02x%02x", sps[1], sps[2], sps[3]), description)
    }
    deinit { invalidate() }
}
