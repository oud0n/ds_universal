import UIKit
import UniformTypeIdentifiers

/// 約束の system.* (設定の画面を開く・ファイルを共有する・画面の自動ロックを止める・ラップタイマーの記録を書く) と、アプリが前に出た・裏に回ったの知らせ
@MainActor
final class SystemModule {
    private unowned let core: NativeCore
    private var observers: [NSObjectProtocol] = []
    /// フォルダを選ぶ画面の受け手 (選び終わるまで持っておく)
    private var folderPicker: FolderPickerDelegate?
    /// 選んだフォルダへ写している最中か・その間に頼まれたか・終わったら返す相手・裏で続けるための OS の約束
    private var syncRunning = false
    private var syncAgain = false
    private var syncWaiters: [(Result<[String: Any], NativeError>) -> Void] = []
    private var syncBackgroundTask: UIBackgroundTaskIdentifier = .invalid
    /// LapTimer/ の下の、いま書いている最中のファイル (system.appendFile で書き始め、system.closeFiles で閉じる)。
    /// 選んだフォルダへは写すだけにして、アプリの中からは消さない。閉じたものは、写せたらアプリの中から消す (移す。2026-10-21)。
    /// アプリを起動し直すと空になる (起動し直したあとは、前の走行のファイルに書き足さないため)
    private var openFiles = Set<String>()
    /// system.closeFiles で閉じたファイル。閉じたあとに書き足されても (測り直した直後に届く前の走行の G センサーの値など)、
    /// 書いている最中に戻さない (戻すと二度と閉じられず、選んだフォルダで消しても写し直してしまう。2026-10-22 のレビュー)
    private var closedFiles = Set<String>()
    /// ファイルに最後に書いた時刻。書いてから少しの間は移さない (閉じたあとに遅れて届く書き足しが、移したあとで書けなくならないように)
    private var lastAppend: [String: Date] = [:]
    /// 最後に書いてから、これだけたったものを移す
    private static let settleSeconds: TimeInterval = 30

    /// ラップタイマーの記録の保管先 ("local" = この iPhone、"folder" = 選んだフォルダ) と、選んだフォルダのブックマーク
    private static let storageKindKey = "lapTimer.storage.kind"
    private static let storageBookmarkKey = "lapTimer.storage.bookmark"

    init(core: NativeCore) {
        self.core = core
    }

    func handle(method: String, params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        switch method {
        case "system.openSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            done(.success([:]))
        case "system.keepAwake":
            // ラップタイマーを開いている間、画面の自動ロックを止める
            UIApplication.shared.isIdleTimerDisabled = (params["on"] as? Bool) ?? false
            done(.success([:]))
        case "system.motionStart":
            // iPhone の G センサーを読み始める (MotionRecorder.swift)。値は知らせ system.motion で 0.5 秒ごとに渡す
            let hz = (params["hz"] as? Double) ?? 50
            let ok = MotionRecorder.shared.start(hz: hz) { [weak self] data in self?.core.emit("system.motion", data) }
            if ok { done(.success([:])) } else { done(.failure(NativeError(.notSupported, "no motion sensor"))) }
        case "system.motionStop":
            MotionRecorder.shared.stop()
            done(.success([:]))
        case "system.setOrientation":
            // ラップタイマーの画面の向き (Orientation.swift)
            let mode = (params["mode"] as? String) ?? "system"
            done(.success(["orientation": OrientationControl.shared.set(mode: mode)]))
        case "system.appendFile":
            // ラップタイマーの走行の記録を、走っている間に書類のフォルダの LapTimer/ に足していく
            guard let rel = params["path"] as? String, let url = lapTimerURL(rel),
                  let b64 = params["b64"] as? String, let data = Data(base64Encoded: b64) else {
                done(.failure(NativeError(.notFound, "bad params")))
                return
            }
            do {
                let fm = FileManager.default
                try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                if (params["createNew"] as? Bool) == true && fm.fileExists(atPath: url.path) {
                    // 新しい走行のファイルは、同じ名前のファイル (前に起動したときの走行) を上書きしない
                    done(.failure(NativeError(.busy, "file exists")))
                    return
                }
                if (params["truncate"] as? Bool) == true {
                    try data.write(to: url)
                } else if !fm.fileExists(atPath: url.path) {
                    // 足す先がない (途中で消された) ときは、頭のないファイルを作らずに知らせる (.bon4 は先頭の 8 バイトが要るため)
                    done(.failure(NativeError(.notFound, "file was removed")))
                    return
                } else {
                    let handle = try FileHandle(forWritingTo: url)
                    defer { try? handle.close() }
                    try handle.seekToEnd()
                    try handle.write(contentsOf: data)
                }
                // 書けたファイルを、書いている最中に数える (createNew で断ったもの・前の走行のファイルは数えない)。
                // 共有のために作るファイル (exports/) は走行ではないので数えない。閉じたファイルは書いている最中に戻さない
                if !rel.hasPrefix("exports/") {
                    lastAppend[rel] = Date()
                    if (params["createNew"] as? Bool) == true { closedFiles.remove(rel) }
                    if !closedFiles.contains(rel) { openFiles.insert(rel) }
                }
                done(.success([:]))
            } catch {
                done(.failure(NativeError(.io, error.localizedDescription)))
            }
        case "system.shareFile":
            guard let rel = params["path"] as? String, let url = lapTimerURL(rel) else {
                done(.failure(NativeError(.notFound, "no file")))
                return
            }
            if FileManager.default.fileExists(atPath: url.path) {
                if share(url: url) { done(.success([:])) } else { done(.failure(NativeError(.io, "could not show the share sheet"))) }
                return
            }
            // LapTimer/ に無ければ (選んだフォルダへ移したあと)、走行の置き場から一時ファイルに写して渡す。
            // iCloud にだけあるときは取り込みを待つので、画面の動くスレッドでは読まない (固まらないように)
            Task {
                let file = await Task.detached(priority: .userInitiated) { Self.copyFromRunRoot(rel) }.value
                guard let file else { return done(.failure(NativeError(.notFound, "no file"))) }
                if self.share(url: file) { done(.success([:])) } else { done(.failure(NativeError(.io, "could not show the share sheet"))) }
            }
        case "system.shareText":
            // Web で作った文 (変換した CSV など) を一時ファイルにして共有する
            guard let name = params["fileName"] as? String, !name.contains("/"), let text = params["text"] as? String else {
                done(.failure(NativeError(.notFound, "bad params")))
                return
            }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            do {
                try text.write(to: url, atomically: true, encoding: .utf8)
                share(url: url)
                done(.success([:]))
            } catch {
                done(.failure(NativeError(.io, error.localizedDescription)))
            }
        case "system.storageInfo":
            done(.success(storageInfo()))
        case "system.pickStorageFolder":
            pickStorageFolder(done: done)
        case "system.setStorageLocal":
            UserDefaults.standard.set("local", forKey: Self.storageKindKey)
            done(.success(storageInfo()))
        case "system.syncLapFiles":
            syncLapFiles(done: done)
        case "system.closeFiles":
            // 書き終えたファイル (走行を閉じた・取り込み終えた)。次の system.syncLapFiles で、選んだフォルダへ移す
            var closing = Set<String>()
            if (params["all"] as? Bool) == true { closing = openFiles }
            if let prefix = params["prefix"] as? String, !prefix.isEmpty { closing.formUnion(openFiles.filter { $0.hasPrefix(prefix) }) }
            if let paths = params["paths"] as? [String] { closing.formUnion(paths) }
            openFiles.subtract(closing)
            closedFiles.formUnion(closing)
            done(.success(["open": openFiles.count]))
        case "system.listLapFiles":
            // ラップタイムの一覧のため、LapTimer/ の下のファイル (大きさと更新日時)
            let fm = FileManager.default
            let files: [[String: Any]] = Self.lapTimerFiles().map { file, rel in
                let attrs = (try? fm.attributesOfItem(atPath: file.path)) ?? [:]
                let size = (attrs[.size] as? Int) ?? 0
                let mtime = ((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
                return ["path": rel, "size": size, "mtimeMs": mtime.rounded()]
            }
            done(.success(["files": files]))
        // 走行の置き場 (選んだフォルダ、なければ LapTimer/) のファイル (RunFiles.swift。2026-10-20)
        case "system.runRoot":
            let (root, scoped) = RunFiles.root()
            done(.success(["urlBase": RunFiles.urlBase, "kind": scoped ? "folder" : "local", "name": root.lastPathComponent]))
        case "system.listRunFiles":
            Task {
                let files = await Task.detached(priority: .userInitiated) { RunFiles.list() }.value
                done(.success(["files": files.map(\.dict)]))
            }
        case "system.readRunFile":
            guard let rel = params["path"] as? String else { return done(.failure(NativeError(.notFound, "no path"))) }
            Task {
                let r: Result<Data, NativeError> = await Task.detached(priority: .userInitiated) {
                    do { return .success(try RunFiles.read(rel)) }
                    catch let e as NativeError { return .failure(e) }
                    catch { return .failure(NativeError(.io, error.localizedDescription)) }
                }.value
                done(r.map { ["b64": $0.base64EncodedString()] })
            }
        case "system.writeRunFile":
            guard let rel = params["path"] as? String, let b64 = params["b64"] as? String, let data = Data(base64Encoded: b64) else {
                return done(.failure(NativeError(.notFound, "bad params")))
            }
            Task {
                let r: Result<Bool, NativeError> = await Task.detached(priority: .userInitiated) {
                    do { try RunFiles.write(rel, data); return .success(true) }
                    catch let e as NativeError { return .failure(e) }
                    catch { return .failure(NativeError(.io, error.localizedDescription)) }
                }.value
                done(r.map { _ in [:] })
            }
        case "system.deleteRunFiles":
            let paths = params["paths"] as? [String] ?? []
            Task {
                let r = await Task.detached(priority: .userInitiated) { RunFiles.delete(paths) }.value
                done(.success(["deleted": r.deleted, "failed": r.failed.map { ["path": $0.0, "error": $0.1] }, "permanent": r.permanent]))
            }
        case "system.readRunRange":
            guard let rel = params["path"] as? String, let offset = params["offset"] as? Double, let length = params["length"] as? Int, offset >= 0 else {
                return done(.failure(NativeError(.notFound, "bad params")))
            }
            Task {
                let r: Result<Data, NativeError> = await Task.detached(priority: .userInitiated) {
                    do { return .success(try RunFiles.readRange(rel, offset: UInt64(offset), length: length)) }
                    catch let e as NativeError { return .failure(e) }
                    catch { return .failure(NativeError(.io, error.localizedDescription)) }
                }.value
                done(r.map { ["b64": $0.base64EncodedString()] })
            }
        case "system.runFileStatus":
            guard let rel = params["path"] as? String else { return done(.failure(NativeError(.notFound, "no path"))) }
            done(.success(RunFiles.status(rel)))
        case "system.downloadRunFile":
            guard let rel = params["path"] as? String else { return done(.failure(NativeError(.notFound, "no path"))) }
            do { try RunFiles.startDownload(rel); done(.success([:])) }
            catch { done(.failure(NativeError(.io, error.localizedDescription))) }
        case "system.readLapFile":
            // 読めるのは走行のログと控えだけ。大きいファイル (動画など) は読まない (base64 で Web に渡すとメモリが足りなくなるため)
            let allowed = ["bon4", "nmea", "json"]
            guard let rel = params["path"] as? String, let url = lapTimerURL(rel),
                  allowed.contains(url.pathExtension.lowercased()) else {
                done(.failure(NativeError(.notFound, "no file")))
                return
            }
            let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? 0
            guard size <= 64 * 1024 * 1024, let data = try? Data(contentsOf: url) else {
                done(.failure(NativeError(size > 64 * 1024 * 1024 ? .io : .notFound, size > 64 * 1024 * 1024 ? "file too large" : "no file")))
                return
            }
            done(.success(["b64": data.base64EncodedString()]))
        default:
            done(.failure(NativeError(.notSupported, "unknown method \(method)")))
        }
    }

    /// 書類のフォルダの LapTimer/ (走っている間は、いつもここに書く)
    private static var lapTimerRoot: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("LapTimer", isDirectory: true)
    }

    /// 走行の置き場 (選んだフォルダ) のログを、一時フォルダに写す (共有の画面で渡すため)
    nonisolated private static func copyFromRunRoot(_ rel: String) -> URL? {
        guard let data = try? RunFiles.read(rel) else { return nil }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent((rel as NSString).lastPathComponent)
        do { try data.write(to: tmp, options: .atomic) } catch { return nil }
        return tmp
    }

    /// 書類のフォルダの LapTimer/ の下の場所 (上のフォルダへ出る名前・絶対の道は断る)
    private func lapTimerURL(_ rel: String) -> URL? {
        guard !rel.isEmpty, !rel.contains(".."), !rel.hasPrefix("/") else { return nil }
        return Self.lapTimerRoot.appendingPathComponent(rel)
    }

    // MARK: - 記録の保管先 (この iPhone / 選んだフォルダ)

    /// 選んだフォルダ (ブックマークから戻す。古くなっていたら作り直す)
    private func storageFolder() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: Self.storageBookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        if stale {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                UserDefaults.standard.set(fresh, forKey: Self.storageBookmarkKey)
            }
        }
        return url
    }

    private func storageInfo() -> [String: Any] {
        let folder = storageFolder()
        let kind = UserDefaults.standard.string(forKey: Self.storageKindKey) == "folder" && folder != nil ? "folder" : "local"
        return ["kind": kind, "folderName": folder?.lastPathComponent ?? "", "folderOk": folder != nil]
    }

    /// 「ファイル」のフォルダを選ぶ画面を出す (iCloud Drive・この iPhone・ほかのクラウドのフォルダ)
    private func pickStorageFolder(done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard let top = topViewController() else {
            done(.failure(NativeError(.io, "could not show the folder picker")))
            return
        }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
        picker.allowsMultipleSelection = false
        let delegate = FolderPickerDelegate { [weak self] url in
            guard let self else { return }
            self.folderPicker = nil
            guard let url else {
                done(.failure(NativeError(.notFound, "cancelled")))
                return
            }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
                UserDefaults.standard.set(bookmark, forKey: Self.storageBookmarkKey)
                UserDefaults.standard.set("folder", forKey: Self.storageKindKey)
                DebugLog.write("storage folder picked")
                done(.success(self.storageInfo()))
            } catch {
                done(.failure(NativeError(.io, error.localizedDescription)))
            }
        }
        folderPicker = delegate
        picker.delegate = delegate
        top.present(picker, animated: true)
    }

    /// LapTimer/ の下のファイルを、選んだフォルダの同じ場所 (サーキット名/日付/ファイル) へ移す (2026-10-21)。
    /// 書いている最中のファイル (openFiles) は写すだけ (大きさの違うもの・ないもの)。書き終えたものは、写せたらアプリの中から消す。
    /// アプリの中に控えを残すと、選んだフォルダ (iCloud Drive など) で消したフォルダを、次に開いたときに写し直して戻してしまうため。
    /// 写せなかったもの (フォルダが使えない・書けない) は、アプリの中に残して次にもう一度移す。
    /// 写している間にもう一度頼まれたら、終わってからもう一度だけ回す (同時に 2 つは走らせない)
    private func syncLapFiles(done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        // 前の版がじかに置いた走行は、写す前に日付のフォルダへ移す (写した先でも日付のフォルダに入るように)
        RunFiles.moveFlatRunsIntoDateFolders(in: RunFiles.lapTimerRoot)
        guard UserDefaults.standard.string(forKey: Self.storageKindKey) == "folder" else {
            done(.success(["kind": "local", "copied": 0, "skipped": 0, "failed": 0]))
            return
        }
        guard let dest = storageFolder() else {
            done(.failure(NativeError(.notFound, "the chosen folder is not available")))
            return
        }
        syncWaiters.append(done)
        if syncRunning {
            syncAgain = true
            return
        }
        syncRunning = true
        // 裏に回った直後に頼まれても、写し終わるまで OS に止められないようにする
        syncBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "LapTimerSync") { [weak self] in
            MainActor.assumeIsolated { self?.endSyncBackgroundTask() }
        }
        Task { @MainActor in
            // 選んだフォルダにも前の版がじかに置いた走行があれば、日付のフォルダへ移す (同じ走行が 2 か所に並ばないように)
            await Task.detached(priority: .utility) {
                let access = dest.startAccessingSecurityScopedResource()
                defer { if access { dest.stopAccessingSecurityScopedResource() } }
                RunFiles.moveFlatRunsIntoDateFolders(in: dest, coordinated: true)
            }.value
            var total = SyncResult()
            repeat {
                syncAgain = false
                let r = await copyChanged(to: dest)
                total.copied += r.copied
                total.moved += r.moved
                total.skipped += r.skipped
                total.failed += r.failed
                total.error = r.error ?? total.error
            } while syncAgain
            if total.failed > 0 { DebugLog.write("storage sync failed=\(total.failed) error=\(total.error ?? "-")") }
            let access = dest.startAccessingSecurityScopedResource()
            if !Self.isInsideLapTimer(dest) { Self.pruneEmptyFolders(Self.lapTimerRoot) }
            if access { dest.stopAccessingSecurityScopedResource() }
            var out: [String: Any] = ["kind": "folder", "copied": total.copied, "moved": total.moved, "skipped": total.skipped, "failed": total.failed]
            if let e = total.error { out["error"] = e }
            let waiters = syncWaiters
            syncWaiters = []
            syncRunning = false
            endSyncBackgroundTask()
            waiters.forEach { $0(.success(out)) }
        }
    }

    private func endSyncBackgroundTask() {
        guard syncBackgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(syncBackgroundTask)
        syncBackgroundTask = .invalid
    }

    struct SyncResult: Sendable {
        var copied = 0
        /// 写して (か、もう同じものがあって)、アプリの中から消したもの
        var moved = 0
        var skipped = 0
        var failed = 0
        var error: String?
    }

    enum WriteOutcome: Sendable {
        case copied
        case failed(String)
    }

    /// 写す・移す。ファイルを読むのは、書き足し (system.appendFile) と同じ MainActor の上 (書きかけのファイルを読まないように)。
    /// 書くのは別のスレッドで、一時ファイルに書いてから入れ替える (途中で失敗しても、写し先の前のファイルは残る)
    private func copyChanged(to dest: URL) async -> SyncResult {
        var r = SyncResult()
        // 選んだフォルダを使う許可。アプリの中のフォルダを選んだときは false でも書けるので、ここでは止めない (書けなければ failed に数える)
        let access = dest.startAccessingSecurityScopedResource()
        defer { if access { dest.stopAccessingSecurityScopedResource() } }
        let fm = FileManager.default
        let sameTree = Self.isInsideLapTimer(dest)
        // 写し終えた (か、もう同じものがある) 書き終えたファイルを、アプリの中から消す
        let now = Date()
        let done = { (file: URL, rel: String) in
            guard !sameTree, !self.openFiles.contains(rel) else { return false }
            if let last = self.lastAppend[rel], now.timeIntervalSince(last) < Self.settleSeconds { return false }
            do {
                try fm.removeItem(at: file)
                self.closedFiles.remove(rel)
                self.lastAppend[rel] = nil
                return true
            } catch {
                DebugLog.write("storage move: could not remove \(rel) \(error.localizedDescription)")
                return false
            }
        }
        for (file, rel) in Self.lapTimerFiles() {
            // ラップタイムの一覧の控えは端末ごとに作るので写さない (2 台で同じ控えを書いてぶつからないように)。
            // 選んだフォルダでは、選んだフォルダの控えを使う。アプリの中の控えは、フォルダが空になったら消す (pruneEmptyFolders)
            let name = (rel as NSString).lastPathComponent
            if name == "laptimes.json" { continue }
            let target = dest.appendingPathComponent(rel)
            // 走行の動画の控え (runs.json)・コーナーの名前 (corners.json と .bak) は、選んだフォルダにまだ無いときだけ写す。
            // 大きさで比べて写すと、選んだフォルダで直した名前・同期を、アプリの中に残った古い中身で毎回戻してしまうため
            // 選んだフォルダにもうあるときは、中身がまったく同じときだけアプリの中から消す。違えば残す
            // (中身を比べずに消すと、この iPhone で付けた動画・コーナーの名前を失う。2026-10-22 のレビュー)
            // コース編集で保存したコースの計測線・セクター線は、選んだフォルダにもう一覧 (course/courses.json) があれば写さない
            // (一覧に載らないファイルが、読み込んだコースデータとして 2 つ目のコースになるため。端末の中のコースは、開いたときに一覧と合わせて書く)
            if (rel.hasPrefix("course/ControlLine/") || rel.hasPrefix("course/Sector/")) && Self.destSize(dest.appendingPathComponent("course/courses.json")) != nil && Self.destSize(target) == nil {
                r.skipped += 1
                continue
            }
            if name == "runs.json" || name == "corners.json" || name == "corners.json.bak" || rel.hasPrefix("course/") {
                if Self.destSize(target) != nil {
                    let same = fm.fileExists(atPath: target.path) && fm.contentsEqual(atPath: file.path, andPath: target.path)
                    if same && done(file, rel) { r.moved += 1 } else { r.skipped += 1 }
                    continue
                }
            }
            let srcSize = (try? fm.attributesOfItem(atPath: file.path)[.size] as? Int) ?? -1
            if srcSize == Self.destSize(target) {
                if done(file, rel) { r.moved += 1 } else { r.skipped += 1 }
                continue
            }
            // 動画 (内蔵カメラで撮ったもの。数 GB になる) は、読み込まずにそのまま移す (書き終えたものしか LapTimer/ に置かない)。
            // 選んだフォルダがアプリの中 (同じ場所) のときと、書いている最中・書き足したばかりのものは動かさない
            if ["mov", "mp4"].contains(file.pathExtension.lowercased()) {
                if sameTree || openFiles.contains(rel) || lastAppend[rel].map({ now.timeIntervalSince($0) < Self.settleSeconds }) == true {
                    r.skipped += 1
                    continue
                }
                let outcome = await Task.detached(priority: .utility) { Self.moveCoordinated(file, to: target) }.value
                switch outcome {
                case .copied:
                    r.moved += 1
                    closedFiles.remove(rel)
                    lastAppend[rel] = nil
                case .failed(let message):
                    r.failed += 1
                    r.error = message
                }
                continue
            }
            guard let data = try? Data(contentsOf: file) else {
                r.failed += 1
                r.error = "could not read \(rel)"
                continue
            }
            let outcome = await Task.detached(priority: .utility) { Self.writeCoordinated(data, to: target) }.value
            switch outcome {
            case .copied:
                // 読んでから書き終えるまでに書き足された (書いている最中だった) ものは、消さずに次に写す
                let nowSize = (try? fm.attributesOfItem(atPath: file.path)[.size] as? Int) ?? -1
                if nowSize == data.count && done(file, rel) { r.moved += 1 } else { r.copied += 1 }
            case .failed(let message):
                r.failed += 1
                r.error = message
            }
        }
        return r
    }

    /// 選んだフォルダがアプリの中の LapTimer/ そのもの (か、その中) か。そうなら写し先と写し元が同じファイルになるので、アプリの中から消さない
    private static func isInsideLapTimer(_ dest: URL) -> Bool {
        let src = lapTimerRoot.resolvingSymlinksInPath().standardizedFileURL.path
        let dst = dest.resolvingSymlinksInPath().standardizedFileURL.path
        return dst == src || dst.hasPrefix(src + "/")
    }

    /// 選んだフォルダのファイルの大きさ。iCloud にだけあるもの (.名前.icloud) は、その中に書いてある大きさ。無ければ nil
    nonisolated private static func destSize(_ target: URL) -> Int? {
        let fm = FileManager.default
        if fm.fileExists(atPath: target.path) {
            return (try? fm.attributesOfItem(atPath: target.path)[.size] as? Int) ?? -2
        }
        let placeholder = target.deletingLastPathComponent().appendingPathComponent(".\(target.lastPathComponent).icloud")
        guard fm.fileExists(atPath: placeholder.path) else { return nil }
        if let data = try? Data(contentsOf: placeholder),
           let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
           let size = plist["NSURLFileSizeKey"] as? Int {
            return size
        }
        return -2
    }

    /// LapTimer/ の下の、空になったフォルダを消す (ラップタイムの一覧の控え laptimes.json だけが残ったフォルダも)。exports/ は残す
    private static func pruneEmptyFolders(_ root: URL) {
        let fm = FileManager.default
        func prune(_ dir: URL) -> Bool {
            guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: []) else { return false }
            var keep = false
            for item in items {
                let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
                if isDir {
                    if item.lastPathComponent == "exports" && dir == root { keep = true; continue }
                    if !prune(item) { keep = true }
                } else if item.lastPathComponent != "laptimes.json" && item.lastPathComponent != ".DS_Store" {
                    keep = true
                }
            }
            if keep || dir == root { return false }
            do {
                try fm.removeItem(at: dir)
                return true
            } catch {
                return false
            }
        }
        _ = prune(root)
    }

    /// LapTimer/ の下のファイル (共有のために作った exports/ は除く) と、LapTimer/ からの道
    private static func lapTimerFiles() -> [(URL, String)] {
        let src = lapTimerRoot
        let base = src.resolvingSymlinksInPath().path
        var files: [(URL, String)] = []
        guard let e = FileManager.default.enumerator(at: src, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]) else { return files }
        for case let file as URL in e {
            let path = file.resolvingSymlinksInPath().path
            guard path.hasPrefix(base + "/") else { continue }
            let rel = String(path.dropFirst(base.count + 1))
            if rel == "exports" || rel.hasPrefix("exports/") {
                e.skipDescendants()
                continue
            }
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            files.append((file, rel))
        }
        return files
    }

    /// 大きなファイルを、選んだフォルダへ移す (iCloud Drive などに、ファイルの手続きを通して)
    nonisolated private static func moveCoordinated(_ file: URL, to target: URL) -> WriteOutcome {
        let fm = FileManager()
        do {
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        } catch {
            return .failed(error.localizedDescription)
        }
        var outcome: WriteOutcome = .failed("could not move \(file.lastPathComponent)")
        var coordError: NSError?
        NSFileCoordinator().coordinate(writingItemAt: file, options: .forMoving, writingItemAt: target, options: .forReplacing, error: &coordError) { src, dst in
            do {
                // 先に消してから移すと、移せなかったときに選んだフォルダの動画まで失うので、入れ替える
                if fm.fileExists(atPath: dst.path) { _ = try fm.replaceItemAt(dst, withItemAt: src) }
                else { try fm.moveItem(at: src, to: dst) }
                outcome = .copied
            } catch {
                outcome = .failed(error.localizedDescription)
            }
        }
        if let coordError { return .failed(coordError.localizedDescription) }
        return outcome
    }

    nonisolated private static func writeCoordinated(_ data: Data, to target: URL) -> WriteOutcome {
        let fm = FileManager()
        do {
            // サーキットのフォルダを先に作る (書き込みの手続きは、ある場所に対して始める)
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        } catch {
            return .failed(error.localizedDescription)
        }
        var coordError: NSError?
        var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: target, options: .forReplacing, error: &coordError) { url in
            do {
                // .atomic: 一時ファイルに書いてから入れ替える
                try data.write(to: url, options: .atomic)
            } catch {
                writeError = error
            }
        }
        if let err = writeError ?? coordError { return .failed(err.localizedDescription) }
        return .copied
    }

    /// いちばん上に出ている画面
    private func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              var top = (scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first)?.rootViewController else { return nil }
        while let presented = top.presentedViewController { top = presented }
        return top
    }

    /// 共有の画面 (AirDrop・「ファイル」に保存・メールなど) を出す
    @discardableResult
    func share(url: URL) -> Bool {
        guard let top = topViewController() else { return false }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // iPad では、出す場所を決めないと落ちる
        sheet.popoverPresentationController?.sourceView = top.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
        top.present(sheet, animated: true)
        return true
    }

    func startObservingAppState() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        // 画面ロックで、守られたファイルが読み書きできなくなる・戻る (記録のファイルに書けなくなっていないかを見るため)
        observers.append(center.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main) { _ in
            DebugLog.write("protectedData unavailable (locked)")
        })
        observers.append(center.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { _ in
            DebugLog.write("protectedData available (unlocked)")
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                DebugLog.write("active footprint=\(String(format: "%.0f", DebugLog.footprintMB()))MB")
                self?.core.webActive = true
                self?.core.emit("system.appState", ["state": "active"])
            }
        })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                DebugLog.write("background footprint=\(String(format: "%.0f", DebugLog.footprintMB()))MB")
                self?.core.emit("system.appState", ["state": "background"])
                self?.core.webActive = false
                self?.core.ble.recorder.flush()
            }
        })
    }
}

/// フォルダを選ぶ画面の受け手。選んだフォルダ (やめたら nil) を一度だけ返す
@MainActor
final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
    private var onPick: ((URL?) -> Void)?

    init(onPick: @escaping (URL?) -> Void) {
        self.onPick = onPick
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        onPick?(urls.first)
        onPick = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        onPick?(nil)
        onPick = nil
    }
}
