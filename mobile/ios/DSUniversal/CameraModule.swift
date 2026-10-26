import AVFoundation
import WebKit
import UIKit

/// 内蔵カメラでの録画 (ラップタイマーの測定開始で撮り始め、終了で止める。2026-10-25。設計は docs/iphone_app_design.md の 6)。
///
/// - レンズは、その端末にあるもの (超広角・広角・望遠・前) から選ぶ。画質は 1080p30 / 1080p60 / 4K30 / 4K60 (レンズが対応するもの)
/// - 後ろのカメラと一緒に、前のカメラ (自分側) も同時に撮れる (AVCaptureMultiCamSession。対応する端末だけ)。
///   そのときの画質は、両方とも同時に撮れる形式 (多くは 1080p まで) から選ぶ。ISO はカメラごとに決める
/// - 向きは、撮り始めたときの画面の向き (ラップタイマーの向き) に合わせ、撮っている間は変えない
/// - ISO を決めたときは、シャッターの速さを自動で動かして明るさを保つ (ISO 優先)。決めないときはすべて自動
/// - 撮っている間は一時ファイルに書き、止めたら Web が渡した LapTimer/ の下の場所 (.nmea と同じ所) へ移す
/// - アプリが裏に回る・電話が来るなどで止まったら、そこまでのファイルを残す。止めるときに、続きの番号を付けて全部移す
/// - 熱くなりすぎたら (thermalState が critical) 録画を止めて、ログの記録は続ける
@MainActor
final class CameraModule: NSObject {
    /// 1 つのカメラ (後ろ = main、前 = front) の録画と映像の枠
    final class Channel {
        let name: String
        var output = AVCaptureMovieFileOutput()
        var device: AVCaptureDevice?
        var active = false
        /// 録画のファイルに書いている (始めると頼んでから、終わったと知らせが来るまで)。カメラに問い合わせると、組み立て中は鍵の取り合いになるので自分で持つ
        var writing = false
        var segments: [(url: URL, startWallMs: Double)] = []
        var currentStartWallMs: Double?
        var isoTarget: Float?
        /** 明るさの補正 (EV。露出は自動のまま、全体を明るめ・暗めにする) */
        var ev: Float = 0
        var frameSec: Double = 1.0 / 30
        var angle: CGFloat = 90
        var liveView: UIView?
        var liveLayer: AVCaptureVideoPreviewLayer?
        init(name: String) { self.name = name }
    }

    /// カメラ用の列へ渡すためのもの (AVFoundation の物は Sendable でないものがあるが、カメラ用の列で 1 つずつ触るので安全)
    struct Box<T>: @unchecked Sendable { let value: T }

    /// カメラの組み立ての中身 (1 つのカメラ分)
    struct Spec: @unchecked Sendable {
        let device: AVCaptureDevice
        let output: AVCaptureMovieFileOutput
        let preset: String
        let fps: Double
        let angle: CGFloat
        let layers: [AVCaptureVideoPreviewLayer]
        /// ピントを遠くに合わせて固定する (組み立ての前に build が入れる)
        var focusFar = true
    }

    private unowned let core: NativeCore
    private let queue = DispatchQueue(label: "laploupe.camera")
    private var session: AVCaptureSession = AVCaptureSession()
    private let main = Channel(name: "main")
    private let front = Channel(name: "front")
    private var channels: [Channel] { [main, front] }
    private var isMulti: Bool { session is AVCaptureMultiCamSession }
    private var stopWaiters: [() -> Void] = []
    private var recording = false
    private var wantRecording = false
    private var isoTimer: Timer?
    private var previewView: UIView?
    private var thermalObserver: NSObjectProtocol?
    private var interruptObservers: [NSObjectProtocol] = []
    /// 撮る前の確かめ (設定の画面の枠に、今の映像を出す)
    private var liveConfig: String?
    /** ピントを遠くに合わせて固定するか (撮る・確かめの映像の頼みで決まる) */
    private var focusFar = true
    private var exposureTimer: Timer?
    /** 確かめの映像で、今頼まれている組み立て (消す頼み・撮り始めで nil)。組み立てを待つ間に替わったら、古い頼みは置かない */
    private var liveRequested: String?
    /** 組み立てている最中の確かめの映像 (同じ組み立ての頼みが続けて来たら、組み直さずに置き場所だけ覚える) */
    private var liveBuilding: String?
    /** 最後に頼まれた置き場所・ISO・明るさ (組み立て終わったら、これで置く) */
    private var liveLatest: (main: CGRect, front: CGRect, iso: Float?, frontIso: Float?, frontEv: Float) = (.zero, .zero, nil, nil, 0)
    /** レンズの一覧と取り付けのずれ (端末の中で変わらないので、1 回だけ調べる) */
    private static var cachedLenses: [Lens]?
    private static var cachedMountOffsets: [String: CGFloat] = [:]

    init(core: NativeCore) {
        self.core = core
        super.init()
    }

    func handle(method: String, params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        switch method {
        case "camera.permission":
            permission(request: params["request"] as? Bool ?? false, audio: params["audio"] as? Bool ?? false, done: done)
        case "camera.lenses":
            done(.success(["lenses": Self.lenses().map(\.json), "multiCam": AVCaptureMultiCamSession.isMultiCamSupported]))
        case "camera.start":
            start(params: params, done: done)
        case "camera.stop":
            stop(path: params["path"] as? String, frontPath: params["frontPath"] as? String, done: done)
        case "camera.preview":
            livePreview(params: params, done: done)
        case "camera.setEv":
            let c = (params["which"] as? String) == "front" ? front : main
            c.ev = Float(params["ev"] as? Double ?? 0)
            applyEv(c)
            done(.success([:]))
        case "camera.setIso":
            applyIso((params["which"] as? String) == "front" ? front : main, (params["iso"] as? Double).map { Float($0) })
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
        /// 前と後ろを同時に撮るときの画質 (同時に撮れない組み合わせなら空)
        let multiPresets: [String]

        var json: [String: Any] {
            [
                "id": id, "position": position, "kind": kind, "zoom": zoom,
                "isoMin": Double(device.activeFormat.minISO), "isoMax": Double(device.activeFormat.maxISO),
                "presets": presets, "multiCamPresets": multiPresets
            ]
        }
    }

    nonisolated static let presetSpecs: [String: (w: Int32, h: Int32, fps: Double)] = [
        "1080p30": (1920, 1080, 30), "1080p60": (1920, 1080, 60), "2160p30": (3840, 2160, 30), "2160p60": (3840, 2160, 60)
    ]

    /// その画質で撮れる形式 (HDR でないもの・ビニングしたものを先に)。multi なら、前と後ろを同時に撮れる形式だけ
    nonisolated static func format(for device: AVCaptureDevice, preset: String, multi: Bool = false) -> AVCaptureDevice.Format? {
        guard let spec = presetSpecs[preset] else { return nil }
        let ok = device.formats.filter { f in
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            return d.width == spec.w && d.height == spec.h && (!multi || f.isMultiCamSupported)
                && f.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= spec.fps - 0.01 }
        }
        return ok.first { !$0.isVideoHDRSupported } ?? ok.first
    }

    static func lenses() -> [Lens] {
        if let cachedLenses { return cachedLenses }
        let found = discoverLenses()
        cachedLenses = found
        return found
    }

    private static func discoverLenses() -> [Lens] {
        let back = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera], mediaType: .video, position: .back).devices
        let fronts = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .front).devices
        let wideFov = back.first { $0.deviceType == .builtInWideAngleCamera }.map { Double($0.activeFormat.videoFieldOfView) } ?? 70
        func zoom(_ d: AVCaptureDevice) -> Double {
            // 広角を 1 として、画角の比から倍率を出す (0.5x・3x・5x など)
            let fov = Double(d.activeFormat.videoFieldOfView)
            let z = tan(wideFov / 2 * .pi / 180) / tan(fov / 2 * .pi / 180)
            return (z * 10).rounded() / 10
        }
        let all = ["1080p30", "1080p60", "2160p30", "2160p60"]
        func presets(_ d: AVCaptureDevice) -> [String] { all.filter { format(for: d, preset: $0) != nil } }
        // 前と後ろを同時に撮れる組み合わせ (その端末が対応しているもの)
        let sets = AVCaptureMultiCamSession.isMultiCamSupported
            ? AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera], mediaType: .video, position: .unspecified).supportedMultiCamDeviceSets
            : []
        func multiPresets(_ d: AVCaptureDevice) -> [String] {
            let pairOk = d.position == .front ? !sets.isEmpty : sets.contains { set in set.contains(d) && set.contains { $0.position == .front } }
            return pairOk ? all.filter { format(for: d, preset: $0, multi: true) != nil } : []
        }
        var out: [Lens] = []
        for d in back {
            let kind = d.deviceType == .builtInUltraWideCamera ? "ultraWide" : d.deviceType == .builtInTelephotoCamera ? "tele" : "wide"
            out.append(Lens(device: d, id: d.uniqueID, position: "back", kind: kind, zoom: kind == "wide" ? 1 : zoom(d), presets: presets(d), multiPresets: multiPresets(d)))
        }
        for d in fronts {
            out.append(Lens(device: d, id: d.uniqueID, position: "front", kind: "front", zoom: 1, presets: presets(d), multiPresets: multiPresets(d)))
        }
        return out.sorted { ($0.position == "back" ? 0 : 1, $0.zoom) < ($1.position == "back" ? 0 : 1, $1.zoom) }
    }

    // MARK: - 撮る

    /// 画面の向き (ラップタイマーの向き) から、録画の回転 (度)。カメラの取り付けの向きの違い (下の mountOffset) も足す
    private static func rotationAngle(for device: AVCaptureDevice) -> CGFloat {
        let front = device.position == .front
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let base: CGFloat
        switch scene?.effectiveGeometry.interfaceOrientation ?? .portrait {
        case .landscapeRight: base = front ? 180 : 0
        case .landscapeLeft: base = front ? 0 : 180
        case .portraitUpsideDown: base = 270
        default: base = 90
        }
        let a = (base + mountOffset(device)).truncatingRemainder(dividingBy: 360)
        return a < 0 ? a + 360 : a
    }

    /// カメラの取り付けの向きが、ふつう (後ろの広角と同じ) から何度ずれているか (90 度刻み)。
    /// iPhone 17 の前のカメラ (正方形のセンサー) は、ほかのカメラと取り付けの向きが違い、同じ角度で回すと映像が 90 度傾いていた。
    /// その端末の向きでの「水平に撮る角度」を、後ろの広角とそのカメラで iPhone に聞き (RotationCoordinator)、ふつうのカメラなら
    /// なるはずの角度との差をずれとする (同じときに聞くので、端末の持ち方によらない)
    private static func mountOffset(_ device: AVCaptureDevice) -> CGFloat {
        if let known = cachedMountOffsets[device.uniqueID] { return known }
        let found = measureMountOffset(device)
        cachedMountOffsets[device.uniqueID] = found
        return found
    }

    private static func measureMountOffset(_ device: AVCaptureDevice) -> CGFloat {
        guard let ref = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back), ref != device else { return 0 }
        let refAngle = AVCaptureDevice.RotationCoordinator(device: ref, previewLayer: nil).videoRotationAngleForHorizonLevelCapture
        let angle = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil).videoRotationAngleForHorizonLevelCapture
        // ふつうの前のカメラは、横のときだけ後ろと 180 度違う (縦は同じ)
        let flat = refAngle.truncatingRemainder(dividingBy: 180) == 0
        let expected = device.position == .front && flat ? (refAngle + 180).truncatingRemainder(dividingBy: 360) : refAngle
        var d = (angle - expected).truncatingRemainder(dividingBy: 360)
        if d < 0 { d += 360 }
        let snapped = (d / 90).rounded() * 90
        DebugLog.write("camera: mount offset \(device.localizedName) ref=\(refAngle) angle=\(angle) offset=\(snapped)")
        return snapped.truncatingRemainder(dividingBy: 360)
    }

    /// 前と後ろを同時に撮るか (multi) で、カメラのまとまり (session) を替える。録画の出力も作り直す (別のまとまりのものは使えないため)
    private func useSession(multi: Bool) {
        guard multi != isMulti else { return }
        hideLive()
        let old = Box(value: session)
        queue.async {
            let s = old.value
            if s.isRunning { s.stopRunning() }
            s.beginConfiguration()
            s.connections.forEach { s.removeConnection($0) }
            s.inputs.forEach { s.removeInput($0) }
            s.outputs.forEach { s.removeOutput($0) }
            s.commitConfiguration()
        }
        session = multi ? AVCaptureMultiCamSession() : AVCaptureSession()
        for c in channels { c.output = AVCaptureMovieFileOutput() }
        liveConfig = nil
        resetInterruptObserver()
    }

    /// 映像を出す層 (前と後ろを同時に撮るときは、つなぎを自分で作るので、つながない層)
    private func makeLayer() -> AVCaptureVideoPreviewLayer {
        isMulti ? AVCaptureVideoPreviewLayer(sessionWithNoConnection: session) : AVCaptureVideoPreviewLayer(session: session)
    }

    /// カメラを組み立てる (カメラ用の列で)。specs[0] が後ろ (main)、specs[1] があれば前
    private func build(_ specsIn: [Spec], audio: Bool) async -> NativeError? {
        let far = focusFar
        let specs = specsIn.map { spec -> Spec in var x = spec; x.focusFar = far; return x }
        let s = Box(value: session)
        let multi = isMulti
        return await withCheckedContinuation { cont in
            queue.async {
                do {
                    if multi, let m = s.value as? AVCaptureMultiCamSession {
                        try Self.configureMulti(session: m, specs: specs, audio: audio)
                    } else {
                        try Self.configure(session: s.value, spec: specs[0], audio: audio)
                    }
                    cont.resume(returning: nil)
                } catch {
                    cont.resume(returning: error as? NativeError ?? NativeError(.io, error.localizedDescription))
                }
            }
        }
    }

    private struct FrontParams { let preset: String; let iso: Float?; let ev: Float }

    private static func frontParams(_ any: Any?) -> FrontParams? {
        guard let d = any as? [String: Any] else { return nil }
        return FrontParams(preset: d["preset"] as? String ?? "1080p30", iso: (d["iso"] as? Double).map { Float($0) }, ev: Float(d["ev"] as? Double ?? 0))
    }

    private func frontLens() -> Lens? { Self.lenses().first { $0.position == "front" } }

    private func start(params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard !wantRecording else { done(.failure(NativeError(.busy, "already recording"))); return }
        // 前の録画を止めている最中 (書き終わりの知らせ待ち) は始めない (前の止める処理と重なると、録画が始まらない・止める答えが返らない)
        guard stopWaiters.isEmpty, !channels.contains(where: { $0.writing }) else { done(.failure(NativeError(.busy, "still stopping"))); return }
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            done(.failure(NativeError(.permissionDenied, "camera"))); return
        }
        // 組み立て中の確かめの映像は、置かずに終わらせる
        liveRequested = nil
        let wantLens = params["lensId"] as? String
        let preset = params["preset"] as? String ?? "1080p30"
        let audio = (params["audio"] as? Bool ?? false) && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        let iso = (params["iso"] as? Double).map { Float($0) }
        let preview = params["preview"] as? Bool ?? false
        focusFar = params["focusFar"] as? Bool ?? true
        main.ev = Float(params["ev"] as? Double ?? 0)
        let all = Self.lenses()
        guard let lens = all.first(where: { $0.id == wantLens }) ?? all.first(where: { $0.kind == "wide" }) ?? all.first else {
            done(.failure(NativeError(.notFound, "no camera"))); return
        }
        // 前も同時に撮る (後ろのレンズを選んでいて、端末が対応しているとき)
        var fp = Self.frontParams(params["front"])
        let fLens = fp != nil && lens.position == "back" && AVCaptureMultiCamSession.isMultiCamSupported ? frontLens() : nil
        if fLens == nil { fp = nil }
        hideLive()
        useSession(multi: fp != nil)
        let spec = Self.presetSpecs[preset] ?? Self.presetSpecs["1080p30"]!
        main.device = lens.device
        main.active = true
        main.isoTarget = iso
        main.frameSec = 1 / spec.fps
        main.angle = Self.rotationAngle(for: lens.device)
        front.active = fp != nil
        front.device = fLens?.device
        var specs: [Spec] = []
        // 撮り始めの 5 秒の小さな映像 (同時に撮るときは、つなぎを組み立てのときに作るので、先に層を作る)
        var previewLayer: AVCaptureVideoPreviewLayer?
        if preview { previewLayer = makeLayer() }
        specs.append(Spec(device: lens.device, output: main.output, preset: preset, fps: spec.fps, angle: main.angle, layers: isMulti ? previewLayer.map { [$0] } ?? [] : []))
        if let fp, let fLens {
            let fs = Self.presetSpecs[fp.preset] ?? Self.presetSpecs["1080p30"]!
            front.isoTarget = fp.iso
            front.ev = fp.ev
            front.frameSec = 1 / fs.fps
            front.angle = Self.rotationAngle(for: fLens.device)
            specs.append(Spec(device: fLens.device, output: front.output, preset: fp.preset, fps: fs.fps, angle: front.angle, layers: []))
        }
        wantRecording = true
        for c in channels { c.segments = [] }
        observeEvents()
        Task { @MainActor in
            if let error = await self.build(specs, audio: audio) {
                self.wantRecording = false
                self.main.active = false
                self.front.active = false
                done(.failure(error))
                return
            }
            // 組み立てを待つ間に止められていたら (camera.stop)、撮り始めない
            guard self.wantRecording else {
                previewLayer?.removeFromSuperlayer()
                done(.failure(NativeError(.busy, "stopped before recording started")))
                return
            }
            for c in self.channels where c.active { self.beginSegment(c); self.applyEv(c) }
            if self.channels.contains(where: { $0.active && $0.isoTarget != nil }) { self.startIsoLoop() }
            if let previewLayer { self.showPreview(previewLayer, angle: self.main.angle) }
            done(.success(["lensId": lens.id, "preset": preset, "front": fp != nil]))
        }
    }

    nonisolated private static func configure(session: AVCaptureSession, spec: Spec, audio: Bool) throws {
        session.beginConfiguration()
        do {
            try configureLocked(session: session, spec: spec, audio: audio)
        } catch {
            session.commitConfiguration()
            throw error
        }
        session.commitConfiguration()
        // レンズを替えると、カメラから録画・映像の枠へのつなぎが作り直される。新しいつなぎにも向きを決め直す
        // (決めないと、既定の横向きで描かれる。前のカメラに替えると、縦の画面でも映像が横になっていた)
        for conn in session.connections where conn.isVideoRotationAngleSupported(spec.angle) {
            conn.videoRotationAngle = spec.angle
        }
        if !session.isRunning { session.startRunning() }
    }

    nonisolated private static func configureLocked(session: AVCaptureSession, spec: Spec, audio: Bool) throws {
        let dev = spec.device, output = spec.output
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
        try setFormat(dev, preset: spec.preset, fps: spec.fps, multi: false, focusFar: spec.focusFar)
        if let conn = output.connection(with: .video) { setupRecording(conn, output: output, angle: spec.angle) }
    }

    nonisolated private static func setFormat(_ dev: AVCaptureDevice, preset: String, fps: Double, multi: Bool, focusFar: Bool = true) throws {
        try dev.lockForConfiguration()
        defer { dev.unlockForConfiguration() }
        if let f = format(for: dev, preset: preset, multi: multi) {
            dev.activeFormat = f
        } else if multi, let f = format(for: dev, preset: "1080p30", multi: true) {
            // 同時に撮れる形式に、その画質が無ければ 1080p30
            dev.activeFormat = f
        }
        // その形式が対応していない fps を決めると落ちるので、対応しているときだけ決める (しないときは、その形式の既定のまま)
        let fpsOk = dev.activeFormat.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= fps + 0.01 && $0.maxFrameRate >= fps - 0.01 }
        if fpsOk {
            let frame = CMTime(value: 1000, timescale: CMTimeScale(fps * 1000))
            dev.activeVideoMinFrameDuration = frame
            dev.activeVideoMaxFrameDuration = frame
        }
        // ピント: 遠くに合わせて固定する (車載では、車内の物やダッシュボードにピントが移らないように)。
        // 決まった位置で固定できないレンズは、自動のまま遠くの範囲だけで合わせる
        if focusFar && dev.isLockingFocusWithCustomLensPositionSupported {
            dev.setFocusModeLocked(lensPosition: 1.0, completionHandler: nil)
        } else {
            if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
            if dev.isAutoFocusRangeRestrictionSupported { dev.autoFocusRangeRestriction = focusFar ? .far : .none }
        }
        if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
    }

    nonisolated private static func setupRecording(_ conn: AVCaptureConnection, output: AVCaptureMovieFileOutput, angle: CGFloat) {
        if conn.isVideoRotationAngleSupported(angle) { conn.videoRotationAngle = angle }
        if conn.isVideoStabilizationSupported { conn.preferredVideoStabilizationMode = .standard }
        if output.availableVideoCodecTypes.contains(.hevc) { output.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.hevc], for: conn) }
    }

    /// 前と後ろを同時に撮るときの組み立て。つなぎ (カメラ → 録画・映像の層) は自分で作る
    nonisolated private static func configureMulti(session: AVCaptureMultiCamSession, specs: [Spec], audio: Bool) throws {
        session.beginConfiguration()
        var failed: NativeError?
        do {
            session.connections.forEach { session.removeConnection($0) }
            session.inputs.forEach { session.removeInput($0) }
            session.outputs.forEach { session.removeOutput($0) }
            for spec in specs {
                let input = try AVCaptureDeviceInput(device: spec.device)
                guard session.canAddInput(input) else { throw NativeError(.io, "multicam input") }
                session.addInputWithNoConnections(input)
                guard session.canAddOutput(spec.output) else { throw NativeError(.io, "multicam output") }
                session.addOutputWithNoConnections(spec.output)
                try setFormat(spec.device, preset: spec.preset, fps: spec.fps, multi: true, focusFar: spec.focusFar)
                guard let port = input.ports(for: .video, sourceDeviceType: spec.device.deviceType, sourceDevicePosition: spec.device.position).first else {
                    throw NativeError(.io, "multicam port")
                }
                let conn = AVCaptureConnection(inputPorts: [port], output: spec.output)
                guard session.canAddConnection(conn) else { throw NativeError(.io, "multicam connection") }
                session.addConnection(conn)
                setupRecording(conn, output: spec.output, angle: spec.angle)
                for layer in spec.layers {
                    let lc = AVCaptureConnection(inputPort: port, videoPreviewLayer: layer)
                    guard session.canAddConnection(lc) else { continue }
                    session.addConnection(lc)
                    if lc.isVideoRotationAngleSupported(spec.angle) { lc.videoRotationAngle = spec.angle }
                }
            }
            // 音は後ろの動画に入れる
            if audio, let mainOut = specs.first?.output, let mic = AVCaptureDevice.default(for: .audio),
               let micIn = try? AVCaptureDeviceInput(device: mic), session.canAddInput(micIn) {
                session.addInputWithNoConnections(micIn)
                if let port = micIn.ports.first(where: { $0.mediaType == .audio }) {
                    let ac = AVCaptureConnection(inputPorts: [port], output: mainOut)
                    if session.canAddConnection(ac) { session.addConnection(ac) }
                }
            }
        } catch {
            failed = error as? NativeError ?? NativeError(.io, error.localizedDescription)
        }
        session.commitConfiguration()
        if let failed { throw failed }
        // 同時に撮るには重すぎる組み合わせ (画質を下げる必要がある)
        if session.hardwareCost > 1.0 { throw NativeError(.io, "multicam-cost") }
        if !session.isRunning { session.startRunning() }
    }

    private func beginSegment(_ c: Channel) {
        guard wantRecording, c.active, !c.writing else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("cam-\(c.name)-\(UUID().uuidString).mov")
        c.currentStartWallMs = nil
        c.writing = true
        // 録画の始め・止めも、組み立てと同じカメラ用の列で行う (主スレッドで始めると、組み立てと鍵の取り合いになって固まった)
        let out = Box(value: c.output), me = Box(value: self as AVCaptureFileOutputRecordingDelegate)
        queue.async { out.value.startRecording(to: url, recordingDelegate: me.value) }
    }

    /// 止める。path (後ろ)・frontPath (前) があれば、撮ったファイルを LapTimer/ の下のその場所へ移す (続きは _2・_3 を付ける)
    private func stop(path: String?, frontPath: String?, done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        wantRecording = false
        isoTimer?.invalidate()
        isoTimer = nil
        let finish = { [weak self] in
            guard let self else { return }
            self.hidePreview()
            let session = Box(value: self.session)
            self.queue.async { if session.value.isRunning { session.value.stopRunning() } }
            let files = self.moveSegments(self.main, path: path)
            let frontFiles = self.moveSegments(self.front, path: frontPath ?? path.map { Self.frontPath($0) })
            self.main.active = false
            self.front.active = false
            done(.success(["files": files, "frontFiles": frontFiles]))
        }
        let busy = channels.filter { $0.writing }
        if busy.isEmpty {
            finish()
        } else {
            stopWaiters.append(finish)
            stopOutputs(busy)
        }
    }

    private static func frontPath(_ path: String) -> String {
        let ns = path as NSString
        return "\(ns.deletingPathExtension)_front.\(ns.pathExtension)"
    }

    private func moveSegments(_ c: Channel, path: String?) -> [[String: Any]] {
        let segs = c.segments
        c.segments = []
        var files: [[String: Any]] = []
        let fm = FileManager.default
        for (i, seg) in segs.enumerated() {
            var url = seg.url
            var rel: String? = nil
            if let path {
                // 同じ名前がもうあれば、名前に _v2・_v3 を付けて置く (上書きしない)
                var candidate = Self.indexedPath(path, index: i)
                var n = 2
                while let dest = Self.lapTimerURL(candidate, index: 0), fm.fileExists(atPath: dest.path), n < 50 {
                    let ns = Self.indexedPath(path, index: i) as NSString
                    candidate = "\(ns.deletingPathExtension)_v\(n).\(ns.pathExtension)"
                    n += 1
                }
                if let dest = Self.lapTimerURL(candidate, index: 0) {
                    try? fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                    do {
                        try fm.moveItem(at: seg.url, to: dest)
                        url = dest
                        rel = candidate
                    } catch {
                        DebugLog.write("camera: could not move \(seg.url.lastPathComponent) to \(candidate): \(error.localizedDescription)")
                    }
                }
                // 移せなかった動画は、走行に書かない (一時フォルダは消えるので、無い動画を指してしまう)
                if rel == nil { continue }
            }
            let asset = AVURLAsset(url: url)
            let duration = CMTimeGetSeconds(asset.duration)
            let bytes = (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
            files.append([
                "path": rel ?? url.lastPathComponent,
                "startWallMs": seg.startWallMs, "durationSec": duration.isFinite ? duration : 0, "bytes": bytes
            ])
        }
        return files
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

    private func startIsoLoop() {
        isoTimer?.invalidate()
        isoTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.adjustExposure() }
        }
    }

    private func adjustExposure() {
        for c in channels where c.active {
            guard let dev = c.device, let target = c.isoTarget else { continue }
            let d = Box(value: dev), frameSec = c.frameSec
            // カメラの設定は、組み立てと同じ列で 1 つずつ行う (レンズを替えている最中に触ると落ちるため)
            queue.async { Self.adjust(d.value, target: target, frameSec: frameSec) }
        }
    }

    nonisolated private static func adjust(_ dev: AVCaptureDevice, target: Float, frameSec: Double) {
        // ISO を決められない (手動の露出に対応していない) レンズでは、自動のまま
        guard dev.isExposureModeSupported(.custom), (try? dev.lockForConfiguration()) != nil else { return }
        defer { dev.unlockForConfiguration() }
        let f = dev.activeFormat
        let iso = min(max(target, f.minISO), f.maxISO)
        // 今の明るさのずれ (EV)。正なら明るすぎる
        let offset = Double(dev.exposureTargetOffset)
        let cur = CMTimeGetSeconds(dev.exposureDuration)
        let lo = CMTimeGetSeconds(f.minExposureDuration), hi = min(frameSec, CMTimeGetSeconds(f.maxExposureDuration))
        guard lo.isFinite, hi.isFinite, hi >= lo else { return }
        var next = cur.isFinite && cur > 0 && offset.isFinite ? cur * pow(2, -offset * 0.6) : frameSec / 2
        next = min(max(next, lo), hi)
        dev.setExposureModeCustom(duration: CMTime(seconds: next, preferredTimescale: 1_000_000), iso: iso, completionHandler: nil)
    }

    // MARK: - プレビュー (撮り始めの 5 秒だけ、右上に小さく)

    private func showPreview(_ layer: AVCaptureVideoPreviewLayer, angle: CGFloat) {
        guard previewView == nil,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first?.windows.first(where: \.isKeyWindow) else { return }
        let w: CGFloat = 160
        let portrait = angle == 90 || angle == 270
        let size = portrait ? CGSize(width: w * 9 / 16, height: w) : CGSize(width: w, height: w * 9 / 16)
        let view = UIView(frame: CGRect(x: window.bounds.width - size.width - 12, y: window.safeAreaInsets.top + 60, width: size.width, height: size.height))
        view.layer.cornerRadius = 10
        view.clipsToBounds = true
        view.layer.borderWidth = 2
        view.layer.borderColor = UIColor.systemRed.cgColor
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        if let conn = layer.connection, conn.isVideoRotationAngleSupported(angle) { conn.videoRotationAngle = angle }
        window.addSubview(view)
        previewView = view
        // 5 秒たったら見えなくするだけ (層を外すとカメラのつなぎが変わり、前と後ろを同時に撮っているときは録画が止まっていた)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak view] in view?.isHidden = true }
    }

    /// 撮り始めの小さな映像を外す (録画を止めたあと)
    private func hidePreview() {
        previewView?.removeFromSuperview()
        previewView = nil
    }

    // MARK: - 撮る前の確かめ (設定の画面の枠に映像を出し、ISO をその場で変える)

    private static func rect(_ any: Any?) -> CGRect {
        let r = any as? [String: Any] ?? [:]
        return CGRect(x: r["x"] as? Double ?? 0, y: r["y"] as? Double ?? 0, width: r["w"] as? Double ?? 0, height: r["h"] as? Double ?? 0)
    }

    private func livePreview(params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard params["show"] as? Bool ?? false else {
            liveRequested = nil
            hideLive()
            if !wantRecording {
                isoTimer?.invalidate()
                isoTimer = nil
                main.active = false
                front.active = false
                let s = Box(value: session)
                queue.async { if s.value.isRunning { s.value.stopRunning() } }
            }
            done(.success([:]))
            return
        }
        guard !wantRecording else { done(.failure(NativeError(.busy, "recording"))); return }
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { done(.failure(NativeError(.permissionDenied, "camera"))); return }
        let mainRect = Self.rect(params["rect"])
        let wantLens = params["lensId"] as? String
        let preset = params["preset"] as? String ?? "1080p30"
        let iso = (params["iso"] as? Double).map { Float($0) }
        let all = Self.lenses()
        guard let lens = all.first(where: { $0.id == wantLens }) ?? all.first(where: { $0.kind == "wide" }) ?? all.first else {
            done(.failure(NativeError(.notFound, "no camera"))); return
        }
        let fd = params["front"] as? [String: Any]
        var fp = Self.frontParams(fd)
        let fLens = fp != nil && lens.position == "back" && AVCaptureMultiCamSession.isMultiCamSupported ? frontLens() : nil
        if fLens == nil { fp = nil }
        let frontRect = Self.rect(fd?["rect"])
        let spec = Self.presetSpecs[preset] ?? Self.presetSpecs["1080p30"]!
        let mainAngle = Self.rotationAngle(for: lens.device)
        focusFar = params["focusFar"] as? Bool ?? true
        main.ev = Float(params["ev"] as? Double ?? 0)
        let config = "\(lens.id)|\(preset)|\(fp?.preset ?? "-")|\(focusFar)"
        liveRequested = config
        liveLatest = (mainRect, frontRect, iso, fp?.iso, fp?.ev ?? 0)
        // 同じ組み立てをしている最中なら、組み直さない (終わったら、最後に頼まれた置き場所に置く)
        if liveBuilding == config { done(.success([:])); return }
        Task { @MainActor in
            // 待っている間に撮り始めた・消す頼み・別の組み立ての頼みが来ていたら、何もしない
            guard !self.wantRecording, self.liveRequested == config else { done(.success([:])); return }
            self.useSession(multi: fp != nil)
            if self.liveConfig != config || !self.session.isRunning {
                self.liveBuilding = config
                defer { self.liveBuilding = nil }
                // 組み直す間は、ISO を保つ調整を止める
                self.isoTimer?.invalidate()
                self.isoTimer = nil
                self.main.device = lens.device
                self.main.active = true
                self.main.frameSec = 1 / spec.fps
                self.main.angle = mainAngle
                self.front.active = fp != nil
                self.front.device = fLens?.device
                var specs: [Spec] = []
                if self.isMulti {
                    // 同時に撮るときは、層ごとにつなぎを作るので、層も作り直す
                    self.hideLive()
                    self.makeLive(self.main)
                    self.makeLive(self.front)
                }
                specs.append(Spec(device: lens.device, output: self.main.output, preset: preset, fps: spec.fps, angle: mainAngle,
                                  layers: self.isMulti ? self.main.liveLayer.map { [$0] } ?? [] : []))
                if let fp, let fLens {
                    let fs = Self.presetSpecs[fp.preset] ?? Self.presetSpecs["1080p30"]!
                    self.front.frameSec = 1 / fs.fps
                    self.front.angle = Self.rotationAngle(for: fLens.device)
                    specs.append(Spec(device: fLens.device, output: self.front.output, preset: fp.preset, fps: fs.fps, angle: self.front.angle,
                                      layers: self.front.liveLayer.map { [$0] } ?? []))
                }
                if let error = await self.build(specs, audio: false) {
                    self.liveConfig = nil
                    done(.failure(error))
                    return
                }
                self.liveConfig = config
            }
            // 待っている間に、撮り始めた・次の頼み (別のレンズ・消す) が来ていたら、そちらに任せる
            guard !self.wantRecording, self.liveRequested == config else { done(.success([:])); return }
            let latest = self.liveLatest
            self.placeLive(self.main, latest.main)
            self.applyIso(self.main, latest.iso)
            self.applyEv(self.main)
            if fp != nil {
                self.placeLive(self.front, latest.front)
                self.applyIso(self.front, latest.frontIso)
                self.front.ev = latest.frontEv
                self.applyEv(self.front)
            }
            self.startExposureReports()
            done(.success([:]))
        }
    }

    private func makeLive(_ c: Channel) {
        guard c.liveView == nil,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first?.windows.first(where: \.isKeyWindow) else { return }
        let view = UIView()
        view.layer.cornerRadius = 10
        view.clipsToBounds = true
        view.backgroundColor = .black
        view.isHidden = true
        let layer = makeLayer()
        layer.videoGravity = .resizeAspect
        view.layer.addSublayer(layer)
        // 映像は見るだけ (押しても下の画面のボタンに届くように)
        view.isUserInteractionEnabled = false
        window.addSubview(view)
        c.liveView = view
        c.liveLayer = layer
    }

    /// 窓の中の WKWebView を探す
    private static func findWebView(in view: UIView?) -> WKWebView? {
        guard let view else { return nil }
        if let web = view as? WKWebView { return web }
        for sub in view.subviews { if let web = findWebView(in: sub) { return web } }
        return nil
    }

    private func placeLive(_ c: Channel, _ rect: CGRect) {
        makeLive(c)
        let angle = c.angle
        // Web の CSS の座標は WKWebView の中の座標。WKWebView は折りたたみの iPhone では内側に寄せてある (WebHost) ので、窓の座標に直す
        if let view = c.liveView, let web = Self.findWebView(in: view.superview) {
            view.frame = web.convert(rect, to: view.superview)
        } else {
            c.liveView?.frame = rect
        }
        c.liveView?.isHidden = rect.width < 4 || rect.height < 4
        c.liveLayer?.frame = CGRect(origin: .zero, size: rect.size)
        if let conn = c.liveLayer?.connection, conn.isVideoRotationAngleSupported(angle) { conn.videoRotationAngle = angle }
        // 映像の枠のつなぎは、作ったあと少し遅れてできることがあるので、もう一度決める
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if let conn = c.liveLayer?.connection, conn.isVideoRotationAngleSupported(angle), conn.videoRotationAngle != angle { conn.videoRotationAngle = angle }
        }
    }

    private func hideLive() {
        exposureTimer?.invalidate()
        exposureTimer = nil
        for c in channels {
            c.liveView?.removeFromSuperview()
            c.liveView = nil
            c.liveLayer = nil
        }
        liveConfig = nil
    }

    /// 明るさの補正 (EV) を入れる (そのレンズの範囲に収める)
    private func applyEv(_ c: Channel) {
        guard let dev = c.device else { return }
        let d = Box(value: dev), ev = c.ev
        queue.async {
            guard (try? d.value.lockForConfiguration()) != nil else { return }
            defer { d.value.unlockForConfiguration() }
            let bias = min(max(ev, d.value.minExposureTargetBias), d.value.maxExposureTargetBias)
            d.value.setExposureTargetBias(bias, completionHandler: nil)
        }
    }

    /// ISO を決める (nil は自動)。決めたときは、シャッターの速さで明るさを保つ
    private func applyIso(_ c: Channel, _ iso: Float?) {
        c.isoTarget = iso
        if channels.contains(where: { $0.active && $0.isoTarget != nil }) {
            if isoTimer == nil { startIsoLoop() }
        } else {
            isoTimer?.invalidate()
            isoTimer = nil
        }
        if iso == nil, let dev = c.device {
            let d = Box(value: dev)
            queue.async {
                guard d.value.isExposureModeSupported(.continuousAutoExposure), (try? d.value.lockForConfiguration()) != nil else { return }
                d.value.exposureMode = .continuousAutoExposure
                d.value.unlockForConfiguration()
            }
        }
    }

    /// 今の ISO とシャッターの速さを、Web に知らせる (枠の下に出す)
    private func startExposureReports() {
        guard exposureTimer == nil else { return }
        exposureTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                for c in self.channels where c.active {
                    guard let dev = c.device else { continue }
                    // レンズを替えた直後は、シャッターの速さが数でない (NaN) ことがある。数でないものは送らない (JSON にできず落ちるため)
                    let iso = Double(dev.iso), shutter = CMTimeGetSeconds(dev.exposureDuration)
                    guard iso.isFinite, shutter.isFinite else { continue }
                    self.core.emit("camera.exposure", ["iso": iso, "shutterSec": shutter, "which": c.name])
                }
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
        if interruptObservers.isEmpty { resetInterruptObserver() }
    }

    /// 裏から戻った・電話が終わったら、続きを撮る (ファイルは分かれる)。カメラのまとまりを替えたら、見張り直す
    private func resetInterruptObserver() {
        interruptObservers.forEach { NotificationCenter.default.removeObserver($0) }
        let s = session
        interruptObservers = [
        NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: s, queue: .main) { note in
            let e = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
            DebugLog.write("camera: session runtime error \(e?.code ?? 0) \(e?.localizedDescription ?? "")")
        },
        NotificationCenter.default.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: s, queue: .main) { note in
            let reason = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int ?? -1
            DebugLog.write("camera: session interrupted reason=\(reason)")
        },NotificationCenter.default.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.wantRecording else { return }
                let s = Box(value: self.session)
                self.queue.async { if !s.value.isRunning { s.value.startRunning() } }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    for c in self.channels where c.active { self.beginSegment(c) }
                }
            }
        }]
    }

    private func thermalChanged() {
        let s = ProcessInfo.processInfo.thermalState
        let name = s == .critical ? "critical" : s == .serious ? "serious" : s == .fair ? "fair" : "nominal"
        if s == .critical && wantRecording {
            // 熱すぎる: 録画だけ止める (ログの記録は Web が続ける)。撮ったファイルは、測定終了のときに移す
            wantRecording = false
            stopOutputs(channels.filter { $0.writing })
            core.emit("camera.state", ["recording": false, "error": "thermal", "thermal": name])
        } else {
            core.emit("camera.state", ["recording": recording, "thermal": name])
        }
    }

    private func stopOutputs(_ list: [Channel]) {
        let outs = Box(value: list.map(\.output))
        queue.async { outs.value.forEach { $0.stopRecording() } }
    }

    private func channel(for output: AVCaptureFileOutput) -> Channel? {
        channels.first { $0.output === output }
    }
}

extension CameraModule: AVCaptureFileOutputRecordingDelegate {
    nonisolated func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
        let now = Date().timeIntervalSince1970 * 1000
        let out = Box(value: output)
        Task { @MainActor in
            guard let c = self.channel(for: out.value) else { return }
            // iOS 18 からは、先頭のコマの時刻 (startPTS) で決め直す (下)
            if c.currentStartWallMs == nil { c.currentStartWallMs = now }
            if c === self.main {
                self.recording = true
                self.core.emit("camera.state", ["recording": true])
            }
        }
    }

    @available(iOS 18.0, *)
    nonisolated func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, startPTS: CMTime, from connections: [AVCaptureConnection]) {
        // 先頭のコマの時刻 (ホストの時計) と今の差だけ、端末の時計を戻す
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        let age = CMTimeGetSeconds(CMTimeSubtract(hostNow, startPTS))
        let wall = Date().timeIntervalSince1970 * 1000 - (age.isFinite && age > 0 && age < 5 ? age * 1000 : 0)
        let out = Box(value: output)
        Task { @MainActor in
            guard let c = self.channel(for: out.value) else { return }
            c.currentStartWallMs = wall
            if c === self.main {
                self.recording = true
                self.core.emit("camera.state", ["recording": true])
            }
        }
    }

    nonisolated func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        // 止めた・止まった (裏に回った・熱・容量)。中身が書けていれば残す
        let ok = error == nil || ((error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? false)
        let message = error?.localizedDescription
        let out = Box(value: output)
        Task { @MainActor in
            guard let c = self.channel(for: out.value) else { return }
            if ok, FileManager.default.fileExists(atPath: outputFileURL.path) {
                c.segments.append((outputFileURL, c.currentStartWallMs ?? Date().timeIntervalSince1970 * 1000))
            }
            if let message, !ok { DebugLog.write("camera(\(c.name)): recording failed \(message)") }
            if self.wantRecording { DebugLog.write("camera(\(c.name)): recording ended by itself ok=\(ok) \(message ?? "")") }
            if c === self.main { self.recording = false }
            // 全部のカメラが止まるまで待つ
            c.writing = false
            guard !self.channels.contains(where: { $0.writing }) else { return }
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
