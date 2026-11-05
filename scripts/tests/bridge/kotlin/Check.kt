package test

import android.webkit.WebView
import io.github.oud0n.laploupe.MainActivity
import io.github.oud0n.laploupe.NativeBridge
import io.github.oud0n.laploupe.NativeError
import io.github.oud0n.laploupe.StubModule
import org.json.JSONObject

private fun request(bridge: NativeBridge, id: Int, method: String?, session: String? = null,
                    open: Boolean = false, version: Int = 1) {
    val message = JSONObject().put("v", version).put("id", id).put("method", method)
        .put("session", session).put("requestSession", open)
    bridge.postMessage(message.toString())
}

fun main() {
    val web = WebView()
    val bridge = NativeBridge(MainActivity(), web)
    val otherWeb = WebView()
    val otherBridge = NativeBridge(MainActivity(), otherWeb)

    request(bridge, 1, "caps.get")
    check(web.sent.last().opt("session") == null && web.sent.last().opt("ok") == true)
    request(bridge, 0, "caps.get", open = true)
    val first = web.sent.last().optString("session")
    request(bridge, 1, "system.closeFiles", first)
    request(bridge, 0, "caps.get", open = true)
    val next = web.sent.last().optString("session")
    request(otherBridge, 0, "caps.get", open = true)
    val third = otherWeb.sent.last().optString("session")
    check(listOf(first, next, third).none { it.isEmpty() } && setOf(first, next, third).size == 3)

    request(bridge, 1, "system.closeFiles", next)
    StubModule.replies[1](Result.success(JSONObject().put("open", 0)))
    check(web.sent.last().optInt("id") == 1 && web.sent.last().opt("session") == next)
    check(web.sent.last().optJSONObject("result")?.optInt("open", -1) == 0)
    StubModule.replies[0](Result.failure(NativeError.io("failed")))
    check(web.sent.last().opt("session") == first && web.sent.last().opt("ok") == false)

    request(bridge, 2, "system.closeFiles", first)
    StubModule.replies[2](Result.success(JSONObject().apply { failEncoding = true }))
    check(web.sent.last().opt("session") == first && web.sent.last().opt("ok") == false)
    request(bridge, 3, null, first)
    check(web.sent.last().opt("session") == first && web.sent.last().opt("ok") == false)
    request(bridge, 4, "caps.get", next, version = 99)
    check(web.sent.last().opt("session") == next && web.sent.last().opt("ok") == false)
    println("PASS Kotlin native reply routing")
}
