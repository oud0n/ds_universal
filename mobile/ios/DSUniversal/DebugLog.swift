import Foundation
import os

/// 調べもの用のログ。アプリが OS に止められても残るよう、ファイル (Documents/ble-captures/debug.log) に書き足す。
/// 「ファイル」アプリの LapLoupe → ble-captures から共有できる。Mac につないでいるときは Console.app にも出る (subsystem: io.github.oud0n.dsuniversal)
///
/// 書くもの: 起動 (どう起動したか)、前・裏、メモリの知らせ、Bluetooth の状態・つなぎ・切れ、記録の開始・停止・再開、裏にいる間のメモリの量。
/// 位置などの測位の中身は書かない
enum DebugLog {
    private static let logger = Logger(subsystem: "io.github.oud0n.dsuniversal", category: "debug")
    private static let queue = DispatchQueue(label: "ds.debuglog")
    /// これを超えたら古い半分を捨てる
    private static let maxBytes = 1_000_000

    static var url: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("ble-captures", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("debug.log")
    }

    /// 1 行書く。すぐファイルに書く (OS に止められても、それまでの行は残る)
    static func write(_ message: String) {
        let line = "\(Date().ISO8601Format(.iso8601(timeZone: .current, includingFractionalSeconds: true))) [\(ProcessInfo.processInfo.processIdentifier)] \(message)\n"
        logger.log("\(message, privacy: .public)")
        queue.async {
            let url = Self.url
            if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
               let size = attrs[.size] as? Int, size > maxBytes,
               let data = try? Data(contentsOf: url) {
                try? data.suffix(maxBytes / 2).write(to: url)
            }
            if let handle = try? FileHandle(forWritingTo: url) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: Data(line.utf8))
                try? handle.close()
            } else {
                try? Data(line.utf8).write(to: url)
            }
        }
    }

    /// このアプリが使っているメモリ (MB)。OS がメモリ不足で止めるときに見る量 (phys_footprint)
    static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
    }
}
