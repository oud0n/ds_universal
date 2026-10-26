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

    func makeUIView(context: Context) -> WebHost {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // 走行の置き場の動画・ログを lapfile://run/ で読む (RunFiles.swift)
        config.setURLSchemeHandler(context.coordinator.lapFiles, forURLScheme: RunFiles.scheme)
        // アプリに入れた Web を laploupe://app/ で返す (BundledWeb.swift)
        config.setURLSchemeHandler(context.coordinator.bundledWeb, forURLScheme: BundledWebSchemeHandler.scheme)
        // 画面のピンチでの拡大・縮小を止める (アプリの中だけ。地図・グラフの 2 本指の拡大は、画面の側で処理するので使える)。
        // ブラウザ版は、見えにくい人が拡大できるよう止めない
        let noZoom = WKUserScript(source: """
            (function () {
              var m = document.querySelector('meta[name=viewport]');
              if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
              m.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no';
            })();
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        config.userContentController.addUserScript(noZoom)
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.isInspectable = true
        context.coordinator.attach(to: webView)
        // 入口のページは、起動のたびに取り直す (GitHub Pages は 10 分覚えさせるので、出し直した版が起動し直しても出ないことがあった)。
        // 中で読む JS・CSS は名前に版が入っているので、これまでどおり覚えたものを使う
        let start = WebSource.startURL
        if start == BundledWebSchemeHandler.startURL {
            // アプリに入れた Web を初めて開くときは、前の読み込み元の保存を先に写してから開く (WebMigration.swift)
            let migration = WebMigration(schemeHandler: context.coordinator.bundledWeb)
            Task { @MainActor in
                // 写すのに時間がかかっても (大きなラップタイマーの控えなど)、15 秒で画面を開く (写すのは裏で続け、終わらなければ次に起動したときにもう一度)
                var opened = false
                let open = { if !opened { opened = true; webView.load(URLRequest(url: start)) } }
                DispatchQueue.main.asyncAfter(deadline: .now() + 15) { open() }
                let copied = await migration.runIfNeeded()
                // 15 秒で先に開いたあとで写し終えたときは、写したもの (設定・自分のコースなど) を読むよう開き直す
                if opened && copied { webView.reload() } else { open() }
            }
        } else {
            webView.load(URLRequest(url: start, cachePolicy: .reloadIgnoringLocalCacheData))
        }
        return WebHost(webView: webView)
    }

    func updateUIView(_ host: WebHost, context: Context) {}
}

/// Web の画面を置く枠。ふつうは画面いっぱい (端の避ける幅は、Web の側で env(safe-area-inset-*) を見て避ける)。
/// 左右で避ける幅が違うとき (折りたたみの iPhone は、時計・電波の帯が右上に縦に並ぶ) だけ、Web をその幅だけ内側に置く
/// (画面いっぱいに重なる画面の右上のボタンが、帯の下に隠れて押せなかった。iPhone の横向きは左右同じ幅なので、今までどおり)
final class WebHost: UIView {
    let webView: WKWebView

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 0x0f / 255, green: 0x11 / 255, blue: 0x17 / 255, alpha: 1)
        addSubview(webView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let inset = safeAreaInsets
        let uneven = abs(inset.left - inset.right) > 1
        webView.frame = uneven ? bounds.inset(by: UIEdgeInsets(top: 0, left: inset.left, bottom: 0, right: inset.right)) : bounds
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }
}

enum WebSource {
    /// 読み込む Web。開発中は Info.plist の DSWebURL (Mac の開発サーバー・試験版のページ) を読む。
    /// 空なら、アプリに入れたビルド (dist) を laploupe://app/ で読む (電波がなくても起動できる)。入れ忘れたときだけ公開版のページを読む
    static var startURL: URL {
        if let text = Bundle.main.object(forInfoDictionaryKey: "DSWebURL") as? String, let url = URL(string: text), !text.isEmpty {
            return url
        }
        if let root = BundledWebSchemeHandler.root, FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) {
            return BundledWebSchemeHandler.startURL
        }
        return URL(string: "https://oud0n.github.io/ds_universal/")!
    }

    /// アプリの画面として開いてよいページか (アプリに入れた Web と、開発中に読む DSWebURL のページ)。
    /// ほかのページ (リンクの先など) はアプリの中で開かず、Safari で開く。ネイティブの窓口も、このページからの呼び出しだけ受ける
    static func isAppPage(_ url: URL?) -> Bool {
        guard let url else { return false }
        if url.scheme == BundledWebSchemeHandler.scheme { return true }
        let start = startURL
        return url.scheme == start.scheme && url.host == start.host && url.port == start.port
    }
}
