import UIKit

/// ネイティブの機能の本体 (アプリに 1 つ)。画面 (WKWebView) とは別に、アプリの起動時に作る。
///
/// 画面が消えている間に OS がアプリを止め、Bluetooth の通知でアプリを裏で起こし直したときは、画面 (WebView) は作られない。
/// そのときも記録とつなぎを戻せるよう、BLE と記録はここに置き、画面の窓口 (NativeBridge) はあとから知らせの送り先としてつながる
@MainActor
final class NativeCore {
    static let shared = NativeCore()

    private(set) lazy var ble = BleModule(core: self)
    private(set) lazy var system = SystemModule(core: self)

    /// 知らせの送り先 (画面の窓口)。画面がないときは nil で、知らせは捨てる
    var sink: ((String, [String: Any]) -> Void)?

    /// 画面が前に出ているか。裏にいる間は、測位の通知を Web に送らない (WKWebView が止まっていて、たまる一方になるため)
    var webActive = true

    func emit(_ event: String, _ data: [String: Any]) {
        sink?(event, data)
    }

    /// アプリの起動時 (OS が裏で起こしたときも)
    func launch() {
        system.startObservingAppState()
        ble.resumeRecordingIfNeeded()
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // どう起動したか (OS が Bluetooth で裏で起こしたときは bluetoothCentrals が付く)
        let keys = (launchOptions ?? [:]).keys.map(\.rawValue).sorted().joined(separator: ",")
        let centrals = (launchOptions?[.bluetoothCentrals] as? [String])?.joined(separator: ",") ?? "-"
        let state = application.applicationState == .background ? "background" : application.applicationState == .active ? "active" : "inactive"
        DebugLog.write("launch state=\(state) options=[\(keys)] centrals=\(centrals) footprint=\(String(format: "%.0f", DebugLog.footprintMB()))MB")
        MainActor.assumeIsolated { NativeCore.shared.launch() }
        return true
    }

    /// 許す画面の向き (ラップタイマーが固めているときは、その向きだけ。Orientation.swift)
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        MainActor.assumeIsolated { OrientationControl.shared.mask }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        DebugLog.write("willTerminate")
    }

    func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
        DebugLog.write("memoryWarning footprint=\(String(format: "%.0f", DebugLog.footprintMB()))MB state=\(application.applicationState == .background ? "background" : "foreground")")
    }
}
