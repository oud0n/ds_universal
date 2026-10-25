package io.github.oud0n.laploupe

import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.Executors

/**
 * 保存・画面の向き・共有など (iPhone の SystemModule.swift と同じ約束。2026-10-25 の最初の版)。
 * 保管場所は、まずアプリの中 (files/LapTimer) だけ。フォルダを選ぶ (Google ドライブなど) のは、あとの版で足す。
 * ラップタイマーの走行のファイルも、走行の画面の置き場も、同じ files/LapTimer
 */
class SystemModule(private val activity: MainActivity, private val bridge: NativeBridge) {
    private val io = Executors.newSingleThreadExecutor()
    val root: File get() = File(activity.filesDir, "LapTimer").apply { mkdirs() }

    /** LapTimer/ の下の場所 (上のフォルダへ出る名前・絶対の道は断る) */
    private fun file(rel: String): File? {
        if (rel.isEmpty() || rel.contains("..") || rel.startsWith("/")) return null
        return File(root, rel)
    }

    private fun bg(done: Done, work: () -> JSONObject) {
        io.execute {
            done(try { Result.success(work()) } catch (e: Exception) { Result.failure(e as? NativeError ?: NativeError.io(e.message ?: "error")) })
        }
    }

    private fun listFiles(): JSONArray {
        val arr = JSONArray()
        val base = root.canonicalPath
        root.walkTopDown().filter { it.isFile && !it.name.startsWith(".") }.forEach { f ->
            val rel = f.canonicalPath.removePrefix("$base/")
            if (rel.startsWith("exports/")) return@forEach
            arr.put(JSONObject().put("path", rel).put("size", f.length()).put("mtimeMs", f.lastModified()).put("local", true))
        }
        return arr
    }

    private val localInfo get() = JSONObject().put("kind", "local").put("folderName", "").put("folderOk", false)

    fun handle(method: String, p: JSONObject, done: Done) {
        when (method) {
            "system.openSettings" -> {
                activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
                done(Result.success(JSONObject()))
            }
            "system.keepAwake" -> {
                if (p.optBoolean("on")) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                done(Result.success(JSONObject()))
            }
            "system.setOrientation" -> {
                val mode = p.optString("mode", "system")
                val landscape = activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
                activity.requestedOrientation = when (mode) {
                    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    "auto" -> ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
                    "hold" -> ActivityInfo.SCREEN_ORIENTATION_LOCKED
                    else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                }
                val now = when (mode) { "portrait" -> false; "landscape" -> true; else -> landscape }
                done(Result.success(JSONObject().put("orientation", if (now) "landscape" else "portrait")))
            }
            "system.appendFile" -> bg(done) {
                val f = file(p.optString("path")) ?: throw NativeError.notFound("bad path")
                val bytes = Base64.decode(p.optString("b64"), Base64.DEFAULT)
                f.parentFile?.mkdirs()
                if (p.optBoolean("createNew") && f.exists()) throw NativeError.busy("file exists")
                if (p.optBoolean("truncate")) f.writeBytes(bytes)
                else if (!f.exists()) throw NativeError.notFound("file was removed")
                else f.appendBytes(bytes)
                JSONObject()
            }
            "system.closeFiles" -> done(Result.success(JSONObject().put("open", 0)))
            "system.listLapFiles" -> bg(done) { JSONObject().put("files", listFiles()) }
            "system.readLapFile", "system.readRunFile" -> bg(done) {
                val f = file(p.optString("path"))?.takeIf { it.isFile } ?: throw NativeError.notFound("no file")
                if (f.length() > 64L * 1024 * 1024) throw NativeError.io("file too large")
                JSONObject().put("b64", Base64.encodeToString(f.readBytes(), Base64.NO_WRAP))
            }
            "system.writeRunFile" -> bg(done) {
                val f = file(p.optString("path")) ?: throw NativeError.notFound("bad path")
                f.parentFile?.mkdirs()
                val tmp = File(f.parentFile, ".${f.name}.tmp")
                tmp.writeBytes(Base64.decode(p.optString("b64"), Base64.DEFAULT))
                if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
                JSONObject()
            }
            "system.readRunRange" -> bg(done) {
                val f = file(p.optString("path"))?.takeIf { it.isFile } ?: throw NativeError.notFound("no file")
                val offset = p.optDouble("offset", 0.0).toLong()
                val length = p.optInt("length", 0).coerceAtMost(8 * 1024 * 1024)
                RandomAccessFile(f, "r").use { raf ->
                    raf.seek(offset)
                    val buf = ByteArray(minOf(length.toLong(), maxOf(0L, raf.length() - offset)).toInt())
                    raf.readFully(buf)
                    JSONObject().put("b64", Base64.encodeToString(buf, Base64.NO_WRAP))
                }
            }
            "system.listRunFiles" -> bg(done) { JSONObject().put("files", listFiles()) }
            "system.runRoot" -> done(Result.success(JSONObject().put("urlBase", MainActivity.RUN_URL_BASE).put("kind", "local").put("name", "LapTimer")))
            "system.runFileStatus" -> done(Result.success(JSONObject().put("local", true).put("downloading", false)))
            "system.downloadRunFile" -> done(Result.success(JSONObject()))
            "system.storageInfo", "system.setStorageLocal" -> done(Result.success(localInfo))
            "system.pickStorageFolder" -> done(Result.failure(NativeError.notSupported("folder storage is not available on Android yet")))
            "system.syncLapFiles" -> done(Result.success(JSONObject().put("kind", "local").put("copied", 0).put("skipped", 0).put("failed", 0)))
            "system.shareFile" -> {
                val f = file(p.optString("path"))?.takeIf { it.isFile } ?: return done(Result.failure(NativeError.notFound("no file")))
                share(f)
                done(Result.success(JSONObject()))
            }
            "system.shareText" -> bg(done) {
                val name = p.optString("fileName")
                if (name.isEmpty() || name.contains("/")) throw NativeError.notFound("bad name")
                val dir = File(activity.cacheDir, "share").apply { mkdirs() }
                val f = File(dir, name).apply { writeText(p.optString("text")) }
                activity.runOnUiThread { share(f) }
                JSONObject()
            }
            else -> done(Result.failure(NativeError.notSupported("unknown method $method")))
        }
    }

    private fun share(f: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", f)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/octet-stream"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivity(Intent.createChooser(send, f.name))
    }
}
