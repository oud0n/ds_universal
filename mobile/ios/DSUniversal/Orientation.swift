import UIKit
import CoreMotion

/// ラップタイマーの画面の向き (約束の system.setOrientation)。
///
/// - system: ふつう (端末の回転と、画面の向きのロックに従う)
/// - auto: 傾き (重力の向き) で縦横を決める。画面の向きのロックが入っていても回す (ホルダーに付けた iPhone のため)
/// - portrait / landscape: その向きに固める。横は傾きで左右を選ぶ (逆さにならないように)
/// - hold: 今の向きのまま固める (測っている間。コーナーの横 G で回らないように)
@MainActor
final class OrientationControl {
    static let shared = OrientationControl()

    /// OS に許す向き (AppDelegate の supportedInterfaceOrientationsFor が返す)
    private(set) var mask: UIInterfaceOrientationMask = OrientationControl.defaultMask

    private let motion = CMMotionManager()
    private var mode = "system"
    /// 傾きで選んだ向きの候補と、選び始めた時刻 (揺れで行ったり来たりしないよう、しばらく続いたら回す)
    private var candidate: UIInterfaceOrientation?
    private var candidateSince: TimeInterval = 0
    private static let settleSec: TimeInterval = 0.6

    static var defaultMask: UIInterfaceOrientationMask {
        UIDevice.current.userInterfaceIdiom == .pad ? .all : .allButUpsideDown
    }

    /// 向きの決め方を替える。返すのは今の向き ("portrait" / "landscape")
    func set(mode newMode: String) -> String {
        mode = newMode
        candidate = nil
        switch newMode {
        case "auto":
            // まず今の向きで固め、あとは傾きで回す
            apply(Self.mask(for: currentOrientation()))
            startMotion()
        case "portrait":
            stopMotion()
            apply(.portrait)
        case "landscape":
            // 今が横ならその向き、縦なら今の傾きで左右を選ぶ (左右を OS に任せると、画面の向きのロック中は回らないことがある)。
            // 傾きがまだ読めていなければ右 (上を左に倒した向き)。あとは傾きで左右を選び直す
            let now = currentOrientation()
            let gx = motion.deviceMotion?.gravity.x ?? -1
            apply(Self.mask(for: now.isLandscape ? now : (gx < 0 ? .landscapeRight : .landscapeLeft)))
            startMotion()
        case "hold":
            stopMotion()
            apply(Self.mask(for: currentOrientation()))
        default:
            mode = "system"
            stopMotion()
            // 画面の向きのロックが入っていると、横のまま残るので、一度縦に戻してから向きを任せる。
            // iPad はどの向きでも使うので戻さない (戻すと、タイマーを閉じるたびに縦にされていた。PLAN-29 の (5))
            let phone = UIDevice.current.userInterfaceIdiom == .phone
            apply(Self.defaultMask, request: phone && currentOrientation().isLandscape ? .portrait : nil)
        }
        return currentOrientation().isLandscape ? "landscape" : "portrait"
    }

    // MARK: - 傾き

    private func startMotion() {
        guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
        motion.deviceMotionUpdateInterval = 0.2
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let g = data?.gravity else { return }
            let gx = g.x, gy = g.y, gz = g.z
            MainActor.assumeIsolated { self?.onGravity(x: gx, y: gy, z: gz) }
        }
    }

    private func stopMotion() {
        if motion.isDeviceMotionActive { motion.stopDeviceMotionUpdates() }
    }

    /// 重力の向き (端末の座標。縦に立てると y = -1、上を左に倒すと x = -1) から向きを選ぶ
    private func onGravity(x: Double, y: Double, z: Double) {
        // 平らに置いたときは決めない
        if abs(z) > 0.8 { candidate = nil; return }
        var want: UIInterfaceOrientation?
        // 上を左に倒す (端末の landscapeLeft) と、画面は landscapeRight
        let side: UIInterfaceOrientation = x < 0 ? .landscapeRight : .landscapeLeft
        switch mode {
        case "auto":
            if abs(y) > abs(x) + 0.25, y < 0 { want = .portrait }
            else if abs(x) > abs(y) + 0.25 { want = side }
        case "landscape":
            if abs(x) > 0.4 { want = side }
        default:
            return
        }
        guard let want, want != currentOrientation() else { candidate = nil; return }
        let now = ProcessInfo.processInfo.systemUptime
        if candidate != want {
            candidate = want
            candidateSince = now
            return
        }
        if now - candidateSince >= Self.settleSec {
            candidate = nil
            apply(Self.mask(for: want))
        }
    }

    // MARK: - OS へ

    private static func mask(for o: UIInterfaceOrientation) -> UIInterfaceOrientationMask {
        switch o {
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        case .portraitUpsideDown: return .portraitUpsideDown
        default: return .portrait
        }
    }

    private var scene: UIWindowScene? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    }

    private func currentOrientation() -> UIInterfaceOrientation {
        scene?.effectiveGeometry.interfaceOrientation ?? .portrait
    }

    /// 許す向きを m にし、request (なければ m) の向きへ回すよう OS に頼む
    private func apply(_ m: UIInterfaceOrientationMask, request: UIInterfaceOrientationMask? = nil) {
        mask = m
        guard let scene else { return }
        for w in scene.windows { w.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations() }
        // 失敗の知らせは主スレッドの外で来るので、主スレッドに縛られない閉包にする (縛ると、その確かめで落ちていた)
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: request ?? m)) { @Sendable error in
            DebugLog.write("orientation: \(error.localizedDescription)")
        }
    }
}
