package io.github.oud0n.laploupe

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Range
import android.view.View
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 内蔵カメラでの録画 (ラップタイマーの測定開始で撮り始め、終了で止める。2026-10-25。iPhone の CameraModule.swift と同じ約束)。
 *
 * - CameraX で撮る (MP4。ファイル名は Web が渡した .mov を .mp4 に替えて置き、その名前を返す)
 * - レンズ: 後ろのカメラ (広角 1×、ズームで 1 より広く撮れる機種は超広角) と前のカメラ
 * - 画質: 1080p / 4K、30 / 60 fps (その機種が撮れるもの)
 * - ISO を決めてシャッターで明るさを合わせる (iPhone の ISO 優先) は、Android のカメラには無いので、この版は自動だけ (isoMax を 0 にして、Web は ISO の欄を出さない)
 * - 前と後ろを同時に撮るのは、この版ではしない (multiCam: false)
 * - 向きは撮り始めたときの画面の向き。止まったら (裏に回ったなど) 戻ったときに続きを撮る (ファイルは分かれる)
 * - 熱くなりすぎたら (THERMAL_STATUS_SEVERE 以上) 録画を止めて、ログの記録は続ける
 */
@SuppressLint("MissingPermission")
@OptIn(ExperimentalCamera2Interop::class)
class CameraModule(private val activity: MainActivity, private val bridge: NativeBridge) {
    private val main = Handler(Looper.getMainLooper())
    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var recorder: Recorder? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var preview: Preview? = null
    private var recording: Recording? = null
    private var wantRecording = false
    private var audio = false
    /** 撮り終えたファイル (止まるたびに足す) */
    private val segments = mutableListOf<Pair<File, Long>>()
    private var currentStart: Long? = null
    private var stopWaiter: (() -> Unit)? = null
    /** 確かめの映像・撮り始めの 5 秒の映像 */
    private var liveView: PreviewView? = null
    private var smallView: PreviewView? = null
    private var liveConfig: String? = null
    private var lastExposureEmit = 0L
    /** 今の組み立て (つなぎ直しに使う) */
    private var current: Config? = null

    data class Config(val lens: Lens, val preset: String, val withPreview: Boolean, val focusFar: Boolean = true)

    /** 明るさの補正 (EV)。露出は自動のまま、全体を明るめ・暗めにする */
    private var ev = 0.0

    /** zoom は画面に出す倍率 (丸めたもの)、ratio はカメラに渡す本当の倍率 */
    data class Lens(val id: String, val cameraIndex: Int, val front: Boolean, val kind: String, val zoom: Float, val presets: List<String>, val ratio: Float = zoom)

    private val thermalListener = PowerManager.OnThermalStatusChangedListener { status ->
        main.post {
            val name = when { status >= PowerManager.THERMAL_STATUS_CRITICAL -> "critical"; status >= PowerManager.THERMAL_STATUS_SEVERE -> "serious"; status >= PowerManager.THERMAL_STATUS_MODERATE -> "fair"; else -> "nominal" }
            if (status >= PowerManager.THERMAL_STATUS_SEVERE && wantRecording) {
                // 熱すぎる: 録画だけ止める (ログの記録は Web が続ける)。撮ったファイルは測定終了のときに移す
                wantRecording = false
                recording?.stop()
                bridge.emit("camera.state", JSONObject().put("recording", false).put("error", "thermal").put("thermal", name))
            } else {
                bridge.emit("camera.state", JSONObject().put("recording", recording != null).put("thermal", name))
            }
        }
    }

    init {
        (activity.getSystemService(Context.POWER_SERVICE) as PowerManager).addThermalStatusListener(activity.mainExecutor, thermalListener)
    }

    fun handle(method: String, params: JSONObject, done: Done) {
        when (method) {
            "camera.permission" -> permission(params.optBoolean("request"), params.optBoolean("audio"), done)
            "camera.lenses" -> withProvider(done) { done(Result.success(JSONObject().put("lenses", JSONArray(lenses().map(::lensJson))).put("multiCam", false))) }
            "camera.start" -> withProvider(done) { start(params, done) }
            "camera.stop" -> stop(params.optString("path").ifEmpty { null }, params.optString("frontPath").ifEmpty { null }, done)
            "camera.preview" -> withProvider(done) { livePreview(params, done) }
            // ISO は自動だけ (明るさは補正 (EV) で変える)
            "camera.setIso" -> done(Result.success(JSONObject()))
            "camera.setEv" -> { ev = params.optDouble("ev", 0.0); applyEv(); done(Result.success(JSONObject())) }
            else -> done(Result.failure(NativeError.notSupported("unknown method $method")))
        }
    }

    // ---- 許可 ----

    private fun state(p: String) = if (ContextCompat.checkSelfPermission(activity, p) == PackageManager.PERMISSION_GRANTED) "granted" else "unknown"

    private fun permission(request: Boolean, wantAudio: Boolean, done: Done) {
        val report = {
            done(Result.success(JSONObject().put("camera", state(Manifest.permission.CAMERA)).put("mic", state(Manifest.permission.RECORD_AUDIO))))
        }
        if (!request) { report(); return }
        val perms = listOfNotNull(Manifest.permission.CAMERA, if (wantAudio) Manifest.permission.RECORD_AUDIO else null).toTypedArray()
        activity.withPermissions(perms) { _ ->
            val cam = state(Manifest.permission.CAMERA)
            val mic = state(Manifest.permission.RECORD_AUDIO)
            // 断られたら denied (聞き直しても OS が出さないことがあるため、Web は設定へ案内する)
            done(Result.success(JSONObject().put("camera", if (cam == "granted") cam else "denied").put("mic", if (mic == "granted") mic else if (wantAudio) "denied" else "unknown")))
        }
    }

    private fun withProvider(done: Done, work: () -> Unit) {
        provider?.let { work(); return }
        val f = ProcessCameraProvider.getInstance(activity)
        f.addListener({
            try { provider = f.get(); work() } catch (e: Exception) { done(Result.failure(NativeError.io(e.message ?: "camera"))) }
        }, ContextCompat.getMainExecutor(activity))
    }

    // ---- レンズ ----

    private fun lenses(): List<Lens> {
        val p = provider ?: return emptyList()
        val out = mutableListOf<Lens>()
        val infos = p.availableCameraInfos
        // 後ろ・前それぞれ、いちばん先のカメラ (論理カメラ。ズームで超広角・望遠に切り替わる機種が多い)
        val back = infos.indexOfFirst { it.lensFacing == CameraSelector.LENS_FACING_BACK }
        val front = infos.indexOfFirst { it.lensFacing == CameraSelector.LENS_FACING_FRONT }
        if (back >= 0) {
            val info = infos[back]
            val presets = presets(info)
            val minZoom = info.zoomState.value?.minZoomRatio ?: 1f
            // 渡す倍率は本当の値のまま (丸めると、撮れる範囲の外になって 1× のままになっていた)
            if (minZoom < 0.9f) out.add(Lens("back@$minZoom", back, false, "ultraWide", Math.round(minZoom * 10) / 10f, presets, minZoom))
            out.add(Lens("back@1", back, false, "wide", 1f, presets))
        }
        if (front >= 0) out.add(Lens("front", front, true, "front", 1f, presets(infos[front])))
        return out
    }

    private fun presets(info: CameraInfo): List<String> {
        val caps = Recorder.getVideoCapabilities(info)
        val qualities = caps.getSupportedQualities(androidx.camera.core.DynamicRange.SDR)
        val fps60 = info.supportedFrameRateRanges.any { it.upper >= 60 }
        val out = mutableListOf<String>()
        if (Quality.FHD in qualities) { out.add("1080p30"); if (fps60) out.add("1080p60") }
        if (Quality.UHD in qualities) { out.add("2160p30"); if (fps60) out.add("2160p60") }
        if (out.isEmpty()) out.add("1080p30")
        return out
    }

    private fun lensJson(l: Lens) = JSONObject()
        .put("id", l.id).put("position", if (l.front) "front" else "back").put("kind", l.kind).put("zoom", l.zoom.toDouble())
        // ISO は自動だけ (0 なら Web は ISO の欄を出さない)
        .put("isoMin", 0).put("isoMax", 0)
        .put("presets", JSONArray(l.presets)).put("multiCamPresets", JSONArray())

    private fun findLens(id: String?): Lens? {
        val all = lenses()
        return all.firstOrNull { it.id == id } ?: all.firstOrNull { it.kind == "wide" } ?: all.firstOrNull()
    }

    // ---- 組み立て ----

    /** 使い方 (録画・映像) を組み立ててカメラにつなぐ */
    private fun bind(config: Config) {
        val p = provider ?: return
        p.unbindAll()
        val (quality, fps) = when (config.preset) {
            "2160p30" -> Quality.UHD to 30
            "2160p60" -> Quality.UHD to 60
            "1080p60" -> Quality.FHD to 60
            else -> Quality.FHD to 30
        }
        // 撮れなければ近い画質へ (4K → 1080p → 720p → 480p。安い機種・エミュレーターは 1080p で撮れないことがある)
        val order = listOf(quality, Quality.FHD, Quality.HD, Quality.SD).distinct()
        val rec = Recorder.Builder().setQualitySelector(QualitySelector.fromOrderedList(order, androidx.camera.video.FallbackStrategy.lowerQualityOrHigherThan(Quality.SD))).build()
        val rotation = activity.display?.rotation ?: 0
        val vcBuilder = VideoCapture.Builder(rec).setTargetRotation(rotation)
        val far = config.focusFar && manualFocus(p.availableCameraInfos[config.lens.cameraIndex])
        if (far) lockFocusFar(Camera2Interop.Extender(vcBuilder))
        val info = p.availableCameraInfos[config.lens.cameraIndex]
        info.supportedFrameRateRanges.firstOrNull { it.lower == fps && it.upper == fps }?.let { vcBuilder.setTargetFrameRate(Range(fps, fps)) }
        val vc = vcBuilder.build()
        val useCases = mutableListOf<androidx.camera.core.UseCase>(vc)
        var pv: Preview? = null
        if (config.withPreview) {
            val b = Preview.Builder().setTargetRotation(rotation)
            if (far) lockFocusFar(Camera2Interop.Extender(b))
            // 今の ISO とシャッターの速さを読む (Web の確かめの欄に出す)
            Camera2Interop.Extender(b).setSessionCaptureCallback(object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
                    val now = System.currentTimeMillis()
                    if (now - lastExposureEmit < 300) return
                    lastExposureEmit = now
                    val iso = result.get(CaptureResult.SENSOR_SENSITIVITY) ?: return
                    val ns = result.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: return
                    main.post { if (liveView != null) bridge.emit("camera.exposure", JSONObject().put("iso", iso).put("shutterSec", ns / 1e9).put("which", "main")) }
                }
            })
            pv = b.build()
            useCases.add(pv)
        }
        val selector = CameraSelector.Builder().requireLensFacing(if (config.lens.front) CameraSelector.LENS_FACING_FRONT else CameraSelector.LENS_FACING_BACK).build()
        camera = p.bindToLifecycle(activity, selector, *useCases.toTypedArray())
        camera?.cameraControl?.setZoomRatio(config.lens.ratio)
        applyEv()
        recorder = rec
        videoCapture = vc
        preview = pv
        current = config
        (liveView ?: smallView)?.let { pv?.surfaceProvider = it.surfaceProvider }
    }

    /** ピントの距離を決められるレンズか (固定焦点のレンズは決められない) */
    private fun manualFocus(info: CameraInfo): Boolean = try {
        (androidx.camera.camera2.interop.Camera2CameraInfo.from(info).getCameraCharacteristic(android.hardware.camera2.CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f) > 0f
    } catch (e: Exception) { false }

    /** ピントを遠く (無限遠 = 距離 0) に固定する (車載で、車内の物にピントが移らないように) */
    private fun <T> lockFocusFar(ext: Camera2Interop.Extender<T>) {
        ext.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
        ext.setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, 0f)
    }

    /** 明るさの補正を入れる (そのカメラの刻み・範囲に合わせる) */
    private fun applyEv() {
        val cam = camera ?: return
        val st = cam.cameraInfo.exposureState
        if (!st.isExposureCompensationSupported) return
        val step = st.exposureCompensationStep.toFloat()
        if (step <= 0f) return
        val idx = kotlin.math.round(ev / step).toInt().coerceIn(st.exposureCompensationRange.lower, st.exposureCompensationRange.upper)
        cam.cameraControl.setExposureCompensationIndex(idx)
    }

    // ---- 撮る ----

    private fun start(params: JSONObject, done: Done) {
        if (wantRecording) { done(Result.failure(NativeError.busy("already recording"))); return }
        if (state(Manifest.permission.CAMERA) != "granted") { done(Result.failure(NativeError.denied("camera"))); return }
        val lens = findLens(params.optString("lensId").ifEmpty { null }) ?: run { done(Result.failure(NativeError.notFound("no camera"))); return }
        val preset = params.optString("preset", "1080p30").let { if (it in lens.presets) it else lens.presets.first() }
        audio = params.optBoolean("audio") && state(Manifest.permission.RECORD_AUDIO) == "granted"
        val showSmall = params.optBoolean("preview")
        ev = params.optDouble("ev", 0.0)
        val focusFar = params.optBoolean("focusFar", true)
        hideLive()
        segments.clear()
        wantRecording = true
        try {
            if (showSmall) showSmall()
            bind(Config(lens, preset, withPreview = showSmall, focusFar = focusFar))
            beginSegment()
        } catch (e: Exception) {
            wantRecording = false
            hideSmall()
            done(Result.failure(NativeError.io(e.message ?: "camera")))
            return
        }
        done(Result.success(JSONObject().put("lensId", lens.id).put("preset", preset).put("front", false)))
    }

    private fun beginSegment() {
        val vc = videoCapture ?: return
        if (!wantRecording || recording != null) return
        val file = File(activity.cacheDir, "cam-${System.currentTimeMillis()}.mp4")
        currentStart = null
        var pending = vc.output.prepareRecording(activity, FileOutputOptions.Builder(file).build())
        if (audio) pending = pending.withAudioEnabled()
        recording = pending.start(ContextCompat.getMainExecutor(activity)) { e ->
            when (e) {
                is VideoRecordEvent.Start -> {
                    currentStart = System.currentTimeMillis()
                    bridge.emit("camera.state", JSONObject().put("recording", true))
                }
                is VideoRecordEvent.Finalize -> {
                    recording = null
                    // 止めた・止まった (裏に回った・熱・容量)。中身が書けていれば残す
                    if (file.exists() && file.length() > 0 && e.error != VideoRecordEvent.Finalize.ERROR_NO_VALID_DATA) {
                        segments.add(file to (currentStart ?: System.currentTimeMillis()))
                    }
                    if (e.hasError()) DebugLog.event("camera: finalize error ${e.error} ${e.cause?.message}")
                    val w = stopWaiter
                    stopWaiter = null
                    if (w != null) w()
                    else if (wantRecording) bridge.emit("camera.state", JSONObject().put("recording", false).put("error", "interrupted"))
                }
            }
        }
    }

    /** 裏から戻ったとき: 撮っている途中なら、続きを撮る (ファイルは分かれる) */
    fun onResume() {
        if (!wantRecording || recording != null) return
        main.postDelayed({
            if (!wantRecording || recording != null) return@postDelayed
            try { current?.let { bind(it) }; beginSegment() } catch (e: Exception) { DebugLog.event("camera: resume failed ${e.message}") }
        }, 500)
    }

    private fun stop(path: String?, frontPath: String?, done: Done) {
        wantRecording = false
        val finish = {
            hideSmall()
            provider?.unbindAll()
            camera = null
            val files = JSONArray()
            for ((i, seg) in segments.withIndex()) {
                val (file, startMs) = seg
                var dest = file
                var rel: String = file.name
                if (path != null) {
                    // MP4 で撮っているので、.mov を .mp4 にして置く
                    rel = indexedPath(path.replace(Regex("\\.mov$", RegexOption.IGNORE_CASE), ".mp4"), i)
                    val target = lapTimerFile(rel)
                    val moved = target != null && try {
                        target.parentFile?.mkdirs()
                        file.renameTo(target) || run { file.copyTo(target, overwrite = true); file.delete(); true }
                    } catch (e: Exception) { DebugLog.event("camera: could not move ${file.name}: ${e.message}"); false }
                    // 移せなかった動画は、走行に書かない (無い動画を指してしまう)
                    if (!moved) continue
                    dest = target!!
                }
                files.put(JSONObject().put("path", rel).put("startWallMs", startMs).put("durationSec", durationSec(dest)).put("bytes", dest.length()))
            }
            segments.clear()
            done(Result.success(JSONObject().put("files", files).put("frontFiles", JSONArray())))
        }
        val r = recording
        if (r != null) { stopWaiter = finish; r.stop() } else finish()
    }

    private fun durationSec(f: File): Double = try {
        val m = android.media.MediaMetadataRetriever()
        m.setDataSource(f.absolutePath)
        val ms = m.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        m.release()
        ms / 1000.0
    } catch (e: Exception) { 0.0 }

    private fun indexedPath(path: String, index: Int): String {
        if (index == 0) return path
        val dot = path.lastIndexOf('.')
        return if (dot < 0) "${path}_${index + 1}" else "${path.substring(0, dot)}_${index + 1}${path.substring(dot)}"
    }

    private fun lapTimerFile(rel: String): File? {
        if (rel.isEmpty() || rel.contains("..") || rel.startsWith("/")) return null
        return File(File(activity.filesDir, "LapTimer"), rel)
    }

    /** 画面を閉じるとき: 録画を止め、カメラを手放す */
    fun shutdown() {
        wantRecording = false
        try { recording?.stop() } catch (_: Exception) {}
        try { provider?.unbindAll() } catch (_: Exception) {}
        try { (activity.getSystemService(Context.POWER_SERVICE) as PowerManager).removeThermalStatusListener(thermalListener) } catch (_: Exception) {}
    }

    // ---- 映像 (確かめの映像・撮り始めの 5 秒) ----

    private fun makeView(): PreviewView = PreviewView(activity).apply {
        // TextureView で描く (見えなくしても面が残り、録画を止めずに済む)
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        scaleType = PreviewView.ScaleType.FIT_CENTER
        setBackgroundColor(android.graphics.Color.BLACK)
        isClickable = false
        isFocusable = false
        clipToOutline = true
        outlineProvider = object : android.view.ViewOutlineProvider() {
            override fun getOutline(view: View, outline: android.graphics.Outline) { outline.setRoundRect(0, 0, view.width, view.height, 10 * resources.displayMetrics.density) }
        }
    }

    private fun showSmall() {
        if (smallView != null) return
        val d = activity.resources.displayMetrics.density
        val portrait = activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT
        val w = 160 * d
        val (vw, vh) = if (portrait) (w * 9 / 16) to w else w to (w * 9 / 16)
        val v = makeView()
        val lp = FrameLayout.LayoutParams(vw.toInt(), vh.toInt()).apply {
            gravity = android.view.Gravity.TOP or android.view.Gravity.END
            topMargin = (60 * d).toInt(); rightMargin = (12 * d).toInt()
        }
        activity.overlay.addView(v, lp)
        smallView = v
        // 5 秒たったら見えなくするだけ (外すと映像のつなぎが変わり、録画が止まることがあるため)
        main.postDelayed({ smallView?.alpha = 0f }, 5000)
    }

    private fun hideSmall() {
        smallView?.let { activity.overlay.removeView(it) }
        smallView = null
    }

    private fun livePreview(params: JSONObject, done: Done) {
        if (!params.optBoolean("show")) {
            hideLive()
            if (!wantRecording) { provider?.unbindAll(); camera = null; current = null }
            done(Result.success(JSONObject()))
            return
        }
        if (wantRecording) { done(Result.failure(NativeError.busy("recording"))); return }
        if (state(Manifest.permission.CAMERA) != "granted") { done(Result.failure(NativeError.denied("camera"))); return }
        val lens = findLens(params.optString("lensId").ifEmpty { null }) ?: run { done(Result.failure(NativeError.notFound("no camera"))); return }
        val preset = params.optString("preset", "1080p30").let { if (it in lens.presets) it else lens.presets.first() }
        val r = params.optJSONObject("rect") ?: JSONObject()
        val d = activity.resources.displayMetrics.density
        // Web の CSS の座標 × 画面の密度 = WebView の中の位置 (WebView は overlay いっぱい)
        val x = (r.optDouble("x", 0.0) * d).toInt(); val y = (r.optDouble("y", 0.0) * d).toInt()
        val w = (r.optDouble("w", 0.0) * d).toInt(); val h = (r.optDouble("h", 0.0) * d).toInt()
        val view = liveView ?: makeView().also { activity.overlay.addView(it, FrameLayout.LayoutParams(1, 1)); liveView = it }
        view.layoutParams = FrameLayout.LayoutParams(maxOf(w, 1), maxOf(h, 1)).apply { leftMargin = x; topMargin = y }
        view.visibility = if (w < 4 || h < 4) View.INVISIBLE else View.VISIBLE
        ev = params.optDouble("ev", 0.0)
        val focusFar = params.optBoolean("focusFar", true)
        val config = "${lens.id}|$preset|$focusFar"
        try {
            if (liveConfig != config || camera == null) {
                bind(Config(lens, preset, withPreview = true, focusFar = focusFar))
                liveConfig = config
            }
            preview?.surfaceProvider = view.surfaceProvider
            applyEv()
        } catch (e: Exception) {
            done(Result.failure(NativeError.io(e.message ?: "camera")))
            return
        }
        done(Result.success(JSONObject()))
    }

    private fun hideLive() {
        liveView?.let { activity.overlay.removeView(it) }
        liveView = null
        liveConfig = null
    }
}
