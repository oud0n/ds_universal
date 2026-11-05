package org.json

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser

class JSONException(message: String) : RuntimeException(message)

// JVM 上で Android の JSONObject のうち、窓口が使う操作と JSON 化の失敗を模擬する。
class JSONObject {
    private val body: JsonObject
    var failEncoding = false
    private var failedChild = false

    constructor() { body = JsonObject() }
    constructor(text: String) { body = JsonParser.parseString(text).asJsonObject }

    fun optInt(key: String, fallback: Int = 0) = body.get(key)?.asInt ?: fallback
    fun optString(key: String) = body.get(key)?.asString ?: ""
    fun opt(key: String): Any? {
        val item = body.get(key) ?: return null
        if (!item.isJsonPrimitive) return null
        return if (item.asJsonPrimitive.isBoolean) item.asBoolean else item.asString
    }
    fun optJSONObject(key: String): JSONObject? = body.getAsJsonObject(key)?.let { JSONObject(it.toString()) }

    fun put(key: String, value: Any?): JSONObject {
        when (value) {
            null -> body.remove(key)
            is JSONObject -> {
                body.add(key, value.body)
                if (value.failEncoding) failedChild = true
            }
            is String -> body.addProperty(key, value)
            is Number -> body.addProperty(key, value)
            is Boolean -> body.addProperty(key, value)
        }
        return this
    }
    fun remove(key: String) {
        body.remove(key)
        if (key == "result") failedChild = false
    }
    fun toString(indent: Int): String {
        if (failEncoding || failedChild) throw JSONException("invalid result")
        return body.toString()
    }
    override fun toString() = body.toString()
    companion object { fun quote(text: String) = Gson().toJson(text) }
}
