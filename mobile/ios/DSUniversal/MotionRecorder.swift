import Foundation
import CoreMotion
import UIKit

/// iPhone の G センサー (約束の system.motionStart / system.motionStop、知らせ system.motion)。2026-10-21。
/// ラップタイマーで測っている間、CoreMotion の値を決まった間隔で読み、0.5 秒ごとにまとめて Web へ渡す。
/// 車の向きへの読み替え (測定開始のときの傾きを基準にする) と .csv への書き込みは Web がする (src/services/phoneImu.ts)
@MainActor
final class MotionRecorder {
    static let shared = MotionRecorder()

    private let manager = CMMotionManager()
    private var timer: Timer?
    /// まだ渡していない値 (列ごと)
    private var t: [Double] = []
    private var gravity: [[Double]] = [[], [], []]
    private var user: [[Double]] = [[], [], []]
    private var rotation: [[Double]] = [[], [], []]
    /// CMDeviceMotion の時刻 (起動からの秒) を UTC に直すための差
    private var uptimeToEpoch: Double = 0
    /// 渡せないとき (画面が裏にいる間) にためておく上限 (50 Hz で 2 分)。超えたら古いものから捨てる
    private static let maxPending = 6000
    /// 値を渡す先 (Web への知らせ)
    private var emitter: (@MainActor ([String: Any]) -> Void)?

    var isRunning: Bool { manager.isDeviceMotionActive }

    /// 読み始める (hz: 1 秒に何回)。もう読んでいれば何もしない
    func start(hz: Double, emit: @escaping @MainActor ([String: Any]) -> Void) -> Bool {
        guard manager.isDeviceMotionAvailable else { return false }
        emitter = emit
        if manager.isDeviceMotionActive { return true }
        uptimeToEpoch = Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime
        manager.deviceMotionUpdateInterval = 1.0 / max(1, min(hz, 100))
        manager.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let m = data else { return }
            let ts = m.timestamp
            let g = m.gravity, u = m.userAcceleration, r = m.rotationRate
            MainActor.assumeIsolated {
                guard let self else { return }
                self.t.append(((self.uptimeToEpoch + ts) * 1000).rounded())
                self.gravity[0].append(g.x); self.gravity[1].append(g.y); self.gravity[2].append(g.z)
                self.user[0].append(u.x); self.user[1].append(u.y); self.user[2].append(u.z)
                self.rotation[0].append(r.x); self.rotation[1].append(r.y); self.rotation[2].append(r.z)
                self.trim()
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.drain() }
        }
        return true
    }

    func stop() {
        guard manager.isDeviceMotionActive else { return }
        manager.stopDeviceMotionUpdates()
        timer?.invalidate()
        timer = nil
        drain(force: true)
    }

    /// ためすぎない (画面が裏にいて Web が受け取れない間に、メモリを使い続けないように)
    private func trim() {
        let over = t.count - Self.maxPending
        guard over > 0 else { return }
        t.removeFirst(over)
        for i in 0..<3 {
            gravity[i].removeFirst(over); user[i].removeFirst(over); rotation[i].removeFirst(over)
        }
    }

    /// Web へ渡す。画面が裏にいる間は渡さずにためておく (WKWebView が止まっていて、知らせがたまる一方になるため)。止めるときは必ず渡す
    private func drain(force: Bool = false) {
        guard !t.isEmpty, let emit = emitter else { return }
        if !force && UIApplication.shared.applicationState == .background { return }
        emit([
            "t": t,
            "gx": gravity[0], "gy": gravity[1], "gz": gravity[2],
            "ux": user[0], "uy": user[1], "uz": user[2],
            "rx": rotation[0], "ry": rotation[1], "rz": rotation[2]
        ])
        t = []
        gravity = [[], [], []]
        user = [[], [], []]
        rotation = [[], [], []]
    }
}
