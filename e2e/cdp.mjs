// 画面の通しの試験の道具 (Chrome DevTools Protocol で、動いているページを操作する)。2026-10-21。
// 追加の道具は使わない (Node の WebSocket と fetch だけ)。

import fs from 'node:fs';
import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Page {
  constructor(ws, outDir, label) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.outDir = outDir;
    this.label = label;
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text ?? '').slice(0, 300));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push(m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300));
    });
  }

  /** 開いているページにつなぐ (port の中で、url に urlPart を含むもの)。newTab なら新しいタブを開く */
  static async connect(port, { urlPart = 'localhost', newTab = false, outDir, label }) {
    let target;
    if (newTab) target = await (await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    else target = (await (await fetch(`http://localhost:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.includes(urlPart));
    if (!target) throw new Error(`port ${port} にページがない`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const p = new Page(ws, outDir, label);
    p.targetId = newTab ? target.id : null;
    p.port = port;
    await p.send('Runtime.enable');
    await p.send('Page.enable');
    return p;
  }

  send(method, params = {}) {
    return new Promise(r => { const i = ++this.id; this.pending.set(i, r); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }

  /** ページの中で式を評価して値を返す (Promise は待つ) */
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`ev: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  }

  /** アプリの様子 (開発サーバーの window.__laploupe) */
  state() {
    return this.ev(`JSON.parse(JSON.stringify(window.__laploupe ?? null))`);
  }

  async waitFor(expr, timeoutMs = 15000, what = expr) {
    const t0 = Date.now();
    for (;;) {
      try { if (await this.ev(`!!(${expr})`)) return; } catch { /* まだ */ }
      if (Date.now() - t0 > timeoutMs) throw new Error(`待ちきれない: ${what}`);
      await sleep(200);
    }
  }

  /** data-testid の要素を押す */
  async click(testid) {
    const ok = await this.ev(`(()=>{const b=document.querySelector('[data-testid="${testid}"]'); if(!b||b.disabled) return false; b.click(); return true})()`);
    if (!ok) throw new Error(`押せない: ${testid}`);
  }

  /** 文字の一致するボタンを押す */
  async clickText(text) {
    const ok = await this.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)}); if(!b||b.disabled) return false; b.click(); return true})()`);
    if (!ok) throw new Error(`押せない: 「${text}」`);
  }

  async exists(testid) {
    return this.ev(`!!document.querySelector('[data-testid="${testid}"]')`);
  }

  async viewport(width, height, mobile) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height });
  }

  async goto(url) {
    // 前のページで出たエラー (つないだときに送られてくる、前からのもの) は数えない
    this.errors = [];
    await this.send('Page.navigate', { url });
    await sleep(500);
    await this.waitFor(`document.readyState === 'complete' && document.querySelector('#root')?.children.length > 0`, 20000, 'ページの読み込み');
    await sleep(1500);
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(this.outDir, `${this.label}_${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  }

  async close() {
    if (this.targetId) await fetch(`http://localhost:${this.port}/json/close/${this.targetId}`).catch(() => {});
    this.ws.close();
  }
}

/** 試験の中の確かめ */
export function check(cond, message) {
  if (!cond) throw new Error(message);
}
