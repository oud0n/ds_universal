import CoreBluetooth
import Foundation

/// 約束の ble.* (探す・つなぐ・通知を受け取る・読む) と recorder.* (通知をそのままファイルに書き足す)。
///
/// - 機器ごとの読み方は持たない。どの特性の通知を受け取るかは Web が ble.connect で渡す
/// - autoReconnect のときは、切れたらここでつなぎ直す (画面が消えて Web が止まっている間も)。
///   CoreBluetooth の connect は、機器が見つかるまで待ち続ける (時間切れにならない)
/// - 通知は受け取った時刻 (単調な時計のナノ秒) を付け、100 ms ごとにまとめて ble.notify で渡す。画面が裏にいる間は渡さない
/// - 記録中は、通知を届いたそばからファイルに書き足す (画面が消えていても続く)。
///   OS がアプリを止めて起こし直したときは、記録とつなぎを戻す (resumeRecordingIfNeeded と willRestoreState)
/// - すべて主スレッドで動かす (20 Hz の通知なので重くなく、Web へ渡すのも主スレッドのため)
@MainActor
final class BleModule: NSObject {
    private unowned let core: NativeCore
    private var central: CBCentralManager!
    let recorder = BleRecorder()

    /// 電源が入る (poweredOn) まで待っている処理と、入らなかったときに失敗を返す先
    private var whenPoweredOn: [(work: () -> Void, done: (Result<[String: Any], NativeError>) -> Void)] = []
    /// 許可を聞いている最中の答え待ち
    private var permissionWaiters: [(String) -> Void] = []

    private var scanPrefixes: [String]?
    /// 広告にこのサービスを載せている機器も知らせる (心拍計・GoPro など、名前がまちまちな機器のため。2026-10-20)
    private var scanServices: [CBUUID] = []
    private var scanTimer: DispatchWorkItem?
    private var discovered: [UUID: CBPeripheral] = [:]

    private struct Link {
        let peripheral: CBPeripheral
        let notify: [(service: CBUUID, characteristic: CBUUID)]
        let autoReconnect: Bool
        var userClosed = false
    }
    private var links: [UUID: Link] = [:]

    /// 読み出し (ble.read) の答え待ち。キーは「機器の ID / 特性」
    private var readWaiters: [String: [(Result<[String: Any], NativeError>) -> Void]] = [:]
    private var pendingReads: [(id: UUID, service: CBUUID, characteristic: CBUUID)] = []
    /// 書く (ble.write) のうち、特性をまだ見つけていないもの
    private var pendingWrites: [PendingWrite] = []
    /// 答えのある書き込みの、書き終わりの知らせ待ち。キーは「機器の ID / 特性」(書いた順)
    private var writeWaiters: [String: [(Result<[String: Any], NativeError>) -> Void]] = [:]
    struct PendingWrite {
        let id: UUID
        let service: CBUUID
        let characteristic: CBUUID
        let data: Data
        let done: (Result<[String: Any], NativeError>) -> Void
    }

    /// まとめて送る前の通知
    private var pending: [UUID: [(characteristic: String, t: UInt64, bytes: Data)]] = [:]
    private var flushTimer: Timer?

    /// 探すのは 10 秒まで (電池のため)
    private static let scanSeconds = 10.0
    private static let flushSeconds = 0.1
    private static let restoreIdentifier = "ds.ble.central"

    init(core: NativeCore) {
        self.core = core
        super.init()
    }

    /// CBCentralManager を作ると、初回は OS が許可を聞く。使うときまで作らない (記録を戻すときは起動時に作る)
    private func ensureCentral() {
        guard central == nil else { return }
        central = CBCentralManager(delegate: self, queue: nil, options: [
            // 画面が消えている間に OS がアプリを止めても、つなぎを戻せるようにする
            CBCentralManagerOptionRestoreIdentifierKey: Self.restoreIdentifier
        ])
    }

    func handle(method: String, params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        switch method {
        case "ble.permission": permission(request: params["request"] as? Bool ?? false, done: done)
        case "ble.scan": scan(prefixes: params["namePrefixes"] as? [String] ?? [], services: (params["services"] as? [String] ?? []).map { CBUUID(string: $0) }, done: done)
        case "ble.stopScan": stopScan(); done(.success([:]))
        case "ble.connect": connect(params: params, done: done)
        case "ble.disconnect": disconnect(id: params["deviceId"] as? String, done: done)
        case "ble.read": read(params: params, done: done)
        case "ble.write": write(params: params, done: done)
        case "recorder.start": startRecording(params: params, done: done)
        case "recorder.stop": done(.success(recorder.stop()))
        case "recorder.status": done(.success(recordingStatus()))
        case "recorder.list": done(.success(["files": recorder.list()]))
        case "recorder.read":
            done(Result { ["text": try recorder.read(params["fileName"] as? String ?? "")] }.mapError(Self.asNativeError))
        case "recorder.remove":
            done(Result { try recorder.remove(params["fileName"] as? String ?? ""); return [:] }.mapError(Self.asNativeError))
        case "recorder.share":
            do {
                core.system.share(url: try BleRecorder.url(of: params["fileName"] as? String ?? ""))
                done(.success([:]))
            } catch {
                done(.failure(Self.asNativeError(error)))
            }
        default: done(.failure(NativeError(.notSupported, "unknown method \(method)")))
        }
    }

    private static func asNativeError(_ error: Error) -> NativeError {
        error as? NativeError ?? NativeError(.io, error.localizedDescription)
    }

    // MARK: - 許可

    private static func permissionState() -> String {
        switch CBManager.authorization {
        case .allowedAlways: return "granted"
        case .denied, .restricted: return "denied"
        default: return "unknown"
        }
    }

    private func permission(request: Bool, done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        let state = Self.permissionState()
        guard request, state == "unknown" else {
            done(.success(["state": state]))
            return
        }
        // 作ると OS が許可を聞き、答えると centralManagerDidUpdateState が呼ばれる
        permissionWaiters.append { done(.success(["state": $0])) }
        ensureCentral()
    }

    /// 電源が入っていれば すぐ、まだなら入ってから行う
    private func onPoweredOn(_ work: @escaping () -> Void, done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        ensureCentral()
        switch central.state {
        case .poweredOn: work()
        case .unauthorized: done(.failure(NativeError(.permissionDenied)))
        case .unsupported: done(.failure(NativeError(.notSupported)))
        case .poweredOff: done(.failure(NativeError(.io, "Bluetooth is off")))
        default: whenPoweredOn.append((work: work, done: done))
        }
    }

    /// 待っていた処理を、電源が入ったら行い、使えないと分かったら失敗で返す (返さないと Web が答えを待ち続ける)
    private func drainWhenPoweredOn(_ state: CBManagerState) {
        let failure: NativeError?
        switch state {
        case .poweredOn: failure = nil
        case .unauthorized: failure = NativeError(.permissionDenied)
        case .unsupported: failure = NativeError(.notSupported)
        case .poweredOff: failure = NativeError(.io, "Bluetooth is off")
        default: return // まだ分からない (unknown・resetting) ときは待ち続ける
        }
        let waiting = whenPoweredOn
        whenPoweredOn.removeAll()
        for item in waiting {
            if let failure { item.done(.failure(failure)) } else { item.work() }
        }
    }

    // MARK: - 探す

    private func scan(prefixes: [String], services: [CBUUID], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        onPoweredOn({ [self] in
            stopScan(notify: false)
            scanPrefixes = prefixes
            scanServices = services
            // デジスパイスは広告のサービスが GATT と違う (0x180D を載せている) ので、サービスでは絞らず名前で絞る
            central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
            let timer = DispatchWorkItem { [weak self] in self?.stopScan() }
            scanTimer = timer
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.scanSeconds, execute: timer)
            done(.success([:]))
        }, done: done)
    }

    private func stopScan(notify: Bool = true) {
        guard scanPrefixes != nil else { return }
        scanTimer?.cancel()
        scanTimer = nil
        scanPrefixes = nil
        if central?.state == .poweredOn { central.stopScan() }
        if notify { core.emit("ble.scanStopped", [:]) }
    }

    // MARK: - つなぐ

    private static func notifyRefs(_ raw: [[String]]) -> [(service: CBUUID, characteristic: CBUUID)] {
        raw.compactMap { $0.count == 2 ? (service: CBUUID(string: $0[0]), characteristic: CBUUID(string: $0[1])) : nil }
    }

    private func connect(params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard let idText = params["deviceId"] as? String, let id = UUID(uuidString: idText) else {
            done(.failure(NativeError(.notFound, "bad deviceId")))
            return
        }
        let notify = Self.notifyRefs((params["notify"] as? [[String: String]] ?? []).compactMap { ref in
            guard let s = ref["service"], let c = ref["characteristic"] else { return nil }
            return [s, c]
        })
        let autoReconnect = params["autoReconnect"] as? Bool ?? true
        onPoweredOn({ [self] in
            // 前に見つけた機器か、前に登録した機器 (アプリを開き直したとき) を、OS に覚えている ID で探す
            guard let peripheral = discovered[id] ?? central.retrievePeripherals(withIdentifiers: [id]).first else {
                done(.failure(NativeError(.notFound)))
                return
            }
            // つないでいる・つなぎかけの機器 (記録を戻したとき・画面を読み直したとき) は、切らずに同じつなぎを使う。
            // 切ってからつなぐと、古いつなぎが切れた知らせを、新しいつなぎが切れたと取り違えてしまう
            if let link = links[id], !link.userClosed {
                links[id] = Link(peripheral: link.peripheral, notify: notify, autoReconnect: autoReconnect)
                emitState(id, link.peripheral.state == .connected ? "connected" : "connecting")
                done(.success([:]))
                return
            }
            open(peripheral, notify: notify, autoReconnect: autoReconnect)
            done(.success([:]))
        }, done: done)
    }

    private func open(_ peripheral: CBPeripheral, notify: [(service: CBUUID, characteristic: CBUUID)], autoReconnect: Bool) {
        peripheral.delegate = self
        links[peripheral.identifier] = Link(peripheral: peripheral, notify: notify, autoReconnect: autoReconnect)
        if peripheral.state == .connected {
            peripheral.discoverServices(Array(Set(notify.map(\.service))))
        } else {
            emitState(peripheral.identifier, "connecting")
            central.connect(peripheral)
        }
    }

    private func disconnect(id idText: String?, done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard let idText, let id = UUID(uuidString: idText), var link = links[id] else {
            done(.success([:]))
            return
        }
        if recorder.active?.deviceId == idText { recorder.stop() }
        link.userClosed = true
        links[id] = link
        central.cancelPeripheralConnection(link.peripheral)
        done(.success([:]))
    }

    private func emitState(_ id: UUID, _ state: String, error: NativeError? = nil) {
        recorder.note(deviceId: id.uuidString, state: state)
        var data: [String: Any] = ["deviceId": id.uuidString, "state": state]
        if let error { data["error"] = ["code": error.code.rawValue, "message": error.message] }
        core.emit("ble.state", data)
    }

    // MARK: - 読む (Device Information など)

    private func read(params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard let idText = params["deviceId"] as? String, let id = UUID(uuidString: idText),
              let s = params["service"] as? String, let c = params["characteristic"] as? String else {
            done(.failure(NativeError(.notFound, "bad params")))
            return
        }
        guard let peripheral = links[id]?.peripheral, peripheral.state == .connected else {
            done(.failure(NativeError(.notConnected)))
            return
        }
        let service = CBUUID(string: s), characteristic = CBUUID(string: c)
        readWaiters[Self.readKey(id, characteristic), default: []].append(done)
        if let found = peripheral.services?.first(where: { $0.uuid == service })?.characteristics?.first(where: { $0.uuid == characteristic }) {
            peripheral.readValue(for: found)
            return
        }
        pendingReads.append((id, service, characteristic))
        if let found = peripheral.services?.first(where: { $0.uuid == service }) {
            peripheral.discoverCharacteristics([characteristic], for: found)
        } else {
            peripheral.discoverServices([service])
        }
    }

    // MARK: - 書く (OBD-II の命令・GoPro の操作など。2026-10-20)

    private func write(params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard let idText = params["deviceId"] as? String, let id = UUID(uuidString: idText),
              let s = params["service"] as? String, let c = params["characteristic"] as? String,
              let b = params["b"] as? String, let data = Data(base64Encoded: b) else {
            done(.failure(NativeError(.notFound, "bad params")))
            return
        }
        guard let peripheral = links[id]?.peripheral, peripheral.state == .connected else {
            done(.failure(NativeError(.notConnected)))
            return
        }
        let service = CBUUID(string: s), characteristic = CBUUID(string: c)
        if let found = peripheral.services?.first(where: { $0.uuid == service })?.characteristics?.first(where: { $0.uuid == characteristic }) {
            writeValue(peripheral, found, data, done)
            return
        }
        // まだ見つけていない特性は、探してから書く
        pendingWrites.append(PendingWrite(id: id, service: service, characteristic: characteristic, data: data, done: done))
        if let found = peripheral.services?.first(where: { $0.uuid == service }) {
            peripheral.discoverCharacteristics(nil, for: found)
        } else {
            peripheral.discoverServices([service])
        }
    }

    /// 答えのある書き込み (write) ができる特性なら書き終わりを待ち、できなければ答えなしで書いてすぐ返す
    private func writeValue(_ peripheral: CBPeripheral, _ characteristic: CBCharacteristic, _ data: Data, _ done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        if characteristic.properties.contains(.write) {
            writeWaiters[Self.readKey(peripheral.identifier, characteristic.uuid), default: []].append(done)
            peripheral.writeValue(data, for: characteristic, type: .withResponse)
        } else if characteristic.properties.contains(.writeWithoutResponse) {
            peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
            done(.success([:]))
        } else {
            done(.failure(NativeError(.notSupported, "characteristic is not writable")))
        }
    }

    private static func readKey(_ id: UUID, _ characteristic: CBUUID) -> String {
        "\(id.uuidString)/\(characteristic.uuidString)"
    }

    private func finishRead(_ id: UUID, _ characteristic: CBUUID, _ result: Result<[String: Any], NativeError>) {
        let key = Self.readKey(id, characteristic)
        let waiters = readWaiters.removeValue(forKey: key) ?? []
        waiters.forEach { $0(result) }
    }

    // MARK: - 記録

    private func startRecording(params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard let idText = params["deviceId"] as? String, let id = UUID(uuidString: idText), let link = links[id] else {
            done(.failure(NativeError(.notConnected)))
            return
        }
        do {
            let notify = link.notify.map { [$0.service.uuidString, $0.characteristic.uuidString] }
            let fileName = try recorder.start(
                name: params["name"] as? String ?? "ble",
                deviceId: idText,
                notify: notify,
                header: params["header"] as? [String] ?? []
            )
            done(.success(["fileName": fileName]))
        } catch {
            done(.failure(Self.asNativeError(error)))
        }
    }

    private func recordingStatus() -> [String: Any] {
        guard let a = recorder.active else { return ["recording": false] }
        return ["recording": true, "fileName": a.fileName, "deviceId": a.deviceId, "notifications": a.notifications]
    }

    /// 起動時: 記録中のまま止められていたら、続きを書き足し、機器につなぎ直す
    func resumeRecordingIfNeeded() {
        guard let active = recorder.resume(), let id = UUID(uuidString: active.deviceId) else {
            DebugLog.write("resumeRecording: no active recording to resume")
            return
        }
        DebugLog.write("resumeRecording: file=\(active.fileName) notifications=\(active.notifications)")
        ensureCentral()
        let notify = Self.notifyRefs(active.notify)
        onPoweredOn({ [self] in
            guard links[id] == nil else { DebugLog.write("resumeRecording: link already exists"); return }
            guard let peripheral = discovered[id] ?? central.retrievePeripherals(withIdentifiers: [id]).first else {
                DebugLog.write("resumeRecording: peripheral not found")
                return
            }
            DebugLog.write("resumeRecording: open peripheral state=\(peripheral.state.rawValue)")
            open(peripheral, notify: notify, autoReconnect: true)
        }, done: { result in
            if case .failure(let e) = result { DebugLog.write("resumeRecording: bluetooth not usable \(e.code.rawValue) \(e.message)") }
        })
    }

    // MARK: - 通知をまとめて送る

    private func enqueue(_ id: UUID, characteristic: CBUUID, bytes: Data) {
        let t = MonoClock.nowNs()
        let name = characteristic.uuidString.lowercased()
        recorder.append(tNs: t, deviceId: id.uuidString, characteristic: name, bytes: bytes)
        guard core.webActive else { return }
        pending[id, default: []].append((name, t, bytes))
        guard flushTimer == nil else { return }
        flushTimer = Timer.scheduledTimer(withTimeInterval: Self.flushSeconds, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.flush() }
        }
    }

    private func flush() {
        guard !pending.isEmpty, core.webActive else {
            pending.removeAll()
            flushTimer?.invalidate()
            flushTimer = nil
            return
        }
        for (id, items) in pending {
            // 特性ごとに分けて送る
            for characteristic in Set(items.map(\.characteristic)) {
                let batch = items.filter { $0.characteristic == characteristic }
                core.emit("ble.notify", [
                    "deviceId": id.uuidString,
                    "characteristic": characteristic,
                    "items": batch.map { ["t": $0.t, "b": $0.bytes.base64EncodedString()] }
                ])
            }
        }
        pending.removeAll()
    }
}

extension BleModule: @preconcurrency CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        DebugLog.write("central state=\(central.state.rawValue) auth=\(Self.permissionState())")
        let state = Self.permissionState()
        if state != "unknown" || central.state == .poweredOn {
            permissionWaiters.forEach { $0(state) }
            permissionWaiters.removeAll()
        }
        drainWhenPoweredOn(central.state)
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        // OS が戻したつなぎ。記録を戻すとき (resumeRecordingIfNeeded) に使えるよう覚えておく
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        DebugLog.write("willRestoreState peripherals=\(restored.map { "\($0.identifier.uuidString.prefix(8)):\($0.state.rawValue)" }.joined(separator: ","))")
        for peripheral in restored {
            peripheral.delegate = self
            discovered[peripheral.identifier] = peripheral
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard let prefixes = scanPrefixes else { return }
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? ""
        // 名前の頭か、広告に載せているサービスのどちらかが合えば知らせる
        let advertised = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []) + (advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] ?? [])
        let byName = prefixes.contains(where: { name.hasPrefix($0) })
        let byService = !scanServices.isEmpty && advertised.contains(where: { scanServices.contains($0) })
        guard byName || byService else { return }
        discovered[peripheral.identifier] = peripheral
        core.emit("ble.device", ["deviceId": peripheral.identifier.uuidString, "name": name, "rssi": RSSI.intValue])
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        DebugLog.write("didConnect \(peripheral.identifier.uuidString.prefix(8))")
        guard let link = links[peripheral.identifier] else { return }
        peripheral.discoverServices(Array(Set(link.notify.map(\.service))))
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        lost(peripheral, error: error)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        lost(peripheral, error: error)
    }

    private func lost(_ peripheral: CBPeripheral, error: Error?) {
        let id = peripheral.identifier
        DebugLog.write("lost \(id.uuidString.prefix(8)) error=\(error?.localizedDescription ?? "-") link=\(links[id] == nil ? "none" : (links[id]!.userClosed ? "userClosed" : "auto"))")
        // 読み出しの答え待ちは、つながっていないで返す
        for key in readWaiters.keys where key.hasPrefix(id.uuidString) {
            readWaiters.removeValue(forKey: key)?.forEach { $0(.failure(NativeError(.notConnected))) }
        }
        pendingReads.removeAll { $0.id == id }
        // 書き込みの待ちも、つながっていないで返す
        for key in writeWaiters.keys where key.hasPrefix(id.uuidString) {
            writeWaiters.removeValue(forKey: key)?.forEach { $0(.failure(NativeError(.notConnected))) }
        }
        pendingWrites.filter { $0.id == id }.forEach { $0.done(.failure(NativeError(.notConnected))) }
        pendingWrites.removeAll { $0.id == id }
        guard let link = links[id] else { return }
        if link.userClosed || !link.autoReconnect {
            links[id] = nil
            emitState(id, "disconnected", error: link.userClosed ? nil : NativeError(.io, error?.localizedDescription ?? ""))
            return
        }
        emitState(id, "reconnecting")
        central.connect(peripheral)
    }
}

extension BleModule: @preconcurrency CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        let id = peripheral.identifier
        guard let link = links[id] else { return }
        for service in peripheral.services ?? [] {
            var wanted = link.notify.filter { $0.service == service.uuid }.map(\.characteristic)
            wanted += pendingReads.filter { $0.id == id && $0.service == service.uuid }.map(\.characteristic)
            wanted += pendingWrites.filter { $0.id == id && $0.service == service.uuid }.map(\.characteristic)
            if !wanted.isEmpty { peripheral.discoverCharacteristics(Array(Set(wanted)), for: service) }
        }
        let foundServices = Set((peripheral.services ?? []).map(\.uuid))
        pendingWrites.filter { $0.id == id && !foundServices.contains($0.service) }.forEach { $0.done(.failure(NativeError(.notFound))) }
        pendingWrites.removeAll { $0.id == id && !foundServices.contains($0.service) }
        // 見つからなかったサービスの読み出しは失敗で返す
        let found = Set((peripheral.services ?? []).map(\.uuid))
        for r in pendingReads where r.id == id && !found.contains(r.service) {
            finishRead(id, r.characteristic, .failure(NativeError(.notFound)))
        }
        pendingReads.removeAll { $0.id == id && !found.contains($0.service) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let id = peripheral.identifier
        guard let link = links[id] else { return }
        var subscribed = false
        for characteristic in service.characteristics ?? [] {
            if link.notify.contains(where: { $0.service == service.uuid && $0.characteristic == characteristic.uuid }) {
                peripheral.setNotifyValue(true, for: characteristic)
                subscribed = true
            }
            if pendingReads.contains(where: { $0.id == id && $0.characteristic == characteristic.uuid }) {
                pendingReads.removeAll { $0.id == id && $0.characteristic == characteristic.uuid }
                peripheral.readValue(for: characteristic)
            }
        }
        for r in pendingReads where r.id == id && r.service == service.uuid {
            finishRead(id, r.characteristic, .failure(NativeError(.notFound)))
        }
        // 探していた特性に書く (見つからなければ失敗で返す)
        let writes = pendingWrites.filter { $0.id == id && $0.service == service.uuid }
        pendingWrites.removeAll { $0.id == id && $0.service == service.uuid }
        for w in writes {
            if let c = service.characteristics?.first(where: { $0.uuid == w.characteristic }) {
                writeValue(peripheral, c, w.data, w.done)
            } else {
                w.done(.failure(NativeError(.notFound)))
            }
        }
        pendingReads.removeAll { $0.id == id && $0.service == service.uuid }
        if subscribed { emitState(id, "connected") }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        let key = Self.readKey(peripheral.identifier, characteristic.uuid)
        guard var waiters = writeWaiters[key], !waiters.isEmpty else { return }
        let done = waiters.removeFirst()
        writeWaiters[key] = waiters.isEmpty ? nil : waiters
        // 暗号化が要る機器 (GoPro) でペアリングしていないと、ここで失敗が返る
        if let error {
            done(.failure(NativeError(.permissionDenied, error.localizedDescription)))
        } else {
            done(.success([:]))
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        let id = peripheral.identifier
        guard links[id] != nil else { return }
        // 読み出しの答えか、通知か
        if readWaiters[Self.readKey(id, characteristic.uuid)] != nil {
            if let error {
                finishRead(id, characteristic.uuid, .failure(NativeError(.io, error.localizedDescription)))
            } else {
                finishRead(id, characteristic.uuid, .success(["b": (characteristic.value ?? Data()).base64EncodedString()]))
            }
            return
        }
        guard let value = characteristic.value else { return }
        enqueue(id, characteristic: characteristic.uuid, bytes: value)
    }
}
