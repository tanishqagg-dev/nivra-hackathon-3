import Foundation
import Network

/// Authenticated local pull server. It never initiates a network connection.
final class USBHTTPServer {
    private let queue = DispatchQueue(label: "work.tanishq.nivra.usb.http")
    private var listener: NWListener?
    private var clients: [UUID: (NWConnection, DispatchWorkItem)] = [:]
    private var generation = UUID()
    private let store: USBFrameStore
    private let videoStore: LocalVideoStore?
    private let analysisStore: NativeAnalysisStore?
    var onReady: (() -> Void)?
    var onFailure: (() -> Void)?
    var onPull: ((Date) -> Void)?
    init(store: USBFrameStore, videoStore: LocalVideoStore? = nil, analysisStore: NativeAnalysisStore? = nil) {
        self.store = store; self.videoStore = videoStore; self.analysisStore = analysisStore
    }

    func start(session: String, transport: LocalCameraTransport = .wireless) {
        queue.async { [weak self] in
            guard let self, self.store.active(session) else { return }
            self.stopOnQueue()
            let generation = self.generation
            do {
                let parameters = NWParameters.tcp
                parameters.includePeerToPeer = false
                if transport == .usb { parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 8940) }
                let listener = try NWListener(using: parameters, on: 8940)
                if transport == .wireless {
                    listener.service = NWListener.Service(name: LocalCameraNetwork.serviceName(), type: "_nivra-camera._tcp")
                }
                self.listener = listener
                listener.stateUpdateHandler = { [weak self] state in
                    guard let self, generation == self.generation, self.store.active(session) else { return }
                    switch state {
                    case .ready: self.onReady?()
                    case .failed: self.stopOnQueue(); self.onFailure?()
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in
                    guard let self, generation == self.generation, self.store.active(session) else { connection.cancel(); return }
                    self.accept(connection, session: session)
                }
                listener.start(queue: self.queue)
            } catch { self.onFailure?() }
        }
    }
    func stop() { queue.async { [weak self] in self?.stopOnQueue() } }
    private func stopOnQueue() {
        generation = UUID(); listener?.cancel(); listener = nil
        for (_, (connection, deadline)) in clients { deadline.cancel(); connection.cancel() }
        clients.removeAll()
    }
    private func finish(_ id: UUID) {
        guard let (connection, deadline) = clients.removeValue(forKey: id) else { return }
        deadline.cancel(); connection.cancel()
    }
    private func accept(_ connection: NWConnection, session: String) {
        guard clients.count < 4 else { connection.cancel(); return }
        let id = UUID()
        let deadline = DispatchWorkItem { [weak self] in self?.finish(id) }
        clients[id] = (connection, deadline)
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.finish(id) }
            if case .cancelled = state { self?.finish(id) }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 3, execute: deadline)
        receive(connection, id: id, data: Data(), session: session)
    }
    private func receive(_ connection: NWConnection, id: UUID, data: Data, session: String) {
        guard clients[id] != nil else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: max(1, 4096 - data.count)) { [weak self] chunk, _, complete, error in
            guard let self, self.clients[id] != nil else { return }
            var collected = data; if let chunk { collected.append(chunk) }
            if collected.range(of: Data([13, 10, 13, 10])) != nil {
                self.respond(connection, id: id, request: collected, session: session)
            } else if error != nil || complete { self.finish(id) }
            else if collected.count >= 4096 { self.send(connection, id: id, status: 431, body: Data()) }
            else { self.receive(connection, id: id, data: collected, session: session) }
        }
    }
    private func respond(_ connection: NWConnection, id: UUID, request: Data, session: String) {
        guard request.count <= 4096, let text = String(data: request, encoding: .utf8), let end = text.range(of: "\r\n\r\n") else {
            send(connection, id: id, status: 400, body: Data()); return
        }
        let rows = String(text[..<end.lowerBound]).components(separatedBy: "\r\n")
        let first = rows[0].split(separator: " ")
        var headers: [String: String] = [:]
        for row in rows.dropFirst() {
            guard let colon = row.firstIndex(of: ":") else { send(connection, id: id, status: 400, body: Data()); return }
            let key = row[..<colon].lowercased(), value = row[row.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard headers[key] == nil else { send(connection, id: id, status: 400, body: Data()); return }
            headers[key] = value
        }
        guard store.authorized(headers["x-nivra-key"] ?? "", session: session) else {
            // Keep failed attempts in a connection slot briefly. Four slots
            // bound guessing without locking a correctly entered key out.
            queue.asyncAfter(deadline: .now() + .milliseconds(250)) { [weak self] in
                guard let self, self.clients[id] != nil else { return }
                self.send(connection, id: id, status: 401, body: Data())
            }
            return
        }
        guard first.count == 3, first[2] == "HTTP/1.1", headers["transfer-encoding"] == nil,
            headers["content-length"] == nil || headers["content-length"] == "0",
            text[end.upperBound...].isEmpty else { send(connection, id: id, status: 400, body: Data()); return }
        guard first[0] == "GET" else { send(connection, id: id, status: 405, body: Data()); return }
        if first[1].hasPrefix("/v1/video") {
            guard let target = URLComponents(string: String(first[1])), target.path == "/v1/video", target.fragment == nil,
                  target.scheme == nil, target.host == nil,
                  (target.queryItems ?? []).count <= 1,
                  (target.queryItems ?? []).allSatisfy({ $0.name == "after" && $0.value?.range(of: "^[0-9]{1,20}$", options: .regularExpression) != nil && UInt64($0.value!) != nil }) else {
                send(connection, id: id, status: 400, body: Data()); return
            }
            let after = target.queryItems?.first?.value.flatMap(UInt64.init)
            if let date = store.pulled(session: session) { onPull?(date) }
            guard let body = videoStore?.response(after: after, session: session) else { send(connection, id: id, status: 204, body: Data()); return }
            send(connection, id: id, status: 200, body: body, type: "application/json")
            return
        }
        switch first[1] {
        case "/v1/analysis":
            guard let body = analysisStore?.response(session: session), body.count <= 3_000_000 else { send(connection, id: id, status: 204, body: Data()); return }
            send(connection, id: id, status: 200, body: body, type: "application/json")
        case "/v1/status":
            guard let body = store.status(session: session) else { finish(id); return }
            send(connection, id: id, status: 200, body: body, type: "application/json")
        case "/v1/frame":
            if let date = store.pulled(session: session) { onPull?(date) }
            guard let frame = store.latest(session: session) else { send(connection, id: id, status: 503, body: Data()); return }
            send(connection, id: id, status: 200, body: frame.jpeg, type: "image/jpeg", extra: ["X-Nivra-Sequence": String(frame.sequence),
                "X-Nivra-Timestamp": String(frame.timestampMs), "X-Nivra-Width": String(frame.width), "X-Nivra-Height": String(frame.height)])
        default: send(connection, id: id, status: 404, body: Data())
        }
    }
    private func send(_ connection: NWConnection, id: UUID, status: Int, body: Data, type: String = "application/octet-stream", extra: [String: String] = [:]) {
        let reason = [200:"OK", 204:"No Content", 400:"Bad Request", 401:"Unauthorized", 404:"Not Found", 405:"Method Not Allowed", 431:"Request Header Fields Too Large", 503:"Service Unavailable"][status] ?? "Error"
        var header = "HTTP/1.1 \(status) \(reason)\r\nContent-Length: \(body.count)\r\nContent-Type: \(type)\r\nCache-Control: no-store\r\nConnection: close\r\n"
        for (key, value) in extra { header += "\(key): \(value)\r\n" }
        header += "\r\n"
        var output = Data(header.utf8); output.append(body)
        connection.send(content: output, completion: .contentProcessed { [weak self] _ in self?.finish(id) })
    }
    deinit { listener?.cancel(); for (_, (connection, deadline)) in clients { deadline.cancel(); connection.cancel() } }
}
