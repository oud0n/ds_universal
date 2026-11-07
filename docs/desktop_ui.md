# PC共通外観 (PLAN-61)

2026-11-08。Mac・Windows・PCブラウザの解析画面を共通の外観に整える。モバイルのコード分離は別作業。

## 範囲

- PCブラウザもサイドバーにそろえる。利用できる画面は既存の機能判定で決める。
- 配色・余白・枠線・見出し・選択状態を `src/styles/desktop.css` にまとめる。
- ネイティブホストは `data-ui="native"`、Electronとブラウザは `data-ui="desktop"`。表示前に設定し、Canvasの色と本文の色をそろえる。
- ライト・ダーク・システム・高コントラストの選択を保つ。キーボードの注目を明示する。
- PCの再生バーは1段。狭い表示では従来の配置へ切り替える。
- 分割・折りたたみ、Car 1〜4、補正、セクター操作、解析項目、動画の入口は維持する。
- G-G図の値の欄は、分割した枠内で独立してスクロールできる。狭い図では左右の軸名を短縮する (BUG-134)。
- Macは標準のアプリメニュー、Windowsは従来のメニューとCtrl系の操作を使う。標準ウィンドウ枠とファイルダイアログを保つ。

OS固有の透過素材・タイトルバー統合、常設ラップ表、検索欄、配置プリセット、書き出しの共通メニューは対象外。解析や保存の共通エンジンは変更しない。

方針の参照: [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/)、[Windows design guidance](https://learn.microsoft.com/en-us/windows/apps/design/)。

## 検証

専用のブラウザプロファイルと同梱の公開デモログ・合成ログだけを使う。実際の保管場所には接続しない。USB接続・機器の消去は行わない。

```sh
npm test -- --run
npm run build
E2E_CDP_PORT=<専用Chromeのポート> E2E_URL=http://127.0.0.1:<開発ポート>/ node e2e/desktop-ui.mjs
E2E_CDP_PORT=<専用Chromeのポート> E2E_URL=http://127.0.0.1:<開発ポート>/ node e2e/lap-playback.mjs
E2E_CDP_PORT=<専用Chromeのポート> E2E_URL=http://127.0.0.1:<開発ポート>/ node e2e/lap-menu-input.mjs
```

`desktop-ui.mjs` は1024×700と1440×900、日英、ライト/ダーク/高コントラスト、4台比較、ラップ選択、引き出し、画面切替え、再生、キーボード、分割操作、サイドバーを確認する。Mac/Windowsのメニュー生成も実際の関数で確認する。

任意のPlaywright環境でFirefox/WebKitを確認する場合:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs E2E_URL=http://127.0.0.1:<開発ポート>/ node e2e/desktop-ui-browsers.mjs
```

`E2E_BROWSERS=firefox` または `webkit` で実行対象を選べる。テスト用の依存とブラウザは製品の依存関係に追加しない。

検証画像は `e2e/out/desktop-ui/` と `e2e/out/desktop-ui-browsers/`。実際のWindowsアプリ・Safari本体での成功は、ChromeやPlaywrightの結果からは判断しない。
