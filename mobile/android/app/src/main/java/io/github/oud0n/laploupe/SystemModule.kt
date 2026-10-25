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
 * 保存・画面の向き・共有など (iPhone の SystemModule.swift と同じ約束。2026-10-25)。
 * 保管場所は、アプリの中 (files/LapTimer) か、利用者が選んだフォルダ (SAF。端末の中・Google ドライブなど)。
 *
 * 選んだフォルダのとき (iPhone の copyChanged と同じ決まり):
 * - 書いている間はアプリの中に書き、書き終えたら (system.closeFiles のあと system.syncLapFiles で) 選んだフォルダへ移す
 * - 読む・書く (走行の置き場の窓口) は選んだフォルダが先。まだ移していないものだけアプリの中から読む
 * - laptimes.json (端末ごとの控え) は写さない。runs.json・コーナーの名前・course/ は、選んだフォルダにもうあれば写さず
 *   (中身がまったく同じときだけアプリの中のものを消す)。上書きすると、ほかの端末で付けた名前・同期を古い中身で戻すため
 */
class SystemModule(private val activity: MainActivity, private val bridge: NativeBridge) {
    companion object {
        /** 書き足してからこの時間がたつまでは、アプリの中から消さない (まだ書き足すかもしれない) */
        private const val SETTLE_MS = 10_000L
        private val SHARED = setOf("runs.json", "corners.json", "corners.json.bak")
    }

    private val io = Executors.newSingleThreadExecutor()
    /** 大きな動画を選んだフォルダへ写す流れ (記録の書き足しを待たせないように、別にする) */
    private val bulk = Executors.newSingleThreadExecutor()
    val root: File get() = File(activity.filesDir, "LapTimer").apply { mkdirs() }
    private val prefs get() = activity.getSharedPreferences("storage", android.content.Context.MODE_PRIVATE)
    /** 選んだフォルダ (無ければ null) */
    @Volatile var folder: SafStore? = prefs.getString("tree", null)?.let { SafStore(activity, Uri.parse(it)) }
        private set
    /** まだ書いている最中のファイル (書き足し中。選んだフォルダへは写すだけで、移さない) */
    private val openFiles = java.util.Collections.synchronizedSet(HashSet<String>())
    /** 最後に書き足した時刻 */
    private val lastAppend = java.util.concurrent.ConcurrentHashMap<String, Long>()
    /** 写している最中の動画 */
    private val movingVideos = java.util.Collections.synchronizedSet(HashSet<String>())

    /** LapTimer/ の下の場所 (上のフォルダへ出る名前・絶対の道は断る) */
    private fun file(rel: String): File? {
        if (rel.isEmpty() || rel.startsWith("/") || rel.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
        return File(root, rel)
    }

    private fun bg(done: Done, work: () -> JSONObject) {
        io.execute {
            done(try { Result.success(work()) } catch (e: Exception) { Result.failure(e as? NativeError ?: NativeError.io(e.message ?: "error")) })
        }
    }

    private fun localFiles(): Map<String, File> {
        val base = root.canonicalPath
        return root.walkTopDown().onEnter { it.name != "exports" || it.parentFile?.canonicalPath != base }
            .filter { it.isFile && !it.name.startsWith(".") }
            .associateBy { it.canonicalPath.removePrefix("$base/") }
    }

    /** 選んだフォルダが使えるとき、その店 (使えなければ null) */
    private fun usableFolder(): SafStore? = folder?.takeIf { it.ok() }

    private fun listFiles(): JSONArray {
        val arr = JSONArray()
        val local = localFiles()
        val seen = HashSet<String>()
        // 選んだフォルダのもの。まだ移していないアプリの中のものも足す (同じ道なら選んだフォルダのもの)
        usableFolder()?.listAll()?.forEach { (rel, e) ->
            seen.add(rel)
            arr.put(JSONObject().put("path", rel).put("size", e.size).put("mtimeMs", e.mtimeMs).put("local", true))
        }
        for ((rel, f) in local) {
            if (rel in seen || (folder != null && rel.substringAfterLast('/') == "laptimes.json")) continue
            arr.put(JSONObject().put("path", rel).put("size", f.length()).put("mtimeMs", f.lastModified()).put("local", true))
        }
        return arr
    }

    private fun info(): JSONObject {
        val f = folder ?: return JSONObject().put("kind", "local").put("folderName", "").put("folderOk", false)
        val ok = f.ok()
        return JSONObject().put("kind", "folder").put("folderName", if (ok) f.name() else "").put("folderOk", ok)
    }

    /** 読む: 選んだフォルダが先、無ければアプリの中 (まだ移していないもの)。フォルダを読めなければ io */
    private fun readAll(rel: String): ByteArray {
        val fold = folder
        if (fold != null) {
            if (!fold.ok()) throw NativeError.io("folder not available")
            val size = fold.size(rel)
            if (size != null) {
                if (size > 64L * 1024 * 1024) throw NativeError.io("file too large")
                return fold.open(rel)?.use { it.readBytes() } ?: throw NativeError.io("cannot open $rel")
            }
            // 入れ替えの途中で止まった (元を消して、一時ファイルの名前を替える前) ときは、一時ファイルを読む
            val dir = rel.substringBeforeLast('/', ""); val name = rel.substringAfterLast('/')
            val tmp = if (dir.isEmpty()) ".$name.tmp" else "$dir/.$name.tmp"
            if (name in SHARED || rel.startsWith("course/")) fold.open(tmp)?.use { return it.readBytes() }
        }
        val f = file(rel)?.takeIf { it.isFile } ?: throw NativeError.notFound("no file")
        if (f.length() > 64L * 1024 * 1024) throw NativeError.io("file too large")
        return f.readBytes()
    }

    /** 書き終えたファイルを選んだフォルダへ移す (書いている最中のものは写すだけ)。写せなかったものはアプリの中に残し、次に移す */
    private fun syncToFolder(): JSONObject {
        val f = folder ?: return JSONObject().put("kind", "local").put("copied", 0).put("skipped", 0).put("failed", 0)
        if (!f.ok()) throw NativeError.notFound("folder not available")
        var copied = 0; var moved = 0; var skipped = 0; var failed = 0
        var error: String? = null
        val now = System.currentTimeMillis()
        val removeLocal = { local: File, rel: String ->
            if (rel in openFiles || now - (lastAppend[rel] ?: 0L) < SETTLE_MS) false
            else local.delete().also { if (it) lastAppend.remove(rel) }
        }
        val courseListExists = try { f.size("course/courses.json") != null } catch (e: Exception) { false }
        for ((rel, local) in localFiles()) {
            val name = rel.substringAfterLast('/')
            // 端末ごとの控えは写さない
            if (name == "laptimes.json") continue
            try {
                // コース編集で保存したコースの線は、選んだフォルダに一覧があれば写さない (一覧に載らないコースが増えるため)
                if ((rel.startsWith("course/ControlLine/") || rel.startsWith("course/Sector/")) && courseListExists && f.size(rel) == null) { skipped++; continue }
                // 共有するもの (runs.json・コーナーの名前・course/) は、選んだフォルダにもうあれば写さない。同じ中身ならアプリの中から消す
                if (name in SHARED || rel.startsWith("course/")) {
                    if (f.size(rel) != null) {
                        if (f.sameContent(rel, local) && removeLocal(local, rel)) moved++ else skipped++
                        continue
                    }
                }
                val there = f.size(rel)
                if (there == local.length()) { if (removeLocal(local, rel)) moved++ else skipped++; continue }
                // 動画は大きいので、別の流れで写す (記録の書き足しを待たせない)
                if (name.substringAfterLast('.').lowercase() in setOf("mp4", "mov")) {
                    if (movingVideos.add(rel)) bulk.execute {
                        try {
                            f.write(rel) { out -> local.inputStream().use { it.copyTo(out) } }
                            if (f.size(rel) == local.length()) local.delete()
                        } catch (e: Exception) {
                            DebugLog.event("video move failed $rel: ${e.message}")
                        } finally { movingVideos.remove(rel) }
                    }
                    skipped++
                    continue
                }
                val before = local.length()
                f.write(rel, atomic = true) { out -> local.inputStream().use { it.copyTo(out) } }
                // 写している間に書き足された (書いている最中だった) ものは、消さずに次に写す
                if (local.length() == before && removeLocal(local, rel)) moved++ else copied++
            } catch (e: Exception) {
                failed++
                error = "$rel: ${e.message}"
            }
        }
        return JSONObject().put("kind", "folder").put("copied", copied).put("moved", moved).put("skipped", skipped).put("failed", failed)
            .apply { if (error != null) put("error", error) }
    }

    private fun pickFolder(done: Done) {
        activity.pickTree { uri ->
            if (uri == null) { done(Result.failure(NativeError.notFound("cancelled"))); return@pickTree }
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            try {
                activity.contentResolver.takePersistableUriPermission(uri, flags)
            } catch (e: Exception) {
                // 覚えられないフォルダは、次に開いたときに使えなくなるので選ばない
                done(Result.failure(NativeError.io("cannot keep access to this folder: ${e.message}")))
                return@pickTree
            }
            val old = folder?.tree
            if (old != null && old != uri) try { activity.contentResolver.releasePersistableUriPermission(old, flags) } catch (_: Exception) {}
            prefs.edit().putString("tree", uri.toString()).apply()
            folder = SafStore(activity, uri)
            bg(done) { info() }
        }
    }

    private fun setLocal(): JSONObject {
        folder?.let { f -> try { activity.contentResolver.releasePersistableUriPermission(f.tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } catch (_: Exception) {} }
        prefs.edit().remove("tree").apply()
        folder = null
        return info()
    }

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
                val rel = p.optString("path")
                val f = file(rel) ?: throw NativeError.notFound("bad path")
                val bytes = Base64.decode(p.optString("b64"), Base64.DEFAULT)
                f.parentFile?.mkdirs()
                if (p.optBoolean("createNew") && f.exists()) throw NativeError.busy("file exists")
                openFiles.add(rel)
                lastAppend[rel] = System.currentTimeMillis()
                if (p.optBoolean("truncate")) f.writeBytes(bytes)
                else if (!f.exists()) throw NativeError.notFound("file was removed")
                else f.appendBytes(bytes)
                JSONObject()
            }
            "system.closeFiles" -> {
                val all = p.optBoolean("all")
                val prefix = p.optString("prefix").ifEmpty { null }
                val paths = p.optJSONArray("paths")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
                synchronized(openFiles) { openFiles.removeAll { all || (prefix != null && it.startsWith(prefix)) || it in paths } }
                done(Result.success(JSONObject().put("open", openFiles.size)))
            }
            "system.listLapFiles", "system.listRunFiles" -> bg(done) { JSONObject().put("files", listFiles()) }
            "system.readLapFile", "system.readRunFile" -> bg(done) {
                JSONObject().put("b64", Base64.encodeToString(readAll(p.optString("path")), Base64.NO_WRAP))
            }
            "system.writeRunFile" -> bg(done) {
                val rel = p.optString("path")
                val f = file(rel) ?: throw NativeError.notFound("bad path")
                val bytes = Base64.decode(p.optString("b64"), Base64.DEFAULT)
                val fold = folder
                if (fold != null) {
                    // 選んだフォルダで直す (書き終えてから入れ替える)。使えなければ失敗にする (アプリの中に書くと、あとで古い中身として残るため)
                    if (!fold.ok()) throw NativeError.io("folder not available")
                    fold.write(rel, atomic = true) { it.write(bytes) }
                    // アプリの中に残っていた古いもの (移す前のもの) は消す
                    if (f.isFile && rel !in openFiles) f.delete()
                    return@bg JSONObject()
                }
                f.parentFile?.mkdirs()
                val tmp = File(f.parentFile, ".${f.name}.tmp")
                tmp.writeBytes(bytes)
                if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
                JSONObject()
            }
            "system.readRunRange" -> bg(done) {
                val rel = p.optString("path")
                val offset = p.optDouble("offset", 0.0).toLong()
                val length = p.optInt("length", 0).coerceAtMost(8 * 1024 * 1024)
                val fold = usableFolder()
                val pfd = fold?.openFd(rel)
                if (pfd != null) {
                    return@bg pfd.use {
                        java.io.FileInputStream(it.fileDescriptor).use { input ->
                            val ch = input.channel
                            val n = minOf(length.toLong(), maxOf(0L, it.statSize - offset)).toInt()
                            val buf = java.nio.ByteBuffer.allocate(n)
                            ch.position(offset)
                            while (buf.hasRemaining() && ch.read(buf) > 0) {}
                            JSONObject().put("b64", Base64.encodeToString(buf.array(), 0, buf.position(), Base64.NO_WRAP))
                        }
                    }
                }
                val f = file(rel)?.takeIf { it.isFile } ?: throw NativeError.notFound("no file")
                RandomAccessFile(f, "r").use { raf ->
                    raf.seek(offset)
                    val buf = ByteArray(minOf(length.toLong(), maxOf(0L, raf.length() - offset)).toInt())
                    raf.readFully(buf)
                    JSONObject().put("b64", Base64.encodeToString(buf, Base64.NO_WRAP))
                }
            }
            "system.runRoot" -> bg(done) {
                val f = usableFolder()
                JSONObject().put("urlBase", MainActivity.RUN_URL_BASE).put("kind", if (f != null) "folder" else "local").put("name", f?.name() ?: "LapTimer")
            }
            "system.runFileStatus" -> done(Result.success(JSONObject().put("local", true).put("downloading", false)))
            "system.downloadRunFile" -> done(Result.success(JSONObject()))
            "system.storageInfo" -> bg(done) { info() }
            "system.setStorageLocal" -> bg(done) { setLocal() }
            "system.pickStorageFolder" -> pickFolder(done)
            "system.syncLapFiles" -> bg(done) { syncToFolder() }
            // 共有: 選んだフォルダのファイルを探すのは時間がかかる (Google ドライブなど) ので、裏で探してから画面を出す
            "system.shareFile" -> bg(done) {
                val rel = p.optString("path")
                val uri = usableFolder()?.find(rel)
                val f = file(rel)?.takeIf { it.isFile }
                when {
                    uri != null -> activity.runOnUiThread { shareUri(uri, rel.substringAfterLast('/')) }
                    f != null -> activity.runOnUiThread { share(f) }
                    else -> throw NativeError.notFound("no file")
                }
                JSONObject()
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

    private fun shareUri(uri: Uri, name: String) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/octet-stream"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivity(Intent.createChooser(send, name))
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
