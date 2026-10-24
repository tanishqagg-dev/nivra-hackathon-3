import SwiftUI
import AVFoundation
import CoreImage
import ImageIO

/// Capture intent survives temporary interruptions, but never an explicit stop.
struct NativeCaptureIntent {
    var requested = false
    var foreground = true
    var interrupted = false
    var workGeneration = UUID()
    var paused = false
    var mayResume: Bool { requested && foreground && !interrupted }
    var shouldCapture: Bool { mayResume && !paused }
}

final class USBOfflineCamera: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    @Published private(set) var running = false
    @Published private(set) var starting = false
    @Published private(set) var paused = false
    @Published private(set) var code = ""
    @Published private(set) var message = "Join the same Wi-Fi router as your Mac. Internet is not needed for video."
    @Published private(set) var lastMacPull: Date?
    @Published private(set) var macConnection = ""
    @Published private(set) var macConnectionFailed = false
    @Published private(set) var macNeedsSettings = false
    private var macPairing: LocalMacPairing?
    private var pairingTask: Task<Void, Never>?
    var onPairingConsumed: (() -> Void)?
    let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "work.tanishq.nivra.usb.camera", qos: .userInitiated)
    private let store = USBFrameStore()
    private let videoStore = LocalVideoStore()
    private let analysisStore = NativeAnalysisStore()
    private lazy var encoder = LocalVideoEncoder(store: videoStore)
    private lazy var server = USBHTTPServer(store: store, videoStore: videoStore, analysisStore: analysisStore)
    private var peopleVision: NativePeopleVision?
    private var fightVision: NativeFightVision?
    private var lastPeopleTimestamp = -Double.infinity
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var output: AVCaptureVideoDataOutput?
    private var configured = false
    private var rotationAngle: CGFloat = 90
    private var pacing = LocalFramePacer(fps: 5)
    private let jpegColorSpace = CGColorSpaceCreateDeviceRGB()
    private var captureKey = "" // Accessed only on the capture queue.
    private var generation = UUID() // Accessed only on the main queue.
    private var interrupted: NSObjectProtocol?
    private var interruptionEnded: NSObjectProtocol?
    private let intentLock = NSLock()
    private var intent = NativeCaptureIntent()
    private var resumeQueued = false
    private func currentIntent() -> NativeCaptureIntent { intentLock.lock(); defer { intentLock.unlock() }; return intent }
    private func updateIntent(_ change: (inout NativeCaptureIntent) -> Void) { intentLock.lock(); change(&intent); intentLock.unlock() }

    override init() {
        super.init()
        interrupted = NotificationCenter.default.addObserver(forName: .AVCaptureSessionWasInterrupted, object: capture, queue: .main) { [weak self] _ in
            guard let self, self.currentIntent().requested else { return }
            self.updateIntent { $0.interrupted = true }
            self.pauseCapture(message: "Camera interrupted. It will resume when available.")
        }
        interruptionEnded = NotificationCenter.default.addObserver(forName: .AVCaptureSessionInterruptionEnded, object: capture, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.updateIntent { $0.interrupted = false }
            self.resumeIfAllowed()
        }
    }
    func start(name: String, pairing: LocalMacPairing? = nil, macCode: String? = nil) {
        guard !running, !starting else { return }
        if currentIntent().requested, !code.isEmpty, macCode == nil || macCode == code {
            if let pairing { macPairing = pairing }
            resumeIfAllowed()
            return
        }
        updateIntent { $0.requested = true; $0.paused = false; $0.workGeneration = UUID() }
        generation = UUID(); let generation = generation
        macPairing = pairing; macConnection = pairing == nil ? "" : "Connecting to Mac…"
        macConnectionFailed = false; macNeedsSettings = false
        starting = true; paused = false; message = "Starting camera…"
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
            DispatchQueue.main.async {
                guard let self, self.generation == generation, self.currentIntent().requested else { return }
                guard allowed else { self.stop(message: "Allow camera access in Settings, then tap Start camera."); return }
                do {
                    let clean = String(name.components(separatedBy: .controlCharacters).joined().prefix(60))
                    let key = try self.store.begin(name: clean.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Camera" : clean, key: macCode)
                    self.code = key; self.lastMacPull = nil
                    self.server.onReady = { [weak self] in
                        DispatchQueue.main.async {
                            guard let self, self.generation == generation, self.store.active(key), self.currentIntent().shouldCapture, self.capture.isRunning else { return }
                            self.resumeQueued = false
                            self.starting = false; self.running = true; self.paused = false
                            self.message = "Waiting for your Mac"
                            UIApplication.shared.isIdleTimerDisabled = true
                            if self.macPairing != nil { self.connectToMac() }
                        }
                    }
                    self.server.onFailure = { [weak self] in
                        DispatchQueue.main.async {
                            guard let self, self.generation == generation, self.currentIntent().requested else { return }
                            self.pauseCapture(message: "Local connection paused. Tap Resume camera to reconnect.")
                        }
                    }
                    self.server.onPull = { [weak self] date in
                        DispatchQueue.main.async {
                            guard let self, self.generation == generation, self.store.active(key) else { return }
                            self.lastMacPull = date
                        }
                    }
                    self.resumeIfAllowed()
                } catch { self.stop(message: "Could not create a connection code. Tap Start camera to retry.") }
            }
        }
    }
    func setForeground(_ active: Bool) {
        updateIntent { $0.foreground = active }
        if active {
            if !capture.isInterrupted { updateIntent { $0.interrupted = false } }
            resumeIfAllowed()
        } else if currentIntent().requested {
            pauseCapture(message: "Camera paused. Return to NIVRA to resume.")
        }
    }
    func resumeIfAllowed() {
        guard currentIntent().mayResume, !code.isEmpty, !running, !resumeQueued else { return }
        resumeQueued = true
        updateIntent { $0.paused = false; $0.workGeneration = UUID() }
        let revision = currentIntent().workGeneration
        let key = code, generation = generation
        starting = true; paused = false; message = "Resuming camera…"
        queue.async { [weak self] in
            guard let self, self.store.active(key), self.currentIntent().shouldCapture, self.currentIntent().workGeneration == revision else { return }
            do {
                try self.configure()
                guard self.store.active(key), self.currentIntent().shouldCapture else { return }
                self.captureKey = key; self.pacing = LocalFramePacer(fps: 5)
                self.lastPeopleTimestamp = -Double.infinity
                self.encoder.reset(session: key)
                self.analysisStore.reset(session: key)
                self.peopleVision?.dispose()
                self.peopleVision = NativePeopleVision(callbackQueue: self.queue)
                self.fightVision?.stop()
                self.fightVision = NativeFightVision(callbackQueue: self.queue,
                    onReport: { [weak self] report in
                        guard let self, self.currentIntent().shouldCapture, self.currentIntent().workGeneration == revision else { return }
                        self.analysisStore.put(report, session: key)
                    },
                    onStatus: { [weak self] status in
                        guard let self, self.currentIntent().shouldCapture, self.currentIntent().workGeneration == revision else { return }
                        self.analysisStore.status(status, session: key)
                    })
                self.fightVision?.start(session: key)
                guard self.currentIntent().shouldCapture, self.currentIntent().workGeneration == revision else { return }
                if !self.capture.isRunning { self.capture.startRunning() }
                guard self.capture.isRunning else { throw NSError(domain: "NIVRAUSB", code: 2) }
                self.server.start(session: key)
            } catch {
                DispatchQueue.main.async {
                    guard self.generation == generation, self.currentIntent().requested else { return }
                    self.pauseCapture(message: "Camera paused. Tap Resume camera to try again.")
                }
            }
        }
    }
    private func pauseCapture(message: String) {
        updateIntent { $0.paused = true; $0.workGeneration = UUID() }
        resumeQueued = false
        pairingTask?.cancel(); pairingTask = nil
        running = false; starting = false; paused = true; self.message = message; lastMacPull = nil
        UIApplication.shared.isIdleTimerDisabled = false
        let key = code
        // Keep listener, code, and session in RAM. Clear completed detections now.
        if !key.isEmpty { analysisStore.reset(session: key) }
        queue.async { [weak self] in
            guard let self, self.store.active(key) else { return }
            self.captureKey = ""
            self.encoder.reset(session: key)
            self.fightVision?.stop(); self.peopleVision?.dispose()
            self.analysisStore.reset(session: key)
            self.peopleVision = nil
            if self.capture.isRunning { self.capture.stopRunning() }
        }
    }
    private func configure() throws {
        guard !configured else { return }
        capture.beginConfiguration(); defer { capture.commitConfiguration() }
        capture.sessionPreset = .hd1280x720
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { throw NSError(domain: "NIVRAUSB", code: 3) }
        let input = try AVCaptureDeviceInput(device: device)
        guard capture.canAddInput(input) else { throw NSError(domain: "NIVRAUSB", code: 4) }
        capture.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        let format = output.availableVideoPixelFormatTypes.contains(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
            ? kCVPixelFormatType_420YpCbCr8BiPlanarFullRange : kCVPixelFormatType_32BGRA
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: format]
        output.setSampleBufferDelegate(self, queue: queue)
        guard capture.canAddOutput(output) else { capture.removeInput(input); throw NSError(domain: "NIVRAUSB", code: 5) }
        capture.addOutput(output); self.output = output
        if let connection = output.connection(with: .video), connection.isVideoRotationAngleSupported(rotationAngle) { connection.videoRotationAngle = rotationAngle }
        let forty = device.formats.first { format in
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            return size.width == 1280 && size.height == 720 && format.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 40 && $0.maxFrameRate >= 40 }
        }
        if forty != nil || device.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 30 && $0.maxFrameRate >= 30 }) {
            do {
                try device.lockForConfiguration()
                if let forty { device.activeFormat = forty }
                let fps: Int32 = forty == nil ? 30 : 40
                device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: fps)
                device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: fps)
                device.unlockForConfiguration()
            } catch { /* The monitor reports received frames, never the requested rate. */ }
        }
        configured = true
    }
    func rotate(to angle: CGFloat) {
        queue.async { [weak self] in
            guard let self, self.rotationAngle != angle,
                  let connection = self.output?.connection(with: .video), connection.isVideoRotationAngleSupported(angle) else { return }
            self.rotationAngle = angle
            connection.videoRotationAngle = angle
            // Pre-rotation joints and video windows cannot describe new pixels.
            if self.store.active(self.captureKey) {
                let key = self.captureKey
                self.encoder.reset(session: key); self.analysisStore.reset(session: key)
                self.peopleVision?.dispose(); self.peopleVision = NativePeopleVision(callbackQueue: self.queue)
                self.lastPeopleTimestamp = -Double.infinity
                self.fightVision?.stop(); self.fightVision?.start(session: key)
            }
        }
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = ProcessInfo.processInfo.systemUptime
        guard currentIntent().shouldCapture, store.active(captureKey), let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1000
        guard pts.isFinite, pts >= 0 else { return }
        let session = captureKey
        let revision = currentIntent().workGeneration
        encoder.append(sampleBuffer, session: session)
        fightVision?.append(sampleBuffer, session: session)
        if pts-lastPeopleTimestamp >= 200, let peopleVision,
           peopleVision.submit(buffer, timestampMs: pts, completion: { [weak self] result in
               guard let self, self.currentIntent().shouldCapture, self.currentIntent().workGeneration == revision else { return }
               if case .success(let report) = result { self.analysisStore.put(report, session: session) }
           }) { lastPeopleTimestamp = pts }
        // JPEGs remain a low-rate review and browser-compatibility fallback.
        guard pacing.admit(now) else { return }
        autoreleasepool {
            let source = CIImage(cvPixelBuffer: buffer)
            let scale = min(1, 960 / max(source.extent.width, source.extent.height))
            let image = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
            guard let jpeg = context.jpegRepresentation(of: image, colorSpace: jpegColorSpace, options: [quality: 0.6]), jpeg.count <= 1_500_000 else { return }
            store.put(jpeg: jpeg, width: Int(image.extent.width.rounded()), height: Int(image.extent.height.rounded()), timestampMs: pts.isFinite && pts >= 0 ? pts : now * 1000, session: captureKey)
        }
    }
    func pair(with pairing: LocalMacPairing) {
        // A fresh scan can arrive while capture is already open. Reuse its
        // active camera key and apply the new invitation immediately.
        pairingTask?.cancel(); pairingTask = nil
        macPairing = pairing
        if running { connectToMac() }
    }
    func connectToMac() {
        guard running, let pairing = macPairing, !code.isEmpty, pairingTask == nil else { return }
        let generation = generation, code = code
        macConnection = "Connecting to Mac…"; macConnectionFailed = false; macNeedsSettings = false
        pairingTask = Task { @MainActor [weak self] in
            do {
                try await LocalMacPairingClient.connect(pairing, code: code)
                guard let self, !Task.isCancelled, self.generation == generation, self.store.active(code) else { return }
                self.macConnection = "Connected to Mac"
                self.macPairing = nil; self.pairingTask = nil
                self.onPairingConsumed?()
            } catch {
                guard let self, !Task.isCancelled, self.generation == generation, self.store.active(code) else { return }
                let failure = LocalMacPairingFailure.classify(error)
                self.macConnection = failure.localizedDescription
                self.macNeedsSettings = failure == .localNetworkDenied
                self.macConnectionFailed = true; self.pairingTask = nil
            }
        }
    }
    func stop(message: String = "Camera stopped. Tap Start camera when you are ready.") {
        updateIntent { $0.requested = false; $0.workGeneration = UUID() }
        resumeQueued = false
        generation = UUID(); pairingTask?.cancel(); pairingTask = nil; macPairing = nil
        macConnection = ""; macConnectionFailed = false; macNeedsSettings = false
        store.stop(); server.stop(); analysisStore.stop(); videoStore.stop()
        running = false; starting = false; paused = false; code = ""; lastMacPull = nil; self.message = message
        UIApplication.shared.isIdleTimerDisabled = false
        queue.async { [weak self] in
            guard let self else { return }
            self.captureKey = ""
            self.encoder.stop(); self.fightVision?.stop(); self.peopleVision?.dispose()
            self.fightVision = nil; self.peopleVision = nil
            if self.capture.isRunning { self.capture.stopRunning() }
        }
    }
    deinit { pairingTask?.cancel(); if let interrupted { NotificationCenter.default.removeObserver(interrupted) }; if let interruptionEnded { NotificationCenter.default.removeObserver(interruptionEnded) }; server.stop(); store.stop() }
}
