import Foundation

@MainActor private func request(_ bridge: NativeBridge, _ web: WKWebView, id: Int, method: String?,
                                session: String? = nil, open: Bool = false, version: Int = 1) {
    var body: [String: Any] = ["v": version, "id": id, "params": [:]]
    body["method"] = method
    body["session"] = session
    if open { body["requestSession"] = true }
    let data = try! JSONSerialization.data(withJSONObject: body)
    bridge.userContentController(web.configuration.userContentController,
                                 didReceive: WKScriptMessage(body: String(decoding: data, as: UTF8.self)))
}

@main enum Check {
    @MainActor static func main() {
        let bridge = NativeBridge(), web = WKWebView()
        let otherBridge = NativeBridge(), otherWeb = WKWebView()
        bridge.attach(to: web)
        otherBridge.attach(to: otherWeb)

        request(bridge, web, id: 1, method: "caps.get")
        precondition(web.sent.last!["session"] == nil && web.sent.last!["ok"] as? Bool == true)
        request(bridge, web, id: 0, method: "caps.get", open: true)
        let first = web.sent.last!["session"] as! String
        request(bridge, web, id: 1, method: "system.closeFiles", session: first)
        request(bridge, web, id: 0, method: "caps.get", open: true)
        let next = web.sent.last!["session"] as! String
        request(otherBridge, otherWeb, id: 0, method: "caps.get", open: true)
        let third = otherWeb.sent.last!["session"] as! String
        precondition(Set([first, next, third]).count == 3)

        // 新しい要求を先に完了させ、同じ id の古い失敗も元の画面の番号で届ける。
        request(bridge, web, id: 1, method: "system.closeFiles", session: next)
        let replies = NativeCore.shared.system.replies
        replies[1](.success(["open": 0]))
        precondition(web.sent.last!["id"] as? Int == 1 && web.sent.last!["session"] as? String == next)
        precondition((web.sent.last!["result"] as? [String: Int])?["open"] == 0)
        replies[0](.failure(NativeError(.io, "failed")))
        precondition(web.sent.last!["session"] as? String == first && web.sent.last!["ok"] as? Bool == false)

        // JSON 化に失敗しても、失敗の応答に同じ番号が入る。
        request(bridge, web, id: 2, method: "system.closeFiles", session: first)
        NativeCore.shared.system.replies[2](.success(["bad": Double.nan]))
        precondition(web.sent.last!["session"] as? String == first && web.sent.last!["ok"] as? Bool == false)
        request(bridge, web, id: 3, method: nil, session: first)
        precondition(web.sent.last!["session"] as? String == first && web.sent.last!["ok"] as? Bool == false)
        request(bridge, web, id: 4, method: "caps.get", session: next, version: 99)
        precondition(web.sent.last!["session"] as? String == next && web.sent.last!["ok"] as? Bool == false)
        precondition(web.configuration.userContentController.registrations == 1)
        // 互いに別の画面の id=1 の成功・失敗、開始応答、知らせ、旧版自身の id=1 の応答を並べる。
        for _ in 0..<2 {
            request(bridge, web, id: 0, method: "caps.get", open: true)
            let sender = web.sent.last!["session"] as! String
            request(bridge, web, id: 1, method: "system.closeFiles", session: sender)
        }
        request(bridge, web, id: 1, method: "system.closeFiles")
        let deliveries = Array(NativeCore.shared.system.replies.suffix(3))
        let start = web.scripts.count
        deliveries[0](.success(["from": "modern"]))
        deliveries[1](.failure(NativeError(.io, "queued error")))
        request(bridge, web, id: 0, method: "caps.get", open: true)
        bridge.emit("system.appState", ["state": "active"])
        deliveries[2](.success(["from": "legacy"]))
        let queued = try! JSONSerialization.data(withJSONObject: Array(web.scripts[start...]))
        try! queued.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
        print("PASS Swift native reply routing")
    }
}
