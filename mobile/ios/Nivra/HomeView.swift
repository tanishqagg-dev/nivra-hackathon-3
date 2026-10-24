import SwiftUI
import CoreLocation

struct HomeView: View {
    @StateObject private var session = WebSession()
    @State private var usbCamera = false
    @State private var localPairing: LocalMacPairing?
    @State private var usbMacCode: String?
    @State private var scanner = false
    @State private var cameraAfterScan = false
    @State private var paste = false
    @State private var link = ""
    @State private var issue: String?
    @State private var role: String?
    @Environment(\.scenePhase) private var phase
    @State private var location = CLLocationManager()

    var body: some View {
        VStack(spacing: 0) {
            if let role {
                HStack {
                    Button { session.stop(); self.role = nil; UIApplication.shared.isIdleTimerDisabled = false } label: { Label("Roles", systemImage: "chevron.left") }
                    Spacer()
                    Text(role).font(.headline)
                    Spacer()
                    Button { session.webView.reload() } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Reload NIVRA")
                }.padding(14).background(Color(white: 0.08))
                WebContent(session: session)
                if let error = session.error {
                    VStack(spacing: 10) {
                        Text(error).font(.callout)
                        Button("Try again") { session.webView.reload() }
                    }.padding().background(Color(white: 0.12))
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 26) {
                        Text("NIVRA").font(.system(size: 42, weight: .black)).tracking(7)
                        Text("Connect a camera").font(.title2.weight(.semibold))
                        Button { scanner = true } label: {
                            HStack(spacing: 16) {
                                Image(systemName: "qrcode.viewfinder").font(.title)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Scan to connect").font(.title3.weight(.semibold))
                                    Text("Scan the QR shown on your Mac.").font(.callout)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                            }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain).foregroundStyle(.black).background(.white, in: RoundedRectangle(cornerRadius: 18))
                        Text("Works offline. Keep the phone unlocked and NIVRA open.").font(.footnote).foregroundStyle(.secondary)
                        DisclosureGroup("Other options") {
                        VStack(alignment: .leading, spacing: 18) {
                        Button("Start camera without scanning") { session.stop(); localPairing = nil; usbMacCode = nil; usbCamera = true }
                            .buttonStyle(.bordered).frame(minHeight: 44)
                        Text("Internet roles").font(.headline)
                        VStack(spacing: 1) {
                            ForEach(NivraRole.allCases) { item in
                                Button { open(item.url, title: item.title) } label: {
                                    HStack(spacing: 18) {
                                        Image(systemName: item.symbol).font(.title2).frame(width: 32)
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(item.title).font(.title3.weight(.semibold))
                                            Text(item.detail).font(.callout).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.caption)
                                    }.padding(.vertical, 22).padding(.horizontal, 18).contentShape(Rectangle())
                                }.buttonStyle(.plain).background(Color(white: 0.10))
                            }
                        }.clipShape(RoundedRectangle(cornerRadius: 18))
                        Button { scanner = true } label: { Label("Scan pairing QR", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).padding(16) }.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
                        Button("Paste pairing link") { paste = true }.frame(maxWidth: .infinity)
                        Text("Internet roles connect to nivra.tanishq.work or nivra.aestrum.in/guard. Use the wireless camera above for local video.")
                            .font(.footnote).foregroundStyle(.secondary).lineSpacing(5)
                        }.padding(.top, 16)
                        }
                    }.padding(26)
                }
            }
        }
        .background(Color(white: 0.035))
        .fullScreenCover(isPresented: $usbCamera, onDismiss: { localPairing = nil; usbMacCode = nil }) { USBCameraView(autoStart: true, pairing: localPairing, macCode: usbMacCode, onPairingConsumed: { localPairing = nil }) }
        .sheet(isPresented: $scanner, onDismiss: {
            if cameraAfterScan { cameraAfterScan = false; usbCamera = true }
        }) {
            QRScanner { result in
                switch result {
                case .success(let text): accept(text)
                case .failure(let error): scanner = false; issue = error.localizedDescription
                }
            }.ignoresSafeArea()
        }
        .alert("Paste pairing link", isPresented: $paste) {
            TextField("https://nivra.tanishq.work/…", text: $link).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Connect") { accept(link); link = "" }
            Button("Cancel", role: .cancel) { link = "" }
        } message: { Text("Use the camera, guard, or operator pairing link created for your site.") }
        .alert("Could not connect", isPresented: Binding(get: { issue != nil }, set: { if !$0 { issue = nil } })) { Button("OK") { issue = nil } } message: { Text(issue ?? "") }
        .onOpenURL { accept($0.absoluteString) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { if let url = $0.webpageURL { accept(url.absoluteString) } }
        .onChange(of: phase) { _, next in
            if next == .background { UIApplication.shared.isIdleTimerDisabled = false; session.pause() }
            if next == .active { UIApplication.shared.isIdleTimerDisabled = role != nil || usbCamera; session.resume() }
        }
    }
    private func accept(_ text: String) {
        // nivra://usb?code=XXXXXXXX comes from the Mac over the USB cable: open the camera on that code.
        if let parts = URLComponents(string: text), parts.scheme == "nivra", parts.host == "usb",
           let code = USBFrameStore.validMacCode(parts.queryItems?.first(where: { $0.name == "code" })?.value) {
            session.stop(); role = nil; localPairing = nil; scanner = false
            usbMacCode = code
            UIApplication.shared.isIdleTimerDisabled = true
            usbCamera = true
            return
        }
        if let pairing = LocalMacPairing.parse(text) {
            session.stop(); role = nil; localPairing = pairing
            if scanner { cameraAfterScan = true; scanner = false }
            else { usbCamera = true }
            return
        }
        scanner = false
        guard let url = pairingURL(text) else { issue = "Scan the QR on your Mac, or a NIVRA website pairing QR."; return }
        open(url, title: url.path == "/camera" ? "Camera" : url.path == "/guard" ? "Guard" : "Camera wall")
    }
    private func open(_ url: URL, title: String) {
        usbCamera = false
        if url.path != "/wall" { location.requestWhenInUseAuthorization() }
        role = title
        UIApplication.shared.isIdleTimerDisabled = true
        session.load(url)
    }
}
