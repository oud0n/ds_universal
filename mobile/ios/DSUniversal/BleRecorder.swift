import UIKit
import Foundation

/// BLE の通知を、そのままファイルに書き足す (約束の recorder.*)。読み方は持たない (読むのは Web)。
///
/// ファイル (Documents/ble-captures/<名前>.csv) の形:
/// ```
/// # ds-ble-capture 1
/// # <Web が渡した見出し (device=… など)>
/// # started_utc_ms=<端末の時計> started_ns=<単調な時計>
/// t_ns,device,characteristic,hex
/// 123456789,<機器の ID>,2a67,8520070012…
/// # state,<t_ns>,reconnecting
/// ```
/// 記録中かどうかは UserDefaults に残し、OS がアプリを止めて起こし直したときに続きから書き足す
@MainActor
final class BleRecorder {
    struct Active: Codable {
        let fileName: String
        let deviceId: String
        /// 通知を受け取る特性 ([サービス, 特性])。起こし直したときに、つなぎ直すのに使う
        let notify: [[String]]
        var notifications: Int
    }

    private static let defaultsKey = "ds.ble.recording"
    private static let flushSeconds = 1.0

    private(set) var active: Active?
    private var handle: FileHandle?
    private var buffer = ""
    private var flushTimer: Timer?
    private var lastFlushNs: UInt64 = 0
    private var lastStatusNs: UInt64 = 0

    static var directory: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("ble-captures", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func url(of fileName: String) throws -> URL {
        // ファイル名だけを受け付ける (ほかのフォルダを指させない)
        guard !fileName.isEmpty, !fileName.contains("/"), !fileName.hasPrefix(".") else {
            throw NativeError(.notFound, "bad file name")
        }
        return directory.appendingPathComponent(fileName)
    }

    func start(name: String, deviceId: String, notify: [[String]], header: [String]) throws -> String {
        if active != nil { _ = stop() }
        let base = name.replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
        var fileName = "\(base).csv"
        var n = 2
        while FileManager.default.fileExists(atPath: try Self.url(of: fileName).path) {
            fileName = "\(base)_\(n).csv"
            n += 1
        }
        let url = try Self.url(of: fileName)
        var text = "# ds-ble-capture 1\n"
        for line in header { text += "# \(line.replacingOccurrences(of: "\n", with: " "))\n" }
        text += "# started_utc_ms=\(Int64(Date().timeIntervalSince1970 * 1000)) started_ns=\(MonoClock.nowNs())\n"
        text += "t_ns,device,characteristic,hex\n"
        guard FileManager.default.createFile(atPath: url.path, contents: Data(text.utf8)) else {
            throw NativeError(.io, "cannot create \(fileName)")
        }
        handle = try FileHandle(forWritingTo: url)
        try handle?.seekToEnd()
        active = Active(fileName: fileName, deviceId: deviceId, notify: notify, notifications: 0)
        DebugLog.write("recorder start \(fileName)")
        save()
        startTimer()
        return fileName
    }

    /// 起こし直したとき: 記録中だったら、同じファイルに続きを書き足す
    func resume() -> Active? {
        guard let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
              let saved = try? JSONDecoder().decode(Active.self, from: data),
              let url = try? Self.url(of: saved.fileName),
              let h = try? FileHandle(forWritingTo: url) else { return nil }
        _ = try? h.seekToEnd()
        handle = h
        active = saved
        buffer += "# resumed,\(MonoClock.nowNs()),started_utc_ms=\(Int64(Date().timeIntervalSince1970 * 1000))\n"
        startTimer()
        return saved
    }

    func append(tNs: UInt64, deviceId: String, characteristic: String, bytes: Data) {
        guard active?.deviceId == deviceId else { return }
        buffer += "\(tNs),\(deviceId),\(characteristic),\(bytes.map { String(format: "%02x", $0) }.joined())\n"
        active?.notifications += 1
        // 裏にいる間はタイマーが動かないことがあるので、書き足すときにも 1 秒ごとに書き出す (OS に止められても失うのは 1 秒分まで)
        if tNs &- lastFlushNs > 1_000_000_000 { flush() }
    }

    func note(deviceId: String, state: String) {
        guard active?.deviceId == deviceId else { return }
        buffer += "# state,\(MonoClock.nowNs()),\(state)\n"
    }

    @discardableResult
    func stop() -> [String: Any] {
        guard let a = active else { return [:] }
        DebugLog.write("recorder stop \(a.fileName) notifications=\(a.notifications)")
        flush()
        try? handle?.close()
        handle = nil
        active = nil
        flushTimer?.invalidate()
        flushTimer = nil
        UserDefaults.standard.removeObject(forKey: Self.defaultsKey)
        let bytes = (try? Self.url(of: a.fileName)).flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? Int } ?? 0
        return ["fileName": a.fileName, "notifications": a.notifications, "bytes": bytes]
    }

    /// 書き足しを待っている分をファイルに書く (1 秒ごとと、裏に回るとき)
    func flush() {
        guard !buffer.isEmpty, let handle else { return }
        do {
            try handle.write(contentsOf: Data(buffer.utf8))
        } catch {
            DebugLog.write("recorder write failed: \(error.localizedDescription)")
        }
        buffer = ""
        lastFlushNs = MonoClock.nowNs()
        save()
        // 30 秒ごとに、記録の進みとメモリの量を残す (裏で止められたときの手がかり)
        if lastFlushNs &- lastStatusNs > 30_000_000_000 {
            lastStatusNs = lastFlushNs
            let n = active?.notifications ?? 0
            Task { @MainActor in
                let state = UIApplication.shared.applicationState == .background ? "background" : "foreground"
                DebugLog.write("recording notifications=\(n) state=\(state) footprint=\(String(format: "%.0f", DebugLog.footprintMB()))MB")
            }
        }
    }

    func list() -> [[String: Any]] {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        let urls = (try? FileManager.default.contentsOfDirectory(at: Self.directory, includingPropertiesForKeys: keys)) ?? []
        return urls.filter { $0.pathExtension == "csv" }.map { url in
            let values = try? url.resourceValues(forKeys: Set(keys))
            return [
                "fileName": url.lastPathComponent,
                "bytes": values?.fileSize ?? 0,
                "modifiedMs": Int64((values?.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000)
            ]
        }
    }

    func read(_ fileName: String) throws -> String {
        if active?.fileName == fileName { flush() }
        return try String(contentsOf: Self.url(of: fileName), encoding: .utf8)
    }

    func remove(_ fileName: String) throws {
        guard active?.fileName != fileName else { throw NativeError(.busy, "recording") }
        try FileManager.default.removeItem(at: Self.url(of: fileName))
    }

    private func startTimer() {
        flushTimer?.invalidate()
        flushTimer = Timer.scheduledTimer(withTimeInterval: Self.flushSeconds, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.flush() }
        }
    }

    private func save() {
        guard let active, let data = try? JSONEncoder().encode(active) else { return }
        UserDefaults.standard.set(data, forKey: Self.defaultsKey)
    }
}
