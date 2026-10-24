import XCTest
import CoreVideo
import Vision
@testable import Nivra

final class NativePeopleVisionTests: XCTestCase {
    func testMapsOnlyObservedEquivalentJointsAndFlipsVisionCoordinates() throws {
        let pose = NativePeopleVision.mappedPose([
            .leftShoulder: NativeObservedPoint(x: 0.2, y: 0.8, confidence: 0.9),
            .rightShoulder: NativeObservedPoint(x: 0.4, y: 0.8, confidence: 0.54),
            .leftWrist: NativeObservedPoint(x: .nan, y: 0.5, confidence: 1),
            .rightWrist: NativeObservedPoint(x: 1.1, y: 0.5, confidence: 1),
        ])
        XCTAssertEqual(pose.count, 33)
        let shoulder = try XCTUnwrap(pose[11])
        XCTAssertEqual(shoulder[0], 0.2)
        XCTAssertEqual(shoulder[1], 0.2, accuracy: 0.00001)
        XCTAssertEqual(shoulder[2], 0.9)
        XCTAssertNil(pose[12]); XCTAssertNil(pose[15]); XCTAssertNil(pose[16])
        for index in [1, 3, 4, 6, 9, 10, 17, 18, 19, 20, 21, 22, 29, 30, 31, 32] { XCTAssertNil(pose[index]) }
    }
    func testConvertsRealRegionToTopLeftWithoutInventingABox() throws {
        let box = try XCTUnwrap(NativePeopleVision.topLeftBox(CGRect(x: 0.1, y: 0.2, width: 0.4, height: 0.5)))
        XCTAssertEqual(box[0], 0.1, accuracy: 0.00001)
        XCTAssertEqual(box[1], 0.3, accuracy: 0.00001)
        XCTAssertEqual(box[2], 0.5, accuracy: 0.00001)
        XCTAssertEqual(box[3], 0.8, accuracy: 0.00001)
        XCTAssertNil(NativePeopleVision.topLeftBox(.zero))
        XCTAssertNil(NativePeopleVision.topLeftBox(CGRect(x: -0.1, y: 0, width: 1, height: 1)))
    }
    func testWireEncodingPreservesNullJointsAndDoesNotClaimFightInference() throws {
        let report = NativePeopleReport(timestampMs: 123, inferenceMs: 4, observedPeople: 2, posePeople: 1,
            tracks: [NativePeopleTrack(id: 0, box: [0, 0, 1, 1])], poses: [Array(repeating: nil, count: 33)])
        let encoded = try JSONEncoder().encode(report)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(json["model"] as? String, "apple-vision-body-pose")
        XCTAssertEqual(json["observedPeople"] as? Int, 2)
        XCTAssertEqual(json["posePeople"] as? Int, 1)
        XCTAssertNil(json["conflict"]); XCTAssertNil(json["events"])
        let poses = try XCTUnwrap(json["poses"] as? [[Any]])
        XCTAssertEqual(poses[0].count, 33)
        XCTAssertTrue(poses[0][0] is NSNull)
    }
    func testBusyDetectorDropsFramesAndDisposeSuppressesItsLateResult() throws {
        var pixelBuffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 32, 32, kCVPixelFormatType_32BGRA, nil, &pixelBuffer), kCVReturnSuccess)
        let buffer = try XCTUnwrap(pixelBuffer)
        let entered = expectation(description: "processor running")
        let suppressed = expectation(description: "no callback after disposal"); suppressed.isInverted = true
        let gate = DispatchSemaphore(value: 0)
        let vision = NativePeopleVision(processor: { _, timestamp, _ in
            entered.fulfill(); _ = gate.wait(timeout: .now() + 2)
            return NativePeopleReport(timestampMs: timestamp, inferenceMs: 1, observedPeople: 0, posePeople: 0, tracks: [], poses: [])
        })
        XCTAssertFalse(vision.submit(buffer, timestampMs: .nan) { _ in XCTFail() })
        XCTAssertTrue(vision.submit(buffer, timestampMs: 1) { _ in suppressed.fulfill() })
        wait(for: [entered], timeout: 1)
        XCTAssertFalse(vision.submit(buffer, timestampMs: 2) { _ in XCTFail() })
        vision.dispose(); gate.signal()
        XCTAssertFalse(vision.submit(buffer, timestampMs: 3) { _ in XCTFail() })
        wait(for: [suppressed], timeout: 0.15)
    }
}
