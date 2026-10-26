package io.github.oud0n.laploupe

import android.content.Context
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileWriter

/**
 * BLE の通知を、そのままファイルに書き足す (約束の recorder.*。iPhone の BleRecorder.swift と同じ形。2026-10-25)。
 * 読み方は持たない (読むのは Web)。files/ble-captures/<名前>.csv:
 * ```
 * # ds-ble-capture 1
 * # <Web が渡した見出し>
 * # started_utc_ms=<端末の時計> started_ns=<単調な時計>
 * t_ns,device,characteristic,hex
 * 123456789,<機器の ID>,2a67,8520070012…
 * # state,<t_ns>,reconnecting
 * ```
 */
class BleRecorder(private val ctx: Context) {
    data class Active(val fileName: String, val deviceId: String, var notifications: Int)

    var active: Active? = null
        private set
    private var writer: FileWriter? = null
    private val buffer = StringBuilder()
    private var lastFlushNs = 0L

    val dir: File get() = File(ctx.filesDir, "ble-captures").apply { mkdirs() }

    /** ファイル名だけを受け付ける (ほかのフォルダを指させない) */
    fun file(name: String): File {
        if (name.isEmpty() || name.contains('/') || name.startsWith('.')) throw NativeError.notFound("bad file name")
        return File(dir, name)
    }

    fun start(name: String, deviceId: String, header: List<String>): String {
        if (active != null) stop()
        val base = name.replace(Regex("[^A-Za-z0-9_.-]"), "_")
        var fileName = "$base.csv"
        var n = 2
        while (file(fileName).exists()) fileName = "${base}_${n++}.csv"
        val text = StringBuilder("# ds-ble-capture 1\n")
        header.forEach { text.append("# ").append(it.replace('\n', ' ')).append('\n') }
        text.append("# started_utc_ms=${System.currentTimeMillis()} started_ns=${SystemClock.elapsedRealtimeNanos()}\n")
        text.append("t_ns,device,characteristic,hex\n")
        val f = file(fileName)
        f.writeText(text.toString())
        writer = FileWriter(f, true)
        active = Active(fileName, deviceId, 0)
        return fileName
    }

    fun append(tNs: Long, deviceId: String, characteristic: String, bytes: ByteArray) {
        val a = active ?: return
        if (a.deviceId != deviceId) return
        buffer.append(tNs).append(',').append(deviceId).append(',').append(characteristic).append(',')
        for (b in bytes) buffer.append(String.format("%02x", b.toInt() and 0xff))
        buffer.append('\n')
        a.notifications++
        // 1 秒ごとに書き出す (止められても失うのは 1 秒分まで)
        if (tNs - lastFlushNs > 1_000_000_000L) flush()
    }

    fun note(deviceId: String, state: String) {
        if (active?.deviceId != deviceId) return
        buffer.append("# state,${SystemClock.elapsedRealtimeNanos()},$state\n")
    }

    fun flush() {
        val w = writer ?: return
        if (buffer.isEmpty()) return
        try { w.write(buffer.toString()); w.flush() } catch (_: Exception) {}
        buffer.setLength(0)
        lastFlushNs = SystemClock.elapsedRealtimeNanos()
    }

    fun stop(): JSONObject {
        val a = active ?: return JSONObject()
        flush()
        try { writer?.close() } catch (_: Exception) {}
        writer = null
        active = null
        return JSONObject().put("fileName", a.fileName).put("notifications", a.notifications).put("bytes", file(a.fileName).length())
    }

    fun status(): JSONObject {
        val a = active ?: return JSONObject().put("recording", false)
        return JSONObject().put("recording", true).put("fileName", a.fileName).put("deviceId", a.deviceId).put("notifications", a.notifications)
    }

    fun list(): JSONArray {
        val out = JSONArray()
        dir.listFiles { f -> f.name.endsWith(".csv") }?.forEach {
            out.put(JSONObject().put("fileName", it.name).put("bytes", it.length()).put("modifiedMs", it.lastModified()))
        }
        return out
    }

    fun read(name: String): String {
        if (active?.fileName == name) flush()
        return file(name).readText()
    }

    fun remove(name: String) {
        if (active?.fileName == name) throw NativeError.busy("recording")
        file(name).delete()
    }
}
