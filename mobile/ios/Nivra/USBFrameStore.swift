import Foundation
import Security

struct USBFrame {
    let jpeg: Data
    let width: Int
    let height: Int
    let sequence: UInt64
    let timestampMs: Double
}

/// The server and capture queues share only this bounded latest-frame slot.
final class USBFrameStore {
    private let lock = NSLock()
    private var key = ""
    private var name = "USB camera"
    private var frame: USBFrame?
    private var lastPull: Date?

    /// Valid code a Mac may hand over when it launches this app over the USB cable.
    static func validMacCode(_ value: String?) -> String? {
        guard let value = value?.uppercased(), value.count == 8,
              value.allSatisfy({ "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains($0) }) else { return nil }
        return value
    }
    func begin(name: String, key provided: String? = nil) throws -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw NSError(domain: "NIVRAUSB", code: 1)
        }
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        // A code from the Mac (launch over USB) lets it connect without anyone typing.
        let next = USBFrameStore.validMacCode(provided) ?? String(bytes.map { alphabet[Int($0 & 31)] })
        lock.lock(); defer { lock.unlock() }
        self.key = next; self.name = name; frame = nil; lastPull = nil
        return next
    }
    func stop() { lock.lock(); key = ""; frame = nil; lastPull = nil; lock.unlock() }
    func active(_ value: String) -> Bool { lock.lock(); defer { lock.unlock() }; return !value.isEmpty && key == value }
    func authorized(_ value: String, session: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let a = Array(value.utf8), b = Array(key.utf8)
        guard key == session, b.count == 8, a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
    func put(jpeg: Data, width: Int, height: Int, timestampMs: Double, session: String) {
        guard !jpeg.isEmpty, jpeg.count <= 1_500_000, jpeg.starts(with: [0xff, 0xd8]), jpeg.suffix(2) == Data([0xff, 0xd9]),
            width > 0, height > 0, width <= 960, height <= 960, timestampMs.isFinite, timestampMs >= 0 else { return }
        lock.lock(); defer { lock.unlock() }
        guard key == session, !key.isEmpty, frame == nil || timestampMs > frame!.timestampMs else { return }
        frame = USBFrame(jpeg: jpeg, width: width, height: height, sequence: (frame?.sequence ?? 0) + 1, timestampMs: timestampMs)
    }
    func latest(session: String) -> USBFrame? {
        lock.lock(); defer { lock.unlock() }; return key == session ? frame : nil
    }
    func status(session: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard key == session, !key.isEmpty else { return nil }
        let object: [String: Any] = ["deviceId": LocalCameraNetwork.serviceName(), "name": name, "videoEncoding": "h264", "analysisProtocol": "native-analysis-v1", "width": frame?.width ?? 0, "height": frame?.height ?? 0,
            "sequence": frame?.sequence ?? 0, "timestampMs": frame?.timestampMs ?? 0,
            "lastMacPullAt": lastPull.map { $0.timeIntervalSince1970 * 1000 } as Any? ?? NSNull()]
        return try? JSONSerialization.data(withJSONObject: object)
    }
    func pulled(session: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        guard key == session, !key.isEmpty else { return nil }
        let now = Date(); lastPull = now; return now
    }
}


/// Select current sensor frames without accumulating delayed work.
struct LocalFramePacer {
    private var nextDue: Double?
    private let interval: Double
    init(fps: Double = 20) { interval = 1.0 / max(1, min(60, fps)) }
    mutating func admit(_ now: Double) -> Bool {
        guard now.isFinite, now >= 0 else { return false }
        guard let deadline = nextDue else { nextDue = now + interval; return true }
        guard now + 0.000001 >= deadline else { return false }
        nextDue = now - deadline >= interval ? now + interval : deadline + interval
        return true
    }
}
