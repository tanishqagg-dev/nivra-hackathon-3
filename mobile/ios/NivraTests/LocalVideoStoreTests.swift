import XCTest
@testable import Nivra

final class LocalVideoStoreTests: XCTestCase {
    private let config = Data([1, 100, 0, 31, 255, 225, 0])
    private func packet(_ store: LocalVideoStore, after: UInt64? = nil, session: String = "key") throws -> [String: Any] {
        let data = try XCTUnwrap(store.response(after: after, session: session))
        XCTAssertLessThanOrEqual(data.count, 3_000_000)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private func put(_ store: LocalVideoStore, _ generation: String, _ time: Double, keyframe: Bool, size: Int = 32) {
        store.append(data: Data(repeating: 3, count: size), timestampMs: time, keyframe: keyframe, codec: "avc1.64001f", description: config,
            width: 1280, height: 720, session: "key", generation: generation)
    }
    func testConfigTimestampIncrementalCursorAndMissingCursorIDRRecovery() throws {
        let store = LocalVideoStore(), generation = store.reset(session: "key")
        put(store, generation, 10, keyframe: false)
        XCTAssertNil(store.response(after: nil, session: "key"))
        put(store, generation, 20, keyframe: true)
        put(store, generation, 45, keyframe: false)
        put(store, generation, 70, keyframe: true)
        put(store, generation, 95, keyframe: false)
        let initial = try packet(store)
        XCTAssertEqual(initial["codec"] as? String, "avc1.64001f")
        XCTAssertEqual(initial["description"] as? String, config.base64EncodedString())
        XCTAssertEqual(initial["generation"] as? String, generation)
        let frames = try XCTUnwrap(initial["frames"] as? [[String: Any]])
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames.first?["timestampMs"] as? Double, 70)
        XCTAssertEqual(frames.first?["keyframe"] as? Bool, true)
        let next = try XCTUnwrap(try packet(store, after: 3)["frames"] as? [[String: Any]])
        XCTAssertEqual(next.count, 1)
        XCTAssertEqual(next[0]["timestampMs"] as? Double, 95)
        XCTAssertNil(store.response(after: 4, session: "key"))
        XCTAssertEqual((try packet(store, after: 999)["frames"] as? [[String: Any]])?.count, 2)
    }
    func testWindowRemainsBoundedAndStartsAtDecodableIDR() throws {
        let store = LocalVideoStore(), generation = store.reset(session: "key")
        for index in 0..<200 { put(store, generation, Double(index) * 25, keyframe: index % 40 == 0, size: 30_000) }
        let frames = try XCTUnwrap(try packet(store, after: 1)["frames"] as? [[String: Any]])
        XCTAssertEqual(frames.first?["keyframe"] as? Bool, true)
        let timestamps = frames.compactMap { $0["timestampMs"] as? Double }
        XCTAssertLessThanOrEqual(timestamps.last! - timestamps.first!, 2000)
        let bytes = frames.compactMap { ($0["data"] as? String).flatMap { Data(base64Encoded: $0) } }.reduce(0) { $0 + $1.count }
        XCTAssertLessThanOrEqual(bytes, LocalVideoStore.byteLimit)
    }
    func testResetRejectsOldGenerationEvenWhenSessionKeyIsReusedAndStopRevokesAccess() {
        let store = LocalVideoStore(), old = store.reset(session: "key")
        put(store, old, 10, keyframe: true)
        let current = store.reset(session: "key")
        XCTAssertNotEqual(old, current)
        put(store, old, 20, keyframe: true)
        XCTAssertNil(store.response(after: nil, session: "key"))
        put(store, current, 30, keyframe: true)
        XCTAssertNotNil(store.response(after: nil, session: "key"))
        XCTAssertNil(store.response(after: nil, session: "wrong"))
        store.stop()
        put(store, current, 40, keyframe: true)
        XCTAssertNil(store.response(after: nil, session: "key"))
    }
    func testSameSessionRotationPreservesCursorAndNewKeyResetsIt() throws {
        let store = LocalVideoStore(), first = store.reset(session: "key")
        put(store, first, 10, keyframe: true)
        put(store, first, 35, keyframe: false)
        let rotated = store.reset(session: "key")
        put(store, rotated, 60, keyframe: true)
        let frames = try XCTUnwrap(try packet(store, after: 2)["frames"] as? [[String: Any]])
        XCTAssertEqual(frames.first?["sequence"] as? Int, 3)
        XCTAssertEqual(frames.first?["keyframe"] as? Bool, true)
        XCTAssertEqual(try packet(store)["generation"] as? String, rotated)
        let fresh = store.reset(session: "newkey")
        store.append(data: Data([1]), timestampMs: 1, keyframe: true, codec: "avc1.64001f", description: config, width: 720, height: 1280, session: "newkey", generation: fresh)
        let freshFrames = try XCTUnwrap(try packet(store, session: "newkey")["frames"] as? [[String: Any]])
        XCTAssertEqual(freshFrames.first?["sequence"] as? Int, 1)
    }
    func testAVCCConfigurationIncludesActualSPSPPSAndNALLength() throws {
        let sps = Data([0x67, 0x4d, 0x40, 0x1f, 0x80]), pps = Data([0x68, 0xe0])
        let result = try XCTUnwrap(LocalVideoEncoder.configuration(sps: sps, pps: pps, nalLength: 4))
        XCTAssertEqual(result.codec, "avc1.4d401f")
        XCTAssertEqual(result.description, Data([1, 0x4d, 0x40, 0x1f, 0xff, 0xe1, 0, 5]) + sps + Data([1, 0, 2]) + pps)
        XCTAssertNil(LocalVideoEncoder.configuration(sps: Data([1]), pps: pps, nalLength: 4))
        XCTAssertNil(LocalVideoEncoder.configuration(sps: sps, pps: pps, nalLength: 3))
    }

}
