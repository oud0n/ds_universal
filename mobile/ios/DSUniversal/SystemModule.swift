import UIKit

/// 約束の system.* (設定の画面を開く・ファイルを共有する・画面の自動ロックを止める) と、アプリが前に出た・裏に回ったの知らせ
@MainActor
final class SystemModule {
    private unowned let core: NativeCore
    private var observers: [NSObjectProtocol] = []

    init(core: NativeCore) {
        self.core = core
    }

    func handle(method: String, params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        switch method {
        case "system.openSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            done(.success([:]))
        case "system.keepAwake":
            // ラップタイマーを開いている間、画面の自動ロックを止める
            UIApplication.shared.isIdleTimerDisabled = (params["on"] as? Bool) ?? false
            done(.success([:]))
        case "system.shareText":
            // Web で作った文 (変換した CSV など) を一時ファイルにして共有する
            guard let name = params["fileName"] as? String, !name.contains("/"), let text = params["text"] as? String else {
                done(.failure(NativeError(.notFound, "bad params")))
                return
            }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            do {
                try text.write(to: url, atomically: true, encoding: .utf8)
                share(url: url)
                done(.success([:]))
            } catch {
                done(.failure(NativeError(.io, error.localizedDescription)))
            }
        default:
            done(.failure(NativeError(.notSupported, "unknown method \(method)")))
        }
    }

    /// 共有の画面 (AirDrop・「ファイル」に保存・メールなど) を出す
    func share(url: URL) {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              var top = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return }
        while let presented = top.presentedViewController { top = presented }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // iPad では、出す場所を決めないと落ちる
        sheet.popoverPresentationController?.sourceView = top.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
        top.present(sheet, animated: true)
    }

    func startObservingAppState() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.core.webActive = true
                self?.core.emit("system.appState", ["state": "active"])
            }
        })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.core.emit("system.appState", ["state": "background"])
                self?.core.webActive = false
                self?.core.ble.recorder.flush()
            }
        })
    }
}
