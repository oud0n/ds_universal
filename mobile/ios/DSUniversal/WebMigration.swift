import Foundation
import WebKit

/// アプリに入れた Web (laploupe://app/) に切り替えたとき、前の読み込み元 (https://oud0n.github.io) のブラウザの保存
/// (localStorage と IndexedDB: 自分で作ったコース・登録した機器・設定など) を、新しい読み込み元へ一度だけ写す。
/// ブラウザの保存は読み込み元ごとに分かれていて、そのままでは新しい版から見えないため。
/// - 前の読み込み元の保存は消さない (写すだけ)
/// - 新しい側にもうある名前は上書きしない
/// - 試験版のページ (/ds_universal/preview/) の保存 (名前の頭に ds_preview: が付く) も、本番の保存に無いものだけ写す
/// - 通信はしない。前の読み込み元のページは、中身をアプリが渡し、読み込み元だけ https://oud0n.github.io として開く (loadHTMLString の baseURL)。
///   以前は GitHub Pages の本物のページを開いていて、電波の弱い所では起動が最大 12 秒ほど待たされていた (1.0.3 の前のレビュー)
@MainActor
final class WebMigration: NSObject, WKNavigationDelegate {
    static let doneKey = "webMigration.fromPages.v1"
    /// 前の読み込み元 (保存は読み込み元ごとに分かれるので、この読み込み元のページの中から読む)
    private static let oldOriginURL = URL(string: "https://oud0n.github.io/ds_universal/")!
    private static let newOriginURL = URL(string: "laploupe://app/__migrate.html")!

    private var webView: WKWebView?
    private var loaded: CheckedContinuation<Bool, Never>?
    /// 読み込みの回 (前の回の時間切れの知らせが、次の回を終わらせないように)
    private var generation = 0
    private let schemeHandler: WKURLSchemeHandler

    init(schemeHandler: WKURLSchemeHandler) {
        self.schemeHandler = schemeHandler
    }

    /// 要るときだけ写す。終わったら (写せなくても) 戻る
    func runIfNeeded() async {
        guard !UserDefaults.standard.bool(forKey: Self.doneKey) else { return }
        // 前の読み込み元 (github.io) の保存が無ければ、写すものは無い (初めて入れた人。起動を待たせない)
        let records = await WKWebsiteDataStore.default().dataRecords(ofTypes: [WKWebsiteDataTypeLocalStorage, WKWebsiteDataTypeIndexedDBDatabases])
        guard records.contains(where: { $0.displayName.contains("github.io") }) else {
            DebugLog.write("web migration: nothing to copy (no github.io data)")
            UserDefaults.standard.set(true, forKey: Self.doneKey)
            return
        }
        DebugLog.write("web migration: start")
        guard let dump = await readOld() else {
            DebugLog.write("web migration: could not read the old origin; retry next launch")
            return
        }
        // 保存があるのに何も読めなかったときは、終わった印を付けない (次に起動したときにもう一度。印を付けると二度と写さないため)
        if dump.hasPrefix("{\"ls\":{},\"idb\":[]") {
            DebugLog.write("web migration: old origin read as empty although data exists; retry next launch")
            webView = nil
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

    /// ページを開いて、読み込み終わるのを待つ。html を渡したときは、通信せずにその中身を url の読み込み元として開く
    private func load(_ url: URL, html: String? = nil, timeout: TimeInterval) async -> Bool {
        let view = makeWebView()
        generation += 1
        let gen = generation
        return await withCheckedContinuation { cont in
            loaded = cont
            if let html {
                view.loadHTMLString(html, baseURL: url)
            } else {
                view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout + 2) { [weak self] in
                guard let self, self.generation == gen else { return }
                self.finishLoad(false)
            }
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
        let html = "<!doctype html><meta charset=utf-8><title>migrate</title>"
        guard await load(Self.oldOriginURL, html: html, timeout: 5), let view = webView else { return nil }
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
    // 前の読み込み元のページとして開けていなければ読まない (別の読み込み元の空の保存を、写したものとみなさないように)
    if (location.origin !== 'https://oud0n.github.io') return null;
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
      // 無い DB を開くと空の DB ができる (indexedDB.databases() が使えないときの名前の決め打ち)。中身のない DB は写さない
      if (stores.length > 0) idb.push({ name, version: db.version, stores });
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
    // 本番の DB と試験版の DB (頭の印を外すと同じ名前) を 1 つにまとめてから写す。
    // 別々に開くと、同じ版の DB が先にできて onupgradeneeded が来ず、試験版にしかない入れ物 (object store) を作れないため。
    // 版は上げない (アプリは決まった版で開くので、上げると開けなくなる)。本番の DB があれば本番の版、無ければ試験版の版
    const merged = new Map();
    for (const x of d.idb.filter(x => !x.name.startsWith(P)).concat(d.idb.filter(x => x.name.startsWith(P)))) {
      const preview = x.name.startsWith(P);
      const name = preview ? x.name.slice(P.length) : x.name;
      const m = merged.get(name) ?? { name, version: x.version || 1, stores: [] };
      for (const s of x.stores) {
        const cur = m.stores.find(t => t.name === s.name);
        if (cur) cur.records = cur.records.concat(s.records);
        else m.stores.push({ ...s, records: s.records.slice() });
      }
      merged.set(name, m);
    }
    for (const src of merged.values()) {
      const name = src.name;
      let db;
      try {
        const r = indexedDB.open(name, src.version);
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
