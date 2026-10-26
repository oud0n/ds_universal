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
        // まだ無い部分は別名になりえないので、あるところまでを確かめれば足りる
        // (無い道をたどると /var が /private/var に直らず、置き場の外と見誤って書けなかった。実機だけで起きる)
        let real = existing.resolvingSymlinksInPath().path
        guard real == base || real.hasPrefix(base + "/") else { return nil }
        return url
    }

    /// 置き場を使う許可をもらって f を呼ぶ
    /// 待つかもしれないファイルの読み書き (iCloud の取り込み・ほかのアプリとの取り合いで待つ) をする列。
    /// Swift の並行処理の共有のスレッド (Task.detached) で待つと、数が限られているので、待つものが重なると
    /// ほかの読み書き (走行の一覧など) まで回らなくなり、アプリが「読み込んでいます」のまま止まっていた (iPad の実機。1.9 GB の動画の取り込み中)
    nonisolated static let ioQueue = DispatchQueue(label: "runfiles.io", qos: .userInitiated, attributes: .concurrent)

    static func background<T: Sendable>(_ f: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { c in ioQueue.async { c.resume(returning: f()) } }
    }

    /// 端末に落ちてきているか (iCloud にだけあるものは false)
    static func isDownloaded(_ url: URL) -> Bool {
        let fresh = URL(fileURLWithPath: url.path)
        let placeholder = fresh.deletingLastPathComponent().appendingPathComponent(".\(fresh.lastPathComponent).icloud")
        let exists = FileManager.default.fileExists(atPath: fresh.path)
        if !exists { return !FileManager.default.fileExists(atPath: placeholder.path) }
        let values = try? fresh.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey, .isUbiquitousItemKey])
        return !(values?.isUbiquitousItem == true && values?.ubiquitousItemDownloadingStatus == .notDownloaded)
    }

    /// 落ちてきていなければ取り込みを頼み、timeout 秒まで待つ。落ちてきたら true。
    /// (取り込みは iCloud の側で順番に進むので、大きな動画の取り込み中は小さなファイルもなかなか来ない。いつまでも待たない)
    static func waitDownloaded(_ url: URL, timeout: TimeInterval) -> Bool {
        if isDownloaded(url) { return true }
        try? FileManager.default.startDownloadingUbiquitousItem(at: url)
        let until = Date().addingTimeInterval(timeout)
        while Date() < until {
            Thread.sleep(forTimeInterval: 0.5)
            if isDownloaded(url) { return true }
        }
        return false
    }

    static func withRoot<T>(_ f: (URL) throws -> T) rethrows -> T {
        let (url, scoped) = root()
        let access = scoped && url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        return try f(url)
    }

    static let videoExt: Set<String> = ["mp4", "mov", "m4v", "lrv", "insv", "mkv", "webm"]

    /// 前の版がサーキットのフォルダにじかに置いた走行のファイル (YYYYMMDDhhmmss.bon4 など) を、日付のフォルダ (YYYYMMDD/) へ移す (2026-10-20)。
    /// 同じ走行のファイル (.bon4・.nmea・.csv) はまとめて動かす。どれかが 10 分以内に書き換えられた (書いている途中かもしれない) とき、
    /// 移す先に同じ名前があるときは、その走行は動かさない (.bon4 と .nmea が別のフォルダに分かれないように)。
    /// coordinated: 選んだフォルダ (iCloud Drive など) では、ほかのアプリと取り合わないよう NSFileCoordinator で動かす
    static func moveFlatRunsIntoDateFolders(in root: URL, coordinated: Bool = false) {
        let fm = FileManager.default
        guard let folders = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { return }
        let pattern = try! NSRegularExpression(pattern: "^((\\d{8})\\d{6}(?:_\\d+)?)(?:\\.[A-Za-z0-9_]+)?\\.(bon4|nmea|csv)$", options: [.caseInsensitive])
        // 共有のための exports/ と、取り込んだ元のログ (取り込み元/) は走行のフォルダではないので動かさない
        for folder in folders where (try? folder.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true && folder.lastPathComponent != "exports" && folder.lastPathComponent != "取り込み元" {
            guard let files = try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey], options: [.skipsHiddenFiles]) else { continue }
            // 走行ごと (名前の頭 YYYYMMDDhhmmss) にまとめる
            var runs: [String: (date: String, files: [URL])] = [:]
            for file in files {
                let name = file.lastPathComponent
                guard let m = pattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)),
                      let stem = Range(m.range(at: 1), in: name), let day = Range(m.range(at: 2), in: name),
                      (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
                runs[String(name[stem]), default: (String(name[day]), [])].files.append(file)
            }
            for (_, run) in runs {
                let recent = run.files.contains { f in
                    guard let d = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate else { return false }
                    return Date().timeIntervalSince(d) < 600
                }
                let dir = folder.appendingPathComponent(run.date, isDirectory: true)
                // 移す先に同じ名前があれば動かさない (iCloud にだけあるファイル .名前.icloud も、あるものとみなす)
                let clash = run.files.contains {
                    fm.fileExists(atPath: dir.appendingPathComponent($0.lastPathComponent).path)
                        || fm.fileExists(atPath: dir.appendingPathComponent(".\($0.lastPathComponent).icloud").path)
                }
                if recent || clash { continue }
                do {
                    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                    for file in run.files {
                        let target = dir.appendingPathComponent(file.lastPathComponent)
                        if coordinated {
                            var coordError: NSError?
                            var moveError: Error?
                            NSFileCoordinator().coordinate(writingItemAt: file, options: .forMoving, writingItemAt: target, options: .forReplacing, error: &coordError) { from, to in
                                do { try FileManager.default.moveItem(at: from, to: to) } catch { moveError = error }
                            }
                            if let e = moveError ?? coordError { throw e }
                        } else {
                            try fm.moveItem(at: file, to: target)
                        }
                    }
                } catch {
                    DebugLog.write("move flat run failed \(run.files.first?.lastPathComponent ?? "-") \(error.localizedDescription)")
                }
            }
        }
    }

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
        // pth・cln・sci: 保管場所の digspice/ のコースデータ (デジスパイスと同じ形。storageCourses.ts)
        let allowed = ["bon4", "nmea", "json", "csv", "pth", "cln", "sci"]
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
            // iCloud にだけあるときは、取り込みを頼んで少し待つ。来なければ「読めない」(io) で返す (無い not-found とは分ける)
            guard waitDownloaded(url, timeout: 15) else { throw NativeError(.io, "not downloaded yet") }
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

    /// 動画の一部を読む (撮影日時・GoPro の GPS を読むため。https のページからは lapfile:// を fetch で読めないので、窓口で渡す)
    static func readRange(_ rel: String, offset: UInt64, length: Int) throws -> Data {
        guard length > 0, length <= 8 * 1024 * 1024 else { throw NativeError(.io, "bad length") }
        return try withRoot { root in
            guard let url = resolve(rel, in: root), videoExt.contains(url.pathExtension.lowercased()) else { throw NativeError(.notFound, "no file") }
            guard FileManager.default.fileExists(atPath: url.path) else { throw NativeError(.notFound, "not downloaded") }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            try handle.seek(toOffset: offset)
            return try handle.read(upToCount: length) ?? Data()
        }
    }

    /// ファイルが端末にあるか・iCloud から取り込み中か
    static func status(_ rel: String) -> [String: Any] {
        withRoot { root in
            guard let url = resolve(rel, in: root) else { return ["local": false, "downloading": false] }
            let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
            let values = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsDownloadingKey, .isUbiquitousItemKey])
            let exists = FileManager.default.fileExists(atPath: url.path)
            var local = exists
            if values?.isUbiquitousItem == true, values?.ubiquitousItemDownloadingStatus == .notDownloaded { local = false }
            if !exists && FileManager.default.fileExists(atPath: placeholder.path) { local = false }
            return ["local": local, "downloading": values?.ubiquitousItemIsDownloading ?? false]
        }
    }

    /// 保管場所の course/ (デジスパイスのコースフォルダにならった形。2026-10-24) に書いてよいファイル:
    /// コーナー (Corner/<フォルダ>.json と .bak)・コース編集で直したコースの計測線・セクター線・その一覧 (courses.json)
    static func isCourseText(_ rel: String) -> Bool {
        rel.range(of: #"^course/(Corner/[a-z0-9_]+\.json(\.bak)?|ControlLine/[^/]+\.cln|Sector/[^/]+\.sci|courses\.json)$"#, options: .regularExpression) != nil
            // 解析用のセッション (保存した比べ方。PLAN-18。2026-10-25)
            || rel.range(of: #"^sessions/[^/]+\.lapsession\.json$"#, options: .regularExpression) != nil
            // メーターの並び (PLAN-08。2026-10-25)
            || rel.range(of: #"^overlays/[^/]+\.overlay\.json$"#, options: .regularExpression) != nil
            // CSV の形式の定義・計算式 (PLAN-36。2026-10-26)
            || rel.range(of: #"^formats/([^/]+\.csvformat\.json|calc\.json)$"#, options: .regularExpression) != nil
    }

    /// 消してよい走行のファイルか (サーキットのフォルダの中のもの。共有の控え・コース・セッションは消さない)
    static func isDeletableRunFile(_ rel: String) -> Bool {
        let name = (rel as NSString).lastPathComponent
        guard rel.contains("/"), !rel.hasPrefix("course/"), !rel.hasPrefix("sessions/"), !rel.hasPrefix("exports/") else { return false }
        return !["runs.json", "laptimes.json", "corners.json", "corners.json.bak"].contains(name) && !name.hasPrefix(".")
    }

    /// 走行のファイルを消す (「ファイル」の最近削除した項目へ移す。移せないときは消す)。選んだフォルダのときは、アプリの中の写しも消す
    /// permanent: 最近削除した項目へ移せず、すぐに消したもの (アプリの中の保管場所など)
    static func delete(_ paths: [String]) -> (deleted: [String], failed: [(String, String)], permanent: [String]) {
        var deleted: [String] = []
        var permanent: [String] = []
        var failed: [(String, String)] = []
        let fm = FileManager.default
        withRoot { root in
            let (_, scoped) = Self.root()
            for rel in paths {
                guard isDeletableRunFile(rel), let url = resolve(rel, in: root) else { failed.append((rel, "not deletable")); continue }
                // iCloud にだけあるもの (.名前.icloud) は、その置き場所のファイルを消す
                let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
                let target = fm.fileExists(atPath: url.path) ? url : (fm.fileExists(atPath: placeholder.path) ? placeholder : nil)
                var ok = target == nil
                var message = ""
                if let target {
                    var coordError: NSError?
                    NSFileCoordinator().coordinate(writingItemAt: target, options: .forDeleting, error: &coordError) { u in
                        do {
                            do { try fm.trashItem(at: u, resultingItemURL: nil) } catch { try fm.removeItem(at: u); permanent.append(rel) }
                            ok = true
                        } catch {
                            message = error.localizedDescription
                        }
                    }
                    if let coordError { ok = false; message = coordError.localizedDescription }
                }
                // 選んだフォルダのとき: まだ移していない、アプリの中の写しも消す (残すと、次に写したときに戻ってくる)
                if scoped, let local = resolve(rel, in: lapTimerRoot), fm.fileExists(atPath: local.path) {
                    do { try fm.removeItem(at: local) } catch { if ok { ok = false; message = error.localizedDescription } }
                }
                if ok { deleted.append(rel) } else { failed.append((rel, message)) }
            }
        }
        return (deleted, failed, permanent)
    }

    /// runs.json・laptimes.json・corners.json (コーナーの名前。前の中身の控え .bak も)・course/ のコースデータだけを書く (一時ファイルに書いてから入れ替える)
    static func write(_ rel: String, _ data: Data) throws {
        let allowed = ["runs.json", "laptimes.json", "corners.json", "corners.json.bak"]
        try withRoot { root in
            guard let url = resolve(rel, in: root), allowed.contains(url.lastPathComponent) || isCourseText(rel) else {
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

        // iCloud から落ちてきていなければ、待たずに断る (取り込みは頼んでおく)。待つと、大きな動画では何十分も読む列をふさいでいた。
        // Web は、端末にある動画だけを付け、取り込みが終わってから付け直す
        guard RunFiles.isDownloaded(file) else {
            try? FileManager.default.startDownloadingUbiquitousItem(at: file)
            return fail(task, 404, url)
        }
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
