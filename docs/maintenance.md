# 開発・リリースの手順 (運用の手引き)

2026-10-27 (1.1.0) 時点。持ち主・ほかのエージェントが、しばらく空いたあとでも同じ手順で直して出せるようにまとめた。構成は [architecture.md](architecture.md)、残件は [../TODO.md](../TODO.md)・[../BUGS.md](../BUGS.md)。

## 1. ブランチとタグ

| 名前 | 役割 |
|---|---|
| `main` | 出したもの。デスクトップ版のリリースのタグはここに付ける。push すると GitHub Pages (ブラウザ版) が出し直される |
| `dev` | 次に出すものをまとめる所。直しは別のブランチで作り、テストを通してから dev にマージする |
| `ios-next` | iPhone 周りの直しで、App Store に出しているものとずれないよう次の版まで dev に入れないもの |
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
4. 同じ番号で出し直すとき (ダウンロードが 0 のときだけ): `gh release delete vX.Y.Z --yes` → `git push origin :refs/tags/vX.Y.Z` → タグを付け直して push。
5. 試験版のページ: `gh workflow run pages.yml -f preview_ref=<ブランチ>` で /ds_universal/preview/ に出る (保存は本番と分かれる)。

## 6. iPhone / iPad のアプリ

### 6.1 ビルドと TestFlight

手順は [mobile/README.md](../mobile/README.md) の「TestFlight に送る」。要点:

- `mobile/ios/project.yml` の `MARKETING_VERSION` (1.1.0 など) と `CURRENT_PROJECT_VERSION` (送るたびに 1 つ上げる)。
- `npm run build` → `cd mobile/ios && xcodegen` → archive → exportArchive (destination=upload)。
- 署名とアップロードは、App Store Connect の API キー (役割 Admin) で行う。キーと ID は `../private/api_key/` (値はそこの README.md。git に入れない)。役割 Developer のキーは PC 版の公証用なので消さない。
- 提出したビルドのコミットにはタグ `ios-X.Y.Z-bN` を付ける。

### 6.2 App Store への提出

- スクリーンショットは iPhone 6.1 インチ・iPhone Duo (外 1398×2034・内 2853×2007)・iPad 13 インチ (2752×2064 か 2064×2752) が要る。iPad は 1.1.0 から要る。元の画像は `../private/app_store_screenshots/`。
  - シミュレーターで撮る: `xcrun simctl status_bar <端末> override --time 9:41 --batteryState charged --batteryLevel 100`、暗い表示は `xcrun simctl ui <端末> appearance dark`。
  - 走行のデータは、データの入ったシミュレーターのアプリの `Documents/` と `Library/WebKit/` を写すと早い。
  - 車載動画が映る画面は、ミラーに映る顔などにモザイクをかける。筑波の映像は使わない。
- API で上げる: App Store Connect API の `appScreenshotSets` (iPad 13 インチは `APP_IPAD_PRO_3GEN_129`) → `appScreenshots` を作る → 返った uploadOperations に PUT → `uploaded: true` と md5 で PATCH。処理中 (`UPLOAD_COMPLETE`) のまま止まったら、消して少し変えたファイル (画質を変えるなど) で上げ直す。
- 却下されたら: 版の番号は、出していない版なら書き換えられる (ビルドの番号と合わせる)。返信は英語で、原因・直したこと・確かめたこと (端末) を短く。
- 審査で落ちやすい所: 使う機能の説明の文 (Info.plist の `NS…UsageDescription`。カメラはファイルの選択の「写真またはビデオを撮る」でも使われる)、外へのリンク、外の寄付 (アプリでは出さない。アプリ内課金の投げ銭だけ)。docs/app_store.md。

### 6.3 実機での確かめ

- 開発版を入れる: `xcodebuild … -configuration Debug -destination 'id=<UDID>' … build` (API キーを付ける) → `xcrun devicectl device install app --device <UDID> <.app>` → `xcrun devicectl device process launch --device <UDID> io.github.oud0n.dsuniversal`。開発版は TestFlight の版を上書きする。
- 画面を撮る: `pymobiledevice3 developer dvt screenshot <png> --udid <UDID>`。
- アプリの記録: `xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer --domain-identifier io.github.oud0n.dsuniversal --source Documents/ble-captures/debug.log --destination <ファイル>`。
- Web の中を見る: `pymobiledevice3 webinspector cdp` (e2e/ios_compare_trace.mjs)。

## 7. Android (友人向けの試験版)

`mobile/android/`。Bluetooth Classic の GPS (Drogger DG-PRO1S)・BLE・内蔵カメラ (CameraX)・選んだフォルダ (SAF)。配布はストアに出さず APK を渡している。実機の確認は友人の端末頼み。

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
