import AVFoundation
import UIKit

/// 内蔵カメラでの録画 (ラップタイマーの測定開始で撮り始め、終了で止める。2026-10-25。設計は docs/iphone_app_design.md の 6)。
///
/// - レンズは、その端末にあるもの (超広角・広角・望遠・前) から選ぶ。画質は 1080p30 / 1080p60 / 4K30 / 4K60 (レンズが対応するもの)
/// - 向きは、撮り始めたときの画面の向き (ラップタイマーの向き) に合わせ、撮っている間は変えない
/// - ISO を決めたときは、シャッターの速さを自動で動かして明るさを保つ (ISO 優先)。決めないときはすべて自動
/// - 撮っている間は一時ファイルに書き、止めたら Web が渡した LapTimer/ の下の場所 (.nmea と同じ所) へ移す
/// - アプリが裏に回る・電話が来るなどで止まったら、そこまでのファイルを残す。止めるときに、続きの番号を付けて全部移す
/// - 熱くなりすぎたら (thermalState が critical) 録画を止めて、ログの記録は続ける
@MainActor
final class CameraModule: NSObject {
    private unowned let core: NativeCore
    private let queue = DispatchQueue(label: "laploupe.camera")
    private let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private var device: AVCaptureDevice?
    /// 撮り終えたファイル (止まるたびに足す) と、撮り始めた時刻 (端末の時計、UTC ミリ秒)
    private var segments: [(url: URL, startWallMs: Double)] = []
    private var currentStartWallMs: Double?
    private var stopWaiters: [() -> Void] = []
    private var recording = false
    private var wantRecording = false
    private var isoTarget: Float?
    private var isoTimer: Timer?
    private var previewView: UIView?
    private var thermalObserver: NSObjectProtocol?
    private var interruptObservers: [NSObjectProtocol] = []
    /// 撮る前の確かめ (設定の画面の枠に、今の映像を出す)
    private var liveView: UIView?
    private var liveLayer: AVCaptureVideoPreviewLayer?
    private var liveConfig: String?
    private var exposureTimer: Timer?
    private var frameSec: Double = 1.0 / 30

    init(core: NativeCore) {
        self.core = core
        super.init()
    }

    func handle(method: String, params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        switch method {
        case "camera.permission":
            permission(request: params["request"] as? Bool ?? false, audio: params["audio"] as? Bool ?? false, done: done)
        case "camera.lenses":
            done(.success(["lenses": Self.lenses().map(\.json)]))
        case "camera.start":
            start(params: params, done: done)
        case "camera.stop":
            stop(path: params["path"] as? String, done: done)
        case "camera.preview":
            livePreview(params: params, done: done)
        case "camera.setIso":
            applyIso((params["iso"] as? Double).map { Float($0) })
            done(.success([:]))
        default:
            done(.failure(NativeError(.notSupported, "unknown method \(method)")))
        }
    }

    // MARK: - 許可

    private static func state(_ s: AVAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        default: return "unknown"
        }
    }

    private func permission(request: Bool, audio: Bool, done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        let report = {
            done(.success([
                "camera": Self.state(AVCaptureDevice.authorizationStatus(for: .video)),
                "mic": Self.state(AVCaptureDevice.authorizationStatus(for: .audio))
            ]))
        }
        guard request else { report(); return }
        Task { @MainActor in
            if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined { _ = await AVCaptureDevice.requestAccess(for: .video) }
            if audio, AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined { _ = await AVCaptureDevice.requestAccess(for: .audio) }
            report()
        }
    }

    // MARK: - レンズ

    struct Lens {
        let device: AVCaptureDevice
        let id: String
        let position: String
        let kind: String
        let zoom: Double
        let presets: [String]

        var json: [String: Any] {
            [
                "id": id, "position": position, "kind": kind, "zoom": zoom,
                "isoMin": Double(device.activeFormat.minISO), "isoMax": Double(device.activeFormat.maxISO),
                "presets": presets
            ]
        }
    }

    nonisolated static let presetSpecs: [String: (w: Int32, h: Int32, fps: Double)] = [
        "1080p30": (1920, 1080, 30), "1080p60": (1920, 1080, 60), "2160p30": (3840, 2160, 30), "2160p60": (3840, 2160, 60)
    ]

    /// その画質で撮れる形式 (HDR でないもの・ビニングしたものを先に)
    nonisolated static func format(for device: AVCaptureDevice, preset: String) -> AVCaptureDevice.Format? {
        guard let spec = presetSpecs[preset] else { return nil }
        let ok = device.formats.filter { f in
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            return d.width == spec.w && d.height == spec.h && f.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= spec.fps - 0.01 }
        }
        return ok.first { !$0.isVideoHDRSupported } ?? ok.first
    }

    static func lenses() -> [Lens] {
        let back = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera], mediaType: .video, position: .back).devices
        let front = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .front).devices
        let wideFov = back.first { $0.deviceType == .builtInWideAngleCamera }.map { Double($0.activeFormat.videoFieldOfView) } ?? 70
        func zoom(_ d: AVCaptureDevice) -> Double {
            // 広角を 1 として、画角の比から倍率を出す (0.5x・3x・5x など)
            let fov = Double(d.activeFormat.videoFieldOfView)
            let z = tan(wideFov / 2 * .pi / 180) / tan(fov / 2 * .pi / 180)
            return (z * 10).rounded() / 10
        }
        func presets(_ d: AVCaptureDevice) -> [String] {
            ["1080p30", "1080p60", "2160p30", "2160p60"].filter { format(for: d, preset: $0) != nil }
        }
        var out: [Lens] = []
        for d in back {
            let kind = d.deviceType == .builtInUltraWideCamera ? "ultraWide" : d.deviceType == .builtInTelephotoCamera ? "tele" : "wide"
            out.append(Lens(device: d, id: d.uniqueID, position: "back", kind: kind, zoom: kind == "wide" ? 1 : zoom(d), presets: presets(d)))
        }
        for d in front {
            out.append(Lens(device: d, id: d.uniqueID, position: "front", kind: "front", zoom: 1, presets: presets(d)))
        }
        return out.sorted { ($0.position == "back" ? 0 : 1, $0.zoom) < ($1.position == "back" ? 0 : 1, $1.zoom) }
    }

    // MARK: - 撮る

    /// 画面の向き (ラップタイマーの向き) から、録画の回転 (度)
    private static func rotationAngle(front: Bool) -> CGFloat {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        switch scene?.effectiveGeometry.interfaceOrientation ?? .portrait {
        case .landscapeRight: return front ? 180 : 0
        case .landscapeLeft: return front ? 0 : 180
        case .portraitUpsideDown: return 270
        default: return 90
        }
    }

    private func start(params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard !wantRecording else { done(.failure(NativeError(.busy, "already recording"))); return }
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            done(.failure(NativeError(.permissionDenied, "camera"))); return
        }
        let wantLens = params["lensId"] as? String
        let preset = params["preset"] as? String ?? "1080p30"
        let audio = (params["audio"] as? Bool ?? false) && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        let iso = (params["iso"] as? Double).map { Float($0) }
        let preview = params["preview"] as? Bool ?? false
        let all = Self.lenses()
        guard let lens = all.first(where: { $0.id == wantLens }) ?? all.first(where: { $0.kind == "wide" }) ?? all.first else {
            done(.failure(NativeError(.notFound, "no camera"))); return
        }
        let spec = Self.presetSpecs[preset] ?? Self.presetSpecs["1080p30"]!
        let angle = Self.rotationAngle(front: lens.position == "front")
        let dev = lens.device
        let lensId = lens.id
        device = dev
        isoTarget = iso
        frameSec = 1 / spec.fps
        hideLive()
        wantRecording = true
        segments = []
        observeEvents()
        let session = session, output = output
        Task { @MainActor in
            // カメラの組み立ては、カメラ用の列で行う (主スレッドを止めない)
            let error: NativeError? = await withCheckedContinuation { cont in
                queue.async {
                    do {
                        try Self.configure(session: session, output: output, device: dev, preset: preset, fps: spec.fps, audio: audio, angle: angle)
                        cont.resume(returning: nil)
                    } catch {
                        cont.resume(returning: error as? NativeError ?? NativeError(.io, error.localizedDescription))
                    }
                }
            }
            if let error {
                self.wantRecording = false
                done(.failure(error))
                return
            }
            self.beginSegment()
            if iso != nil { self.startIsoLoop(frameSec: 1 / spec.fps) }
            if preview { self.showPreview() }
            done(.success(["lensId": lensId, "preset": preset]))
        }
    }

    nonisolated private static func configure(session: AVCaptureSession, output: AVCaptureMovieFileOutput, device dev: AVCaptureDevice, preset: String, fps: Double, audio: Bool, angle: CGFloat) throws {
        session.beginConfiguration()
        do {
            try configureLocked(session: session, output: output, device: dev, preset: preset, fps: fps, audio: audio, angle: angle)
        } catch {
            session.commitConfiguration()
            throw error
        }
        session.commitConfiguration()
        if !session.isRunning { session.startRunning() }
    }

    nonisolated private static func configureLocked(session: AVCaptureSession, output: AVCaptureMovieFileOutput, device dev: AVCaptureDevice, preset: String, fps: Double, audio: Bool, angle: CGFloat) throws {
        session.inputs.forEach { session.removeInput($0) }
        if session.canSetSessionPreset(.inputPriority) { session.sessionPreset = .inputPriority }
        let input = try AVCaptureDeviceInput(device: dev)
        guard session.canAddInput(input) else { throw NativeError(.io, "camera input") }
        session.addInput(input)
        if audio, let mic = AVCaptureDevice.default(for: .audio), let micIn = try? AVCaptureDeviceInput(device: mic), session.canAddInput(micIn) {
            session.addInput(micIn)
        }
        if !session.outputs.contains(output) {
            guard session.canAddOutput(output) else { throw NativeError(.io, "movie output") }
            session.addOutput(output)
        }
        try dev.lockForConfiguration()
        if let f = format(for: dev, preset: preset) { dev.activeFormat = f }
        let frame = CMTime(value: 1000, timescale: CMTimeScale(fps * 1000))
        dev.activeVideoMinFrameDuration = frame
        dev.activeVideoMaxFrameDuration = frame
        if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
        if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
        dev.unlockForConfiguration()
        if let conn = output.connection(with: .video) {
            if conn.isVideoRotationAngleSupported(angle) { conn.videoRotationAngle = angle }
            if conn.isVideoStabilizationSupported { conn.preferredVideoStabilizationMode = .standard }
            if output.availableVideoCodecTypes.contains(.hevc) { output.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.hevc], for: conn) }
        }
    }

    private func beginSegment() {
        guard wantRecording, !output.isRecording else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("cam-\(UUID().uuidString).mov")
        currentStartWallMs = nil
        output.startRecording(to: url, recordingDelegate: self)
    }

    /// 止める。path があれば、撮ったファイルを LapTimer/ の下のその場所へ移す (続きは _2・_3 を付ける)
    private func stop(path: String?, done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        wantRecording = false
        isoTimer?.invalidate()
        isoTimer = nil
        hidePreview()
        let finish = { [weak self] in
            guard let self else { return }
            let segs = self.segments
            self.segments = []
            self.queue.async { [session = self.session] in if session.isRunning { session.stopRunning() } }
            var files: [[String: Any]] = []
            for (i, seg) in segs.enumerated() {
                var url = seg.url
                if let path, let dest = Self.lapTimerURL(path, index: i) {
                    try? FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                    if (try? FileManager.default.moveItem(at: seg.url, to: dest)) != nil { url = dest }
                }
                let asset = AVURLAsset(url: url)
                let duration = CMTimeGetSeconds(asset.duration)
                let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
                files.append([
                    "path": path.map { Self.indexedPath($0, index: i) } ?? url.lastPathComponent,
                    "startWallMs": seg.startWallMs, "durationSec": duration.isFinite ? duration : 0, "bytes": bytes
                ])
            }
            done(.success(["files": files]))
        }
        if output.isRecording {
            stopWaiters.append(finish)
            output.stopRecording()
        } else {
            finish()
        }
    }

    private static func indexedPath(_ path: String, index: Int) -> String {
        guard index > 0 else { return path }
        let ns = path as NSString
        return "\(ns.deletingPathExtension)_\(index + 1).\(ns.pathExtension)"
    }

    private static func lapTimerURL(_ rel: String, index: Int) -> URL? {
        guard !rel.isEmpty, !rel.contains(".."), !rel.hasPrefix("/") else { return nil }
        return RunFiles.lapTimerRoot.appendingPathComponent(indexedPath(rel, index: index))
    }

    // MARK: - ISO 優先 (シャッターの速さで明るさを保つ)

    private func startIsoLoop(frameSec: Double) {
        isoTimer?.invalidate()
        isoTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.adjustExposure(frameSec: frameSec) }
        }
    }

    private func adjustExposure(frameSec: Double) {
        guard let dev = device, let target = isoTarget else { return }
        let f = dev.activeFormat
        let iso = min(max(target, f.minISO), f.maxISO)
        // 今の明るさのずれ (EV)。正なら明るすぎる
        let offset = Double(dev.exposureTargetOffset)
        let cur = CMTimeGetSeconds(dev.exposureDuration)
        var next = cur.isFinite && cur > 0 ? cur * pow(2, -offset * 0.6) : frameSec / 2
        next = min(max(next, CMTimeGetSeconds(f.minExposureDuration)), min(frameSec, CMTimeGetSeconds(f.maxExposureDuration)))
        guard (try? dev.lockForConfiguration()) != nil else { return }
        dev.setExposureModeCustom(duration: CMTime(seconds: next, preferredTimescale: 1_000_000), iso: iso, completionHandler: nil)
        dev.unlockForConfiguration()
    }

    // MARK: - プレビュー (撮り始めの 5 秒だけ、右上に小さく)

    private func showPreview() {
        guard previewView == nil,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first?.windows.first(where: \.isKeyWindow) else { return }
        let w: CGFloat = 160
        let view = UIView(frame: CGRect(x: window.bounds.width - w - 12, y: window.safeAreaInsets.top + 60, width: w, height: w * 9 / 16))
        view.layer.cornerRadius = 10
        view.clipsToBounds = true
        view.layer.borderWidth = 2
        view.layer.borderColor = UIColor.systemRed.cgColor
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        window.addSubview(view)
        previewView = view
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.hidePreview() }
    }

    private func hidePreview() {
        previewView?.removeFromSuperview()
        previewView = nil
    }

    // MARK: - 撮る前の確かめ (設定の画面の枠に映像を出し、ISO をその場で変える)

    private func livePreview(params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard params["show"] as? Bool ?? false else {
            hideLive()
            if !wantRecording {
                isoTimer?.invalidate()
                isoTimer = nil
                queue.async { [session] in if session.isRunning { session.stopRunning() } }
            }
            done(.success([:]))
            return
        }
        guard !wantRecording else { done(.failure(NativeError(.busy, "recording"))); return }
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { done(.failure(NativeError(.permissionDenied, "camera"))); return }
        let r = params["rect"] as? [String: Any] ?? [:]
        let rect = CGRect(x: r["x"] as? Double ?? 0, y: r["y"] as? Double ?? 0, width: r["w"] as? Double ?? 0, height: r["h"] as? Double ?? 0)
        let wantLens = params["lensId"] as? String
        let preset = params["preset"] as? String ?? "1080p30"
        let iso = (params["iso"] as? Double).map { Float($0) }
        let all = Self.lenses()
        guard let lens = all.first(where: { $0.id == wantLens }) ?? all.first(where: { $0.kind == "wide" }) ?? all.first else {
            done(.failure(NativeError(.notFound, "no camera"))); return
        }
        let spec = Self.presetSpecs[preset] ?? Self.presetSpecs["1080p30"]!
        let angle = Self.rotationAngle(front: lens.position == "front")
        let config = "\(lens.id)|\(preset)"
        let dev = lens.device
        let session = session, output = output
        Task { @MainActor in
            if self.liveConfig != config || !session.isRunning {
                self.device = dev
                self.frameSec = 1 / spec.fps
                let error: NativeError? = await withCheckedContinuation { cont in
                    self.queue.async {
                        do {
                            try Self.configure(session: session, output: output, device: dev, preset: preset, fps: spec.fps, audio: false, angle: angle)
                            cont.resume(returning: nil)
                        } catch {
                            cont.resume(returning: error as? NativeError ?? NativeError(.io, error.localizedDescription))
                        }
                    }
                }
                if let error { done(.failure(error)); return }
                self.liveConfig = config
            }
            self.placeLive(rect, angle: angle)
            self.applyIso(iso)
            self.startExposureReports()
            done(.success([:]))
        }
    }

    private func placeLive(_ rect: CGRect, angle: CGFloat) {
        guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first?.windows.first(where: \.isKeyWindow) else { return }
        if liveView == nil {
            let view = UIView()
            view.layer.cornerRadius = 10
            view.clipsToBounds = true
            view.backgroundColor = .black
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspect
            view.layer.addSublayer(layer)
            // 映像は見るだけ (押しても下の画面のボタンに届くように)
            view.isUserInteractionEnabled = false
            window.addSubview(view)
            liveView = view
            liveLayer = layer
        }
        // Web の CSS の座標は、WKWebView (画面いっぱい) の座標と同じ
        liveView?.frame = rect
        liveView?.isHidden = rect.width < 4 || rect.height < 4
        liveLayer?.frame = CGRect(origin: .zero, size: rect.size)
        if let conn = liveLayer?.connection, conn.isVideoRotationAngleSupported(angle) { conn.videoRotationAngle = angle }
    }

    private func hideLive() {
        exposureTimer?.invalidate()
        exposureTimer = nil
        liveView?.removeFromSuperview()
        liveView = nil
        liveLayer = nil
        liveConfig = nil
    }

    /// ISO を決める (nil は自動)。決めたときは、シャッターの速さで明るさを保つ
    private func applyIso(_ iso: Float?) {
        isoTarget = iso
        if iso != nil {
            startIsoLoop(frameSec: frameSec)
        } else {
            isoTimer?.invalidate()
            isoTimer = nil
            if let dev = device, dev.isExposureModeSupported(.continuousAutoExposure), (try? dev.lockForConfiguration()) != nil {
                dev.exposureMode = .continuousAutoExposure
                dev.unlockForConfiguration()
            }
        }
    }

    /// 今の ISO とシャッターの速さを、Web に知らせる (枠の下に出す)
    private func startExposureReports() {
        guard exposureTimer == nil else { return }
        exposureTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let dev = self.device else { return }
                self.core.emit("camera.exposure", ["iso": Double(dev.iso), "shutterSec": CMTimeGetSeconds(dev.exposureDuration)])
            }
        }
    }

    // MARK: - 熱・止まったとき

    private func observeEvents() {
        if thermalObserver == nil {
            thermalObserver = NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.thermalChanged() }
            }
        }
        if interruptObservers.isEmpty {
            // 裏から戻った・電話が終わったら、続きを撮る (ファイルは分かれる)
            interruptObservers.append(NotificationCenter.default.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.wantRecording else { return }
                    self.queue.async { [session = self.session] in if !session.isRunning { session.startRunning() } }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.beginSegment() }
                }
            })
        }
    }

    private func thermalChanged() {
        let s = ProcessInfo.processInfo.thermalState
        let name = s == .critical ? "critical" : s == .serious ? "serious" : s == .fair ? "fair" : "nominal"
        if s == .critical && wantRecording {
            // 熱すぎる: 録画だけ止める (ログの記録は Web が続ける)。撮ったファイルは、測定終了のときに移す
            wantRecording = false
            if output.isRecording { output.stopRecording() }
            core.emit("camera.state", ["recording": false, "error": "thermal", "thermal": name])
        } else {
            core.emit("camera.state", ["recording": recording, "thermal": name])
        }
    }
}

extension CameraModule: AVCaptureFileOutputRecordingDelegate {
    nonisolated func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
        let now = Date().timeIntervalSince1970 * 1000
        Task { @MainActor in
            // iOS 18 からは、先頭のコマの時刻 (startPTS) で決め直す (下)
            if self.currentStartWallMs == nil { self.currentStartWallMs = now }
            self.recording = true
            self.core.emit("camera.state", ["recording": true])
        }
    }

    @available(iOS 18.0, *)
    nonisolated func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, startPTS: CMTime, from connections: [AVCaptureConnection]) {
        // 先頭のコマの時刻 (ホストの時計) と今の差だけ、端末の時計を戻す
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        let age = CMTimeGetSeconds(CMTimeSubtract(hostNow, startPTS))
        let wall = Date().timeIntervalSince1970 * 1000 - (age.isFinite && age > 0 && age < 5 ? age * 1000 : 0)
        Task { @MainActor in
            self.currentStartWallMs = wall
            self.recording = true
            self.core.emit("camera.state", ["recording": true])
        }
    }

    nonisolated func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        // 止めた・止まった (裏に回った・熱・容量)。中身が書けていれば残す
        let ok = error == nil || ((error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? false)
        Task { @MainActor in
            self.recording = false
            if ok, FileManager.default.fileExists(atPath: outputFileURL.path) {
                self.segments.append((outputFileURL, self.currentStartWallMs ?? Date().timeIntervalSince1970 * 1000))
            }
            if let error, !ok { DebugLog.write("camera: recording failed \(error.localizedDescription)") }
            let waiters = self.stopWaiters
            self.stopWaiters = []
            if waiters.isEmpty {
                // こちらから止めたのでないとき (裏に回ったなど) は知らせる
                if self.wantRecording { self.core.emit("camera.state", ["recording": false, "error": "interrupted"]) }
            } else {
                waiters.forEach { $0() }
            }
        }
    }
}
