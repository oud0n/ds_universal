import UIKit

/// 約束の system.* (設定の画面を開く) と、アプリが前に出た・裏に回ったの知らせ
@MainActor
final class SystemModule {
    private unowned let bridge: NativeBridge
    private var observers: [NSObjectProtocol] = []

    init(bridge: NativeBridge) {
        self.bridge = bridge
    }

    func handle(method: String, params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        switch method {
        case "system.openSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            done(.success([:]))
        default:
            done(.failure(NativeError(.notSupported, "unknown method \(method)")))
        }
    }

    func startObservingAppState() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.bridge.emit("system.appState", ["state": "active"]) }
        })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.bridge.emit("system.appState", ["state": "background"]) }
        })
    }
}
