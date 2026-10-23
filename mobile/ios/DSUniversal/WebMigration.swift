import Foundation
import WebKit

/// アプリに入れた Web (laploupe://app/) に切り替えたとき、前の読み込み元 (https://oud0n.github.io) のブラウザの保存
/// (localStorage と IndexedDB: 自分で作ったコース・登録した機器・設定など) を、新しい読み込み元へ一度だけ写す。
/// ブラウザの保存は読み込み元ごとに分かれていて、そのままでは新しい版から見えないため。
/// - 前の読み込み元の保存は消さない (写すだけ)
/// - 新しい側にもうある名前は上書きしない
/// - 試験版のページ (/ds_universal/preview/) の保存 (名前の頭に ds_preview: が付く) も、本番の保存に無いものだけ写す
/// - 電波がなく前の読み込み元を開けないときは、今回は写さず、次に起動したときにもう一度試す
@MainActor
final class WebMigration: NSObject, WKNavigationDelegate {
    static let doneKey = "webMigration.fromPages.v1"
    /// 前の読み込み元の、軽いページ (無い道なので GitHub の 404 のページが出る。読み込み元が同じなので保存は読める)
    private static let oldOriginURL = URL(string: "https://oud0n.github.io/ds_universal/__laploupe_migrate__")!
    private static let newOriginURL = URL(string: "laploupe://app/__migrate.html")!

    private var webView: WKWebView?
    private var loaded: CheckedContinuation<Bool, Never>?
    private let schemeHandler: WKURLSchemeHandler

    init(schemeHandler: WKURLSchemeHandler) {
        self.schemeHandler = schemeHandler
    }

    /// 要るときだけ写す。終わったら (写せなくても) 戻る
    func runIfNeeded() async {
        guard !UserDefaults.standard.bool(forKey: Self.doneKey) else { return }
        DebugLog.write("web migration: start")
        guard let dump = await readOld() else {
            DebugLog.write("web migration: could not read the old origin (offline?); retry next launch")
            return
        }
        if let result = await writeNew(dump) {
            DebugLog.write("web migration: done \(result)")
            UserDefaults.standard.set(true, forKey: Self.doneKey)
        } else {
            DebugLog.write("web migration: write failed; retry next launch")
        }
        webView = nil
    }

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: BundledWebSchemeHandler.scheme)
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 10, height: 10), configuration: config)
        view.navigationDelegate = self
        webView = view
        return view
    }

    private func load(_ url: URL, timeout: TimeInterval) async -> Bool {
        let view = makeWebView()
        return await withCheckedContinuation { cont in
            loaded = cont
            view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout))
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout + 2) { [weak self] in self?.finishLoad(false) }
        }
    }

    private func finishLoad(_ ok: Bool) {
        guard let cont = loaded else { return }
        loaded = nil
        cont.resume(returning: ok)
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated { finishLoad(true) }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { finishLoad(false) }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { finishLoad(false) }
    }

    /// 前の読み込み元の保存を、JSON の文字列で読み出す
    private func readOld() async -> String? {
        guard await load(Self.oldOriginURL, timeout: 10), let view = webView else { return nil }
        do {
            let value = try await view.callAsyncJavaScript(Self.dumpScript, contentWorld: .page)
            return value as? String
        } catch {
            DebugLog.write("web migration: dump error \(error.localizedDescription)")
            return nil
        }
    }

    /// 新しい読み込み元へ写す。写した数を返す
    private func writeNew(_ dump: String) async -> String? {
        guard await load(Self.newOriginURL, timeout: 5), let view = webView else { return nil }
        do {
            let value = try await view.callAsyncJavaScript(Self.importScript, arguments: ["dump": dump], contentWorld: .page)
            return (value as? String) ?? "ok"
        } catch {
            DebugLog.write("web migration: import error \(error.localizedDescription)")
            return nil
        }
    }

    // 値を JSON にする (数値の配列・日付・NaN も戻せるように印を付ける)
    private static let codec = """
    const P = 'ds_preview:';
    const toB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const fromB64 = b => { const s = atob(b); const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; };
    const enc = v => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : { __t: 'num', v: String(v) };
      if (v === null || typeof v !== 'object') return v;
      if (v instanceof ArrayBuffer) return { __t: 'ArrayBuffer', b64: toB64(new Uint8Array(v)) };
      if (ArrayBuffer.isView(v)) return { __t: v.constructor.name, b64: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
      if (v instanceof Date) return { __t: 'Date', v: v.getTime() };
      if (Array.isArray(v)) return v.map(enc);
      const o = {}; for (const k of Object.keys(v)) o[k] = enc(v[k]); return o;
    };
    const dec = v => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(dec);
      if (typeof v.__t === 'string') {
        if (v.__t === 'num') return Number(v.v);
        if (v.__t === 'Date') return new Date(v.v);
        if (v.__t === 'ArrayBuffer') return fromB64(v.b64).buffer;
        const C = globalThis[v.__t];
        if (typeof C === 'function') { const u8 = fromB64(v.b64); return new C(u8.buffer, 0, u8.byteLength / (C.BYTES_PER_ELEMENT || 1)); }
      }
      const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k]); return o;
    };
    const req = r => new Promise((ok, ng) => { r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); });
    """

    private static let dumpScript = codec + """
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null) ls[k] = localStorage.getItem(k); }
    let names = [];
    try { names = (await indexedDB.databases()).map(d => d.name).filter(Boolean); }
    catch (e) { names = ['ds_universal', 'laploupe-laptimer', P + 'ds_universal', P + 'laploupe-laptimer']; }
    const idb = [];
    for (const name of names) {
      let db;
      try { db = await req(indexedDB.open(name)); } catch (e) { continue; }
      const stores = [];
      for (const sn of Array.from(db.objectStoreNames)) {
        const st = db.transaction(sn, 'readonly').objectStore(sn);
        const indexes = Array.from(st.indexNames).map(n => { const i = st.index(n); return { name: n, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }; });
        const keys = await req(st.getAllKeys());
        const values = await req(db.transaction(sn, 'readonly').objectStore(sn).getAll());
        stores.push({ name: sn, keyPath: st.keyPath, autoIncrement: st.autoIncrement, indexes, records: keys.map((k, i) => [enc(k), enc(values[i])]) });
      }
      idb.push({ name, version: db.version, stores });
      db.close();
    }
    return JSON.stringify({ ls, idb });
    """

    private static let importScript = codec + """
    const d = JSON.parse(dump);
    let lsCount = 0, idbCount = 0;
    // 本番の保存を先に、試験版の保存 (頭の印を外す) は本番に無いものだけ
    const lsKeys = Object.keys(d.ls);
    for (const k of lsKeys.filter(k => !k.startsWith(P)).concat(lsKeys.filter(k => k.startsWith(P)))) {
      const name = k.startsWith(P) ? k.slice(P.length) : k;
      if (localStorage.getItem(name) === null) { localStorage.setItem(name, d.ls[k]); lsCount++; }
    }
    const dbs = d.idb.filter(x => !x.name.startsWith(P)).concat(d.idb.filter(x => x.name.startsWith(P)));
    for (const src of dbs) {
      const name = src.name.startsWith(P) ? src.name.slice(P.length) : src.name;
      let db;
      try {
        const r = indexedDB.open(name, Math.max(1, src.version));
        r.onupgradeneeded = () => {
          const x = r.result;
          for (const s of src.stores) {
            if (x.objectStoreNames.contains(s.name)) continue;
            const opts = { autoIncrement: s.autoIncrement };
            if (s.keyPath !== null && s.keyPath !== undefined) opts.keyPath = s.keyPath;
            const st = x.createObjectStore(s.name, opts);
            for (const i of s.indexes) st.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
          }
        };
        db = await req(r);
      } catch (e) {
        try { db = await req(indexedDB.open(name)); } catch (e2) { continue; }
      }
      for (const s of src.stores) {
        if (!db.objectStoreNames.contains(s.name)) continue;
        for (const [k, v] of s.records) {
          const key = dec(k), value = dec(v);
          const st = db.transaction(s.name, 'readwrite').objectStore(s.name);
          const exists = await req(st.count(key));
          if (exists > 0) continue;
          const st2 = db.transaction(s.name, 'readwrite').objectStore(s.name);
          try { await req(s.keyPath !== null && s.keyPath !== undefined ? st2.add(value) : st2.add(value, key)); idbCount++; } catch (e) {}
        }
      }
      db.close();
    }
    return 'localStorage ' + lsCount + ', IndexedDB ' + idbCount;
    """
}
