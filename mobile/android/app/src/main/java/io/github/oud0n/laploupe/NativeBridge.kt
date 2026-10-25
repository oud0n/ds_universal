package io.github.oud0n.laploupe

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/** 約束のエラーの符号 (src/native/contract.ts の NativeErrorCode と同じ) */
class NativeError(val code: String, message: String = "") : Exception(message) {
    companion object {
        fun notSupported(m: String = "") = NativeError("not-supported", m)
        fun notFound(m: String = "") = NativeError("not-found", m)
        fun io(m: String = "") = NativeError("io", m)
        fun busy(m: String = "") = NativeError("busy", m)
        fun denied(m: String = "") = NativeError("permission-denied", m)
        fun notConnected(m: String = "") = NativeError("not-connected", m)
    }
}

typealias Done = (Result<JSONObject>) -> Unit

/**
 * Web とのやりとりの窓口 (約束は src/native/contract.ts。iPhone の NativeBridge.swift と同じ形)。
 * Web から: window.dsNativeAndroid.postMessage(JSON の文字列)。Web へ: window.dsNative.receive(JSON の文字列)
 */
class NativeBridge(private val activity: MainActivity, private val webView: WebView) {
    companion object {
        const val CONTRACT_VERSION = 1
    }

    private val main = Handler(Looper.getMainLooper())
    val system = SystemModule(activity, this)
    val spp = SppModule(activity, this)
    val ble = BleModule(activity, this)
    val camera = CameraModule(activity, this)
    val motion = MotionModule(activity, this)

    @JavascriptInterface
    fun postMessage(text: String) {
        // 主スレッドで受ける (アプリの画面のページからの呼び出しだけ)
        main.post {
            if (!MainActivity.isAppPage(webView.url)) return@post
            val req = try { JSONObject(text) } catch (e: Exception) { return@post }
            val id = req.optInt("id", -1)
            val method = req.optString("method")
            if (id < 0 || method.isEmpty()) return@post
            if (req.optInt("v") != CONTRACT_VERSION) {
                reply(id, Result.failure(NativeError.notSupported("contract version ${req.opt("v")}")))
                return@post
            }
            val params = req.optJSONObject("params") ?: JSONObject()
            val done: Done = { r -> main.post { reply(id, r) } }
            try {
                when {
                    method == "caps.get" -> done(Result.success(JSONObject()
                        .put("contractVersion", CONTRACT_VERSION)
                        .put("platform", "android")
                        .put("deviceKind", "phone")
                        .put("features", JSONObject().put("ble", true).put("iap", false).put("camera", true).put("spp", true))))
                    method == "system.motionStart" || method == "system.motionStop" -> motion.handle(method, params, done)
                    method.startsWith("system.") -> system.handle(method, params, done)
                    method.startsWith("spp.") -> spp.handle(method, params, done)
                    method.startsWith("ble.") || method.startsWith("recorder.") -> ble.handle(method, params, done)
                    method.startsWith("camera.") -> camera.handle(method, params, done)
                    else -> done(Result.failure(NativeError.notSupported("unknown method $method")))
                }
            } catch (e: Exception) {
                done(Result.failure(e as? NativeError ?: NativeError.io(e.message ?: "error")))
            }
        }
    }

    /** 画面を閉じるとき: すべての機器・センサー・録画を手放す */
    fun shutdown() {
        try { ble.shutdown() } catch (_: Exception) {}
        try { spp.shutdown() } catch (_: Exception) {}
        try { motion.shutdown() } catch (_: Exception) {}
        try { camera.shutdown() } catch (_: Exception) {}
    }

    fun emit(event: String, data: JSONObject) {
        send(JSONObject().put("event", event).put("data", data))
    }

    private fun reply(id: Int, r: Result<JSONObject>) {
        val msg = JSONObject().put("id", id)
        r.fold(
            onSuccess = { msg.put("ok", true).put("result", it) },
            onFailure = { e ->
                val ne = e as? NativeError ?: NativeError.io(e.message ?: "error")
                msg.put("ok", false).put("error", JSONObject().put("code", ne.code).put("message", ne.message ?: ""))
            }
        )
        send(msg)
    }

    private fun send(message: JSONObject) {
        // JSON の文字列を、JavaScript の文字列の値として渡す (中身をそのまま実行しない)
        val literal = JSONObject.quote(message.toString())
        main.post { webView.evaluateJavascript("window.dsNative && window.dsNative.receive($literal)", null) }
    }
}
