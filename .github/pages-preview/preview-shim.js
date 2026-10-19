// GitHub Pages の試験版 (/ds_universal/preview/) だけに入れるスクリプト。.github/workflows/pages.yml が index.html の <title> の直後 (ほかのスクリプトより先) に差し込む。
// GitHub Pages はどのパスも同じ場所 (oud0n.github.io) 扱いなので、試験版と本番はブラウザに保存するもの (設定・コース・同期ピンなど) を共有してしまう。
// 試験版で保存の形が変わっても本番が読めなくならないよう、保存する名前の頭に印を付けて分ける (アプリのコードは変えない)
(function () {
  var P = 'ds_preview:';
  try {
    var proto = Storage.prototype;
    var get = proto.getItem, set = proto.setItem, remove = proto.removeItem, key = proto.key;
    var lengthDesc = Object.getOwnPropertyDescriptor(proto, 'length');
    var own = function (store) {
      var out = [];
      var n = lengthDesc.get.call(store);
      for (var i = 0; i < n; i++) {
        var k = key.call(store, i);
        if (k !== null && k.indexOf(P) === 0) out.push(k);
      }
      return out;
    };
    proto.getItem = function (k) { return get.call(this, P + k); };
    proto.setItem = function (k, v) { return set.call(this, P + k, v); };
    proto.removeItem = function (k) { return remove.call(this, P + k); };
    proto.key = function (i) { var k = own(this)[i]; return k === undefined ? null : k.slice(P.length); };
    proto.clear = function () { var self = this; own(self).forEach(function (k) { remove.call(self, k); }); };
    Object.defineProperty(proto, 'length', { configurable: true, get: function () { return own(this).length; } });
  } catch (e) { /* 保存が使えない環境 */ }
  try {
    var open = IDBFactory.prototype.open, del = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.open = function (name, version) {
      return version === undefined ? open.call(this, P + name) : open.call(this, P + name, version);
    };
    IDBFactory.prototype.deleteDatabase = function (name) { return del.call(this, P + name); };
  } catch (e) { /* IndexedDB がない環境 */ }
  // どのブランチの試験版かを、画面の左下とタブの名前に出す (__PREVIEW_REF__ は workflow がブランチ名に置き換える)
  var ref = '__PREVIEW_REF__';
  document.title = '[試験版 ' + ref + '] ' + document.title;
  document.addEventListener('DOMContentLoaded', function () {
    var tag = document.createElement('div');
    tag.textContent = '試験版: ' + ref;
    tag.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:2147483647;padding:1px 6px;border-radius:4px;background:#b45309;color:#fff;font:11px/1.6 sans-serif;pointer-events:none;opacity:.85';
    document.body.appendChild(tag);
  });
})();
