import CoreBluetooth
import Foundation

/// 約束の ble.* (探す・つなぐ・通知を受け取る)。
///
/// - 機器ごとの読み方は持たない。どの特性の通知を受け取るかは Web が ble.connect で渡す
/// - autoReconnect のときは、切れたらここでつなぎ直す (画面が消えて Web が止まっている間も)。
///   CoreBluetooth の connect は、機器が見つかるまで待ち続ける (時間切れにならない)
/// - 通知は受け取った時刻 (単調な時計のナノ秒) を付け、100 ms ごとにまとめて ble.notify で渡す
/// - すべて主スレッドで動かす (20 Hz の通知なので重くなく、Web へ渡すのも主スレッドのため)
@MainActor
final class BleModule: NSObject {
    private unowned let bridge: NativeBridge
    private var central: CBCentralManager!

    /// 電源が入る (poweredOn) まで待っている処理
    private var whenPoweredOn: [() -> Void] = []
    /// 許可を聞いている最中の答え待ち
    private var permissionWaiters: [(String) -> Void] = []

    private var scanPrefixes: [String]?
    private var scanTimer: DispatchWorkItem?
    private var discovered: [UUID: CBPeripheral] = [:]

    private struct Link {
        let peripheral: CBPeripheral
        let notify: [(service: CBUUID, characteristic: CBUUID)]
        let autoReconnect: Bool
        var userClosed = false
    }
    private var links: [UUID: Link] = [:]

    /// まとめて送る前の通知
    private var pending: [UUID: [(characteristic: String, t: UInt64, bytes: Data)]] = [:]
    private var flushTimer: Timer?

    /// 探すのは 10 秒まで (電池のため)
    private static let scanSeconds = 10.0
    private static let flushSeconds = 0.1

    init(bridge: NativeBridge) {
        self.bridge = bridge
        super.init()
    }

    /// CBCentralManager を作ると、初回は OS が許可を聞く。使うときまで作らない
    private func ensureCentral() {
        guard central == nil else { return }
        central = CBCentralManager(delegate: self, queue: nil, options: [
            // 画面が消えている間に OS がアプリを止めても、つなぎを戻せるようにする
            CBCentralManagerOptionRestoreIdentifierKey: "ds.ble.central"
        ])
    }

    func handle(method: String, params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        switch method {
        case "ble.permission": permission(request: params["request"] as? Bool ?? false, done: done)
        case "ble.scan": scan(prefixes: params["namePrefixes"] as? [String] ?? [], done: done)
        case "ble.stopScan": stopScan(); done(.success([:]))
        case "ble.connect": connect(params: params, done: done)
        case "ble.disconnect": disconnect(id: params["deviceId"] as? String, done: done)
        default: done(.failure(NativeError(.notSupported, "unknown method \(method)")))
        }
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
        default: whenPoweredOn.append(work)
        }
    }

    // MARK: - 探す

    private func scan(prefixes: [String], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        onPoweredOn({ [self] in
            stopScan(notify: false)
            scanPrefixes = prefixes
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
        if notify { bridge.emit("ble.scanStopped", [:]) }
    }

    // MARK: - つなぐ

    private func connect(params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard let idText = params["deviceId"] as? String, let id = UUID(uuidString: idText) else {
            done(.failure(NativeError(.notFound, "bad deviceId")))
            return
        }
        let notify = (params["notify"] as? [[String: String]] ?? []).compactMap { ref -> (CBUUID, CBUUID)? in
            guard let s = ref["service"], let c = ref["characteristic"] else { return nil }
            return (CBUUID(string: s), CBUUID(string: c))
        }
        let autoReconnect = params["autoReconnect"] as? Bool ?? true
        onPoweredOn({ [self] in
            // 前に見つけた機器か、前に登録した機器 (アプリを開き直したとき) を、OS に覚えている ID で探す
            guard let peripheral = discovered[id] ?? central.retrievePeripherals(withIdentifiers: [id]).first else {
                done(.failure(NativeError(.notFound)))
                return
            }
            if let old = links[id] { central.cancelPeripheralConnection(old.peripheral) }
            peripheral.delegate = self
            links[id] = Link(peripheral: peripheral, notify: notify.map { (service: $0.0, characteristic: $0.1) }, autoReconnect: autoReconnect)
            emitState(id, "connecting")
            central.connect(peripheral)
            done(.success([:]))
        }, done: done)
    }

    private func disconnect(id idText: String?, done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        guard let idText, let id = UUID(uuidString: idText), var link = links[id] else {
            done(.success([:]))
            return
        }
        link.userClosed = true
        links[id] = link
        central.cancelPeripheralConnection(link.peripheral)
        done(.success([:]))
    }

    private func emitState(_ id: UUID, _ state: String, error: NativeError? = nil) {
        var data: [String: Any] = ["deviceId": id.uuidString, "state": state]
        if let error { data["error"] = ["code": error.code.rawValue, "message": error.message] }
        bridge.emit("ble.state", data)
    }

    // MARK: - 通知をまとめて送る

    private func enqueue(_ id: UUID, characteristic: CBUUID, bytes: Data) {
        pending[id, default: []].append((characteristic.uuidString.lowercased(), MonoClock.nowNs(), bytes))
        guard flushTimer == nil else { return }
        flushTimer = Timer.scheduledTimer(withTimeInterval: Self.flushSeconds, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.flush() }
        }
    }

    private func flush() {
        guard !pending.isEmpty else {
            flushTimer?.invalidate()
            flushTimer = nil
            return
        }
        for (id, items) in pending {
            // 特性ごとに分けて送る
            for characteristic in Set(items.map(\.characteristic)) {
                let batch = items.filter { $0.characteristic == characteristic }
                bridge.emit("ble.notify", [
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
        let state = Self.permissionState()
        if state != "unknown" || central.state == .poweredOn {
            permissionWaiters.forEach { $0(state) }
            permissionWaiters.removeAll()
        }
        if central.state == .poweredOn {
            let works = whenPoweredOn
            whenPoweredOn.removeAll()
            works.forEach { $0() }
        }
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        // OS が戻したつなぎ。Web が ble.connect を呼び直すまでは、通知の受け取り先を持たないので何もしない
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard let prefixes = scanPrefixes else { return }
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? ""
        guard prefixes.contains(where: { name.hasPrefix($0) }) else { return }
        discovered[peripheral.identifier] = peripheral
        bridge.emit("ble.device", ["deviceId": peripheral.identifier.uuidString, "name": name, "rssi": RSSI.intValue])
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
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
        guard let link = links[peripheral.identifier] else { return }
        for service in peripheral.services ?? [] {
            let wanted = link.notify.filter { $0.service == service.uuid }.map(\.characteristic)
            if !wanted.isEmpty { peripheral.discoverCharacteristics(wanted, for: service) }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let link = links[peripheral.identifier] else { return }
        for characteristic in service.characteristics ?? [] where link.notify.contains(where: { $0.characteristic == characteristic.uuid }) {
            peripheral.setNotifyValue(true, for: characteristic)
        }
        emitState(peripheral.identifier, "connected")
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard links[peripheral.identifier] != nil, let value = characteristic.value else { return }
        enqueue(peripheral.identifier, characteristic: characteristic.uuid, bytes: value)
    }
}
