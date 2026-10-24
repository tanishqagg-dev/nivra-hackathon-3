import SwiftUI
import AVFoundation
import CoreImage.CIFilterBuiltins

private final class USBPreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    var rotationChanged: ((CGFloat) -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        let angle: CGFloat
        switch window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: angle = 0
        case .landscapeRight: angle = 180
        case .portraitUpsideDown: angle = 270
        default: angle = 90
        }
        if let connection = preview.connection, connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        rotationChanged?(angle)
    }
}
private struct USBPreview: UIViewRepresentable {
    let camera: USBOfflineCamera
    func makeUIView(context: Context) -> USBPreviewView {
        let view = USBPreviewView()
        view.preview.session = camera.capture
        view.preview.videoGravity = .resizeAspect
        view.rotationChanged = { [weak camera] angle in camera?.rotate(to: angle) }
        return view
    }
    func updateUIView(_ view: USBPreviewView, context: Context) { view.setNeedsLayout() }
}

struct USBCameraView: View {
    var autoStart = false
    var pairing: LocalMacPairing?
    /// Code chosen by a Mac that launched this app over the USB cable.
    var macCode: String? = nil
    var onPairingConsumed: (() -> Void)?
    @State private var didInitialStart = false
    @StateObject private var camera = USBOfflineCamera()
    @State private var name = "Camera"
    @State private var copied = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if camera.running || camera.starting { USBPreview(camera: camera).ignoresSafeArea() }
            else { Image(systemName: "video").font(.system(size: 64, weight: .ultraLight)).foregroundStyle(.gray) }
        }
        .safeAreaInset(edge: .top) {
            HStack {
                Button { camera.stop(); dismiss() } label: { Label("Done", systemImage: "chevron.left") }
                Spacer()
                Text("Wireless camera").font(.headline)
            }.padding(18).background(.black.opacity(0.85))
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 14) {
                if camera.running {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let connected = camera.lastMacPull.map { context.date.timeIntervalSince($0) < 4 } ?? false
                        Label(connected ? "Video connected" : camera.macConnection.isEmpty ? "Waiting for your Mac" : camera.macConnection, systemImage: connected ? "wifi" : "wifi.slash").font(.subheadline)
                    }
                    if camera.macNeedsSettings { Button("Open Settings") {
                        camera.stop(); onPairingConsumed?(); dismiss()
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }.buttonStyle(.bordered).frame(minHeight: 44) }
                    if camera.macConnectionFailed { Button("Try again") { camera.connectToMac() }.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black) }
                    DisclosureGroup("Connection details") {
                    Text(String(camera.code.prefix(4)) + " " + String(camera.code.suffix(4)))
                        .font(.system(size: 32, weight: .semibold, design: .monospaced)).tracking(3)
                        .accessibilityLabel("Camera connection code: \(camera.code.map(String.init).joined(separator: " "))")
                    TimelineView(.periodic(from: .now, by: 2)) { _ in
                        if let payload = LocalCameraNetwork.pairingPayload(addresses: LocalCameraNetwork.addresses(), key: camera.code), let image = localCameraQR(payload) {
                            Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
                                .frame(width: 136, height: 136).padding(10).background(.white, in: RoundedRectangle(cornerRadius: 10))
                                .accessibilityLabel("Camera connection QR. Scan on your Mac.")
                        } else {
                            Text("Join the same Wi-Fi router as your Mac to show your connection QR.").font(.footnote).multilineTextAlignment(.center)
                        }
                    }
                    Text("Find this camera on your Mac, or scan this QR. Enter the code if asked. Keep this screen open.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    HStack(spacing: 14) {
                        Button(copied ? "Copied" : "Copy code") { UIPasteboard.general.string = camera.code; copied = true }
                            .buttonStyle(.bordered).frame(minHeight: 44)
                        Button("Stop camera") { camera.stop(); onPairingConsumed?(); copied = false }.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black).frame(minHeight: 44)
                    }
                } else if camera.paused {
                    Text(camera.message).font(.callout).multilineTextAlignment(.center)
                    HStack(spacing: 14) {
                        Button("Resume camera") { camera.setForeground(true) }.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
                        Button("Stop camera") { camera.stop(); onPairingConsumed?() }.buttonStyle(.bordered)
                    }.frame(minHeight: 44)
                } else {
                    Text(camera.message).font(.callout).multilineTextAlignment(.center)
                    if !camera.starting {
                        DisclosureGroup("Camera name") {
                            TextField("Camera name", text: $name).textInputAutocapitalization(.words).autocorrectionDisabled()
                                .padding(14).background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 12))
                                .accessibilityLabel("Camera name")
                        }
                        Button { copied = false; camera.start(name: name, pairing: pairing) } label: { Text(camera.message.contains("could") || camera.message.contains("Allow") ? "Try again" : "Start camera").font(.headline).frame(maxWidth: .infinity).padding(14) }
                            .buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
                    } else {
                        Button("Cancel") { camera.stop() }.buttonStyle(.bordered).frame(minHeight: 44)
                    }
                }
            }.padding(20).frame(maxWidth: 560).frame(maxWidth: .infinity).background(.black.opacity(0.9))
        }
        .foregroundStyle(.white)
        .onAppear {
            // The home button explicitly requested capture. Appearance replay
            // must not restart a camera the user has stopped.
            guard autoStart, !didInitialStart else { return }
            didInitialStart = true
            camera.setForeground(phase != .background)
            camera.onPairingConsumed = onPairingConsumed
            camera.start(name: name, pairing: pairing, macCode: macCode)
        }
        .onChange(of: macCode) { _, next in
            // The Mac relaunched us with a new code: restart capture on that code.
            guard let next else { return }
            camera.stop()
            camera.start(name: name, pairing: pairing, macCode: next)
        }
        .onDisappear { camera.stop() }
        .onChange(of: pairing) { _, next in
            if let next {
                if camera.running || camera.starting || camera.paused { camera.pair(with: next) }
                else { camera.start(name: name, pairing: next) }
            }
        }
        .onChange(of: phase) { _, next in
            if next == .background { camera.setForeground(false) }
            else if next == .active { camera.setForeground(true) }
        }
    }
}

private func localCameraQR(_ payload: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(payload.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage,
          let image = CIContext().createCGImage(output.transformed(by: CGAffineTransform(scaleX: 6, y: 6)), from: output.extent.applying(CGAffineTransform(scaleX: 6, y: 6))) else { return nil }
    return UIImage(cgImage: image)
}
