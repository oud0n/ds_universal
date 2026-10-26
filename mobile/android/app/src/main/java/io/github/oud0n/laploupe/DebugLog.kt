package io.github.oud0n.laploupe

import android.content.Context
import android.os.Build
import android.os.SystemClock
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 確かめの記録 (Bluetooth Classic の機器を試してもらうため。2026-10-25)。
 * つなぐたびに debug/spp-日時.log を作り、機種と OS の版、つなぐ・切れる・ペアリングの結果、受け取った行をそのまま書く。
 * 古いものは 10 個まで残す
 */
object DebugLog {
    private var file: File? = null
    private val stamp = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun dir(ctx: Context): File = File(ctx.filesDir, "debug").apply { mkdirs() }

    @Synchronized
    fun begin(ctx: Context, what: String) {
        val name = "spp-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date()) + ".log"
        val f = File(dir(ctx), name)
        f.writeText(
            "LapLoupe Android ${appVersion(ctx)}\n" +
                "device: ${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE})\n" +
                "android: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})\n" +
                "start: ${Date()} / $what\n\n"
        )
        file = f
        dir(ctx).listFiles()?.filter { it.name.startsWith("spp-") }?.sortedByDescending { it.name }?.drop(10)?.forEach { it.delete() }
    }

    @Synchronized
    fun event(text: String) {
        file?.appendText("${stamp.format(Date())} [${SystemClock.elapsedRealtime()}] $text\n")
    }

    /** 受け取った行 (NMEA の文などをそのまま) */
    @Synchronized
    fun data(text: String) {
        file?.appendText(text)
    }

    /** いちばん新しい記録 */
    fun latest(ctx: Context): File? = dir(ctx).listFiles()?.filter { it.name.startsWith("spp-") }?.maxByOrNull { it.name }

    private fun appVersion(ctx: Context): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?"
    } catch (e: Exception) { "?" }
}
