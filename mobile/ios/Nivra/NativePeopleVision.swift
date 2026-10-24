import Foundation
import Vision
import CoreVideo
import ImageIO

struct NativePeopleTrack: Codable, Equatable {
    /// Frame-local detection label. It is not a persistent person identity.
    let id: Int
    let box: [Double]
}

struct NativePeopleReport: Encodable {
    let type = "native-people-v1"
    let model = "apple-vision-body-pose"
    let timestampMs: Double
    let inferenceMs: Double
    let observedPeople: Int
    let posePeople: Int
    let tracks: [NativePeopleTrack]
    /// MediaPipe-compatible slot order, with unsupported or uncertain joints null.
    let poses: [[[Double]?]]
}

struct NativeObservedPoint {
    let x: Double
    let y: Double
    let confidence: Double
}

/// Prototype only. No capture, HTTP, tracking identity, or fight classification.
/// The caller submits its current pixel buffer; a busy detector drops that frame.
final class NativePeopleVision {
    typealias Processor = (CVPixelBuffer, Double, CGImagePropertyOrientation) throws -> NativePeopleReport
    private let queue = DispatchQueue(label: "work.tanishq.nivra.people", qos: .userInitiated)
    private let lock = NSLock()
    private let callbackQueue: DispatchQueue
    private let processor: Processor
    private var busy = false
    private var disposed = false
    private var lastTimestamp = -Double.infinity
    private var generation = UUID()

    init(callbackQueue: DispatchQueue = .main, processor: Processor? = nil) {
        self.callbackQueue = callbackQueue
        self.processor = processor ?? Self.analyze
    }

    /// True means accepted for analysis. At most one source buffer is retained.
    @discardableResult
    func submit(_ pixelBuffer: CVPixelBuffer, timestampMs: Double,
                orientation: CGImagePropertyOrientation = .up,
                completion: @escaping (Result<NativePeopleReport, Error>) -> Void) -> Bool {
        lock.lock()
        guard !disposed, !busy, timestampMs.isFinite, timestampMs >= 0, timestampMs > lastTimestamp else { lock.unlock(); return false }
        busy = true; lastTimestamp = timestampMs
        let epoch = generation
        lock.unlock()
        queue.async { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let active = !self.disposed && self.generation == epoch
            self.lock.unlock()
            guard active else { return }
            let result = Result { try autoreleasepool { try self.processor(pixelBuffer, timestampMs, orientation) } }
            self.lock.lock(); self.busy = false; self.lock.unlock()
            self.callbackQueue.async { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let current = !self.disposed && self.generation == epoch
                self.lock.unlock()
                if current { completion(result) }
            }
        }
        return true
    }

    /// In-flight Vision work may finish, but it cannot publish after disposal.
    func dispose() {
        lock.lock(); disposed = true; generation = UUID(); lock.unlock()
    }

    private static func analyze(_ buffer: CVPixelBuffer, _ timestampMs: Double,
                                _ orientation: CGImagePropertyOrientation) throws -> NativePeopleReport {
        let started = ProcessInfo.processInfo.systemUptime
        let rectangles = VNDetectHumanRectanglesRequest()
        rectangles.upperBodyOnly = false
        let body = VNDetectHumanBodyPoseRequest()
        // Vision selects the supported processor. Do not claim Neural Engine use
        // merely because the phone has one.
        try VNImageRequestHandler(cvPixelBuffer: buffer, orientation: orientation).perform([rectangles, body])
        let tracks = (rectangles.results ?? []).filter { $0.confidence >= 0.5 }.prefix(32).enumerated().compactMap { index, observation -> NativePeopleTrack? in
            guard let box = topLeftBox(observation.boundingBox) else { return nil }
            return NativePeopleTrack(id: index, box: box)
        }
        let poses = try (body.results ?? []).prefix(32).map { observation in
            let recognized = try observation.recognizedPoints(.all)
            return mappedPose(recognized.mapValues { NativeObservedPoint(x: $0.location.x, y: $0.location.y, confidence: Double($0.confidence)) })
        }.filter { $0.compactMap { $0 }.count >= 4 }
        return NativePeopleReport(timestampMs: timestampMs,
            inferenceMs: (ProcessInfo.processInfo.systemUptime - started) * 1000,
            observedPeople: tracks.count, posePeople: poses.count, tracks: tracks, poses: poses)
    }

    static func topLeftBox(_ box: CGRect) -> [Double]? {
        let values = [box.minX, 1 - box.maxY, box.maxX, 1 - box.minY].map(Double.init)
        guard values.allSatisfy({ $0.isFinite && (0...1).contains($0) }), values[2] > values[0], values[3] > values[1] else { return nil }
        return values
    }

    static func mappedPose(_ points: [VNHumanBodyPoseObservation.JointName: NativeObservedPoint]) -> [[Double]?] {
        let mapping: [(VNHumanBodyPoseObservation.JointName, Int)] = [
            (.nose, 0), (.leftEye, 2), (.rightEye, 5), (.leftEar, 7), (.rightEar, 8),
            (.leftShoulder, 11), (.rightShoulder, 12), (.leftElbow, 13), (.rightElbow, 14),
            (.leftWrist, 15), (.rightWrist, 16), (.leftHip, 23), (.rightHip, 24),
            (.leftKnee, 25), (.rightKnee, 26), (.leftAnkle, 27), (.rightAnkle, 28),
        ]
        var pose = Array<[Double]?>(repeating: nil, count: 33)
        for (name, index) in mapping {
            guard let point = points[name], [point.x, point.y, point.confidence].allSatisfy({ $0.isFinite && (0...1).contains($0) }), point.confidence >= 0.55 else { continue }
            pose[index] = [point.x, 1 - point.y, point.confidence]
        }
        return pose
    }
}
