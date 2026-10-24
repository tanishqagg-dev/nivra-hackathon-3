import Foundation
import Darwin

// Local discovery never includes the connection key. Only the on-screen QR does.
enum LocalCameraNetwork {
    static func privateIPv4(_ address: String) -> Bool {
        let components = address.split(separator: ".", omittingEmptySubsequences: false)
        guard components.count == 4, components.allSatisfy({ !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } && ($0.count == 1 || $0.first != "0") }) else { return false }
        let parts = components.compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        return parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168)
    }
    static func candidates(_ interfaces: [(String, String)]) -> [String] {
        let ordered = interfaces.filter { ($0.0.hasPrefix("en") || $0.0.hasPrefix("bridge")) && privateIPv4($0.1) }
            .sorted { lhs, rhs in
                func rank(_ name: String) -> Int { name == "en0" ? 0 : name == "bridge100" ? 1 : 2 }
                return rank(lhs.0) == rank(rhs.0) ? lhs.0 < rhs.0 : rank(lhs.0) < rank(rhs.0)
            }
        var seen = Set<String>()
        return ordered.compactMap { seen.insert($0.1).inserted ? $0.1 : nil }
    }
    static func addresses() -> [String] {
        var pointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&pointer) == 0, let first = pointer else { return [] }
        defer { freeifaddrs(pointer) }
        var found: [(String, String)] = []
        var next: UnsafeMutablePointer<ifaddrs>? = first
        while let item = next {
            let interface = item.pointee
            defer { next = interface.ifa_next }
            guard let address = interface.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                interface.ifa_flags & UInt32(IFF_UP) != 0, interface.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            found.append((String(cString: interface.ifa_name), String(cString: host)))
        }
        return candidates(found)
    }
    static func serviceName(defaults: UserDefaults = .standard) -> String {
        let storageKey = "nivra.localCamera.installation"
        let id = defaults.string(forKey: storageKey) ?? UUID().uuidString.lowercased()
        defaults.set(id, forKey: storageKey)
        return "NIVRA-" + String(id.replacingOccurrences(of: "-", with: "").prefix(12))
    }
    static func pairingPayload(addresses: [String], key: String) -> String? {
        let safe = addresses.filter(privateIPv4)
        guard let host = safe.first, key.range(of: "^[A-HJ-NP-Z2-9]{8}$", options: .regularExpression) != nil else { return nil }
        var url = URLComponents()
        url.scheme = "nivra-local"; url.host = "camera"
        url.queryItems = [URLQueryItem(name: "host", value: host), URLQueryItem(name: "port", value: "8940"), URLQueryItem(name: "hosts", value: safe.joined(separator: ","))]
        url.fragment = "key=" + key
        return url.string
    }
}

enum LocalCameraTransport {
    case wireless, usb
}

struct LocalMacPairing: Equatable {
    let hosts: [String]
    let token: String

    static func parse(_ text: String) -> LocalMacPairing? {
        guard text.count <= 2048, let url = URLComponents(string: text),
            url.scheme == "nivra", url.host == "local-camera", url.path.isEmpty,
            url.user == nil, url.password == nil, url.port == nil,
            let items = url.queryItems, Set(items.map(\.name)).count == items.count,
            Set(items.map(\.name)).isSubset(of: ["host", "hosts", "port"]),
            items.first(where: { $0.name == "port" })?.value == "8871",
            let host = items.first(where: { $0.name == "host" })?.value,
            LocalCameraNetwork.privateIPv4(host),
            let fragment = url.fragment, fragment.hasPrefix("pair=") else { return nil }
        let token = String(fragment.dropFirst(5))
        guard token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return nil }
        var hosts = [host]
        if let item = items.first(where: { $0.name == "hosts" }) {
            guard let value = item.value else { return nil }
            let candidates = value.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
            guard !candidates.isEmpty, candidates.count <= 8, candidates.allSatisfy(LocalCameraNetwork.privateIPv4) else { return nil }
            hosts.append(contentsOf: candidates)
        }
        var seen = Set<String>()
        hosts = hosts.filter { seen.insert($0).inserted }
        guard hosts.count <= 8 else { return nil }
        return LocalMacPairing(hosts: hosts, token: token)
    }
}

private final class LocalPairingNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum LocalMacPairingFailure: Error, LocalizedError {
    case localNetworkDenied, transportBlocked, expiredInvite, timeout, macUnavailable, verificationFailed
    var errorDescription: String? {
        switch self {
        case .localNetworkDenied: return "Allow Local Network access for NIVRA in Settings, then scan the Mac QR again."
        case .transportBlocked: return "iOS blocked the local connection. Update NIVRA, then scan a new Mac QR."
        case .expiredInvite: return "This QR has expired or was already used. Show a new QR on your Mac and scan it."
        case .timeout: return "Your Mac did not respond in time. Keep NIVRA open on the Mac, then tap Try again."
        case .macUnavailable: return "Could not reach NIVRA on your Mac. Check Local Network access and keep NIVRA open on the Mac."
        case .verificationFailed: return "Your Mac could not connect back to this camera. Keep this screen open and tap Try again."
        }
    }
    static func classify(_ error: Error) -> LocalMacPairingFailure {
        if let known = error as? LocalMacPairingFailure { return known }
        var current = error as NSError
        for _ in 0..<4 {
            // NWPath explicitly names this privacy restriction. An offline
            // error alone is not evidence that permission was denied.
            let path = String(describing: current.userInfo["_NSURLErrorNWPathKey"] ?? "").lowercased().filter(\.isLetter)
            if path.contains("localnetworkprohibited") || path.contains("localnetworkdenied") { return .localNetworkDenied }
            if current.domain == NSURLErrorDomain {
                if current.code == URLError.appTransportSecurityRequiresSecureConnection.rawValue { return .transportBlocked }
                if current.code == URLError.timedOut.rawValue { return .timeout }
            }
            guard let underlying = current.userInfo[NSUnderlyingErrorKey] as? NSError else { break }
            current = underlying
        }
        return .macUnavailable
    }
}

enum LocalMacPairingClient {
    static func connect(_ pairing: LocalMacPairing, code: String) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await attempt(pairing, code: code) }
            group.addTask {
                try await Task.sleep(nanoseconds: 20_000_000_000)
                throw LocalMacPairingFailure.timeout
            }
            defer { group.cancelAll() }
            try await group.next()
        }
    }
    private static func attempt(_ pairing: LocalMacPairing, code: String) async throws {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12; config.timeoutIntervalForResource = 12
        config.httpShouldSetCookies = false; config.urlCache = nil
        config.connectionProxyDictionary = [:]
        let session = URLSession(configuration: config, delegate: LocalPairingNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let body = try JSONSerialization.data(withJSONObject: ["token": pairing.token, "code": code, "port": 8940])
        var lastFailure = LocalMacPairingFailure.macUnavailable
        for host in pairing.hosts {
            try Task.checkCancellation()
            guard LocalCameraNetwork.privateIPv4(host), let url = URL(string: "http://\(host):8871/pair") else { continue }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"; request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do {
                let (_, response) = try await session.data(for: request)
                try Task.checkCancellation()
                if let http = response as? HTTPURLResponse {
                    if (200...299).contains(http.statusCode) { return }
                    if http.statusCode == 403 { throw LocalMacPairingFailure.expiredInvite }
                    lastFailure = http.statusCode == 408 ? .timeout : .verificationFailed
                }
            } catch is CancellationError { throw CancellationError() }
            catch {
                if Task.isCancelled { throw CancellationError() }
                lastFailure = LocalMacPairingFailure.classify(error)
                if lastFailure == .localNetworkDenied || lastFailure == .transportBlocked || lastFailure == .expiredInvite { throw lastFailure }
            }
        }
        throw lastFailure
    }
}
