import Foundation
import AVFoundation
import CoreML
import Vision

@main struct Evaluation {
 static func main() throws {
  guard CommandLine.arguments.count == 2 else {fatalError("Usage: evaluate-native-clips /path/to/footage/fights/cuts")}
  let footage=URL(fileURLWithPath:CommandLine.arguments[1])
  let root=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
  let package=root.appendingPathComponent("mobile/ios/Models/NivraX3D.mlpackage")
  let compiled=try MLModel.compileModel(at:package)
  let config=MLModelConfiguration();config.computeUnits = .cpuOnly
  let model=try MLModel(contentsOf:compiled,configuration:config)
  let metadata=model.modelDescription.metadata[.creatorDefinedKey] as? [String:String]
  guard metadata?["precision"] == "float32",metadata?["checkpointSHA256"] == "e833f69d110f167cad4a6c38d385564bdb2f6de63d246e45cb03ff9aa17f0349" else {fatalError("Wrong model")}
  var clips:[[String:Any]]=[]
  for name in ["F07","C01"] {
   let url=footage.appendingPathComponent("\(name).mp4")
   let asset=AVURLAsset(url:url);let track=asset.tracks(withMediaType:.video)[0]
   let reader=try AVAssetReader(asset:asset)
   let output=AVAssetReaderTrackOutput(track:track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA]);output.alwaysCopiesSampleData=false
   reader.add(output);guard reader.startReading() else {throw reader.error!}
   // Two fixed grids: actual native cadence, and the predeclared 0.5–4.5s core.
   let targets=Array(Set((0...24).map{Double($0)*200}+(0...20).map{500+Double($0)*200})).sorted()
   var chosen:[Double:(NativeFightFrame,Int,Int)]=[:]
   var previous:CMSampleBuffer?;var index=0
   var captured: [NativeFightFrame] = [];var lastCapture = -Double.infinity
   func save(_ sample:CMSampleBuffer,_ target:Double) throws {
    let timestamp=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))*1000
    let pixel=CMSampleBufferGetImageBuffer(sample)!
    let rgb=try NativeFightVision.rgb224(pixel)
    var people = -1;var poses = -1
    if target >= 3800 {
     let rectangle=VNDetectHumanRectanglesRequest();rectangle.upperBodyOnly=false;rectangle.usesCPUOnly=true
     let body=VNDetectHumanBodyPoseRequest();body.usesCPUOnly=true
     try VNImageRequestHandler(cvPixelBuffer:pixel,orientation:.up).perform([rectangle,body])
     people=(rectangle.results ?? []).filter{$0.confidence>=0.5 && NativePeopleVision.topLeftBox($0.boundingBox) != nil}.prefix(32).count
     poses=try (body.results ?? []).prefix(32).map{observation in NativePeopleVision.mappedPose(try observation.recognizedPoints(.all).mapValues{NativeObservedPoint(x:$0.location.x,y:$0.location.y,confidence:Double($0.confidence))})}.filter{$0.compactMap{$0}.count>=4}.count
    }
    chosen[target]=(NativeFightFrame(timestampMs:timestamp,rgb:rgb),people,poses)
   }
   while let current=output.copyNextSampleBuffer() {
    let now=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(current))*1000
    if now > lastCapture && NativeFightVision.intervalElapsed(now, since:lastCapture, minimum:200) {
     try save(current,now);captured.append(chosen[now]!.0);lastCapture=now
    }
    while index<targets.count && now+0.0001>=targets[index] {
     let target=targets[index]
     if let prior=previous,abs(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(prior))*1000-target)<abs(now-target){try save(prior,target)}else{try save(current,target)}
     index+=1
    }
    previous=current
   }
   if reader.status == .failed {throw reader.error!}
   var windows:[[String:Any]]=[]
   var lastNative = -Double.infinity
   let requests: [(String,Double)] = captured.filter {$0.timestampMs>=3799}.map { ("native",$0.timestampMs) } + [("declared-core",4500.0)]
   for (label,end) in requests {
    var sourceTargets: [Double] = []
    if label == "native" { for i in 0...24 {let t=Double(i)*200.0;if t<=end {sourceTargets.append(t)}} }
    else {for i in 0...20 {sourceTargets.append(500.0+Double(i)*200.0)}}
    let source: [NativeFightFrame] = label == "native" ? captured.filter {$0.timestampMs<=end} : sourceTargets.compactMap{chosen[$0]?.0}
    guard let window=NativeFightVision.window(source) else { continue }
    if label == "native" { guard NativeFightVision.intervalElapsed(window.last!.timestampMs,since:lastNative,minimum:400) else {continue};lastNative=window.last!.timestampMs }
    let tensor=try NativeFightVision.tensor(window.map { $0.rgb });let began=ProcessInfo.processInfo.systemUptime
    let result=try model.prediction(from:MLDictionaryFeatureProvider(dictionary:["frames":tensor]))
    let ms=(ProcessInfo.processInfo.systemUptime-began)*1000
    windows.append(["protocol":label,"nominalEndMs":end,"windowStartMs":window[0].timestampMs,"windowEndMs":window.last!.timestampMs,"uniqueFrames":Set(window.map { $0.timestampMs }).count,"selectedSourceTimestampsMs":window.map { $0.timestampMs },"modelScore":result.featureValue(for:"backboneScores")!.multiArrayValue![1].doubleValue,"publisherScore":result.featureValue(for:"publisherScores")!.multiArrayValue![1].doubleValue,"inferenceMs":ms,"observedPeople":chosen[end]!.1,"posePeople":chosen[end]!.2])
   }
   clips.append(["clip":name,"path":url.path,"label":name == "F07" ? "positive grab/push" : "negative busy hall","videoDurationMs":CMTimeGetSeconds(track.timeRange.duration)*1000,"windows":windows])
   let data=try JSONSerialization.data(withJSONObject:["compute":"CoreML CPU_ONLY + Vision CPU_ONLY","checkpointSHA256":metadata!["checkpointSHA256"]!,"precision":"float32","captureProtocol":"actual decoded source frames admitted at >=200ms from the preceding admitted PTS, with0.001ms roundoff tolerance; no busy-worker timing simulation","clips":clips],options:[.prettyPrinted,.sortedKeys])
   try data.write(to:root.appendingPathComponent("test-results/native-two-clip/raw.json"))
   print("Finished \(name): \(windows.count) windows")
  }
 }
}
