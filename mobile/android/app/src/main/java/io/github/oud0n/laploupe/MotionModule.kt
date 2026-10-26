package io.github.oud0n.laploupe

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

/**
 * 端末の G センサー (約束の system.motionStart / system.motionStop、知らせ system.motion。2026-10-25。iPhone の MotionRecorder.swift と同じ形)。
 * 測っている間、重力・重力を除いた加速度・回転の速さを読み、0.5 秒ごとにまとめて Web へ渡す。車の向きへの読み替えは Web がする。
 *
 * 向きの決まり: 軸は iPhone と同じ (x 右・y 上・z 画面から手前)。ただし Android の加速度は iPhone と符号が逆
 * (Android は置いた端末で z = +9.8、iPhone の重力は z = −1) なので、重力と加速度は符号を変えて G にする。回転の速さはそのまま (rad/s)
 */
class MotionModule(private val ctx: Context, private val bridge: NativeBridge) : SensorEventListener {
    companion object {
        private const val G = 9.80665
        private const val MAX_PENDING = 6000
    }

    private val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val main = Handler(Looper.getMainLooper())
    private var running = false
    /** 読み始めるたびに増やす (止めたあとに届いた前の回の値を捨てるため) */
    private var generation = 0
    private val grav = DoubleArray(3)
    private val lin = DoubleArray(3)
    private var haveGrav = false
    private val t = ArrayList<Double>()
    private val cols = Array(9) { ArrayList<Double>() }
    private val drainer = object : Runnable {
        override fun run() { drain(); if (running) main.postDelayed(this, 500) }
    }

    fun handle(method: String, params: JSONObject, done: Done) {
        when (method) {
            "system.motionStart" -> {
                val gyro = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
                val gravity = sm.getDefaultSensor(Sensor.TYPE_GRAVITY)
                val linear = sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
                if (gyro == null || gravity == null || linear == null) { done(Result.failure(NativeError.notSupported("no motion sensors"))); return }
                if (!running) {
                    val us = (1_000_000.0 / params.optDouble("hz", 50.0).coerceIn(1.0, 100.0)).toInt()
                    generation++
                    haveGrav = false
                    t.clear(); cols.forEach { it.clear() }
                    sm.registerListener(this, gravity, us)
                    sm.registerListener(this, linear, us)
                    // 回転の速さが来るたびに 1 行 (そのときの重力・加速度と組にする)
                    sm.registerListener(this, gyro, us)
                    running = true
                    main.postDelayed(drainer, 500)
                }
                done(Result.success(JSONObject()))
            }
            "system.motionStop" -> {
                if (running) {
                    sm.unregisterListener(this)
                    running = false
                    generation++
                    main.removeCallbacks(drainer)
                    drain()
                }
                done(Result.success(JSONObject()))
            }
            else -> done(Result.failure(NativeError.notSupported("unknown method $method")))
        }
    }

    override fun onSensorChanged(e: SensorEvent) {
        when (e.sensor.type) {
            Sensor.TYPE_GRAVITY -> { for (i in 0..2) grav[i] = -e.values[i] / G; haveGrav = true }
            Sensor.TYPE_LINEAR_ACCELERATION -> for (i in 0..2) lin[i] = -e.values[i] / G
            Sensor.TYPE_GYROSCOPE -> {
                if (!haveGrav) return
                // 時刻 (起動からのナノ秒) を UTC のミリ秒に
                val utc = System.currentTimeMillis() - SystemClock.elapsedRealtime() + e.timestamp / 1_000_000.0
                val row = doubleArrayOf(grav[0], grav[1], grav[2], lin[0], lin[1], lin[2], e.values[0].toDouble(), e.values[1].toDouble(), e.values[2].toDouble())
                val gen = generation
                main.post {
                    if (gen != generation) return@post
                    t.add(Math.round(utc).toDouble())
                    for (i in 0..8) cols[i].add(row[i])
                    // ためすぎない (Web が受け取れない間)
                    if (t.size > MAX_PENDING) { t.removeAt(0); cols.forEach { it.removeAt(0) } }
                }
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    /** 画面を閉じるとき */
    fun shutdown() {
        sm.unregisterListener(this)
        running = false
        generation++
        main.removeCallbacks(drainer)
    }

    private fun drain() {
        if (t.isEmpty()) return
        val names = listOf("gx", "gy", "gz", "ux", "uy", "uz", "rx", "ry", "rz")
        val data = JSONObject().put("t", JSONArray(t))
        names.forEachIndexed { i, n -> data.put(n, JSONArray(cols[i])) }
        bridge.emit("system.motion", data)
        t.clear()
        cols.forEach { it.clear() }
    }
}
