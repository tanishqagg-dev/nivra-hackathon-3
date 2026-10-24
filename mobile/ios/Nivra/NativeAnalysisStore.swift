import Foundation

/// Latest completed results only. Source clocks belong to the capture session.
final class NativeAnalysisStore {
    private let lock = NSLock()
    private var session = ""
    private var state = "loading"
    private var detail = "Starting detection on this phone…"
    private var people: NativePeopleReport?
    private var fight: NativeFightReport?

    func reset(session: String) {
        lock.lock(); defer { lock.unlock() }
        self.session = session; state = "loading"; detail = "Starting detection on this phone…"
        people = nil; fight = nil
    }
    func stop() {
        lock.lock(); defer { lock.unlock() }
        session = ""; people = nil; fight = nil
    }
    func status(_ status: NativeFightStatus, session: String) {
        lock.lock(); defer { lock.unlock() }
        guard !session.isEmpty, self.session == session else { return }
        state = status.state; detail = String(status.detail.prefix(240))
        if state != "ready" { fight = nil }
    }
    func put(_ report: NativePeopleReport, session: String) {
        lock.lock(); defer { lock.unlock() }
        guard !session.isEmpty, self.session == session,
              report.timestampMs > (people?.timestampMs ?? -1) else { return }
        people = report
    }
    func put(_ report: NativeFightReport, session: String) {
        lock.lock(); defer { lock.unlock() }
        guard !session.isEmpty, self.session == session,
              report.timestampMs > (fight?.timestampMs ?? -1) else { return }
        fight = report
    }
    func response(session: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard !session.isEmpty, self.session == session else { return nil }
        struct Envelope: Encodable {
            let type = "native-analysis-v1"
            let state: String
            let detail: String
            let people: NativePeopleReport?
            let fight: NativeFightReport?
        }
        return try? JSONEncoder().encode(Envelope(state: state, detail: detail, people: people, fight: fight))
    }
}
