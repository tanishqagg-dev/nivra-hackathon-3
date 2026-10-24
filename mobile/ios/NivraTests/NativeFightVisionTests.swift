import XCTest
import CoreML
import CoreMedia
import CoreVideo
@testable import Nivra

final class NativeFightVisionTests: XCTestCase {
    private func sample(_ timestamp: Double) throws -> CMSampleBuffer {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 224, 224, kCVPixelFormatType_32BGRA, nil, &buffer), kCVReturnSuccess)
        let image = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(image, [])
        let pointer = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self)
        for row in 0..<224 { for col in 0..<224 {
            let offset = row*CVPixelBufferGetBytesPerRow(image)+col*4
            pointer[offset] = 30; pointer[offset+1] = 20; pointer[offset+2] = 10; pointer[offset+3] = 255
        } }
        CVPixelBufferUnlockBaseAddress(image, [])
        var description: CMVideoFormatDescription?
        XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &description), noErr)
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 20), presentationTimeStamp: CMTime(seconds: timestamp/1000, preferredTimescale: 1000), decodeTimeStamp: .invalid)
        var result: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: try XCTUnwrap(description), sampleTiming: &timing, sampleBufferOut: &result), noErr)
        return try XCTUnwrap(result)
    }

    func testWindowRequiresRealSpanAndUniqueSamplesAndSamplesSourceTime() throws {
        let rgb = [UInt8](repeating: 127, count: 224*224*3)
        let frames = stride(from: 0, through: 4000, by: 200).map { NativeFightFrame(timestampMs: Double($0), rgb: rgb) }
        XCTAssertNil(NativeFightVision.window(Array(frames.prefix(19))))
        let selected = try XCTUnwrap(NativeFightVision.window(frames))
        XCTAssertEqual(selected.count, 16)
        XCTAssertEqual(selected.first?.timestampMs, 0)
        XCTAssertEqual(selected.last?.timestampMs, 4000)
        XCTAssertEqual(Set(selected.map(\.timestampMs)).count, 16)
        XCTAssertNil(NativeFightVision.window(Array(repeating: frames[0], count: 20)))
        XCTAssertNil(NativeFightVision.window([frames.first!,frames.last!]))
    }

    func testC01FractionalTimestampsRetainBoundaryFrameAndCadence() throws {
        let rgb = [UInt8](repeating: 127, count: 224*224*3)
        // Actual AVFoundation C01 source times. Binary rounding formerly dropped
        // the first frame and skipped a prediction only fractions of a ns early.
        let first = 532.6666666666666
        let end = 4532.666666666667
        let frames = (0...20).map { NativeFightFrame(timestampMs: first+Double($0)*200, rgb: rgb) }
        let selected = try XCTUnwrap(NativeFightVision.window(frames))
        XCTAssertEqual(selected.first?.timestampMs, first)
        XCTAssertEqual(selected.last?.timestampMs, end)
        XCTAssertTrue(NativeFightVision.intervalElapsed(4799.333333333333, since: 4399.333333333334, minimum: 400))
        XCTAssertTrue(NativeFightVision.intervalElapsed(799.3333333333333, since: 599.3333333333334, minimum: 200))
        XCTAssertTrue(NativeFightVision.intervalElapsed(4332.666666666666, since: first, minimum: 3800))
        XCTAssertFalse(NativeFightVision.intervalElapsed(399.99, since: 0, minimum: 400))
        XCTAssertFalse(NativeFightVision.intervalElapsed(199.99, since: 0, minimum: 200))
        XCTAssertFalse(NativeFightVision.intervalElapsed(3799.99, since: 0, minimum: 3800))
        // 0.01ms beyond retention is still excluded, so stale input cannot use
        // the tolerance to extend the actual four-second evidence window.
        let stale = NativeFightFrame(timestampMs: -0.01+first, rgb: rgb)
        let bounded = try XCTUnwrap(NativeFightVision.window([stale]+frames))
        XCTAssertEqual(bounded.first?.timestampMs, first)
    }

    func testRGBOrderAndNCTHWTensorMatchOriginalModelInput() throws {
        let image = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample(1000)))
        let rgb = try NativeFightVision.rgb224(image)
        XCTAssertEqual(Array(rgb.prefix(3)), [10,20,30])
        XCTAssertEqual(Array(rgb.suffix(3)), [10,20,30])
        var frames = Array(repeating: rgb, count: 16)
        frames[15][0] = 99
        let tensor = try NativeFightVision.tensor(frames)
        XCTAssertEqual(tensor.shape.map(\.intValue), [1,3,16,224,224])
        XCTAssertEqual(tensor[[0,0,0,0,0] as [NSNumber]].floatValue, 10)
        XCTAssertEqual(tensor[[0,1,0,0,0] as [NSNumber]].floatValue, 20)
        XCTAssertEqual(tensor[[0,2,0,0,0] as [NSNumber]].floatValue, 30)
        XCTAssertEqual(tensor[[0,0,15,0,0] as [NSNumber]].floatValue, 99)
    }

    func testCompiledTrainedModelMatchesPythonGrayGoldenScores() throws {
        let predictor = try NativeFightVision.loadModel()
        let rgb = [UInt8](repeating: 127, count: 224*224*3)
        let input = try NativeFightVision.tensor(Array(repeating: rgb, count: 16))
        let result = try predictor(input)
        // Original checkpoint, same RGB127 input, /255 then (.45,.225).
        XCTAssertEqual(result.modelScore, 0.35407623648643494, accuracy: 0.0001)
        XCTAssertEqual(result.publisherScore, 0.42755162715911865, accuracy: 0.0001)
    }

    func testActualNV12CaptureFormatConvertsObservedPixelsToRGB() throws {
        var image: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault,224,224,kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            [kCVPixelBufferIOSurfacePropertiesKey:[:]] as CFDictionary,&image),kCVReturnSuccess)
        let buffer = try XCTUnwrap(image)
        CVPixelBufferLockBaseAddress(buffer,[])
        for plane in 0..<2 {
            let pointer = try XCTUnwrap(CVPixelBufferGetBaseAddressOfPlane(buffer,plane))
            memset(pointer,plane == 0 ? 127 : 128,CVPixelBufferGetBytesPerRowOfPlane(buffer,plane)*CVPixelBufferGetHeightOfPlane(buffer,plane))
        }
        CVPixelBufferUnlockBaseAddress(buffer,[])
        let rgb = try NativeFightVision.rgb224(buffer)
        XCTAssertEqual(rgb.count,224*224*3)
        XCTAssertTrue(rgb.allSatisfy { abs(Int($0)-127)<=2 })
        let predict = try NativeFightVision.loadModel()
        let reference = try predict(NativeFightVision.tensor(Array(repeating:[UInt8](repeating:127,count:224*224*3),count:16)))
        let nv12 = try predict(NativeFightVision.tensor(Array(repeating:rgb,count:16)))
        XCTAssertEqual(nv12.modelScore,reference.modelScore,accuracy:0.0001)
        XCTAssertEqual(nv12.publisherScore,reference.publisherScore,accuracy:0.0001)
    }

    func testWarmupDoesNotBlockCaptureAndStopSuppressesLateStatus() throws {
        let entered = expectation(description: "warmup running")
        let late = expectation(description: "no status after stop");late.isInverted = true
        let gate = DispatchSemaphore(value: 0)
        let vision = NativeFightVision(loader: {
            return { _ in entered.fulfill();_ = gate.wait(timeout: .now()+2);return (0.3,0.4) }
        },onReport: { _ in XCTFail("No window") },onStatus: { value in if value.state == "ready" { late.fulfill() } })
        vision.start(session: "first")
        wait(for: [entered], timeout: 2)
        XCTAssertFalse(vision.append(try sample(1000),session: "first"))
        vision.stop();gate.signal()
        XCTAssertFalse(vision.append(try sample(2000),session: "first"))
        wait(for: [late], timeout: 0.2)
    }

    func testReportUsesSourceWindowAndDoesNotInventFightDecision() throws {
        let report = NativeFightReport(timestampMs: 5000, windowStartMs: 1000, windowEndMs: 5000,
            uniqueFrames: 16, inferenceMs: 100, publisherScore: 0.5, modelScore: 0.5, windowReady: true)
        let encoded = try JSONEncoder().encode(report)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(json["type"] as? String,"native-fight-v1")
        XCTAssertEqual(json["model"] as? String,"nivra-x3d-rwf2000-v1")
        XCTAssertNil(json["events"]);XCTAssertNil(json["poses"])
        XCTAssertEqual(try JSONDecoder().decode(NativeFightReport.self,from:encoded).timestampMs,5000)
    }

    func testActualAppendPipelineReportsOnlyObservedSourceWindow() throws {
        let ready = expectation(description: "ready after background warmup")
        let result = expectation(description: "actual source window processed")
        result.assertForOverFulfill = true
        let vision = NativeFightVision(loader: { return { _ in (0.25,0.37754067) } },onReport: { report in
            XCTAssertEqual(report.timestampMs,3800)
            XCTAssertEqual(report.windowStartMs,0)
            XCTAssertEqual(report.windowEndMs,3800)
            XCTAssertEqual(report.uniqueFrames,16)
            XCTAssertEqual(report.modelScore,0.25)
            XCTAssertEqual(report.publisherScore,0.37754067)
            XCTAssertTrue(report.windowReady)
            result.fulfill()
        },onStatus: { if $0.state == "ready" { ready.fulfill() } })
        vision.start(session:"source")
        wait(for:[ready],timeout:3)
        XCTAssertFalse(vision.append(try sample(0),session:"other"))
        for index in 0...19 {
            let source = try sample(Double(index*200))
            let deadline = ProcessInfo.processInfo.systemUptime+1
            var accepted = vision.append(source,session:"source")
            while !accepted && ProcessInfo.processInfo.systemUptime<deadline {
                Thread.sleep(forTimeInterval:0.001)
                accepted = vision.append(source,session:"source")
            }
            XCTAssertTrue(accepted)
        }
        wait(for:[result],timeout:3)
        vision.stop()
    }

    func testLoadFailureReportsErrorAndNeverClaimsReadyOrProducesScores() throws {
        let error = expectation(description:"honest model error")
        let vision = NativeFightVision(loader:{ throw NativeFightVision.Failure.missingModel },
            onReport:{ _ in XCTFail("No model can produce a report") },onStatus:{ status in
                XCTAssertNotEqual(status.state,"ready")
                if status.state == "error" { error.fulfill() }
            })
        vision.start(session:"unavailable")
        wait(for:[error],timeout:2)
        XCTAssertFalse(vision.append(try sample(1000),session:"unavailable"))
        vision.stop()
    }
}
