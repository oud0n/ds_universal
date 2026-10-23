// ios_compare_trace.mjs がページに入れる記録係: <video> の位置の移動・速さの変更・再生/停止と、コマが出た時刻 (requestVideoFrameCallback)、画面の処理の止まり (rAF が 50 ms 超)
(() => {
  if (window.__trace) { window.__trace.ev = []; window.__trace.t0 = performance.now(); return 'reset'; }
  const T = window.__trace = { t0: performance.now(), ev: [] };
  const ids = new WeakMap(); let next = 0;
  const idOf = el => { if (!ids.has(el)) ids.set(el, next++); return ids.get(el); };
  const name = el => decodeURIComponent((el.getAttribute('src') || el.currentSrc || '').split('/').pop() || '').slice(-40);
  const push = (k, el, v) => T.ev.push({ t: performance.now(), k, id: el ? idOf(el) : -1, f: el ? name(el) : '', v, m: el ? el.muted : undefined, p: el ? el.paused : undefined });
  const P = HTMLMediaElement.prototype;
  for (const prop of ['currentTime', 'playbackRate']) {
    const d = Object.getOwnPropertyDescriptor(P, prop);
    Object.defineProperty(P, prop, { configurable: true, get: d.get, set(v) { push(prop === 'currentTime' ? 'seek' : 'rate', this, v); d.set.call(this, v); } });
  }
  const pl = P.play, pa = P.pause;
  P.play = function () { push('play', this); return pl.call(this); };
  P.pause = function () { push('pause', this); return pa.call(this); };
  const watched = new WeakSet();
  const watch = () => document.querySelectorAll('video').forEach(v => {
    if (watched.has(v) || !v.requestVideoFrameCallback) return;
    watched.add(v);
    const cb = (now, meta) => { T.ev.push({ t: performance.now(), k: 'frame', id: idOf(v), f: name(v), v: meta.mediaTime, pf: meta.presentedFrames, m: v.muted }); v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  });
  setInterval(watch, 300); watch();
  let last = performance.now();
  const raf = () => { const n = performance.now(); if (n - last > 50) T.ev.push({ t: n, k: 'jank', v: n - last }); last = n; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  return 'installed';
})()
