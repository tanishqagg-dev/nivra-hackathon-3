import Foundation

struct LocalVideoFrame: Encodable {
    let sequence: UInt64
    let timestampMs: Double
    let keyframe: Bool
    let data: Data
}

/// Compressed AVCC samples only. The HTTP consumer never holds the capture queue.
final class LocalVideoStore {
    private let lock = NSLock()
    private var session = ""
    private var generation = UUID().uuidString
    private var codec = ""
    private var description = Data()
    private var width = 0, height = 0
    private var sequence: UInt64 = 0
    private var frames: [LocalVideoFrame] = []
    private var bytes = 0
    private var lastTimestamp = -Double.infinity
    static let byteLimit = 2_000_000

    @discardableResult
    func reset(session: String) -> String {
        lock.lock(); defer { lock.unlock() }
        if self.session != session || session.isEmpty { sequence = 0 }
        self.session = session; generation = UUID().uuidString
        codec = ""; description = Data(); width = 0; height = 0
        frames.removeAll(); bytes = 0; lastTimestamp = -Double.infinity
        return generation
    }
    func stop() { _ = reset(session: "") }

    func append(data: Data, timestampMs: Double, keyframe: Bool, codec: String, description: Data,
                width: Int, height: Int, session: String, generation: String) {
        guard !data.isEmpty, data.count <= 1_000_000, timestampMs.isFinite, timestampMs >= 0,
              codec.range(of: "^avc1\\.[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
              !description.isEmpty, description.count <= 4096, width > 0, height > 0,
              width <= 1280, height <= 1280 else { return }
        lock.lock(); defer { lock.unlock() }
        guard !session.isEmpty, self.session == session, self.generation == generation, timestampMs > lastTimestamp else { return }
        // A configuration change requires a fresh keyframe. No mixed decoder state.
        if self.codec != codec || self.description != description || self.width != width || self.height != height {
            guard keyframe else { return }
            frames.removeAll(); bytes = 0
            self.codec = codec; self.description = description; self.width = width; self.height = height
        }
        guard keyframe || !frames.isEmpty else { return }
        lastTimestamp = timestampMs; sequence += 1
        frames.append(LocalVideoFrame(sequence: sequence, timestampMs: timestampMs, keyframe: keyframe, data: data)); bytes += data.count
        while let first = frames.first, bytes > Self.byteLimit || frames.count > 90 || timestampMs - first.timestampMs > 2000 {
            bytes -= frames.removeFirst().data.count
        }
        // The retained window must start at an IDR, so a new viewer can decode it.
        while let first = frames.first, !first.keyframe { bytes -= frames.removeFirst().data.count }
    }

    private struct Packet: Encodable {
        let version = 1
        let generation: String
        let codec: String
        let description: Data
        let width: Int
        let height: Int
        let frames: [LocalVideoFrame]
    }
    private func packet(after: UInt64?, session: String) -> Packet? {
        lock.lock(); defer { lock.unlock() }
        guard !session.isEmpty, self.session == session, !frames.isEmpty else { return nil }
        let selected: [LocalVideoFrame]
        if let after, after >= frames[0].sequence, after <= sequence {
            selected = frames.filter { $0.sequence > after }
        } else {
            // Missing or evicted cursor: restart at the newest usable IDR.
            let start = frames.lastIndex(where: \.keyframe) ?? 0
            selected = Array(frames[start...])
        }
        guard !selected.isEmpty else { return nil }
        return Packet(generation: generation, codec: codec, description: description, width: width, height: height, frames: selected)
    }
    func response(after: UInt64?, session: String) -> Data? {
        guard let packet = packet(after: after, session: session) else { return nil }
        // Base64/JSON encoding works on a snapshot, outside the producer lock.
        guard let payload = try? JSONEncoder().encode(packet), payload.count <= 3_000_000 else { return nil }
        return payload
    }
}
