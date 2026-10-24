import Foundation
import CoreML
import CoreMedia
import CoreVideo
import CoreImage
import Accelerate

struct NativeFightReport: Codable {
    var type = "native-fight-v1"
    var model = "nivra-x3d-rwf2000-v1"
    let timestampMs: Double
    let windowStartMs: Double
    let windowEndMs: Double
    let uniqueFrames: Int
    let inferenceMs: Double
    let publisherScore: Double
    let modelScore: Double
    let windowReady: Bool
}

struct NativeFightStatus: Codable {
    let state: String
    var model = "nivra-x3d-rwf2000-v1"
    let detail: String
}

struct NativeFightFrame {
    let timestampMs: Double
    let rgb: [UInt8]
}

/// The same trained X3D candidate as the Mac, without decisions or fabricated actors.
/// One worker retains at most one incoming pixel buffer. Capture never waits for inference.
final class NativeFightVision {
    // Source timestamps are floating-point milliseconds. Tolerate only rounding
    // at cadence/window boundaries, never a meaningfully shorter video window.
    static let timestampToleranceMs = 0.001
    static func intervalElapsed(_ timestamp: Double, since previous: Double, minimum: Double) -> Bool {
        timestamp - previous + timestampToleranceMs >= minimum
    }
    private static let colorContext = CIContext(options: [.cacheIntermediates: false])
    typealias Scores = (modelScore: Double, publisherScore: Double)
    typealias Predictor = (MLMultiArray) throws -> Scores
    typealias Loader = () throws -> Predictor
    private let worker = DispatchQueue(label: "work.tanishq.nivra.fight", qos: .userInitiated)
    private let lock = NSLock()
    private let callbackQueue: DispatchQueue
    private let loader: Loader
    private let onReport: (NativeFightReport) -> Void
    private let onStatus: (NativeFightStatus) -> Void
    private var session: String?
    private var generation = UUID()
    private var busy = false
    private var ready = false
    private var lastAdmitted = -Double.infinity
    // Accessed only on worker.
    private var predictor: Predictor?
    private var frames: [NativeFightFrame] = []
    private var lastPrediction = -Double.infinity

    init(callbackQueue: DispatchQueue = .main, loader: Loader? = nil,
         onReport: @escaping (NativeFightReport) -> Void,
         onStatus: @escaping (NativeFightStatus) -> Void) {
        self.callbackQueue = callbackQueue
        self.loader = loader ?? Self.loadModel
        self.onReport = onReport
        self.onStatus = onStatus
    }

    func start(session: String) {
        guard !session.isEmpty else { return }
        lock.lock()
        generation = UUID(); let epoch = generation
        self.session = session; busy = true; ready = false; lastAdmitted = -.infinity
        lock.unlock()
        status("loading", "Loading the trained phone model…", session, epoch)
        worker.async { [weak self] in
            guard let self, self.current(session, epoch) else { return }
            self.frames.removeAll(); self.lastPrediction = -.infinity
            do {
                let loaded = try self.predictor ?? self.loader()
                // Cold Core ML compilation can be slow. Warm it away from capture/UI.
                let warm = try Self.tensor(Array(repeating: [UInt8](repeating: 127, count: 224*224*3), count: 16))
                let warmScores = try loaded(warm)
                guard [warmScores.modelScore, warmScores.publisherScore].allSatisfy({ $0.isFinite && (0...1).contains($0) }) else {
                    throw Failure.invalidOutput
                }
                self.predictor = loaded
                self.lock.lock()
                let active = self.session == session && self.generation == epoch
                if active { self.ready = true; self.busy = false }
                self.lock.unlock()
                if active { self.status("ready", "Phone model ready. Collecting a four-second video window.", session, epoch) }
            } catch {
                self.fail(session, epoch)
            }
        }
    }

    /// Stops publication immediately. Existing Core ML work can finish safely in the background.
    func stop() {
        lock.lock(); session = nil; generation = UUID(); ready = false; busy = false; lock.unlock()
        worker.async { [weak self] in self?.frames.removeAll() }
    }

    @discardableResult
    func append(_ sampleBuffer: CMSampleBuffer, session: String) -> Bool {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return false }
        let timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))*1000
        guard timestamp.isFinite, timestamp >= 0 else { return false }
        lock.lock()
        guard self.session == session, ready, !busy, timestamp > lastAdmitted,
              Self.intervalElapsed(timestamp, since: lastAdmitted, minimum: 200) else { lock.unlock(); return false }
        let epoch = generation
        busy = true; lastAdmitted = timestamp
        lock.unlock()
        worker.async { [weak self] in
            guard let self else { return }
            defer {
                self.lock.lock()
                if self.session == session && self.generation == epoch { self.busy = false }
                self.lock.unlock()
            }
            guard self.current(session, epoch) else { return }
            do {
                try autoreleasepool {
                    let rgb = try Self.rgb224(buffer)
                    self.frames.removeAll { timestamp-$0.timestampMs > 4500 + Self.timestampToleranceMs }
                    self.frames.append(NativeFightFrame(timestampMs: timestamp, rgb: rgb))
                    if self.frames.count > 24 { self.frames.removeFirst(self.frames.count-24) }
                    guard Self.intervalElapsed(timestamp, since: self.lastPrediction, minimum: 400),
                          let window = Self.window(self.frames), let predict = self.predictor else { return }
                    self.lastPrediction = timestamp
                    let input = try Self.tensor(window.map(\.rgb))
                    let began = ProcessInfo.processInfo.systemUptime
                    let scores = try predict(input)
                    guard [scores.modelScore, scores.publisherScore].allSatisfy({ $0.isFinite && (0...1).contains($0) }) else {
                        throw Failure.invalidOutput
                    }
                    let report = NativeFightReport(timestampMs: timestamp,
                        windowStartMs: window[0].timestampMs, windowEndMs: timestamp,
                        uniqueFrames: Set(window.map(\.timestampMs)).count,
                        inferenceMs: (ProcessInfo.processInfo.systemUptime-began)*1000,
                        publisherScore: scores.publisherScore, modelScore: scores.modelScore, windowReady: true)
                    self.callbackQueue.async { [weak self] in
                        guard let self, self.current(session, epoch) else { return }
                        self.onReport(report)
                    }
                }
            } catch { self.fail(session, epoch) }
        }
        return true
    }

    private func current(_ session: String, _ epoch: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return self.session == session && generation == epoch
    }
    private func status(_ state: String, _ detail: String, _ session: String, _ epoch: UUID) {
        callbackQueue.async { [weak self] in
            guard let self, self.current(session, epoch) else { return }
            self.onStatus(NativeFightStatus(state: state, detail: detail))
        }
    }
    private func fail(_ session: String, _ epoch: UUID) {
        lock.lock()
        if self.session == session && generation == epoch { ready = false; busy = false }
        lock.unlock()
        status("error", "The trained phone model could not run. Video can continue.", session, epoch)
    }

    enum Failure: Error { case missingModel, invalidPixels, invalidWindow, invalidOutput }

    static func loadModel() throws -> Predictor {
        guard let url = Bundle.main.url(forResource: "NivraX3D", withExtension: "mlmodelc") else { throw Failure.missingModel }
        let configuration = MLModelConfiguration(); configuration.computeUnits = .all
        let model = try MLModel(contentsOf: url, configuration: configuration)
        let metadata = model.modelDescription.metadata[.creatorDefinedKey] as? [String:String]
        guard metadata?["checkpointSHA256"] == "e833f69d110f167cad4a6c38d385564bdb2f6de63d246e45cb03ff9aa17f0349",
              metadata?["precision"] == "float32" else { throw Failure.invalidOutput }
        return { frames in
            let output = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["frames": frames]))
            guard let raw = output.featureValue(for: "backboneScores")?.multiArrayValue,
                  let publisher = output.featureValue(for: "publisherScores")?.multiArrayValue,
                  raw.count == 2, publisher.count == 2 else { throw Failure.invalidOutput }
            return (raw[1].doubleValue, publisher[1].doubleValue)
        }
    }

    /// Source-time nearest sampling matches the Mac's 16-frame temporal input.
    static func window(_ source: [NativeFightFrame]) -> [NativeFightFrame]? {
        guard let end = source.last?.timestampMs else { return nil }
        let values = source.filter { $0.timestampMs.isFinite && $0.timestampMs >= 0 && end-$0.timestampMs <= 4000 + timestampToleranceMs && end >= $0.timestampMs }
        guard let first = values.first, values.count >= 8, intervalElapsed(end, since: first.timestampMs, minimum: 3800) else { return nil }
        let selected = (0..<16).map { index in
            let target = first.timestampMs+(end-first.timestampMs)*Double(index)/15
            return values.min { abs($0.timestampMs-target) < abs($1.timestampMs-target) }!
        }
        return Set(selected.map(\.timestampMs)).count >= 8 ? selected : nil
    }

    /// RGB bytes are 0..255; normalization is embedded in the verified Core ML graph.
    static func tensor(_ rgb: [[UInt8]]) throws -> MLMultiArray {
        guard rgb.count == 16, rgb.allSatisfy({ $0.count == 224*224*3 }) else { throw Failure.invalidWindow }
        let array = try MLMultiArray(shape: [1,3,16,224,224], dataType: .float32)
        let pointer = array.dataPointer.bindMemory(to: Float.self, capacity: array.count)
        let plane = 224*224
        for time in 0..<16 {
            for pixel in 0..<plane {
                for channel in 0..<3 { pointer[channel*16*plane+time*plane+pixel] = Float(rgb[time][pixel*3+channel]) }
            }
        }
        return array
    }

    static func rgb224(_ buffer: CVPixelBuffer) throws -> [UInt8] {
        let format = CVPixelBufferGetPixelFormatType(buffer)
        if format != kCVPixelFormatType_32BGRA {
            guard format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange else { throw Failure.invalidPixels }
            var converted: CVPixelBuffer?
            let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
            guard CVPixelBufferCreate(kCFAllocatorDefault,224,224,kCVPixelFormatType_32BGRA,attributes,&converted) == kCVReturnSuccess,
                  let converted else { throw Failure.invalidPixels }
            let source = CIImage(cvPixelBuffer: buffer)
            let resized = source.transformed(by: CGAffineTransform(scaleX:224/source.extent.width,y:224/source.extent.height))
            colorContext.render(resized,to:converted,bounds:CGRect(x:0,y:0,width:224,height:224),colorSpace:CGColorSpaceCreateDeviceRGB())
            return try rgb224(converted)
        }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw Failure.invalidPixels }
        var source = vImage_Buffer(data: base, height: vImagePixelCount(CVPixelBufferGetHeight(buffer)),
            width: vImagePixelCount(CVPixelBufferGetWidth(buffer)), rowBytes: CVPixelBufferGetBytesPerRow(buffer))
        var bgra = [UInt8](repeating: 0, count: 224*224*4)
        let result = bgra.withUnsafeMutableBytes { bytes -> vImage_Error in
            var destination = vImage_Buffer(data: bytes.baseAddress!, height: 224, width: 224, rowBytes: 224*4)
            return vImageScale_ARGB8888(&source, &destination, nil, vImage_Flags(kvImageNoFlags))
        }
        guard result == kvImageNoError else { throw Failure.invalidPixels }
        var rgb = [UInt8](repeating: 0, count: 224*224*3)
        for pixel in 0..<(224*224) {
            rgb[pixel*3] = bgra[pixel*4+2]
            rgb[pixel*3+1] = bgra[pixel*4+1]
            rgb[pixel*3+2] = bgra[pixel*4]
        }
        return rgb
    }
}
