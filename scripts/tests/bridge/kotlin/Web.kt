package android.webkit

import com.google.gson.JsonParser
import org.json.JSONObject

annotation class JavascriptInterface
class WebView {
    val url = "https://example.local"
    val sent = mutableListOf<JSONObject>()
    val scripts = mutableListOf<String>()

    fun evaluateJavascript(script: String, callback: Any?) {
        scripts += script
        val call = "window.dsNative.receive("
        check(call in script && script.endsWith(")"))
        val literal = script.substringAfter(call).removeSuffix(")")
        sent += JSONObject(JsonParser.parseString(literal).asString)
    }
}
