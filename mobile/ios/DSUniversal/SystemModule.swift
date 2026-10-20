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
                done(.success([:]))
            } catch {
                done(.failure(NativeError(.io, error.localizedDescription)))
            }
        case "system.shareFile":
            guard let rel = params["path"] as? String, let url = lapTimerURL(rel), FileManager.default.fileExists(atPath: url.path) else {
                done(.failure(NativeError(.notFound, "no file")))
                return
            }
            if share(url: url) {
                done(.success([:]))
            } else {
                done(.failure(NativeError(.io, "could not show the share sheet")))
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
        default:
            done(.failure(NativeError(.notSupported, "unknown method \(method)")))
        }
    }

    /// 書類のフォルダの LapTimer/ (走っている間は、いつもここに書く)
    private static var lapTimerRoot: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("LapTimer", isDirectory: true)
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

    /// LapTimer/ の下のファイルを、選んだフォルダの同じ場所 (サーキット名/ファイル) へ写す。大きさの違うもの・ないものだけ。
    /// 写している間にもう一度頼まれたら、終わってからもう一度だけ回す (同時に 2 つは走らせない)
    private func syncLapFiles(done: @escaping (Result<[String: Any], NativeError>) -> Void) {
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
            var total = SyncResult()
            repeat {
                syncAgain = false
                let r = await copyChanged(to: dest)
                total.copied += r.copied
                total.skipped += r.skipped
                total.failed += r.failed
                total.error = r.error ?? total.error
            } while syncAgain
            if total.failed > 0 { DebugLog.write("storage sync failed=\(total.failed) error=\(total.error ?? "-")") }
            var out: [String: Any] = ["kind": "folder", "copied": total.copied, "skipped": total.skipped, "failed": total.failed]
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
        var skipped = 0
        var failed = 0
        var error: String?
    }

    enum WriteOutcome: Sendable {
        case copied
        case failed(String)
    }

    /// 写す。ファイルを読むのは、書き足し (system.appendFile) と同じ MainActor の上 (書きかけのファイルを読まないように)。
    /// 書くのは別のスレッドで、一時ファイルに書いてから入れ替える (途中で失敗しても、写し先の前のファイルは残る)
    private func copyChanged(to dest: URL) async -> SyncResult {
        var r = SyncResult()
        // 選んだフォルダを使う許可。アプリの中のフォルダを選んだときは false でも書けるので、ここでは止めない (書けなければ failed に数える)
        let access = dest.startAccessingSecurityScopedResource()
        defer { if access { dest.stopAccessingSecurityScopedResource() } }
        let fm = FileManager.default
        for (file, rel) in Self.lapTimerFiles() {
            let target = dest.appendingPathComponent(rel)
            let srcSize = (try? fm.attributesOfItem(atPath: file.path)[.size] as? Int) ?? -1
            let dstSize = (try? fm.attributesOfItem(atPath: target.path)[.size] as? Int) ?? -2
            if srcSize == dstSize {
                r.skipped += 1
                continue
            }
            guard let data = try? Data(contentsOf: file) else {
                r.failed += 1
                r.error = "could not read \(rel)"
                continue
            }
            let outcome = await Task.detached(priority: .utility) { Self.writeCoordinated(data, to: target) }.value
            switch outcome {
            case .copied: r.copied += 1
            case .failed(let message):
                r.failed += 1
                r.error = message
            }
        }
        return r
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
