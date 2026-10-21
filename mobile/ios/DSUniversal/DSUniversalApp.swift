import SwiftUI
import WebKit

/// アプリの外側の枠。中身は WKWebView で動く今の Web (docs/iphone_app_design.md の 2)
@main
struct DSUniversalApp: App {
    /// 起動時に BLE と記録を用意する (OS が裏で起こしたときは、画面は作られない)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            WebContainer()
                .ignoresSafeArea()
        }
    }
}

struct WebContainer: UIViewRepresentable {
    func makeCoordinator() -> NativeBridge {
        NativeBridge()
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // 走行の置き場の動画・ログを lapfile://run/ で読む (RunFiles.swift)
        config.setURLSchemeHandler(context.coordinator.lapFiles, forURLScheme: RunFiles.scheme)
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        context.coordinator.attach(to: webView)
        // 入口のページは、起動のたびに取り直す (GitHub Pages は 10 分覚えさせるので、出し直した版が起動し直しても出ないことがあった)。
        // 中で読む JS・CSS は名前に版が入っているので、これまでどおり覚えたものを使う
        webView.load(URLRequest(url: WebSource.startURL, cachePolicy: .reloadIgnoringLocalCacheData))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}

enum WebSource {
    /// 読み込む Web。開発中は Info.plist の DSWebURL (Mac の開発サーバー、例 http://192.168.1.13:5173/) を読む。
    /// 配る版は、アプリに入れたビルド (dist) を app:// で読む形にする (動画の範囲の読み出しと一緒に作る。進め方の 1)
    static var startURL: URL {
        if let text = Bundle.main.object(forInfoDictionaryKey: "DSWebURL") as? String, let url = URL(string: text), !text.isEmpty {
            return url
        }
        return URL(string: "https://oud0n.github.io/ds_universal/")!
    }
}
