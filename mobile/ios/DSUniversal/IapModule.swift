import Foundation
import StoreKit

/// アプリ内課金 (投げ銭。消耗型の「ガソリン 1L・5L・10L」)。StoreKit 2。
/// 何も解放しないので、買った記録は持たない (購入の復元も要らない)。商品の ID は Web が渡す (src/services/tips.ts)
@MainActor
final class IapModule {
    private unowned let core: NativeCore
    private var products: [String: Product] = [:]
    private var updates: Task<Void, Never>?

    init(core: NativeCore) {
        self.core = core
    }

    /// 起動時: 終わっていない購入 (保留だった購入・購入の途中でアプリが閉じたもの) を受け取って終える。
    /// 終えないと、次に起動したときにまた届き続ける
    func start() {
        guard updates == nil else { return }
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                guard case .verified(let tx) = result else { continue }
                await tx.finish()
                self?.core.emit("iap.purchased", ["productId": tx.productID])
            }
        }
    }

    func handle(method: String, params: [String: Any], done: @escaping (Result<[String: Any], NativeError>) -> Void) {
        switch method {
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
                    switch try await product.purchase() {
                    case .success(.verified(let tx)):
                        await tx.finish()
                        done(.success(["status": "purchased"]))
                    case .success(.unverified(_, let error)):
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
