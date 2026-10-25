package io.github.oud0n.laploupe

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.companion.AssociationRequest
import android.companion.BluetoothDeviceFilter
import android.companion.CompanionDeviceManager
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.regex.Pattern

/**
 * Bluetooth Classic のシリアル (SPP)。Drogger の DG-PRO1S など、Bluetooth Classic で NMEA を送ってくる GPS の受信機とつなぐ (2026-10-25)。
 * - 機器は OS の選ぶ画面 (CompanionDeviceManager) で選び、そのままペアリングする (位置の許可は要らない)
 * - つないだら、受け取ったバイト列を 100 ms ごとにまとめて spp.data で Web に渡す (読み方は Web の DroggerStream)
 * - 切れたら、spp.disconnect まで 3 秒ごとにつなぎ直す
 * - つなぐたびに、確かめの記録 (DebugLog) を書く
 */
@SuppressLint("MissingPermission")
class SppModule(private val activity: MainActivity, private val bridge: NativeBridge) {
    companion object {
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val FLUSH_MS = 100L
        private const val RETRY_MS = 3000L
    }

    private val main = Handler(Looper.getMainLooper())
    private val adapter: BluetoothAdapter? get() = (activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private val links = mutableMapOf<String, Link>()

    fun handle(method: String, params: JSONObject, done: Done) {
        when (method) {
            "spp.pick" -> {
                val prefixes = params.optJSONArray("namePrefixes")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
                activity.withBluetoothPermission { ok ->
                    if (!ok) done(Result.failure(NativeError.denied("bluetooth"))) else pick(prefixes, done)
                }
            }
            "spp.connect" -> {
                val id = params.optString("deviceId")
                activity.withBluetoothPermission { ok ->
                    if (!ok) { done(Result.failure(NativeError.denied("bluetooth"))); return@withBluetoothPermission }
                    val dev = try { adapter?.getRemoteDevice(id) } catch (e: Exception) { null }
                    if (dev == null) { done(Result.failure(NativeError.notFound("no device $id"))); return@withBluetoothPermission }
                    links.remove(id)?.stop()
                    val link = Link(dev)
                    links[id] = link
                    link.start()
                    done(Result.success(JSONObject()))
                }
            }
            "spp.disconnect" -> {
                links.remove(params.optString("deviceId"))?.stop()
                done(Result.success(JSONObject()))
            }
            "spp.shareLog" -> {
                val f = DebugLog.latest(activity) ?: return done(Result.failure(NativeError.notFound("no log yet")))
                val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", f)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, "LapLoupe ${f.name}")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.startActivity(Intent.createChooser(send, f.name))
                done(Result.success(JSONObject()))
            }
            else -> done(Result.failure(NativeError.notSupported("unknown method $method")))
        }
    }

    // ---- 選ぶ (OS の画面) ----

    private fun pick(prefixes: List<String>, doneOnce: Done) {
        // 断られたときは、失敗の知らせと画面の結果の両方が来るので、答えは 1 回だけにする
        var answered = false
        val done: Done = { r -> if (!answered) { answered = true; doneOnce(r) } }
        val cdm = activity.getSystemService(Context.COMPANION_DEVICE_SERVICE) as CompanionDeviceManager
        val filter = BluetoothDeviceFilter.Builder().apply {
            if (prefixes.isNotEmpty()) setNamePattern(Pattern.compile("^(" + prefixes.joinToString("|") { Pattern.quote(it) } + ").*"))
        }.build()
        val request = AssociationRequest.Builder().addDeviceFilter(filter).setSingleDevice(false).build()
        DebugLog.begin(activity, "pick ${prefixes.joinToString(",")}")
        val callback = object : CompanionDeviceManager.Callback() {
            @Deprecated("API 33 からは onAssociationPending")
            override fun onDeviceFound(chooserLauncher: IntentSender) = launch(chooserLauncher)
            override fun onAssociationPending(intentSender: IntentSender) = launch(intentSender)
            override fun onFailure(error: CharSequence?) {
                DebugLog.event("pick failed: $error")
                done(Result.failure(NativeError.notFound(error?.toString() ?: "no device")))
            }

            private fun launch(sender: IntentSender) {
                activity.launchIntentSender(sender) { data ->
                    val dev = data?.let { deviceFrom(it) }
                    if (dev == null) {
                        DebugLog.event("pick cancelled")
                        done(Result.failure(NativeError("cancelled", "cancelled")))
                        return@launchIntentSender
                    }
                    DebugLog.event("picked ${dev.name} ${dev.address} type=${dev.type} bond=${dev.bondState}")
                    // ペアリングしていなければ、ここでペアリングする (つなぐときにも OS が聞いてくる)
                    if (dev.bondState != BluetoothDevice.BOND_BONDED) {
                        val started = dev.createBond()
                        DebugLog.event("createBond started=$started")
                    }
                    done(Result.success(JSONObject().put("deviceId", dev.address).put("name", dev.name ?: dev.address)))
                }
            }
        }
        @Suppress("DEPRECATION")
        cdm.associate(request, callback, main)
    }

    private fun deviceFrom(data: Intent): BluetoothDevice? {
        return if (Build.VERSION.SDK_INT >= 33) {
            data.getParcelableExtra(CompanionDeviceManager.EXTRA_DEVICE, BluetoothDevice::class.java)
                ?: data.getParcelableExtra(CompanionDeviceManager.EXTRA_ASSOCIATION, android.companion.AssociationInfo::class.java)
                    ?.deviceMacAddress?.toString()?.uppercase()?.let { adapter?.getRemoteDevice(it) }
        } else {
            @Suppress("DEPRECATION")
            data.getParcelableExtra(CompanionDeviceManager.EXTRA_DEVICE)
        }
    }

    // ---- つなぐ ----

    private inner class Link(private val dev: BluetoothDevice) {
        @Volatile private var wanted = true
        @Volatile private var socket: BluetoothSocket? = null
        private val buffer = ByteArrayOutputStream()
        private var firstT = 0L
        private val flusher = object : Runnable {
            override fun run() {
                flush()
                if (wanted) main.postDelayed(this, FLUSH_MS)
            }
        }

        fun start() {
            DebugLog.begin(activity, "connect ${dev.name} ${dev.address} bond=${dev.bondState}")
            main.postDelayed(flusher, FLUSH_MS)
            Thread({ loop() }, "spp-${dev.address}").start()
        }

        fun stop() {
            wanted = false
            DebugLog.event("disconnect (by app)")
            try { socket?.close() } catch (_: Exception) {}
            main.removeCallbacks(flusher)
            state("disconnected", null)
        }

        private fun state(s: String, error: String?) {
            val data = JSONObject().put("deviceId", dev.address).put("state", s)
            if (error != null) data.put("error", JSONObject().put("code", "not-connected").put("message", error))
            bridge.emit("spp.state", data)
        }

        private fun open(): BluetoothSocket {
            adapter?.cancelDiscovery()
            // ふつうの形 → 暗号化なしの形 → チャンネル 1 を決め打ち (つながらない機種があるため、順に試す)
            val tries = listOf<Pair<String, () -> BluetoothSocket>>(
                "secure" to { dev.createRfcommSocketToServiceRecord(SPP_UUID) },
                "insecure" to { dev.createInsecureRfcommSocketToServiceRecord(SPP_UUID) },
                "channel1" to { dev.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType).invoke(dev, 1) as BluetoothSocket }
            )
            var last: Exception? = null
            for ((name, make) in tries) {
                try {
                    val s = make()
                    s.connect()
                    DebugLog.event("connected via $name")
                    return s
                } catch (e: Exception) {
                    DebugLog.event("connect via $name failed: ${e.javaClass.simpleName} ${e.message}")
                    last = e
                }
            }
            throw last ?: Exception("connect failed")
        }

        private fun loop() {
            var first = true
            while (wanted) {
                main.post { state(if (first) "connecting" else "reconnecting", null) }
                try {
                    val s = open()
                    socket = s
                    main.post { state("connected", null) }
                    val input = s.inputStream
                    val chunk = ByteArray(4096)
                    while (wanted) {
                        val n = input.read(chunk)
                        if (n < 0) break
                        if (n == 0) continue
                        synchronized(buffer) {
                            if (buffer.size() == 0) firstT = SystemClock.elapsedRealtimeNanos()
                            buffer.write(chunk, 0, n)
                        }
                        DebugLog.data(String(chunk, 0, n, Charsets.US_ASCII))
                    }
                    DebugLog.event("stream ended")
                } catch (e: Exception) {
                    if (wanted) DebugLog.event("link lost: ${e.javaClass.simpleName} ${e.message}")
                } finally {
                    try { socket?.close() } catch (_: Exception) {}
                    socket = null
                }
                first = false
                if (wanted) {
                    main.post { state("reconnecting", "lost") }
                    SystemClock.sleep(RETRY_MS)
                }
            }
        }

        private fun flush() {
            val bytes: ByteArray
            val t: Long
            synchronized(buffer) {
                if (buffer.size() == 0) return
                bytes = buffer.toByteArray()
                t = firstT
                buffer.reset()
            }
            val item = JSONObject().put("t", t).put("b", Base64.encodeToString(bytes, Base64.NO_WRAP))
            bridge.emit("spp.data", JSONObject().put("deviceId", dev.address).put("items", JSONArray().put(item)))
        }
    }
}
