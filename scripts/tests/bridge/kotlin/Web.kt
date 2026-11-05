package android.webkit

import com.google.gson.JsonParser
import org.json.JSONObject

annotation class JavascriptInterface
class WebView {
    val url = "https://example.local"
    val sent = mutableListOf<JSONObject>()

    fun evaluateJavascript(script: String, callback: Any?) {
        val prefix = "window.dsNative && window.dsNative.receive("
        check(script.startsWith(prefix) && script.endsWith(")"))
        val literal = script.removePrefix(prefix).removeSuffix(")")
        sent += JSONObject(JsonParser.parseString(literal).asString)
    }
}
