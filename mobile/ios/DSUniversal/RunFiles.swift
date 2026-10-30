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
        // 小さなファイルはすぐ来るので、はじめは細かく見る (0.5 秒ごとだと、コースのファイル 200 個で 2 分近くかかっていた)
        var step: TimeInterval = 0.05
        while Date() < until {
            Thread.sleep(forTimeInterval: step)
            if isDownloaded(url) { return true }
            step = min(step * 2, 0.5)
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
                    // 隠しフォルダ (アプリのゴミ箱 .trash・.Trash・.stversions など) の中は見ない (デスクトップ版と同じ。BUG-38 の 7)
                    if values?.isRegularFile != true && !name.hasSuffix(".icloud") {
                        e.skipDescendants()
                        continue
                    }
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
        // 守るフォルダ: コース・比べ方・書き出し・メーターの並び・CSV の形式と計算式・デジスパイスのコースデータ (取り込み元/ は、取り込みに失敗したときの書きかけを消すので守らない)
        let protected = ["course/", "sessions/", "exports/", "overlays/", "formats/", "digspice/"]
        guard rel.contains("/"), !protected.contains(where: { rel.hasPrefix($0) }) else { return false }
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
                // 選んだフォルダのとき: まだ移していない、アプリの中の写しも消す (残すと、次に写したときに戻ってくる)。
                // フォルダで消せなかったときは、写しは残す (消せたことにしない)。フォルダに無く、写ししか無いときは、それが最後の 1 つなので
                // できればゴミ箱へ移し、移せずにすぐ消したら permanent に入れる
                if ok, scoped, let local = resolve(rel, in: lapTimerRoot), fm.fileExists(atPath: local.path) {
                    do {
                        if target == nil {
                            do { try fm.trashItem(at: local, resultingItemURL: nil) } catch { try fm.removeItem(at: local); permanent.append(rel) }
                        } else {
                            try fm.removeItem(at: local)
                        }
                    } catch { ok = false; message = error.localizedDescription }
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

/// アプリのゴミ箱 (2026-10-28)。走行を消すとき、置き場の .trash/<印>/ へ元の道のまま移す。
/// 「ファイル」の最近削除した項目へ移すと、アプリが消したものは「復旧」を選べず戻せなかったため。
/// 走行の記録 (runs.json の行) は Web が trash.json に書いて添える。戻すのも、30 日で本当に消すのも Web が頼む
enum RunTrash {
    static let folder = ".trash"
    static let manifest = "trash.json"

    /// 印 (英数字・- ・_ だけ。道に使うので、ほかの文字は断る)
    static func isValidId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 64 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// iCloud にだけあるもの (.名前.icloud) も含めて、そこにあるか
    private static func existing(_ url: URL) -> Bool {
        let fm = FileManager.default
        let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
        return fm.fileExists(atPath: url.path) || fm.fileExists(atPath: placeholder.path)
    }

    /// ほかのアプリ (iCloud など) と取り合わないよう、ファイルの手続きを通して動かす。移す先のフォルダは作る
    private static func move(_ from: URL, to: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
        var coordError: NSError?
        var moveError: Error?
        NSFileCoordinator().coordinate(writingItemAt: from, options: .forMoving, writingItemAt: to, options: .forReplacing, error: &coordError) { a, b in
            do { try fm.moveItem(at: a, to: b) } catch { moveError = error }
        }
        if let e = moveError ?? coordError { throw e }
    }

    /// 走行のファイルをゴミ箱へ移し、trash.json を書く。選んだフォルダのときは、まだ移していないアプリの中の写しも片付ける
    /// (選んだフォルダで移せたら写しは消す。フォルダに無く写ししか無いときは、写しをフォルダのゴミ箱へ移す)
    static func trash(_ paths: [String], id: String, manifestText: String) -> (moved: [String], failed: [(String, String)]) {
        var moved: [String] = []
        var failed: [(String, String)] = []
        guard isValidId(id) else { return ([], paths.map { ($0, "bad id") }) }
        let fm = FileManager.default
        RunFiles.withRoot { root in
            let (_, scoped) = RunFiles.root()
            let box = root.appendingPathComponent(folder, isDirectory: true).appendingPathComponent(id, isDirectory: true)
            for rel in paths {
                guard RunFiles.isDeletableRunFile(rel), let url = RunFiles.resolve(rel, in: root) else { failed.append((rel, "not deletable")); continue }
                let dest = box.appendingPathComponent(rel)
                let local = scoped ? RunFiles.resolve(rel, in: RunFiles.lapTimerRoot) : nil
                let hasLocal = local.map { fm.fileExists(atPath: $0.path) } ?? false
                do {
                    if existing(url) {
                        try move(url, to: dest)
                        if hasLocal, let local { try fm.removeItem(at: local) }
                    } else if hasLocal, let local {
                        try move(local, to: dest)
                    }
                    // どこにも無いものは、もう無いので移したことにする (消すときと同じ)
                    moved.append(rel)
                } catch {
                    failed.append((rel, error.localizedDescription))
                }
            }
            if !moved.isEmpty {
                do {
                    try fm.createDirectory(at: box, withIntermediateDirectories: true)
                    try write(Data(manifestText.utf8), to: box.appendingPathComponent(manifest))
                } catch {
                    DebugLog.write("trash: could not write manifest \(id) \(error.localizedDescription)")
                }
            }
        }
        return (moved, failed)
    }

    private static func write(_ data: Data, to url: URL) throws {
        var coordError: NSError?
        var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordError) { u in
            do { try data.write(to: u, options: .atomic) } catch { writeError = error }
        }
        if let e = writeError ?? coordError { throw e }
    }

    struct Item: Sendable {
        let id: String
        let manifest: String?
        let files: [(path: String, size: Int)]
        let mtimeMs: Double
        var dict: [String: Any] {
            var d: [String: Any] = ["id": id, "files": files.map { ["path": $0.path, "size": $0.size] }, "mtimeMs": mtimeMs]
            if let manifest { d["manifest"] = manifest }
            return d
        }
    }

    /// ゴミ箱の中の走行 (印・trash.json の中身・中のファイル)
    static func list() -> [Item] {
        RunFiles.withRoot { root in
            let fm = FileManager.default
            let top = root.appendingPathComponent(folder, isDirectory: true)
            guard let ids = try? fm.contentsOfDirectory(atPath: top.path) else { return [] }
            var out: [Item] = []
            for id in ids where isValidId(id) {
                let box = top.appendingPathComponent(id, isDirectory: true)
                var isDir: ObjCBool = false
                guard fm.fileExists(atPath: box.path, isDirectory: &isDir), isDir.boolValue else { continue }
                var files: [(path: String, size: Int)] = []
                var text: String?
                let base = box.resolvingSymlinksInPath().path
                let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
                if let e = fm.enumerator(at: box, includingPropertiesForKeys: keys, options: []) {
                    for case let file as URL in e {
                        let path = file.resolvingSymlinksInPath().path
                        guard path.hasPrefix(base + "/") else { continue }
                        var rel = String(path.dropFirst(base.count + 1))
                        var name = (rel as NSString).lastPathComponent
                        var size = (try? file.resourceValues(forKeys: Set(keys)))?.fileSize ?? 0
                        if name.hasPrefix(".") {
                            guard name.hasSuffix(".icloud"), name.count > 8 else { continue }
                            name = String(name.dropFirst().dropLast(7))
                            rel = ((rel as NSString).deletingLastPathComponent as NSString).appendingPathComponent(name)
                            if let data = try? Data(contentsOf: file),
                               let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] {
                                size = (plist["NSURLFileSizeKey"] as? Int) ?? 0
                            }
                        } else if (try? file.resourceValues(forKeys: Set(keys)))?.isRegularFile != true {
                            continue
                        }
                        if rel == manifest {
                            let url = box.appendingPathComponent(manifest)
                            if RunFiles.waitDownloaded(url, timeout: 5) { text = try? String(contentsOf: url, encoding: .utf8) }
                            continue
                        }
                        files.append((rel, size))
                    }
                }
                let mtime = ((try? fm.attributesOfItem(atPath: box.path)[.modificationDate]) as? Date)?.timeIntervalSince1970 ?? 0
                out.append(Item(id: id, manifest: text, files: files, mtimeMs: (mtime * 1000).rounded()))
            }
            return out
        }
    }

    /// 元の場所へ戻す。元の場所に同じ名前があるものは戻さない (上書きしない)。全部戻せたら、その印のフォルダを消す
    static func restore(id: String) -> (restored: [String], failed: [(String, String)]) {
        var restored: [String] = []
        var failed: [(String, String)] = []
        guard isValidId(id) else { return ([], [("", "bad id")]) }
        RunFiles.withRoot { root in
            let box = root.appendingPathComponent(folder, isDirectory: true).appendingPathComponent(id, isDirectory: true)
            let files = list().first { $0.id == id }?.files.map(\.path) ?? []
            for rel in files {
                guard let dest = RunFiles.resolve(rel, in: root), RunFiles.isDeletableRunFile(rel) else { failed.append((rel, "not restorable")); continue }
                if existing(dest) { failed.append((rel, "exists")); continue }
                do { try move(box.appendingPathComponent(rel), to: dest); restored.append(rel) } catch { failed.append((rel, error.localizedDescription)) }
            }
            if failed.isEmpty { remove(box) }
        }
        return (restored, failed)
    }

    /// 本当に消す (戻せない)
    static func purge(ids: [String]) -> (purged: [String], failed: [(String, String)]) {
        var purged: [String] = []
        var failed: [(String, String)] = []
        RunFiles.withRoot { root in
            for id in ids {
                guard isValidId(id) else { failed.append((id, "bad id")); continue }
                let box = root.appendingPathComponent(folder, isDirectory: true).appendingPathComponent(id, isDirectory: true)
                if let e = remove(box) { failed.append((id, e)) } else { purged.append(id) }
            }
        }
        return (purged, failed)
    }

    /// フォルダを消す (無ければ何もしない)。失敗したらその文
    @discardableResult
    private static func remove(_ url: URL) -> String? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        var coordError: NSError?
        var removeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forDeleting, error: &coordError) { u in
            do { try FileManager.default.removeItem(at: u) } catch { removeError = error }
        }
        return (removeError ?? coordError)?.localizedDescription
    }
}
