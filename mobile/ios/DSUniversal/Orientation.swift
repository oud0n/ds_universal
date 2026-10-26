import UIKit

/// ラップタイマーの画面の向き (約束の system.setOrientation)。
///
/// - system: ふつう (端末の回転と、画面の向きのロックに従う)
/// - hold: 今の向きのまま固める (測っている間。コーナーの横 G で回らないように)
///
/// 測る前に向きを選ぶ (自動・縦・横) のはやめた。折りたたみの iPhone で、畳んだ画面で固めたまま開くと、
/// 開いた画面が固めた向きのまま入り、開いた画面ではアプリから向きを直せない (OS が断る) ため、戻せなくなっていた。
/// 測っている間の固定は残し、開いたら外す (開いた画面ではどのみち固められない)
@MainActor
final class OrientationControl {
    static let shared = OrientationControl()

    /// OS に許す向き (AppDelegate の supportedInterfaceOrientationsFor が返す)
    private(set) var mask: UIInterfaceOrientationMask = OrientationControl.defaultMask

    private var mode = "system"
    /// 折りたたみの iPhone が開いているか
    private var hingeOpen = false
    private var hingeInteraction: AnyObject?
    private var geometryObservation: NSKeyValueObservation?
    private var lastSize: CGSize = .zero
    private var reapply: DispatchWorkItem?

    static var defaultMask: UIInterfaceOrientationMask {
        UIDevice.current.userInterfaceIdiom == .pad ? .all : .allButUpsideDown
    }

    /// 向きの決め方を替える。返すのは今の向き ("portrait" / "landscape")
    func set(mode newMode: String) -> String {
        mode = newMode == "hold" ? "hold" : "system"
        watchFolding()
        if mode == "hold" && !hingeOpen {
            apply(Self.mask(for: currentOrientation()))
        } else if mode == "hold" {
            // 開いた画面では固めない
            release()
        } else {
            // 画面の向きのロックが入っていると、横のまま残るので、一度縦に戻してから向きを任せる。
            // iPad と開いた折りたたみは戻さない (iPad はどの向きでも使う。PLAN-29 の (5)。開いた画面では頼めない)
            let phone = UIDevice.current.userInterfaceIdiom == .phone && !hingeOpen
            apply(Self.defaultMask, request: phone && currentOrientation().isLandscape ? .portrait : nil)
        }
        return currentOrientation().isLandscape ? "landscape" : "portrait"
    }

    // MARK: - 折りたたみ

    /// ヒンジと画面の移り変わりを見る (ヒンジは iOS 27.1 から。折りたたみでない端末では知らせが来ない)
    private func watchFolding() {
        guard hingeInteraction == nil, let scene, let window = scene.windows.first else { return }
        if #available(iOS 27.1, *) {
            let interaction = UIHingeInteraction { [weak self] _, update in
                guard let self else { return }
                let open = update.hinge.map { $0.status == .partiallyOpen || $0.status == .fullyOpen } ?? false
                guard open != self.hingeOpen else { return }
                self.hingeOpen = open
                DebugLog.write("orientation: hinge \(open ? "open" : "closed") mode=\(self.mode)")
                // 開き始めたらすぐ外す (開いた画面へ移る前に間に合えば、開いた画面が正しい向きで入る)。
                // 閉じたときはまだ開いた側の画面にいるので、画面が移ってから固め直す (sceneMoved)
                if open { self.release() }
            }
            window.addInteraction(interaction)
            hingeInteraction = interaction
        }
        lastSize = scene.coordinateSpace.bounds.size
        geometryObservation = scene.observe(\.effectiveGeometry, options: [.new]) { [weak self] scene, _ in
            MainActor.assumeIsolated { self?.sceneMoved(scene) }
        }
    }

    /// 画面の大きさが変わった (畳んだ・開いた) ら、一度外し、落ち着いてから測っている間の固定に戻す
    private func sceneMoved(_ scene: UIWindowScene) {
        let size = scene.coordinateSpace.bounds.size
        // 回しただけ (縦横が入れ替わっただけ) は移ったとみなさない
        let rotated = size.width == lastSize.height && size.height == lastSize.width
        let same = size == lastSize || rotated
        lastSize = size
        guard !same else { return }
        release()
        reapply?.cancel()
        guard mode == "hold" else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.mode == "hold" else { return }
            _ = self.set(mode: "hold")
        }
        reapply = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: item)
    }

    /// 固めるのをやめる (向きを頼み直さない。開いた画面ではどのみち断られる)
    private func release() {
        mask = Self.defaultMask
        guard let scene else { return }
        for w in scene.windows { w.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations() }
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
            // 断られたら固めたままにしない (OS が向きを決める窓では、固めた向きが残って戻せなくなる)
            Task { @MainActor in OrientationControl.shared.release() }
        }
    }
}
