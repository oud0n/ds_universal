package io.github.oud0n.laploupe

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.graphics.Color
import android.webkit.MimeTypeMap
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream

/**
 * Android 版の画面 (2026-10-25)。アプリに入れた Web (assets/web = npm run build の dist) を WebView で開く。
 * - 画面: https://appassets.androidplatform.net/app/ (WebViewAssetLoader。通信はしない)
 * - 走行のファイル (動画など): https://appassets.androidplatform.net/run/ (files/LapTimer)
 */
class MainActivity : ComponentActivity() {
    companion object {
        private const val HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$HOST/app/index.html"
        const val RUN_URL_BASE = "https://$HOST/run/"

        /** アプリの画面のページか (ほかのページからは、窓口を使わせない) */
        fun isAppPage(url: String?): Boolean = url != null && url.startsWith("https://$HOST/app/")
    }

    private lateinit var webView: WebView
    /** WebView の上に重ねる物 (カメラの映像) を置く所。WebView と同じ広さ */
    lateinit var overlay: FrameLayout
        private set
    lateinit var bridge: NativeBridge
        private set

    // ---- ほかの画面 (ファイルを選ぶ・機器を選ぶ・許可) の結果 ----
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r: ActivityResult ->
        val data = r.data
        val uris = if (r.resultCode == RESULT_OK && data != null) {
            data.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } } ?: data.data?.let { arrayOf(it) }
        } else null
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }
    private var senderCallback: ((Intent?) -> Unit)? = null
    private val senderLauncher = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        senderCallback?.invoke(if (r.resultCode == RESULT_OK) r.data else null)
        senderCallback = null
    }
    // 許可を聞く画面は 1 つずつしか出せないので、頼みを列にして順に聞く (重ねて頼むと、前の頼みの答えが返らなかった)
    private val permissionQueue = ArrayDeque<Pair<Array<String>, (Boolean) -> Unit>>()
    private var permissionAsking = false

    private val permissionsLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
        val (perms, cb) = permissionQueue.removeFirst()
        permissionAsking = false
        // 取り消されたとき (答えが空) は、もらえなかったとする
        cb(r.isNotEmpty() && perms.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED })
        askNextPermission()
    }

    private fun askNextPermission() {
        if (permissionAsking) return
        while (permissionQueue.isNotEmpty()) {
            val (perms, cb) = permissionQueue.first()
            val missing = perms.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
            if (missing.isEmpty()) { permissionQueue.removeFirst(); cb(true); continue }
            permissionAsking = true
            permissionsLauncher.launch(missing.toTypedArray())
            return
        }
    }

    /** いくつかの許可をまとめて聞く (全部もらえたら true)。ほかの頼みを聞いている最中なら、終わってから聞く */
    fun withPermissions(perms: Array<String>, cb: (Boolean) -> Unit) {
        permissionQueue.addLast(perms to cb)
        askNextPermission()
    }

    private var treeCallback: ((Uri?) -> Unit)? = null
    private val treeLauncher = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        treeCallback?.invoke(uri)
        treeCallback = null
    }

    /** フォルダを選ぶ画面 (保管場所にするフォルダ。やめたら null) */
    fun pickTree(cb: (Uri?) -> Unit) {
        treeCallback = cb
        treeLauncher.launch(null)
    }

    fun launchIntentSender(sender: IntentSender, cb: (Intent?) -> Unit) {
        senderCallback = cb
        senderLauncher.launch(IntentSenderRequest.Builder(sender).build())
    }

    /** Bluetooth の許可 (Android 12 からは BLUETOOTH_CONNECT。それより前は要らない) */
    fun withBluetoothPermission(cb: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < 31) { cb(true); return }
        withPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), cb)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        // Android 15 からは画面の端まで描くので、状態のバー・ジェスチャーのバー・切り欠きの分だけ内側に寄せる
        overlay = FrameLayout(this)
        val frame = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            addView(this@MainActivity.overlay, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(frame)
        WebView.setWebContentsDebuggingEnabled(true)
        bridge = NativeBridge(this, webView)

        val runRoot = File(filesDir, "LapTimer").apply { mkdirs() }
        val loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/run/", FileHandler(runRoot))
            .addPathHandler("/app/", AssetHandler())
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setGeolocationEnabled(true)
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
        }
        webView.addJavascriptInterface(bridge, "dsNativeAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                // 走行のファイル (動画) は、一部だけを読む頼み (Range) に答える (答えないと、WebView が動画を再生できない)
                val url = request.url
                if (url.host == HOST && url.path?.startsWith("/run/") == true) return runFile(runRoot, url.path!!.removePrefix("/run/"), request.requestHeaders)
                return loader.shouldInterceptRequest(url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == HOST) return false
                // 外のリンクはブラウザで開く (開けるアプリが無ければ何もしない)
                try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (e: android.content.ActivityNotFoundException) { DebugLog.event("no app for $url") }
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            // 「この端末の GPS」で測るとき: Web が位置を使いたいと言ったら、OS の位置の許可を聞いて渡す (アプリの画面だけ)
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: android.webkit.GeolocationPermissions.Callback) {
                if (!isAppPage(webView.url)) { callback.invoke(origin, false, false); return }
                withPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) { ok ->
                    callback.invoke(origin, ok || ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED, false)
                }
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                pickFiles.launch(intent)
                return true
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
        webView.loadUrl(START_URL)
    }

    override fun onResume() {
        super.onResume()
        if (::bridge.isInitialized) {
            bridge.emit("system.appState", JSONObject().put("state", "active"))
            bridge.camera.onResume()
        }
    }

    override fun onDestroy() {
        // 画面を閉じた・作り直すとき: つなぎ・センサー・録画を手放す (残すと、古いつなぎがつなぎ直し続けていた)
        if (::bridge.isInitialized) bridge.shutdown()
        super.onDestroy()
    }

    override fun onPause() {
        if (::bridge.isInitialized) bridge.emit("system.appState", JSONObject().put("state", "background"))
        super.onPause()
    }

    /** アプリに入れた Web (assets/web) */
    private inner class AssetHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val rel = path.ifEmpty { "index.html" }
            if (rel.contains("..")) return null
            return try {
                val stream = assets.open("web/$rel")
                WebResourceResponse(mime(rel), null, stream)
            } catch (e: Exception) {
                null
            }
        }
    }

    /** 走行のファイル (files/LapTimer)。Range があれば、その部分だけを 206 で返す */
    private fun runFile(root: File, rel: String, headers: Map<String, String>): WebResourceResponse? {
        val path = Uri.decode(rel)
        if (path.contains("..")) return null
        // 選んだフォルダがあればそちらが先 (まだ移していないものだけアプリの中)
        if (::bridge.isInitialized && bridge.system.folder != null) safRunFile(path, headers)?.let { return it }
        val f = File(root, path)
        if (!f.isFile) return WebResourceResponse("text/plain", null, 404, "Not Found", emptyMap(), null)
        val len = f.length()
        val range = headers.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        val m = range?.let { Regex("bytes=(\\d*)-(\\d*)").find(it) }
        val common = mapOf("Accept-Ranges" to "bytes", "Access-Control-Allow-Origin" to "*")
        if (m == null) {
            return WebResourceResponse(mime(f.name), null, 200, "OK", common + ("Content-Length" to len.toString()), FileInputStream(f))
        }
        val (a, b) = m.destructured
        val start = if (a.isEmpty()) maxOf(0L, len - (b.toLongOrNull() ?: 0L)) else a.toLong()
        val end = if (a.isEmpty() || b.isEmpty()) len - 1 else minOf(b.toLong(), len - 1)
        if (start >= len || end < start) return WebResourceResponse(mime(f.name), null, 416, "Range Not Satisfiable", common + ("Content-Range" to "bytes */$len"), null)
        val input = FileInputStream(f)
        input.channel.position(start)
        val body = limited(input, end - start + 1)
        return WebResourceResponse(mime(f.name), null, 206, "Partial Content",
            common + mapOf("Content-Range" to "bytes $start-$end/$len", "Content-Length" to (end - start + 1).toString()), body)
    }

    /** 選んだフォルダの走行のファイル。Range にも答える。無ければ null (アプリの中を見る) */
    private fun safRunFile(path: String, headers: Map<String, String>): WebResourceResponse? {
        val store = bridge.system.folder ?: return null
        val pfd = try { store.openFd(path) } catch (e: Exception) { null } ?: return null
        val len = pfd.statSize
        val name = path.substringAfterLast('/')
        val common = mapOf("Accept-Ranges" to "bytes", "Access-Control-Allow-Origin" to "*")
        val input = ParcelFileDescriptor.AutoCloseInputStream(pfd)
        val range = headers.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        val m = range?.let { Regex("bytes=(\\d*)-(\\d*)").find(it) }
        // 大きさが分からない (len < 0) ときは、全部を Content-Length なしで返す
        if (m == null || len <= 0) return WebResourceResponse(mime(name), null, 200, "OK", if (len > 0) common + ("Content-Length" to len.toString()) else common, input)
        val (a, b) = m.destructured
        val start = if (a.isEmpty()) maxOf(0L, len - (b.toLongOrNull() ?: 0L)) else a.toLong()
        val end = if (a.isEmpty() || b.isEmpty()) len - 1 else minOf(b.toLong(), len - 1)
        if (start >= len || end < start) { input.close(); return WebResourceResponse(mime(name), null, 416, "Range Not Satisfiable", common + ("Content-Range" to "bytes */$len"), null) }
        input.channel.position(start)
        return WebResourceResponse(mime(name), null, 206, "Partial Content",
            common + mapOf("Content-Range" to "bytes $start-$end/$len", "Content-Length" to (end - start + 1).toString()), limited(input, end - start + 1))
    }

    /** n バイトまでしか読ませない流れ */
    private fun limited(input: java.io.InputStream, n: Long) = object : java.io.FilterInputStream(input) {
        var left = n
        override fun read(): Int { if (left <= 0) return -1; val r = super.read(); if (r >= 0) left--; return r }
        override fun read(buf: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val r = super.read(buf, off, minOf(len.toLong(), left).toInt())
            if (r > 0) left -= r
            return r
        }
    }

    /** 走行のファイル (files/LapTimer)。動画の一部だけを読む頼み (Range) にも答える */
    private class FileHandler(private val root: File) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            if (path.contains("..")) return null
            val f = File(root, Uri.decode(path))
            if (!f.isFile) return null
            return WebResourceResponse(mime(f.name), null, FileInputStream(f))
        }
    }
}

private fun mime(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    return when (ext) {
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "html" -> "text/html"
        "json", "webmanifest" -> "application/json"
        "svg" -> "image/svg+xml"
        "wasm" -> "application/wasm"
        "mov" -> "video/quicktime"
        else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }
}
