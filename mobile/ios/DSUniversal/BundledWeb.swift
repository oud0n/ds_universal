import Foundation
import WebKit

/// アプリに入れた Web (dist) を laploupe://app/ で返す (docs/ios_native_study.md の P1b)。
/// 起動のたびに GitHub Pages から読まないので、電波のない所でも起動でき、審査を通った版の画面がそのまま動く
final class BundledWebSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "laploupe"
    static let startURL = URL(string: "laploupe://app/index.html")!

    /// アプリに入れた Web の置き場 (作るときに dist をそのまま入れる。project.yml)
    static var root: URL? {
        Bundle.main.url(forResource: "dist", withExtension: nil)
    }

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json",
        "map": "application/json",
        "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "ico": "image/x-icon",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "ttf": "font/ttf",
        "wasm": "application/wasm",
        "txt": "text/plain; charset=utf-8",
        "xml": "application/xml",
        "cln": "text/plain; charset=utf-8",
        "sci": "text/plain; charset=utf-8",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app", let root = Self.root?.standardizedFileURL else {
            return fail(task, 404)
        }
        var path = url.path
        // 前の読み込み元の保存を写すときに開く、空のページ (WebMigration.swift)
        if path == "/__migrate.html" {
            let html = Data("<!doctype html><meta charset=utf-8><title>migrate</title>".utf8)
            return send(task, url, html, Self.types["html"]!)
        }
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        // 置き場の外 (../ など) は返さない
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            return fail(task, 404)
        }
        send(task, url, data, Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream")
    }

    private func send(_ task: WKURLSchemeTask, _ url: URL, _ data: Data, _ type: String) {
        let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            return fail(task, 500)
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, _ status: Int) {
        guard let url = task.request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0"]) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(response)
        task.didReceive(Data())
        task.didFinish()
    }
}
