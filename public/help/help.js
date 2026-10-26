// 使い方のページの端末・言語の切り替え。アプリから開くときは ?device=iphone&lang=ja を付ける。選んだものはこの端末に覚える
(function () {
  var q = new URLSearchParams(location.search);
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  var ua = navigator.userAgent;
  var guessDevice = /iPhone|iPad|iPod/.test(ua) ? 'iphone' : /Android/.test(ua) ? 'android' : 'desktop';
  var guessLang = (navigator.language || 'ja').toLowerCase().indexOf('ja') === 0 ? 'ja' : 'en';
  var device = q.get('device') || store.get('help_device') || guessDevice;
  var lang = q.get('lang') || store.get('help_lang') || guessLang;
  var root = document.documentElement;
  function apply() {
    root.setAttribute('data-device', device);
    root.setAttribute('data-lang', lang);
    root.setAttribute('lang', lang);
    document.querySelectorAll('[data-set-device]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-set-device') === device)); });
    document.querySelectorAll('[data-set-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-set-lang') === lang)); });
    var t = document.querySelector('title[data-ja]');
    if (t) document.title = t.getAttribute(lang === 'en' ? 'data-en' : 'data-ja');
    // ページの間のリンクにも、今の端末・言語を付ける
    document.querySelectorAll('a[data-keep]').forEach(function (a) { var u = new URL(a.getAttribute('href'), location.href); u.searchParams.set('device', device); u.searchParams.set('lang', lang); a.href = u.pathname.split('/').pop() + u.search; });
  }
  apply();
  // アプリの中 (laploupe://) では動画を入れていないので、公開しているページの動画を開く
  if (location.protocol === 'laploupe:') {
    document.querySelectorAll('video[data-src]').forEach(function (v) { v.src = 'https://oud0n.github.io/ds_universal/help/' + v.getAttribute('data-src'); });
  } else {
    document.querySelectorAll('video[data-src]').forEach(function (v) { v.src = v.getAttribute('data-src'); });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-set-device],[data-set-lang]');
    if (!b) return;
    if (b.hasAttribute('data-set-device')) { device = b.getAttribute('data-set-device'); store.set('help_device', device); }
    else { lang = b.getAttribute('data-set-lang'); store.set('help_lang', lang); }
    apply();
  });
})();
