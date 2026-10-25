import Foundation
import WebKit

/// Web とネイティブの間の約束 (src/native/contract.ts) の iPhone 側。
///
/// Web から: `window.webkit.messageHandlers.dsNative.postMessage(JSON の文字列)`
///   {"v": 1, "id": 番号, "method": "ble.scan", "params": {...}}
/// Web へ: `window.dsNative.receive(JSON の文字列)`
///   答え {"id": 番号, "ok": true, "result": {...}} / {"id": 番号, "ok": false, "error": {"code": "...", "message": "..."}}
///   知らせ {"event": "ble.notify", "data": {...}}
///
/// ここには解析・周の判定・機器ごとのデータの読み方を入れない (Android でも同じものを書くことになるため)。
/// 約束を変えるときは contractVersion を上げ、contract.ts と Android 側も同じに直す
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandler {
    static let contractVersion = 1
    static let handlerName = "dsNative"

    private weak var webView: WKWebView?
    private let core = NativeCore.shared
    /// Web のダウンロード (書き出したファイル) を受け取って共有の画面を出す (WebDownloads.swift)。webView は受け手を弱く持つので、ここで持つ
    private var downloads: WebDownloads?
    /// lapfile://run/ の受け手 (WKWebViewConfiguration は受け手を強く持たないことがあるので、ここで持つ)
    let lapFiles = LapFileSchemeHandler()
    let bundledWeb = BundledWebSchemeHandler()

    func attach(to webView: WKWebView) {
        self.webView = webView
        webView.configuration.userContentController.add(self, name: Self.handlerName)
        let downloads = WebDownloads(system: core.system)
        self.downloads = downloads
        webView.navigationDelegate = downloads
        // alert・confirm・prompt を出す (出さないと confirm がいつも「いいえ」になる)
        webView.uiDelegate = downloads
        core.sink = { [weak self] event, data in self?.emit(event, data) }
    }

    // MARK: - Web から

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // アプリの画面 (いちばん外の枠) からの呼び出しだけ受ける (ほかのページ・中の枠から保管場所などを使わせない)
        let origin = message.frameInfo.securityOrigin
        let originURL = URL(string: "\(origin.protocol)://\(origin.host)\(origin.port > 0 ? ":\(origin.port)" : "")/")
        guard message.frameInfo.isMainFrame, WebSource.isAppPage(originURL) else {
            NSLog("[native] アプリの画面でないところからの呼び出しを断った: \(origin.protocol)://\(origin.host)")
            return
        }
        guard let text = message.body as? String,
              let data = text.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = req["id"] as? Int,
              let method = req["method"] as? String else {
            NSLog("[native] 読めない呼び出し: \(message.body)")
            return
        }
        guard (req["v"] as? Int) == Self.contractVersion else {
            reply(id: id, error: NativeError(.notSupported, "contract version \(req["v"] ?? "?")"))
            return
        }
        let params = req["params"] as? [String: Any] ?? [:]
        let done: (Result<[String: Any], NativeError>) -> Void = { [weak self] result in
            switch result {
            case .success(let value): self?.reply(id: id, result: value)
            case .failure(let error): self?.reply(id: id, error: error)
            }
        }
        switch method {
        case "caps.get":
            done(.success([
                "contractVersion": Self.contractVersion,
                "platform": "ios",
                "deviceKind": DeviceKind.current,
                "features": ["ble": true, "iap": true, "camera": true]
            ]))
        case let m where m.hasPrefix("ble.") || m.hasPrefix("recorder."):
            core.ble.handle(method: m, params: params, done: done)
        case let m where m.hasPrefix("system."):
            core.system.handle(method: m, params: params, done: done)
        case let m where m.hasPrefix("iap."):
            core.iap.handle(method: m, params: params, done: done)
        case let m where m.hasPrefix("camera."):
            core.camera.handle(method: m, params: params, done: done)
        default:
            done(.failure(NativeError(.notSupported, "unknown method \(method)")))
        }
    }

    // MARK: - Web へ

    func emit(_ event: String, _ data: [String: Any]) {
        send(["event": event, "data": data])
    }

    private func reply(id: Int, result: [String: Any]) {
        send(["id": id, "ok": true, "result": result])
    }

    private func reply(id: Int, error: NativeError) {
        send(["id": id, "ok": false, "error": ["code": error.code.rawValue, "message": error.message]])
    }

    private func send(_ message: [String: Any]) {
        // JSON にできないもの (NaN・無限大など) が混ざっていたら送らない (JSONSerialization は例外を投げてアプリが落ちるため)
        guard JSONSerialization.isValidJSONObject(message) else {
            DebugLog.write("bridge: dropped a message that is not valid JSON: \(message["event"] ?? message["id"] ?? "?")")
            // 答え (id のあるもの) は、捨てずにエラーの答えにする (捨てると、Web が答えを待ち続ける)
            if let id = message["id"] { send(["id": id, "ok": false, "error": ["code": "io", "message": "reply could not be encoded"]]) }
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let json = String(data: data, encoding: .utf8),
              // JSON の文字列を、JavaScript の文字列の値として渡す (中身をそのまま実行しない)
              let literalData = try? JSONSerialization.data(withJSONObject: json, options: .fragmentsAllowed),
              let literal = String(data: literalData, encoding: .utf8) else { return }
        let script = "window.dsNative && window.dsNative.receive(\(literal))"
        webView?.evaluateJavaScript(script)
    }
}

/// 約束のエラーの符号 (contract.ts の NativeErrorCode と同じ)
struct NativeError: Error {
    enum Code: String {
        case permissionDenied = "permission-denied"
        case notSupported = "not-supported"
        case notConnected = "not-connected"
        case notFound = "not-found"
        case io
        case busy
    }

    let code: Code
    let message: String

    init(_ code: Code, _ message: String = "") {
        self.code = code
        self.message = message
    }
}

/// 時刻: すべて単調な時計のナノ秒 (mach_absolute_time と同じ時計。カメラのコマ・CoreMotion の時刻と並べられる)
enum MonoClock {
    static func nowNs() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    }
}

@MainActor
enum DeviceKind {
    static var current: String {
        // 折りたたみの端末を見分ける方法は、実機が出てから足す (docs/iphone_app_design.md の 3)
        UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"
    }
}
