package io.github.oud0n.laploupe

import org.json.JSONObject

class PackageInfo { val versionName: String? = "test" }
class PackageManager {
    fun getPackageInfo(name: String, flags: Int) = PackageInfo()
}
class MainActivity {
    val packageManager = PackageManager()
    val packageName = "example"
    fun deviceKind() = "phone"
    companion object { fun isAppPage(url: String?) = true }
}

class StubModule(activity: MainActivity, bridge: NativeBridge) {
    companion object { val replies = mutableListOf<Done>() }
    fun handle(method: String, params: JSONObject, done: Done) { replies += done }
    fun shutdown() {}
}
typealias SystemModule = StubModule
typealias SppModule = StubModule
typealias BleModule = StubModule
typealias CameraModule = StubModule
typealias MotionModule = StubModule
