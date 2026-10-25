package io.github.oud0n.laploupe

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
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
    private var permissionCallback: ((Boolean) -> Unit)? = null
    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionCallback?.invoke(granted)
        permissionCallback = null
    }

    fun launchIntentSender(sender: IntentSender, cb: (Intent?) -> Unit) {
        senderCallback = cb
        senderLauncher.launch(IntentSenderRequest.Builder(sender).build())
    }

    /** Bluetooth の許可 (Android 12 からは BLUETOOTH_CONNECT。それより前は要らない) */
    fun withBluetoothPermission(cb: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < 31 || ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) {
            cb(true)
            return
        }
        permissionCallback = cb
        permissionLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        // Android 15 からは画面の端まで描くので、状態のバー・ジェスチャーのバー・切り欠きの分だけ内側に寄せる
        val frame = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
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
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
        }
        webView.addJavascriptInterface(bridge, "dsNativeAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == HOST) return false
                // 外のリンクはブラウザで開く
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
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
        if (::bridge.isInitialized) bridge.emit("system.appState", JSONObject().put("state", "active"))
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
