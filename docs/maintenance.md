# 開発・リリースの手順 (運用の手引き)

2026-10-27 (1.1.0) 時点。持ち主・ほかのエージェントが、しばらく空いたあとでも同じ手順で直して出せるようにまとめた。構成は [architecture.md](architecture.md)、残件は [../TODO.md](../TODO.md)・[../BUGS.md](../BUGS.md)。

## アイコンの更新

元画像は `build/icon-ios.svg` (通常)・`build/icon-ios-dark.svg` (ダーク)。タイヤの中心は 1024 四方の中央、ダークのタイヤだけ 98% に縮めている。持ち手は同じ寸法。

macOS で `swift scripts/generate-icons.swift` を実行すると、PC の SVG・PNG・ICO・ICNS、Mac の Dock、Web の favicon、共通の正方形画像をまとめて作り直す。生成済みの画像も git に入れ、通常のビルドで Swift は要求しない。`build/icon-square.png` と `build/icon-square-dark.png` は透明度なし。端末側のアイコン素材としても使う。PC 用は角の外が透明。

Web の favicon と Mac の起動中の Dock は OS の外観に従う。Finder・Windows・Apple touch icon は通常版を使う。Android の画像資源はホスト側で管理する。

当面の自動切替は Mac の Dock と iOS / iPadOS でよい (持ち主、2026-11-06)。Windows・Android の追加対応は後回し。必要な作業と確認条件は [TODO.md の PLAN-57・58](../TODO.md#plan-5758-アイコンの自動切替)。

## 1. ブランチとタグ

| 名前 | 役割 |
|---|---|
| `main` | 出したもの。デスクトップ版のリリースのタグはここに付ける。push すると GitHub Pages (ブラウザ版) が出し直される |
| `dev` | 次に出すものをまとめる所。直しは別のブランチで作り、テストを通してから dev にマージする |
| `ios-next` | (2026-10-30 に dev に入れて終えた) iPhone 周りの直しも、ほかと同じく作業のブランチから dev に入れる。iPhone 版を出すかは下の版の番号の決まりで決める |
| 作業のブランチ | `fix/…`・`feat/…`。worktree で作るときは `git add -A` を使わない (node_modules のリンクが入ったことがある) |
| タグ `vX.Y.Z` | デスクトップ版のリリース (CI が Mac・Windows を作って GitHub Release に置く) |
| タグ `ios-X.Y.Z-bN` | App Store に出した iOS のビルドのコミット (例: `ios-1.1.0-b14` = 3540e0b) |

- 版の番号: X.Y (1.1 など) は、iPhone のアプリと PC 版でそろえる。いちばん下の桁 (1.1.**x**) は、そろえるのを基本にするが、ずれてもよい (2026-10-30 から)。
  - PC 版だけの直しなら、PC 版だけ上げて出す (例: PC 1.1.2・iPhone 1.1.1 のまま)。iPhone 版は、iPhone に効く直しがあるときだけ出す。
  - iPhone 版を出すときは、その時の PC 版の番号に合わせる (PC が 1.1.2 なら iPhone も 1.1.2。間の 1.1.1 は飛ばしてよい)。
  - リリースノートには、どの版に何が入ったかを、PC・iPhone の区別が分かるように書く。
- dev → main のマージ・push・タグは、持ち主の許しを得てから。

## 2. 毎回の確かめ

```sh
npm install
npx tsc --noEmit -p .     # 型
npx vitest run            # 単体 (2026-10-27 で 471 件)
npm run build             # dist (iOS・Android のアプリにも入る)
```

保管場所のログを使う単体試験は、`LAPLOUPE_TEST_STORE` に試験用の写しの絶対パスを指定したときだけ実行する。

端末専用のネイティブ試験は、それぞれのホスト側で管理する。

## 3. 画面の通しの試験 (e2e)

本物の保管場所は使わない (周を隠すなどで書き換えるため)。写しで回す。

```sh
cp -c -R ~/Library/Mobile\ Documents/com~apple~CloudDocs/LapLoupe <作業用>/LapLoupe   # APFS の写し (すぐ終わる)
echo '{"folder": "<作業用>/LapLoupe"}' > <作業用>/electron-data/lap-folder.json
npx vite --port 5184 --strictPort &
open -n "$PWD/node_modules/electron/dist/Electron.app" --env ELECTRON_START_URL=http://localhost:5184/ \
  --args "$PWD" --user-data-dir=<作業用>/electron-data --remote-debugging-port=9334
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9224 --user-data-dir=<作業用>/chrome about:blank &
E2E_APP=http://localhost:5184/ node e2e/run.mjs --electron 9334 --chrome 9224 [--only 名前の一部]
```

- Electron は `open -n <絶対パス>` で起こす (`npx electron` だと Bluetooth の許可で落ちることがある)。
- 失敗した場面のスクリーンショットは `e2e/out/`。開発サーバーのときだけ `window.__laploupe` で状態を読める。
- 試験の中で「デジスパイスに USB でつなぐ」のボタンは押さない (出る画面で Electron と CDP が固まる)。

## 4. レビュー

- 敵対的なレビューは、コードを読むだけで行い、見つかったものは必ずコードで確かめてから直す。
- agy (Gemini): `agy -p "<英語の指示>" --model <モデル> --mode plan < /dev/null > review.md`。途中は Flash・Argon Medium、main へマージする前は Argon High (使う前に持ち主に聞く。枠をすぐ使い切るため)。
- Fable: 基礎の設計 (画面の組み方・状態の持ち方・ファイルの形) に関わる所だけ (高いので)。
- GUI の洗い出し: 上の e2e と同じ写しの環境で、agy の MCP (chrome-desktop → 9334・chrome-phone → 9224) か、CDP のスクリプトで触る。スマートフォンは `?native=mock` と画面の大きさの切り替え。2 人で同じ画面を触らない。直すのは回の合間 (vite の読み直しでページが変わるため)。
- iOS シミュレーター: `xcrun simctl` (許可の切り替え `privacy grant|revoke|reset`、位置 `location`、写真 `addmedia`) と、シミュレーターを操作する道具。カメラ・Bluetooth はシミュレーターに無いので実機で。

## 5. デスクトップ版・ブラウザ版のリリース

1. `package.json` の `version` と、`docs/release-notes.md`・`release-notes.en.md` の節を書く。
2. dev → main にマージして push。ブラウザ版 (Pages) は main の push で出し直される (`.github/workflows/pages.yml`)。
3. `git tag -a vX.Y.Z main -m "LapLoupe X.Y.Z"` → `git push origin vX.Y.Z`。CI (`build-and-release.yml`) が Mac (署名・公証。リポジトリの secrets) と Windows を作り、GitHub Release を作る (説明はコミットから自動)。公証に 10〜30 分かかる。
   - タグのビルドだけ、新しい版を確かめる (`electron/updater.cjs`。CI が `-c.extraMetadata.autoUpdate=true` を付ける)。リリースには `latest.yml`・`latest-mac.yml`・`-mac.zip` と、`.exe`・`-mac.zip` の blockmap (差分で落とすため) も置く (無いと、前の版のアプリが新しい版を見つけられない)。dmg の blockmap は使わないので置かない。説明の頭に、どれを落とすかを CI が書く。手元・タグでない CI のビルドは確かめない。
   - 出したら、前の版のアプリで「新しい版を確かめる」→「入れる」→「再起動して入れる」が通るか、一度は確かめる。画面だけなら、開発中に `LAPLOUPE_FAKE_UPDATE=1.9.0` (zip 版などの形は `LAPLOUPE_FAKE_UPDATE_MODE=manual` も) で起こすと、新しい版があるふりをする。
   - Windows のインストーラーの名前は `LapLoupe-Setup-X.Y.Z.exe` (空白を入れない。GitHub が空白を「.」に変え、目録と名前がずれるため)。
4. 同じ番号で出し直すとき (ダウンロードが 0 のときだけ): `gh release delete vX.Y.Z --yes` → `git push origin :refs/tags/vX.Y.Z` → タグを付け直して push。
5. 試験版のページ: `gh workflow run pages.yml -f preview_ref=<ブランチ>` で /ds_universal/preview/ に出る (保存は本番と分かれる)。

## 6. iPhone / iPad のアプリ

iOS ホストのソース・専用試験・ビルド・配布手順は別の作業場で管理する。このリポジトリは共通 Web とネイティブの契約を管理する。

## 7. Android

Android ホストのソース・専用試験・Gradle設定・画像資源は、このリポジトリでは管理しない。共通のWeb/ネイティブ契約と模擬窓口は維持する。

## 8. 秘密と持ち主だけの資料 (`../private/`、git に入れない)

- `api_key/`: App Store Connect の API キー (README.md に ID と使い分け)。
- `analytics.md`: アクセス数の見方 (GoatCounter のトークン付きの URL など。公開の場所に貼らない)。
- `app_store_screenshots/`・`promo/`: ストアの画像・紹介動画。
- `re_report/`: 公式ソフトの解析の記録 (公開しない。ドリフト採点は作らない)。

## 9. 守ること

- 公式ソフトのドリフト採点は作らない (解析だけ。公開の資料には「作らない」と書く)。公式の G・旋回半径の計算は使ってよい。
- デジスパイスの公式のコースの座標を写さない (場所・線の位置の手がかりにするのはよい)。
- 文書・コメント・画面の文言は、短くわかりやすい日本語 (英語も添える画面の文言は `t('…', '…')`)。
- 利用者への返信 (issue) は短く、「ご報告ありがとうございます」で始めない。
