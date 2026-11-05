import Foundation

protocol WKScriptMessageHandler {}
struct Origin {
    let `protocol` = "https"
    let host = "example.local"
    let port = 0
}
struct Frame {
    let securityOrigin = Origin()
    let isMainFrame = true
}
struct WKScriptMessage {
    let frameInfo = Frame()
    let body: Any
}
@MainActor final class WKUserContentController {
    var registrations = 0
    func add(_ handler: NativeBridge, name: String) { registrations += 1 }
}
@MainActor final class Config {
    let userContentController = WKUserContentController()
}
@MainActor final class WKWebView {
    let configuration = Config()
    var navigationDelegate: WebDownloads?
    var uiDelegate: WebDownloads?
    private(set) var sent: [[String: Any]] = []
    private(set) var scripts: [String] = []

    func evaluateJavaScript(_ script: String) {
        scripts.append(script)
        // ここでは応答の中身だけを読む。実際の配送条件は Node.js でこの式をそのまま実行して試す。
        let call = script.range(of: "window.dsNative.receive(")!
        precondition(script.hasSuffix(")"))
        let literal = Data(script[call.upperBound...].dropLast().utf8)
        let json = try! JSONSerialization.jsonObject(with: literal, options: .fragmentsAllowed) as! String
        sent.append(try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any])
    }
}

enum WebSource { static func isAppPage(_ url: URL?) -> Bool { true } }
enum DebugLog { static func write(_ message: String) {} }
enum Idiom { case phone, pad }
struct UIDevice { static let current = UIDevice(); let userInterfaceIdiom = Idiom.phone }
final class LapFileSchemeHandler {}
final class BundledWebSchemeHandler {}
@MainActor final class WebDownloads { init(system: StubModule) {} }

@MainActor final class StubModule {
    typealias Reply = (Result<[String: Any], NativeError>) -> Void
    private(set) var replies: [Reply] = []
    func handle(method: String, params: [String: Any], done: @escaping Reply) {
        replies.append(done)
    }
}
@MainActor final class NativeCore {
    static let shared = NativeCore()
    let system = StubModule(), ble = StubModule(), iap = StubModule(), camera = StubModule()
    var sink: ((String, [String: Any]) -> Void)?
}
