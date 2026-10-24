import UIKit
import WebKit

/// Web の「ダウンロード」(書き出した動画・NMEA・CSV・.bon4 など。<a download> と blob:) を受け取る (2026-10-20)。
/// WKWebView はそのままではダウンロードを受け取らない (何も起きない) ので、ここで受け取り、
/// 書類のフォルダの Downloads/ に置いてから共有の画面を出す (「ファイル」に保存・写真に保存・AirDrop など)。
/// Downloads/ は「ファイル」アプリの このiPhone内 → このアプリ からも見えるので、共有の画面を閉じてもファイルは残る。
/// ふつうのページの移動は、今までどおり通す。
/// あわせて、Web の alert / confirm / prompt を iPhone の確認の画面で出す (WKWebView はそのままでは出さず、confirm は「いいえ」になる)
@MainActor
final class WebDownloads: NSObject, WKNavigationDelegate, WKDownloadDelegate, WKUIDelegate {
    private let system: SystemModule
    /// 受け取り中のファイルの置き場所 (ダウンロードごと)
    private var destinations: [ObjectIdentifier: URL] = [:]

    init(system: SystemModule) {
        self.system = system
    }

    static var directory: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: - 移動かダウンロードか

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        // <a download> で押されたものは、ダウンロードとして受け取る
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download, preferences)
            return
        }
        // アプリの画面 (laploupe://app/) から、ほかのページへ移らない。リンクの先は Safari で開く
        // (ほかのページがアプリの中で開くと、ネイティブの窓口 (保管場所・Bluetooth・課金) を使えてしまうため)
        let url = navigationAction.request.url
        let isMain = navigationAction.targetFrame?.isMainFrame ?? true
        let scheme = url?.scheme ?? ""
        if isMain, !WebSource.isAppPage(url), !["about", "blob", "data"].contains(scheme) {
            if let url, ["http", "https", "mailto"].contains(scheme) { UIApplication.shared.open(url) }
            decisionHandler(.cancel, preferences)
            return
        }
        decisionHandler(.allow, preferences)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        // 画面に出せない形 (動画のファイル・zip など) は、ダウンロードとして受け取る
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: - 受け取る

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor (URL?) -> Void) {
        let url = Self.uniqueURL(for: suggestedFilename)
        destinations[ObjectIdentifier(download)] = url
        DebugLog.write("download start \(url.lastPathComponent)")
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        DebugLog.write("download done \(url.lastPathComponent) bytes=\(size)")
        system.share(url: url)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let url = destinations.removeValue(forKey: ObjectIdentifier(download))
        DebugLog.write("download failed \(url?.lastPathComponent ?? "-") \(error.localizedDescription)")
        if let url { try? FileManager.default.removeItem(at: url) }
    }

    // MARK: - alert / confirm / prompt

    private func present(_ alert: UIAlertController, or fallback: () -> Void) {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              var top = (scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first)?.rootViewController else {
            fallback()
            return
        }
        while let presented = top.presentedViewController { top = presented }
        top.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, or: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (Bool) -> Void) {
        let ja = Locale.preferredLanguages.first?.hasPrefix("ja") ?? true
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: ja ? "キャンセル" : "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (String?) -> Void) {
        let ja = Locale.preferredLanguages.first?.hasPrefix("ja") ?? true
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: ja ? "キャンセル" : "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert) { completionHandler(nil) }
    }

    /// 同じ名前があれば「名前 2.拡張子」のようにずらす (前に書き出したものを上書きしない)。名前に / などは使わない
    private static func uniqueURL(for suggested: String) -> URL {
        let safe = suggested.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let name = safe.isEmpty ? "download" : safe
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var url = directory.appendingPathComponent(name)
        var i = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = directory.appendingPathComponent(ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)")
            i += 1
        }
        return url
    }
}
