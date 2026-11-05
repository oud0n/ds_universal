import Foundation
import StoreKit

/// StoreKit 2。商品の ID は画面から受け取り、購入状態は StoreKit から読み直す。
@MainActor
final class IapModule {
    private unowned let core: NativeCore
    private var products: [String: Product] = [:]
    private var updates: Task<Void, Never>?

    private typealias Reply = (Result<[String: Any], NativeError>) -> Void
    private var revision = 0
    private var scan: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var waiters: [Reply] = []
    private var toFinish: [UInt64: Transaction] = [:]

    init(core: NativeCore) {
        self.core = core
    }

    private func readEntitlements(_ reply: @escaping Reply) {
        waiters.append(reply)
        if scan == nil { startScan() }
    }

    /// 取引や復元が割り込んだら、待っている画面にも新しい一覧を返す。
    /// StoreKit が古い読み取りの中止に応じなくても、新しい読み取りは始められる。
    private func startScan() {
        scan?.cancel()
        revision += 1
        let version = revision
        scan = Task {
            var ids = Set<String>()
            for await result in Transaction.currentEntitlements {
                guard !Task.isCancelled else { return }
                if case .verified(let tx) = result, tx.productType == .nonConsumable, tx.revocationDate == nil {
                    ids.insert(tx.productID)
                }
            }
            guard !Task.isCancelled else { return }
            endScan(version, .success(ids.sorted()))
        }
        // 待っている要求の制限時間は、取引が重なって読み直しても延ばさない。
        if deadline == nil {
            deadline = Task {
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                guard !Task.isCancelled else { return }
                endScan(revision, .failure(NativeError(.io, "Entitlement lookup timed out")))
            }
        }
    }

    private func endScan(_ version: Int, _ result: Result<[String], NativeError>) {
        guard version == revision, scan != nil else { return }
        scan?.cancel()
        scan = nil
        deadline?.cancel()
        deadline = nil
        let replies = waiters
        waiters.removeAll()
        switch result {
        case .success(let ids):
            let snapshot: [String: Any] = ["revision": version, "productIds": ids]
            let delivered = Array(toFinish.values)
            toFinish.removeAll()
            // 画面側で先に待ち時間を過ぎていても、知らせで最新の一覧を受け取れる。
            core.emit("iap.entitlementsChanged", snapshot)
            for reply in replies { reply(.success(snapshot)) }
            Task { for tx in delivered { await tx.finish() } }
        case .failure(let error):
            // 未配達の取引は残す。次の読み取りが成功してから終える。
            for reply in replies { reply(.failure(error)) }
        }
    }

    private func deliver(_ tx: Transaction, fromUpdates: Bool) async {
        switch tx.productType {
        case .nonConsumable:
            toFinish[tx.id] = tx
            startScan()
        case .consumable:
            if fromUpdates { core.emit("iap.purchased", ["productId": tx.productID]) }
            await tx.finish()
        default:
            return
        }
    }

    private func unverified(_ tx: Transaction, _ error: Error) async {
        DebugLog.write("iap: unverified transaction \(tx.productID): \(error.localizedDescription)")
        if tx.productType == .nonConsumable {
            // 確認できていない買い切りの取引は終えず、確認済みの一覧だけを通知する。
            startScan()
        } else if tx.productType == .consumable {
            await tx.finish()
        }
    }

    /// 起動時: 終わっていない購入 (保留だった購入・購入の途中でアプリが閉じたもの) を受け取って終える。
    /// 終えないと、次に起動したときにまた届き続ける
    func start() {
        guard updates == nil else { return }
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                switch result {
                case .verified(let tx):
                    await self?.deliver(tx, fromUpdates: true)
                case .unverified(let tx, let error):
                    await self?.unverified(tx, error)
                }
            }
        }
    }

    func handle(method: String, params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        switch method {
        case "iap.entitlements":
            readEntitlements(done)
        case "iap.restore":
            Task {
                do {
                    try await AppStore.sync()
                    waiters.append(done)
                    startScan()
                } catch {
                    done(.failure(NativeError(.io, error.localizedDescription)))
                }
            }
        case "iap.products":
            // 商品の名前と、その国の通貨での値段 (App Store Connect で決めたもの)
            let ids = params["ids"] as? [String] ?? []
            Task {
                do {
                    let list = try await Product.products(for: ids)
                    for p in list { self.products[p.id] = p }
                    let items: [[String: Any]] = list.sorted { $0.price < $1.price }.map {
                        ["id": $0.id, "displayName": $0.displayName, "description": $0.description, "displayPrice": $0.displayPrice]
                    }
                    done(.success(["products": items]))
                } catch {
                    done(.failure(NativeError(.io, error.localizedDescription)))
                }
            }
        case "iap.purchase":
            guard let id = params["id"] as? String else {
                done(.failure(NativeError(.notFound, "no product id")))
                return
            }
            Task {
                do {
                    let product: Product
                    if let p = self.products[id] {
                        product = p
                    } else if let p = try await Product.products(for: [id]).first {
                        product = p
                    } else {
                        done(.failure(NativeError(.notFound, "product \(id)")))
                        return
                    }
                    guard product.type == .consumable || product.type == .nonConsumable else {
                        done(.failure(NativeError(.notSupported, "unsupported product type")))
                        return
                    }
                    switch try await product.purchase() {
                    case .success(.verified(let tx)):
                        await deliver(tx, fromUpdates: false)
                        done(.success(["status": "purchased"]))
                    case .success(.unverified(let tx, let error)):
                        await unverified(tx, error)
                        done(.failure(NativeError(.io, "unverified purchase: \(error.localizedDescription)")))
                    case .pending:
                        // 保護者の承認待ちなど。決まったら Transaction.updates に届く (start)
                        done(.success(["status": "pending"]))
                    case .userCancelled:
                        done(.success(["status": "cancelled"]))
                    @unknown default:
                        done(.success(["status": "cancelled"]))
                    }
                } catch {
                    done(.failure(NativeError(.io, error.localizedDescription)))
                }
            }
        default:
            done(.failure(NativeError(.notSupported, "unknown method \(method)")))
        }
    }
}
