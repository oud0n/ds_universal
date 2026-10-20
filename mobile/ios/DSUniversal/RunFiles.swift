import Foundation
@preconcurrency import WebKit

/// 走行のフォルダ (2026-10-20、docs/session_storage_design.md)。
/// 保管場所に選んだフォルダ (iCloud Drive など) があればそこ、なければ書類の LapTimer/ を「走行の置き場」とし、
/// その下のサーキットのフォルダの .bon4・.nmea・動画・runs.json・laptimes.json を Web から読み書きする。
/// 動画は lapfile://run/<道> で Web に見せる (大きな動画を丸ごと読まず、頼まれた範囲だけ読む。LapFileSchemeHandler)
enum RunFiles {
    static let storageKindKey = "lapTimer.storage.kind"
    static let storageBookmarkKey = "lapTimer.storage.bookmark"
    static let scheme = "lapfile"
    static let urlBase = "lapfile://run/"

    /// 書類の LapTimer/ (走っている間は、いつもここに書く)
    static var lapTimerRoot: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("LapTimer", isDirectory: true)
    }

    /// 走行の置き場と、選んだフォルダか
    static func root() -> (url: URL, scoped: Bool) {
        if UserDefaults.standard.string(forKey: storageKindKey) == "folder",
           let data = UserDefaults.standard.data(forKey: storageBookmarkKey) {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) {
                return (url, true)
            }
        }
        return (lapTimerRoot, false)
    }

    /// 置き場の下の場所 (上のフォルダへ出る名前・絶対の道は断る)
    static func resolve(_ rel: String, in root: URL) -> URL? {
        guard !rel.isEmpty, !rel.hasPrefix("/"), !rel.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        let url = root.appendingPathComponent(rel)
        // 別名 (シンボリックリンク) をたどった先も、置き場の中か確かめる。まだ無いファイル (これから書く) は、
        // いちばん近くにある上のフォルダをたどって確かめる (無い部分があると、途中の別名がたどられないため)
        let base = root.resolvingSymlinksInPath().path
        var existing = url
        while !FileManager.default.fileExists(atPath: existing.path) && existing.path.count > root.path.count {
            existing = existing.deletingLastPathComponent()
        }
        let real = existing.resolvingSymlinksInPath().path
        guard real == base || real.hasPrefix(base + "/") else { return nil }
        if existing.path != url.path, !url.resolvingSymlinksInPath().path.hasPrefix(base + "/") { return nil }
        return url
    }

    /// 置き場を使う許可をもらって f を呼ぶ
    static func withRoot<T>(_ f: (URL) throws -> T) rethrows -> T {
        let (url, scoped) = root()
        let access = scoped && url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        return try f(url)
    }

    static let videoExt: Set<String> = ["mp4", "mov", "m4v", "lrv", "insv", "mkv", "webm"]

    /// 置き場の下のファイル。iCloud からまだ落ちてきていないファイル (.名前.icloud) も、元の名前で local: false として出す
    struct FileInfo: Sendable {
        let path: String
        let size: Int
        let mtimeMs: Double
        let local: Bool
        var dict: [String: Any] { ["path": path, "size": size, "mtimeMs": mtimeMs, "local": local] }
    }

    static func list() -> [FileInfo] {
        withRoot { root in
            let base = root.resolvingSymlinksInPath().path
            var out: [FileInfo] = []
            let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey, .ubiquitousItemDownloadingStatusKey, .isUbiquitousItemKey]
            guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys, options: []) else { return out }
            for case let file as URL in e {
                let path = file.resolvingSymlinksInPath().path
                guard path.hasPrefix(base + "/") else { continue }
                var rel = String(path.dropFirst(base.count + 1))
                let name = (rel as NSString).lastPathComponent
                if rel == "exports" || rel.hasPrefix("exports/") || rel == "Downloads" {
                    e.skipDescendants()
                    continue
                }
                let values = try? file.resourceValues(forKeys: Set(keys))
                if name.hasPrefix(".") {
                    // iCloud の置き場所だけのファイル (.名前.icloud)。それ以外の隠しファイルは出さない
                    guard name.hasSuffix(".icloud"), name.count > 8 else { continue }
                    let real = String(name.dropFirst().dropLast(7))
                    rel = ((rel as NSString).deletingLastPathComponent as NSString).appendingPathComponent(real)
                    var size = 0
                    if let data = try? Data(contentsOf: file),
                       let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] {
                        size = (plist["NSURLFileSizeKey"] as? Int) ?? 0
                    }
                    let mtime = (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
                    out.append(FileInfo(path: rel, size: size, mtimeMs: mtime.rounded(), local: false))
                    continue
                }
                guard values?.isRegularFile == true else { continue }
                let size = values?.fileSize ?? 0
                let mtime = (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
                var local = true
                if values?.isUbiquitousItem == true, let status = values?.ubiquitousItemDownloadingStatus, status == .notDownloaded {
                    local = false
                }
                out.append(FileInfo(path: rel, size: size, mtimeMs: mtime.rounded(), local: local))
            }
            return out
        }
    }

    /// ログ・控えを読む (動画などの大きなファイルは読まない)。iCloud から落ちてきていなければ、落ちてくるのを待つ
    static func read(_ rel: String) throws -> Data {
        let allowed = ["bon4", "nmea", "json", "csv"]
        return try withRoot { root in
            guard let url = resolve(rel, in: root), allowed.contains(url.pathExtension.lowercased()) else {
                throw NativeError(.notFound, "no file")
            }
            // 無いファイル (iCloud にだけあるもの .名前.icloud も無いとき) は not-found。読めないときの io と分ける
            // (runs.json が読めないのに「無い」とみなして書くと、ほかの走行の行を消すため)
            let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
            if !FileManager.default.fileExists(atPath: url.path) && !FileManager.default.fileExists(atPath: placeholder.path) {
                throw NativeError(.notFound, "no file")
            }
            var coordError: NSError?
            var result: Result<Data, Error> = .failure(NativeError(.io, "could not read"))
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordError) { u in
                let size = ((try? FileManager.default.attributesOfItem(atPath: u.path))?[.size] as? Int) ?? 0
                if size > 64 * 1024 * 1024 {
                    result = .failure(NativeError(.io, "file too large"))
                    return
                }
                do { result = .success(try Data(contentsOf: u)) } catch { result = .failure(error) }
            }
            if let coordError { throw coordError }
            return try result.get()
        }
    }

    /// runs.json・laptimes.json だけを書く (一時ファイルに書いてから入れ替える)
    static func write(_ rel: String, _ data: Data) throws {
        let allowed = ["runs.json", "laptimes.json"]
        try withRoot { root in
            guard let url = resolve(rel, in: root), allowed.contains(url.lastPathComponent) else {
                throw NativeError(.notFound, "not writable")
            }
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            var coordError: NSError?
            var writeError: Error?
            NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordError) { u in
                do { try data.write(to: u, options: .atomic) } catch { writeError = error }
            }
            if let err = writeError ?? coordError { throw err }
        }
    }

    /// iCloud からの取り込みを始める (動画を開く前に。終わるのは待たない)
    static func startDownload(_ rel: String) throws {
        try withRoot { root in
            guard let url = resolve(rel, in: root) else { throw NativeError(.notFound, "no file") }
            try FileManager.default.startDownloadingUbiquitousItem(at: url)
        }
    }

    static func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "mp4", "m4v", "lrv", "insv": return "video/mp4"
        case "mov": return "video/quicktime"
        case "webm": return "video/webm"
        case "mkv": return "video/x-matroska"
        case "json": return "application/json"
        default: return "application/octet-stream"
        }
    }
}

/// lapfile://run/<道> を、走行の置き場のファイルから返す。Range (bytes=a-b) に答える (動画の再生・範囲の読み出し)
/// WKURLSchemeTask を別のスレッドへ渡すための箱 (渡した先では、main の上でだけ触る)
private struct TaskBox: @unchecked Sendable {
    let task: WKURLSchemeTask
}

final class LapFileSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    nonisolated private let lock = NSLock()
    nonisolated(unsafe) private var running = Set<ObjectIdentifier>()
    nonisolated private let queue = DispatchQueue(label: "lapfile", qos: .userInitiated, attributes: .concurrent)
    /// 1 回に渡す大きさ
    nonisolated private static let chunk = 1 << 20

    nonisolated private func isRunning(_ task: WKURLSchemeTask) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return running.contains(ObjectIdentifier(task))
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        lock.lock(); running.insert(ObjectIdentifier(task)); lock.unlock()
        let request = task.request
        let box = TaskBox(task: task)
        queue.async { [weak self] in self?.serve(box, request) }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); running.remove(ObjectIdentifier(task)); lock.unlock()
    }

    /// 頼みに答える (答えは main で渡す。止められた頼みには渡さない)
    nonisolated private func send(_ box: TaskBox, _ f: @escaping @Sendable (WKURLSchemeTask) -> Void) {
        DispatchQueue.main.sync {
            guard self.isRunning(box.task) else { return }
            f(box.task)
        }
    }

    nonisolated private func finish(_ box: TaskBox) {
        DispatchQueue.main.sync {
            guard self.isRunning(box.task) else { return }
            box.task.didFinish()
            self.lock.lock(); self.running.remove(ObjectIdentifier(box.task)); self.lock.unlock()
        }
    }

    nonisolated private func fail(_ task: TaskBox, _ status: Int, _ url: URL) {
        let headers = ["Access-Control-Allow-Origin": "*", "Content-Length": "0"]
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        send(task) { $0.didReceive(response) }
        finish(task)
    }

    nonisolated private func serve(_ task: TaskBox, _ request: URLRequest) {
        guard let url = request.url else { return }
        // lapfile://run/<道 (% で書いたもの)>
        let rel = (url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path)
        guard url.host == "run", !rel.isEmpty else { return fail(task, 404, url) }
        let (root, scoped) = RunFiles.root()
        let access = scoped && root.startAccessingSecurityScopedResource()
        defer { if access { root.stopAccessingSecurityScopedResource() } }
        // 読めるのは動画だけ (ログ・控えは system.readRunFile で読む)
        guard let file = RunFiles.resolve(rel, in: root), RunFiles.videoExt.contains(file.pathExtension.lowercased()) else { return fail(task, 404, url) }

        // iCloud から落ちてきていなければ、落ちてくるまで待つ (Web は開く前に、大きさを知らせて聞いておく)
        var coordError: NSError?
        var handle: FileHandle?
        var size: UInt64 = 0
        NSFileCoordinator().coordinate(readingItemAt: file, options: [], error: &coordError) { u in
            size = ((try? FileManager.default.attributesOfItem(atPath: u.path))?[.size] as? NSNumber)?.uint64Value ?? 0
            handle = try? FileHandle(forReadingFrom: u)
        }
        guard let handle, coordError == nil else { return fail(task, 404, url) }
        defer { try? handle.close() }

        var start: UInt64 = 0
        var end: UInt64 = size > 0 ? size - 1 : 0
        var partial = false
        if let range = request.value(forHTTPHeaderField: "Range"), range.hasPrefix("bytes=") {
            let spec = range.dropFirst(6).split(separator: ",").first ?? ""
            let parts = spec.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
            if parts.count == 2 {
                if parts[0].isEmpty, let n = UInt64(parts[1]) {
                    start = size > n ? size - n : 0
                    partial = true
                } else if let a = UInt64(parts[0]) {
                    start = a
                    if let b = UInt64(parts[1]) { end = min(b, end) }
                    partial = true
                }
                // 読めない Range (bytes=- など) は付いていないものとして、全部を返す
            }
        }
        if size == 0 && !partial {
            let headers = ["Content-Type": RunFiles.mimeType(file.pathExtension), "Content-Length": "0", "Access-Control-Allow-Origin": "*"]
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
            send(task) { $0.didReceive(response) }
            return finish(task)
        }
        if size == 0 || start > end || start >= size {
            let headers = ["Content-Range": "bytes */\(size)", "Access-Control-Allow-Origin": "*", "Content-Length": "0"]
            let response = HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1", headerFields: headers)!
            send(task) { $0.didReceive(response) }
            return finish(task)
        }
        let length = end - start + 1
        var headers: [String: String] = [
            "Content-Type": RunFiles.mimeType(file.pathExtension),
            "Content-Length": String(length),
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
            "Cache-Control": "no-store"
        ]
        if partial { headers["Content-Range"] = "bytes \(start)-\(end)/\(size)" }
        let response = HTTPURLResponse(url: url, statusCode: partial ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        send(task) { $0.didReceive(response) }

        do {
            try handle.seek(toOffset: start)
            var left = length
            while left > 0 {
                guard isRunning(task.task) else { return }
                let n = Int(min(UInt64(Self.chunk), left))
                guard let data = try handle.read(upToCount: n), !data.isEmpty else { break }
                left -= UInt64(data.count)
                send(task) { $0.didReceive(data) }
            }
            finish(task)
        } catch {
            send(task) { $0.didFailWithError(error) }
            lock.lock(); running.remove(ObjectIdentifier(task.task)); lock.unlock()
        }
    }
}
