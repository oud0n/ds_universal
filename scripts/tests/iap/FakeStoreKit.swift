import Foundation

struct NativeError: Error {
    enum Code { case io, notSupported, notFound }
    let code: Code
    let message: String
    init(_ code: Code, _ message: String) {
        self.code = code
        self.message = message
    }
}

@MainActor final class NativeCore {
    var events: [(String, [String: Any])] = []
    func emit(_ name: String, _ data: [String: Any]) { events.append((name, data)) }
}

enum DebugLog {
    static func write(_ text: String) {}
}

enum Kind: Sendable { case consumable, nonConsumable, other }
enum Verification: Sendable {
    case verified(Transaction)
    case unverified(Transaction, NativeError)
}
enum PurchaseResult: Sendable { case success(Verification), pending, userCancelled }

struct Product: Sendable {
    let id: String
    let type = Kind.nonConsumable
    let price = 1
    var displayName: String { id }
    let description = ""
    let displayPrice = "1"

    static func products(for ids: [String]) async throws -> [Product] { ids.map { Product(id: $0) } }
    func purchase() async throws -> PurchaseResult {
        .success(.verified(Transaction(productID: id, productType: type)))
    }
}

struct Transaction: Sendable {
    let productID: String
    let productType: Kind
    var revocationDate: Date? = nil
    var id: UInt64 { UInt64(productID.utf8.first!) }

    @MainActor static var scans: [AsyncStream<Verification>.Continuation] = []
    @MainActor static var feed: AsyncStream<Verification>.Continuation?
    @MainActor static var finished: [String] = []
    @MainActor static var delayNextFinish: String?
    @MainActor static var blockedFinish: CheckedContinuation<Void, Never>?
    @MainActor static var currentEntitlements: AsyncStream<Verification> {
        let (stream, continuation) = AsyncStream<Verification>.makeStream()
        scans.append(continuation)
        return stream
    }
    @MainActor static var updates: AsyncStream<Verification> {
        let (stream, continuation) = AsyncStream<Verification>.makeStream()
        feed = continuation
        return stream
    }

    @MainActor func finish() async {
        if Self.delayNextFinish == productID {
            Self.delayNextFinish = nil
            await withCheckedContinuation { Self.blockedFinish = $0 }
        }
        Self.finished.append(productID)
    }
}

enum AppStore {
    @MainActor static var fail = false
    @MainActor static func sync() async throws {
        if fail { throw NativeError(.io, "sync failed") }
    }
}
