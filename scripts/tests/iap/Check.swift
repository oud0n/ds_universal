import Foundation

@main enum Check {
    @MainActor static func main() async {
        let watchdog = Task {
            try await Task.sleep(for: .seconds(45))
            fatalError("StoreKit test did not finish")
        }
        defer { watchdog.cancel() }

        let core = NativeCore()
        let module = IapModule(core: core)
        var original: Result<[String: Any], NativeError>?
        module.start()
        module.start()
        module.handle(method: "iap.entitlements", params: [:]) { original = $0 }
        while Transaction.scans.count != 1 || Transaction.feed == nil { await Task.yield() }

        // 起動時の未完了取引が一覧の読み取りに割り込む。古い読み取りを待つ画面も新しい結果を得る。
        let stale = Transaction(productID: "a", productType: .nonConsumable)
        let revoked = Transaction(productID: "a", productType: .nonConsumable, revocationDate: Date())
        let active = Transaction(productID: "b", productType: .nonConsumable)
        let tip = Transaction(productID: "c", productType: .consumable)
        let bad = Transaction(productID: "x", productType: .nonConsumable)
        Transaction.scans[0].yield(.verified(stale))
        Transaction.feed!.yield(.verified(revoked))
        while Transaction.scans.count != 2 { await Task.yield() }
        Transaction.scans[0].finish()
        precondition(original == nil)
        Transaction.scans[1].yield(.verified(revoked))
        Transaction.scans[1].yield(.verified(tip))
        Transaction.scans[1].yield(.verified(active))
        Transaction.scans[1].yield(.unverified(bad, NativeError(.io, "unverified")))
        Transaction.scans[1].finish()
        while original == nil || Transaction.finished.isEmpty { await Task.yield() }
        let snapshot = try! original!.get()
        precondition(snapshot["productIds"] as? [String] == ["b"])
        precondition(core.events[0].0 == "iap.entitlementsChanged")
        precondition(snapshot["revision"] as? Int == core.events[0].1["revision"] as? Int)

        // 支払い成功の直後に一覧が止まっても、結果を返し、次の取引を受け取れる。
        var purchase: Result<[String: Any], NativeError>?
        module.handle(method: "iap.purchase", params: ["id": "d"]) { purchase = $0 }
        while purchase == nil || Transaction.scans.count != 3 { await Task.yield() }
        precondition(try! purchase!.get()["status"] as? String == "purchased")
        Transaction.feed!.yield(.verified(tip))
        while !Transaction.finished.contains("c") { await Task.yield() }
        precondition(core.events.last!.0 == "iap.purchased")
        var timedOut: Result<[String: Any], NativeError>?
        module.handle(method: "iap.entitlements", params: [:]) { timedOut = $0 }
        let eventCount = core.events.count
        while timedOut == nil { try! await Task.sleep(for: .milliseconds(50)) }
        if case .failure? = timedOut {} else { fatalError("hung inventory claimed success") }
        precondition(core.events.count == eventCount && !Transaction.finished.contains("d"))

        // 次の要求は新しい列を読む。遅れて終わった古い列では配達しない。
        var fresh: Result<[String: Any], NativeError>?
        module.handle(method: "iap.entitlements", params: [:]) { fresh = $0 }
        while Transaction.scans.count < 4 { await Task.yield() }
        Transaction.scans[2].yield(.verified(stale))
        Transaction.scans[2].finish()
        Transaction.delayNextFinish = "d"
        Transaction.scans[3].yield(.verified(Transaction(productID: "d", productType: .nonConsumable)))
        Transaction.scans[3].finish()
        while fresh == nil || Transaction.blockedFinish == nil { await Task.yield() }
        precondition(try! fresh!.get()["productIds"] as? [String] == ["d"])
        precondition(core.events.count == eventCount + 1)

        // finish が待っている間に同じ ID の取り消しが届いても、新しい配達を消さない。
        Transaction.feed!.yield(.verified(Transaction(productID: "d", productType: .nonConsumable, revocationDate: Date())))
        while Transaction.scans.count < 5 { await Task.yield() }
        Transaction.scans[4].finish()
        while !Transaction.finished.contains("d") { await Task.yield() }
        Transaction.blockedFinish!.resume()
        while Transaction.finished.filter({ $0 == "d" }).count < 2 { await Task.yield() }
        precondition(core.events.last!.1["productIds"] as? [String] == [])

        // 確認できない買い切り取引も、復元に失敗したときも、所有を増やさない。
        Transaction.feed!.yield(.unverified(bad, NativeError(.io, "unverified")))
        while Transaction.scans.count < 6 { await Task.yield() }
        Transaction.scans[5].yield(.unverified(bad, NativeError(.io, "unverified")))
        Transaction.scans[5].finish()
        while core.events.count < eventCount + 3 { await Task.yield() }
        precondition(!Transaction.finished.contains("x"))
        AppStore.fail = true
        var failedRestore: Result<[String: Any], NativeError>?
        module.handle(method: "iap.restore", params: [:]) { failedRestore = $0 }
        while failedRestore == nil { await Task.yield() }
        if case .failure? = failedRestore {} else { fatalError("restore failure was lost") }
        Transaction.feed!.finish()
        print("PASS StoreKit inventory, updates, recovery and transaction completion")
    }
}
