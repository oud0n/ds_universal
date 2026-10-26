package io.github.oud0n.laploupe

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * 約束の ble.* (探す・つなぐ・通知を受け取る・読む・書く) と recorder.* (2026-10-25。iPhone の BleModule.swift と同じ形)。
 *
 * - 機器ごとの読み方は持たない。どの特性の通知を受け取るかは Web が ble.connect で渡す
 * - Android の GATT は、命令 (通知の設定・読む・書く・MTU) を 1 つずつしか受け付けないので、機器ごとの順番待ちの列で 1 つずつ出す
 * - autoReconnect のときは、切れたらここでつなぎ直す (機器が戻るまで OS が待つ autoConnect でつなぐ)
 * - 通知は受け取った時刻 (単調な時計のナノ秒) を付け、100 ms ごとにまとめて ble.notify で渡す
 * - 許可: Android 12 からは「付近の機器」(BLUETOOTH_SCAN・CONNECT)、それより前は位置情報 (BLE で探すのに要る)
 * - GATT の知らせは別のスレッドで来るので、すべて主スレッドへ移してから扱う
 */
@SuppressLint("MissingPermission")
class BleModule(private val activity: MainActivity, private val bridge: NativeBridge) {
    companion object {
        private const val SCAN_MS = 10_000L
        private const val FLUSH_MS = 100L
        private const val OP_TIMEOUT_MS = 6_000L
        private const val RETRY_MS = 1_000L
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val BASE = "-0000-1000-8000-00805f9b34fb"

        /** 16 ビット ('2a67')・32 ビット・128 ビットの UUID を読む */
        fun uuid(s: String): UUID = when (s.length) {
            4 -> UUID.fromString("0000$s$BASE")
            8 -> UUID.fromString("$s$BASE")
            else -> UUID.fromString(s)
        }

        /** Web に渡す特性の名前 (iPhone と同じく、決まった形の UUID は短い形の小文字) */
        fun name(u: UUID): String {
            val t = u.toString().lowercase()
            return if (t.startsWith("0000") && t.endsWith(BASE)) t.substring(4, 8) else t
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val manager get() = activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter: BluetoothAdapter? get() = manager.adapter
    val recorder = BleRecorder(activity)

    // ---- 許可 ----

    private val permissions: Array<String> =
        if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun granted() = permissions.all { ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED }

    /** 許可があれば、Bluetooth が入っていれば work、だめなら失敗を返す */
    private fun ready(done: Done, work: () -> Unit) {
        val go = {
            val a = adapter
            when {
                a == null -> done(Result.failure(NativeError.notSupported("no bluetooth")))
                !a.isEnabled -> done(Result.failure(NativeError.io("Bluetooth is off")))
                else -> work()
            }
        }
        if (granted()) go() else activity.withPermissions(permissions) { ok -> if (ok) go() else done(Result.failure(NativeError.denied("bluetooth"))) }
    }

    fun handle(method: String, params: JSONObject, done: Done) {
        when (method) {
            "ble.permission" -> {
                if (granted()) done(Result.success(JSONObject().put("state", "granted")))
                else if (!params.optBoolean("request")) done(Result.success(JSONObject().put("state", "unknown")))
                else activity.withPermissions(permissions) { ok -> done(Result.success(JSONObject().put("state", if (ok) "granted" else "denied"))) }
            }
            "ble.scan" -> ready(done) { scan(strings(params.optJSONArray("namePrefixes")), strings(params.optJSONArray("services")).map(::uuid)); done(Result.success(JSONObject())) }
            "ble.stopScan" -> { stopScan(); done(Result.success(JSONObject())) }
            "ble.connect" -> ready(done) { connect(params, done) }
            "ble.disconnect" -> { disconnect(params.optString("deviceId")); done(Result.success(JSONObject())) }
            "ble.read" -> queueOp(params, done) { Op.Read(it.first, it.second, done) }
            "ble.write" -> {
                val data = try { Base64.decode(params.optString("b"), Base64.DEFAULT) } catch (e: Exception) { null }
                if (data == null) done(Result.failure(NativeError.notFound("bad data")))
                else queueOp(params, done) { Op.Write(it.first, it.second, data, done) }
            }
            "recorder.start" -> {
                val id = params.optString("deviceId")
                if (links[id] == null) done(Result.failure(NativeError.notConnected()))
                else done(Result.success(JSONObject().put("fileName", recorder.start(params.optString("name", "ble"), id, strings(params.optJSONArray("header"))))))
            }
            "recorder.stop" -> done(Result.success(recorder.stop()))
            "recorder.status" -> done(Result.success(recorder.status()))
            "recorder.list" -> done(Result.success(JSONObject().put("files", recorder.list())))
            "recorder.read" -> done(Result.success(JSONObject().put("text", recorder.read(params.optString("fileName")))))
            "recorder.remove" -> { recorder.remove(params.optString("fileName")); done(Result.success(JSONObject())) }
            "recorder.share" -> {
                val f = recorder.file(params.optString("fileName"))
                if (!f.exists()) throw NativeError.notFound("no file")
                val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", f)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/csv"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.startActivity(Intent.createChooser(send, f.name))
                done(Result.success(JSONObject()))
            }
            else -> done(Result.failure(NativeError.notSupported("unknown method $method")))
        }
    }

    private fun strings(a: JSONArray?): List<String> = a?.let { (0 until it.length()).map { i -> it.getString(i) } } ?: emptyList()

    // ---- 探す ----

    private var scanCallback: ScanCallback? = null
    private val reported = mutableSetOf<String>()
    private val scanStop = Runnable { stopScan() }

    private fun scan(prefixes: List<String>, services: List<UUID>) {
        stopScan(notify = false)
        reported.clear()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val record = result.scanRecord
                val name = record?.deviceName ?: result.device.name ?: ""
                val advertised = record?.serviceUuids?.map { it.uuid } ?: emptyList()
                val byName = prefixes.any { name.startsWith(it) }
                val byService = services.isNotEmpty() && advertised.any { it in services }
                if (!byName && !byService) return
                val id = result.device.address
                main.post {
                    if (!reported.add(id)) return@post
                    bridge.emit("ble.device", JSONObject().put("deviceId", id).put("name", name).put("rssi", result.rssi))
                }
            }

            override fun onScanFailed(errorCode: Int) {
                main.post { stopScan() }
            }
        }
        scanCallback = cb
        // デジスパイスは広告のサービスが GATT と違うので、サービスでは絞らず名前で絞る (iPhone と同じ)
        adapter?.bluetoothLeScanner?.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
        main.postDelayed(scanStop, SCAN_MS)
    }

    private fun stopScan(notify: Boolean = true) {
        val cb = scanCallback ?: return
        scanCallback = null
        main.removeCallbacks(scanStop)
        try { adapter?.bluetoothLeScanner?.stopScan(cb) } catch (_: Exception) {}
        if (notify) bridge.emit("ble.scanStopped", JSONObject())
    }

    // ---- つなぐ ----

    private sealed class Op {
        class Mtu(val size: Int) : Op()
        class Subscribe(val service: UUID, val characteristic: UUID) : Op()
        class Read(val service: UUID, val characteristic: UUID, val done: Done) : Op()
        class Write(val service: UUID, val characteristic: UUID, val data: ByteArray, val done: Done) : Op()
        /** 通知の設定が終わった (connected を知らせる) */
        object Ready : Op()
    }

    private inner class Link(val device: BluetoothDevice, var notify: List<Pair<UUID, UUID>>, var autoReconnect: Boolean, var highThroughput: Boolean) {
        var gatt: BluetoothGatt? = null
        var userClosed = false
        /** サービスを見つけ終わった (命令を出せる) */
        var discovered = false
        val ops = ArrayDeque<Op>()
        var current: Op? = null
        /** 通知の設定に失敗した理由 (つないだと知らせる前に、これがあれば切る) */
        var subscribeError: NativeError? = null
        val timeout = Runnable { finishOp(this, Result.failure(NativeError.io("timeout"))) }
        val id: String get() = device.address

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                main.post { onState(this@Link, g, status, newState) }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                main.post { onDiscovered(this@Link, g) }
            }

            override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                main.post { if (current is Op.Mtu) finishOp(this@Link, Result.success(JSONObject())) }
            }

            override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
                main.post {
                    if (current !is Op.Subscribe) return@post
                    if (status == BluetoothGatt.GATT_SUCCESS) finishOp(this@Link, Result.success(JSONObject()))
                    else {
                        // 通知を受け取れない (ペアリングが要る機器など)。つないだことにせず、理由を付けて切る
                        val err = authError(status)
                        finishOp(this@Link, Result.failure(err))
                        subscribeError = err
                    }
                }
            }

            override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
                main.post { onRead(this@Link, value, status) }
            }

            @Deprecated("API 33 より前")
            override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
                @Suppress("DEPRECATION") val v = c.value ?: ByteArray(0)
                main.post { onRead(this@Link, v, status) }
            }

            override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
                main.post {
                    if (current !is Op.Write) return@post
                    // 暗号化が要る機器 (GoPro) でペアリングしていないと、ここで失敗が返る
                    finishOp(this@Link, if (status == BluetoothGatt.GATT_SUCCESS) Result.success(JSONObject()) else Result.failure(authError(status)))
                }
            }

            override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
                enqueueNotify(this@Link.id, c.uuid, value)
            }

            @Deprecated("API 33 より前")
            override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
                @Suppress("DEPRECATION") val v = c.value?.copyOf() ?: return
                enqueueNotify(this@Link.id, c.uuid, v)
            }
        }
    }

    private val links = mutableMapOf<String, Link>()

    private fun authError(status: Int) = when (status) {
        BluetoothGatt.GATT_INSUFFICIENT_AUTHENTICATION, BluetoothGatt.GATT_INSUFFICIENT_ENCRYPTION, 137 -> NativeError.denied("pairing required ($status)")
        else -> NativeError.io("gatt status $status")
    }

    private fun connect(params: JSONObject, done: Done) {
        val id = params.optString("deviceId")
        if (!BluetoothAdapter.checkBluetoothAddress(id)) { done(Result.failure(NativeError.notFound("bad deviceId"))); return }
        val notify = mutableListOf<Pair<UUID, UUID>>()
        params.optJSONArray("notify")?.let { a ->
            for (i in 0 until a.length()) {
                val r = a.optJSONObject(i) ?: continue
                try { notify.add(uuid(r.getString("service")) to uuid(r.getString("characteristic"))) } catch (_: Exception) {}
            }
        }
        val auto = params.optBoolean("autoReconnect", true)
        val fast = params.optBoolean("highThroughput", false)
        // つないでいる・つなぎかけの機器 (画面を読み直したとき) は、切らずに同じつなぎを使う
        links[id]?.let { link ->
            if (!link.userClosed) {
                link.notify = notify; link.autoReconnect = auto; link.highThroughput = fast
                emitState(id, if (link.discovered) "connected" else "connecting")
                done(Result.success(JSONObject()))
                return
            }
        }
        stopScan()
        val link = Link(adapter!!.getRemoteDevice(id), notify, auto, fast)
        links[id] = link
        emitState(id, "connecting")
        open(link, autoConnect = false)
        done(Result.success(JSONObject()))
    }

    private fun open(link: Link, autoConnect: Boolean) {
        link.discovered = false
        link.gatt = link.device.connectGatt(activity, autoConnect, link.callback, BluetoothDevice.TRANSPORT_LE)
    }

    private fun disconnect(id: String) {
        val link = links[id] ?: return
        if (recorder.active?.deviceId == id) recorder.stop()
        link.userClosed = true
        val g = link.gatt
        if (g == null) {
            links.remove(id)
            emitState(id, "disconnected")
        } else {
            g.disconnect()
            // 知らせが来ないことがあるので、少し待っても切れなければ閉じる (その間に同じ機器をつなぎ直していても、古いつなぎは閉じる)
            main.postDelayed({
                if (links[id] === link) closeLink(link, null)
                else if (link.gatt === g) { try { g.close() } catch (_: Exception) {}; link.gatt = null }
            }, 1500)
        }
    }

    private fun onState(link: Link, g: BluetoothGatt, status: Int, newState: Int) {
        if (links[link.id] !== link || link.gatt !== g) { g.close(); return }
        if (newState == BluetoothProfile.STATE_CONNECTED) {
            if (link.highThroughput) g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
            g.discoverServices()
            return
        }
        if (newState != BluetoothProfile.STATE_DISCONNECTED) return
        g.close()
        link.gatt = null
        failOps(link)
        if (link.userClosed || !link.autoReconnect) { closeLink(link, if (link.userClosed) null else NativeError.io("gatt status $status")); return }
        emitState(link.id, "reconnecting")
        // 機器が戻るまで OS に待ってもらう (autoConnect)
        main.postDelayed({ if (links[link.id] === link && !link.userClosed) open(link, autoConnect = true) }, RETRY_MS)
    }

    private fun closeLink(link: Link, error: NativeError?) {
        try { link.gatt?.close() } catch (_: Exception) {}
        link.gatt = null
        failOps(link)
        if (links[link.id] === link) links.remove(link.id)
        emitState(link.id, "disconnected", error)
    }

    private fun onDiscovered(link: Link, g: BluetoothGatt) {
        if (links[link.id] !== link || link.gatt !== g) return
        link.discovered = true
        // 通知の設定は、ほかの命令 (読む・書く) より先に
        val setup = ArrayDeque<Op>()
        if (link.highThroughput) setup.add(Op.Mtu(247))
        link.notify.forEach { (s, c) -> setup.add(Op.Subscribe(s, c)) }
        setup.add(Op.Ready)
        val rest = link.ops.toList()
        link.ops.clear()
        link.ops.addAll(setup)
        link.ops.addAll(rest)
        next(link)
    }

    /** 読む・書くを列に入れる (つないでいなければ失敗) */
    private fun queueOp(params: JSONObject, done: Done, make: (Pair<UUID, UUID>) -> Op) {
        val link = links[params.optString("deviceId")]
        if (link == null || link.gatt == null || link.userClosed) { done(Result.failure(NativeError.notConnected())); return }
        val ref = try { uuid(params.getString("service")) to uuid(params.getString("characteristic")) } catch (e: Exception) { done(Result.failure(NativeError.notFound("bad params"))); return }
        link.ops.add(make(ref))
        if (link.discovered) next(link)
    }

    private fun characteristic(g: BluetoothGatt, s: UUID, c: UUID): BluetoothGattCharacteristic? = g.getService(s)?.getCharacteristic(c)

    /** 列の次の命令を出す (出せないものは、その場で終える) */
    private fun next(link: Link) {
        while (link.current == null) {
            val g = link.gatt ?: return
            val op = link.ops.removeFirstOrNull() ?: return
            val started: Boolean = when (op) {
                is Op.Mtu -> g.requestMtu(op.size)
                is Op.Ready -> {
                    val err = link.subscribeError
                    if (err != null) { link.userClosed = true; link.subscribeError = null; DebugLog.event("ble subscribe failed: ${err.message}"); link.gatt?.disconnect(); closeLink(link, err); return }
                    emitState(link.id, "connected"); false
                }
                is Op.Subscribe -> {
                    val c = characteristic(g, op.service, op.characteristic)
                    val d = c?.getDescriptor(CCCD)
                    if (c == null || d == null || !g.setCharacteristicNotification(c, true)) false
                    else {
                        val value = if (c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE else BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                        writeDescriptor(g, d, value)
                    }
                }
                is Op.Read -> {
                    val c = characteristic(g, op.service, op.characteristic)
                    if (c == null) { op.done(Result.failure(NativeError.notFound())); false } else g.readCharacteristic(c).also { if (!it) op.done(Result.failure(NativeError.io("read failed"))) }
                }
                is Op.Write -> {
                    val c = characteristic(g, op.service, op.characteristic)
                    when {
                        c == null -> { op.done(Result.failure(NativeError.notFound())); false }
                        c.properties and (BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) == 0 -> {
                            op.done(Result.failure(NativeError.notSupported("characteristic is not writable"))); false
                        }
                        else -> {
                            val withResponse = c.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0
                            val type = if (withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                            val ok = writeCharacteristic(g, c, op.data, type)
                            // 答えのない書き込みは、完了の知らせが来ない機種があるので、書いたらすぐ返す
                            if (!ok) op.done(Result.failure(NativeError.io("write failed"))) else if (!withResponse) op.done(Result.success(JSONObject()))
                            ok && withResponse
                        }
                    }
                }
            }
            if (started) {
                link.current = op
                main.postDelayed(link.timeout, OP_TIMEOUT_MS)
            }
        }
    }

    private fun finishOp(link: Link, r: Result<JSONObject>) {
        val op = link.current ?: return
        link.current = null
        main.removeCallbacks(link.timeout)
        when (op) {
            is Op.Read -> op.done(r)
            is Op.Write -> op.done(r)
            else -> {}
        }
        next(link)
    }

    private fun onRead(link: Link, value: ByteArray, status: Int) {
        if (link.current !is Op.Read) return
        finishOp(link, if (status == BluetoothGatt.GATT_SUCCESS) Result.success(JSONObject().put("b", Base64.encodeToString(value, Base64.NO_WRAP))) else Result.failure(authError(status)))
    }

    private fun failOps(link: Link) {
        main.removeCallbacks(link.timeout)
        val all = listOfNotNull(link.current) + link.ops
        link.current = null
        link.ops.clear()
        for (op in all) when (op) {
            is Op.Read -> op.done(Result.failure(NativeError.notConnected()))
            is Op.Write -> op.done(Result.failure(NativeError.notConnected()))
            else -> {}
        }
    }

    @Suppress("DEPRECATION")
    private fun writeDescriptor(g: BluetoothGatt, d: BluetoothGattDescriptor, value: ByteArray): Boolean =
        if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(d, value) == BluetoothGatt.GATT_SUCCESS
        else { d.value = value; g.writeDescriptor(d) }

    @Suppress("DEPRECATION")
    private fun writeCharacteristic(g: BluetoothGatt, c: BluetoothGattCharacteristic, data: ByteArray, type: Int): Boolean =
        if (Build.VERSION.SDK_INT >= 33) g.writeCharacteristic(c, data, type) == BluetoothGatt.GATT_SUCCESS
        else { c.writeType = type; c.value = data; g.writeCharacteristic(c) }

    private fun emitState(id: String, state: String, error: NativeError? = null) {
        recorder.note(id, state)
        val data = JSONObject().put("deviceId", id).put("state", state)
        if (error != null) data.put("error", JSONObject().put("code", error.code).put("message", error.message ?: ""))
        bridge.emit("ble.state", data)
    }

    /** 画面を閉じるとき: 全部のつなぎを閉じ、記録を書き終える */
    fun shutdown() {
        stopScan(notify = false)
        recorder.stop()
        for (link in links.values.toList()) { link.userClosed = true; try { link.gatt?.disconnect(); link.gatt?.close() } catch (_: Exception) {} }
        links.clear()
    }

    // ---- 通知をまとめて送る ----

    private class Item(val t: Long, val bytes: ByteArray)
    private val pending = LinkedHashMap<Pair<String, String>, MutableList<Item>>()
    private var flushScheduled = false
    private val flusher = Runnable { flush() }

    /** GATT のスレッドから呼ばれる。時刻は受け取ったそばで付ける */
    private fun enqueueNotify(id: String, c: UUID, value: ByteArray) {
        val t = SystemClock.elapsedRealtimeNanos()
        val key = id to name(c)
        main.post {
            recorder.append(t, id, key.second, value)
            pending.getOrPut(key) { mutableListOf() }.add(Item(t, value))
            if (!flushScheduled) { flushScheduled = true; main.postDelayed(flusher, FLUSH_MS) }
        }
    }

    private fun flush() {
        flushScheduled = false
        for ((key, items) in pending) {
            val arr = JSONArray()
            items.forEach { arr.put(JSONObject().put("t", it.t).put("b", Base64.encodeToString(it.bytes, Base64.NO_WRAP))) }
            bridge.emit("ble.notify", JSONObject().put("deviceId", key.first).put("characteristic", key.second).put("items", arr))
        }
        pending.clear()
    }
}
