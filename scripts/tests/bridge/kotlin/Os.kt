package android.os

class Looper {
    companion object { fun getMainLooper() = Looper() }
}

// 主スレッドに送った処理は、この試験ではすぐ実行する。
class Handler(looper: Looper) {
    fun post(block: () -> Unit) = block()
}
