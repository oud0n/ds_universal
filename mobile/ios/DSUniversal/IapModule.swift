import Foundation
import StoreKit

/// StoreKit 2。商品の ID は画面から受け取り、購入状態は StoreKit から読み直す。
@MainActor
final class IapModule {
    private unowned let core: NativeCore
    private var products: [String: Product] = [:]
    private var updates: Task<Void, Never>?

    private var revision = 0
    private var reading: Task<[String], Never>?

    init(core: NativeCore) {
        self.core = core
    }

    /// 読み取り中に取引や復元があったら、その読み取りでは返さず、新しい一覧を待つ。
    private func invalidateEntitlements() {
        revision += 1
        reading = nil
    }

    private func entitlements() async -> [String: Any] {
        while true {
            if reading == nil {
                revision += 1
                reading = Task {
                    var ids = Set<String>()
                    for await result in Transaction.currentEntitlements {
                        if case .verified(let tx) = result, tx.productType == .nonConsumable, tx.revocationDate == nil {
                            ids.insert(tx.productID)
                        }
                    }
                    return ids.sorted()
                }
            }
            let version = revision
            let ids = await reading!.value
            guard version == revision else { continue }
            reading = nil
            return ["revision": version, "productIds": ids]
        }
    }

    private func deliver(_ tx: Transaction, fromUpdates: Bool) async {
        switch tx.productType {
        case .nonConsumable:
            invalidateEntitlements()
            let snapshot = await entitlements()
            core.emit("iap.entitlementsChanged", snapshot)
        case .consumable:
            if fromUpdates {
                core.emit("iap.purchased", ["productId": tx.productID])
            }
        default:
            return
        }
        await tx.finish()
    }

    private func unverified(_ tx: Transaction, _ error: Error) async {
        DebugLog.write("iap: unverified transaction \(tx.productID): \(error.localizedDescription)")
        if tx.productType == .nonConsumable {
            invalidateEntitlements()
            core.emit("iap.entitlementsChanged", await entitlements())
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
            Task { done(.success(await entitlements())) }
        case "iap.restore":
            Task {
                do {
                    try await AppStore.sync()
                    invalidateEntitlements()
                    done(.success(await entitlements()))
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
