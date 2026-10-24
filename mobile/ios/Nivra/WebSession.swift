import SwiftUI
import WebKit
import AVFoundation

@MainActor
final class WebSession: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    @Published var error: String?
    private var resumeNeeded = false
    private let host = "nivra.tanishq.work"
    private func trusted(_ url: URL?) -> Bool { url?.scheme == "https" && trustedWebHosts.contains(url?.host?.lowercased() ?? "") }

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "NIVRA-Native iOS/1.0"
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        let lifecycle = """
        (() => {
          const geo = navigator.geolocation;
          const active = new Set();
          const watch = geo.watchPosition.bind(geo);
          const clear = geo.clearWatch.bind(geo);
          geo.watchPosition = (...args) => { const id = watch(...args); active.add(id); return id; };
          geo.clearWatch = id => { active.delete(id); clear(id); };
          window.nivraPause = () => {
            active.forEach(clear); active.clear();
            document.querySelectorAll('video').forEach(video => {
              video.pause();
              if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
            });
          };
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: lifecycle, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
    }
    func load(_ url: URL) { error = nil; resumeNeeded = false; webView.load(URLRequest(url: url)) }
    func stop() {
        pause()
        resumeNeeded = false
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }
    func pause() {
        guard trusted(webView.url) else { return }
        resumeNeeded = true
        webView.evaluateJavaScript("window.nivraPause?.()", completionHandler: nil)
        webView.setCameraCaptureState(.none, completionHandler: nil)
        webView.setMicrophoneCaptureState(.none, completionHandler: nil)
    }
    func resume() {
        if resumeNeeded { resumeNeeded = false; webView.reload() }
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { error = nil }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError failure: Error) { show(failure) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError failure: Error) { show(failure) }
    private func show(_ failure: Error) {
        if (failure as NSError).code != NSURLErrorCancelled { error = "NIVRA could not load. Check your internet connection and try again." }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { error = "NIVRA stopped responding. Reload to reconnect." }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if url.scheme == "about" || trusted(url) { decisionHandler(.allow); return }
        // tel: links (the guard page's "Call police") go to the system dialer.
        if ["https", "http", "tel"].contains(url.scheme?.lowercased() ?? "") { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["https", "tel"].contains(url.scheme?.lowercased() ?? "") { UIApplication.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // Microphone capture is not a NIVRA feature. Let WebKit prompt for camera consent.
        let allowed = origin.protocol == "https" && origin.host == host && frame.isMainFrame && type == .camera
        decisionHandler(allowed ? .prompt : .deny)
    }
}

struct WebContent: UIViewRepresentable {
    @ObservedObject var session: WebSession
    func makeUIView(context: Context) -> WKWebView { session.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
