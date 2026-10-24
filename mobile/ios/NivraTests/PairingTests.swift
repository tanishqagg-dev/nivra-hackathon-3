import XCTest
@testable import Nivra

final class PairingTests: XCTestCase {
    private let token = "0123456789012345678901234567890123456789"
    func testPairingFragmentsStayOnServiceOrigin() {
        for path in ["camera", "guard"] {
            let expected = "https://nivra.tanishq.work/\(path)#pair=\(token)"
            XCTAssertEqual(pairingURL(expected)?.absoluteString, expected)
            XCTAssertEqual(pairingURL("nivra://\(path)#pair=\(token)")?.absoluteString, expected)
        }
    }
    func testOperatorPairingKeepsFragmentOnWall() {
        XCTAssertEqual(pairingURL("https://nivra.tanishq.work/wall#operator=\(token)")?.absoluteString, "https://nivra.tanishq.work/wall#operator=\(token)")
        XCTAssertEqual(pairingURL("https://nivra.tanishq.work/#operator=\(token)")?.absoluteString, "https://nivra.tanishq.work/wall#operator=\(token)")
    }
    func testAestrumGuardLinkKeepsFragmentOnGuardHost() {
        let token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd"
        let expected = "https://nivra.aestrum.in/guard#pair=\(token)"
        XCTAssertEqual(pairingURL(expected)?.absoluteString, expected)
        XCTAssertEqual(pairingURL("  https://NIVRA.aestrum.in/guard/#pair=\(token)\n")?.absoluteString, expected)
        XCTAssertEqual(NivraRole.aestrumGuard.url.absoluteString, "https://nivra.aestrum.in/guard")
        XCTAssertTrue(trustedWebHosts.contains("nivra.aestrum.in"))
    }
    func testRejectsUntrustedAestrumGuardLinks() {
        for input in [
            "http://nivra.aestrum.in/guard#pair=\(token)",
            "https://nivra.aestrum.in.evil.example/guard#pair=\(token)",
            "https://evil.aestrum.in/guard#pair=\(token)",
            "https://aestrum.in/guard#pair=\(token)",
            "https://nivra.aestrum.in/camera#pair=\(token)",
            "https://nivra.aestrum.in/wall#operator=\(token)",
            "https://nivra.aestrum.in/guard/api/pair#pair=\(token)",
            "https://nivra.aestrum.in/#pair=\(token)",
            "https://nivra.aestrum.in:444/guard#pair=\(token)",
            "https://user@nivra.aestrum.in/guard#pair=\(token)",
            "https://nivra.aestrum.in/guard?pair=\(token)",
            "https://nivra.aestrum.in/guard#operator=\(token)",
            "https://nivra.aestrum.in/guard#pair=short"
        ] { XCTAssertNil(pairingURL(input), input) }
    }
    func testRejectsUntrustedOrMalformedPairingLinks() {
        for input in [
            "https://evil.example/camera#pair=\(token)",
            "http://nivra.tanishq.work/guard#pair=\(token)",
            "https://nivra.tanishq.work:444/guard#pair=\(token)",
            "https://user@nivra.tanishq.work/guard#pair=\(token)",
            "https://nivra.tanishq.work/wall#pair=\(token)",
            "https://nivra.tanishq.work/camera?pair=\(token)",
            "nivra://guard#pair=short"
        ] { XCTAssertNil(pairingURL(input), input) }
    }
}

final class USBFrameStoreTests: XCTestCase {
    private let jpeg = Data([0xff, 0xd8, 0x00, 0xff, 0xd9])
    func testSessionCodeIsUnambiguousAndEveryStartInvalidatesThePreviousSession() throws {
        let store = USBFrameStore()
        let first = try store.begin(name: "Entrance")
        XCTAssertNotNil(first.range(of: "^[A-HJ-NP-Z2-9]{8}$", options: .regularExpression))
        XCTAssertTrue(store.authorized(first, session: first))
        XCTAssertFalse(store.authorized("WRONGKEY", session: first))
        XCTAssertFalse(store.authorized("", session: first))
        store.put(jpeg: jpeg, width: 540, height: 960, timestampMs: 100, session: first)
        XCTAssertEqual(store.latest(session: first)?.sequence, 1)
        let second = try store.begin(name: "Hall")
        XCTAssertFalse(store.active(first))
        XCTAssertFalse(store.authorized(first, session: first))
        XCTAssertNil(store.latest(session: second))
        store.put(jpeg: jpeg, width: 540, height: 960, timestampMs: 200, session: first)
        XCTAssertNil(store.latest(session: second))
    }
    func testStatusDoesNotReflectKeyAndStopErasesFrameAndAccess() throws {
        let store = USBFrameStore(), key = try store.begin(name: "Entrance")
        store.put(jpeg: jpeg, width: 540, height: 960, timestampMs: 100, session: key)
        XCTAssertNotNil(store.pulled(session: key))
        let json = try XCTUnwrap(store.status(session: key))
        let status = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
        XCTAssertEqual(status["name"] as? String, "Entrance")
        let deviceId = try XCTUnwrap(status["deviceId"] as? String)
        XCTAssertEqual(deviceId, LocalCameraNetwork.serviceName())
        XCTAssertNotNil(deviceId.range(of: "^NIVRA-[0-9a-f]{12}$", options: .regularExpression))
        let rotatedKey = try store.begin(name: "Entrance")
        let rotatedStatus = try XCTUnwrap(store.status(session: rotatedKey))
        let rotatedObject = try XCTUnwrap(JSONSerialization.jsonObject(with: rotatedStatus) as? [String: Any])
        XCTAssertEqual(rotatedObject["deviceId"] as? String, deviceId)
        XCTAssertFalse(String(decoding: rotatedStatus, as: UTF8.self).contains(rotatedKey))
        XCTAssertEqual(status["sequence"] as? Int, 1)
        XCTAssertNil(status["code"])
        XCTAssertFalse(String(decoding: json, as: UTF8.self).contains(key))
        store.stop()
        XCTAssertFalse(store.authorized(key, session: key))
        XCTAssertNil(store.status(session: key))
        XCTAssertNil(store.latest(session: key))
        XCTAssertNil(store.pulled(session: key))
    }
    func testOnlyBoundedMonotonicFramesFromTheCurrentSessionAreAccepted() throws {
        let store = USBFrameStore(), key = try store.begin(name: "Entrance")
        for (data, width, height, timestamp) in [(Data(), 540, 960, 10.0), (jpeg, 0, 960, 10), (jpeg, 540, 961, 10),
            (jpeg, 540, 960, Double.nan), (jpeg, 540, 960, -1), (Data(repeating: 0, count: 1_500_001), 540, 960, 10)] {
            store.put(jpeg: data, width: width, height: height, timestampMs: timestamp, session: key)
        }
        XCTAssertNil(store.latest(session: key))
        store.put(jpeg: jpeg, width: 540, height: 960, timestampMs: 100, session: key)
        store.put(jpeg: jpeg, width: 540, height: 960, timestampMs: 99, session: key)
        XCTAssertEqual(store.latest(session: key)?.sequence, 1)
        store.put(jpeg: jpeg, width: 960, height: 540, timestampMs: 200, session: key)
        XCTAssertEqual(store.latest(session: key)?.sequence, 2)
        XCTAssertEqual(store.latest(session: key)?.width, 960)
    }
}


final class LocalCameraNetworkTests: XCTestCase {
    func testOnlyPrivateLANAddressesAreOfferedWithWiFiFirst() {
        let result = LocalCameraNetwork.candidates([("pdp_ip0", "10.1.2.3"), ("en1", "192.168.2.4"),
            ("bridge100", "172.20.10.1"), ("en0", "192.168.1.2"), ("lo0", "127.0.0.1"),
            ("en2", "169.254.2.3"), ("en3", "8.8.8.8"), ("en4", "192.168.1.2")])
        XCTAssertEqual(result, ["192.168.1.2", "172.20.10.1", "192.168.2.4"])
        for value in ["172.32.0.1", "192..168.1.2", "192.168.01.2", "+192.168.1.2", "169.254.1.2", "127.0.0.1"] { XCTAssertFalse(LocalCameraNetwork.privateIPv4(value), value) }
        XCTAssertFalse(LocalCameraNetwork.privateIPv4("192.168.0.999"))
    }
    func testQRKeepsSessionKeyInFragmentAndOffersHotspotFallback() throws {
        let payload = try XCTUnwrap(LocalCameraNetwork.pairingPayload(addresses: ["172.20.10.1", "192.168.2.3"], key: "ABCDEFGH"))
        let url = try XCTUnwrap(URLComponents(string: payload))
        XCTAssertEqual(url.scheme, "nivra-local")
        XCTAssertEqual(url.host, "camera")
        XCTAssertEqual(url.fragment, "key=ABCDEFGH")
        XCTAssertFalse(url.query?.contains("ABCDEFGH") ?? true)
        XCTAssertEqual(url.queryItems?.first(where: { $0.name == "host" })?.value, "172.20.10.1")
        XCTAssertEqual(url.queryItems?.first(where: { $0.name == "hosts" })?.value, "172.20.10.1,192.168.2.3")
        XCTAssertNil(LocalCameraNetwork.pairingPayload(addresses: ["127.0.0.1"], key: "ABCDEFGH"))
        XCTAssertNil(LocalCameraNetwork.pairingPayload(addresses: ["192.168.1.2"], key: "invalid"))
    }
    func testBonjourIdentityIsStableAndContainsNoSessionKey() throws {
        let suite = "nivra-test-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = LocalCameraNetwork.serviceName(defaults: defaults)
        XCTAssertEqual(first, LocalCameraNetwork.serviceName(defaults: defaults))
        XCTAssertNotNil(first.range(of: "^NIVRA-[0-9a-f]{12}$", options: .regularExpression))
    }
}


final class LocalFramePacerTests: XCTestCase {
    func testThirtyHzSensorProducesTwentyCurrentFramesPerSecond() {
        var pacing = LocalFramePacer()
        let accepted = (0..<30).filter { pacing.admit(Double($0) / 30) }
        XCTAssertEqual(accepted.count, 20)
    }
    func testStallsDoNotCreateCatchupBacklogOrAcceptInvalidTimes() {
        var pacing = LocalFramePacer()
        XCTAssertFalse(pacing.admit(.nan))
        XCTAssertFalse(pacing.admit(-1))
        XCTAssertTrue(pacing.admit(0))
        XCTAssertFalse(pacing.admit(0.01))
        XCTAssertTrue(pacing.admit(1))
        XCTAssertFalse(pacing.admit(1.001))
        XCTAssertTrue(pacing.admit(1.05))
    }
}


final class LocalMacPairingTests: XCTestCase {
    private let token = String(repeating: "a", count: 43)
    func testAcceptsPrivateMacQRAndKeepsFallbackAddressesBounded() throws {
        let pairing = try XCTUnwrap(LocalMacPairing.parse("nivra://local-camera?host=192.168.1.2&hosts=192.168.1.2,172.20.10.1&port=8871#pair=\(token)"))
        XCTAssertEqual(pairing.hosts, ["192.168.1.2", "172.20.10.1"])
        XCTAssertEqual(pairing.token, token)
        XCTAssertNotNil(LocalMacPairing.parse("nivra://local-camera?host=10.0.0.2&port=8871#pair=\(token)"))
        XCTAssertNil(pairingURL("nivra://local-camera?host=10.0.0.2&port=8871#pair=\(token)"))
    }
    func testRejectsWrongPortsKindsCredentialsPublicIPsAndAmbiguousFields() {
        let base = "nivra://local-camera?host=192.168.1.2&port=8871#pair=\(token)"
        for value in [
            base.replacingOccurrences(of: "8871", with: "8870"),
            base.replacingOccurrences(of: "local-camera?", with: "local-camera/path?"),
            base.replacingOccurrences(of: "local-camera?", with: "user@local-camera?"),
            base.replacingOccurrences(of: "local-camera?", with: "local-camera:8871?"),
            base.replacingOccurrences(of: "192.168.1.2", with: "127.0.0.1"),
            base.replacingOccurrences(of: "192.168.1.2", with: "169.254.1.2"),
            base.replacingOccurrences(of: "192.168.1.2", with: "8.8.8.8"),
            base.replacingOccurrences(of: "192.168.1.2", with: "192.168.001.2"),
            base.replacingOccurrences(of: "&port=", with: "&host=10.0.0.1&port="),
            base.replacingOccurrences(of: "&port=", with: "&unknown=true&port="),
            base.replacingOccurrences(of: "&port=", with: "&hosts=10.0.0.2,8.8.8.8&port="),
            base.replacingOccurrences(of: "&port=", with: "&hosts=&port="),
            base.replacingOccurrences(of: "#pair=", with: "#other="),
            base + "&pair=second", base + "a"
        ] { XCTAssertNil(LocalMacPairing.parse(value), value) }
    }
}


final class LocalMacPairingFailureTests: XCTestCase {
    func testExplicitLocalNetworkPrivacyDenialIsActionable() {
        let denied = NSError(domain: NSURLErrorDomain, code: URLError.notConnectedToInternet.rawValue,
            userInfo: ["_NSURLErrorNWPathKey": "unsatisfied (Local network prohibited)"])
        XCTAssertEqual(LocalMacPairingFailure.classify(denied), .localNetworkDenied)
        XCTAssertTrue(LocalMacPairingFailure.classify(denied).localizedDescription.contains("Settings"))
        let nested = NSError(domain: "outer", code: 1, userInfo: [NSUnderlyingErrorKey: denied])
        XCTAssertEqual(LocalMacPairingFailure.classify(nested), .localNetworkDenied)
    }
    func testOfflineAloneIsNotMisreportedAsPermissionDenial() {
        XCTAssertEqual(LocalMacPairingFailure.classify(URLError(.notConnectedToInternet)), .macUnavailable)
        XCTAssertEqual(LocalMacPairingFailure.classify(URLError(.cannotConnectToHost)), .macUnavailable)
        XCTAssertEqual(LocalMacPairingFailure.classify(URLError(.timedOut)), .timeout)
        XCTAssertEqual(LocalMacPairingFailure.classify(URLError(.appTransportSecurityRequiresSecureConnection)), .transportBlocked)
        XCTAssertEqual(LocalMacPairingFailure.classify(LocalMacPairingFailure.expiredInvite), .expiredInvite)
    }
}


final class NativeCaptureIntentTests: XCTestCase {
    func testTemporaryBackgroundPauseResumesSameCaptureIntent() {
        var intent = NativeCaptureIntent()
        XCTAssertFalse(intent.shouldCapture)
        intent.requested = true
        XCTAssertTrue(intent.shouldCapture)
        intent.foreground = false; intent.paused = true
        XCTAssertFalse(intent.shouldCapture)
        XCTAssertFalse(intent.mayResume)
        XCTAssertTrue(intent.requested)
        intent.foreground = true
        XCTAssertTrue(intent.mayResume)
        XCTAssertFalse(intent.shouldCapture)
        intent.paused = false
        XCTAssertTrue(intent.shouldCapture)
    }
    func testInterruptionEndingInBackgroundCannotStartCamera() {
        var intent = NativeCaptureIntent(requested: true)
        intent.interrupted = true
        XCTAssertFalse(intent.shouldCapture)
        intent.foreground = false
        intent.interrupted = false
        XCTAssertFalse(intent.shouldCapture)
        intent.foreground = true
        XCTAssertTrue(intent.shouldCapture)
    }
    func testExplicitStopDuringPauseCannotBeUndoneByForegroundOrInterruptionEnd() {
        var intent = NativeCaptureIntent(requested: true, foreground: false, interrupted: true)
        intent.requested = false
        intent.foreground = true
        intent.interrupted = false
        XCTAssertFalse(intent.shouldCapture)
    }
}
