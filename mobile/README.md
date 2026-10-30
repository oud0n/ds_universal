# スマートフォンのアプリ (ネイティブの部分)

画面と解析は、ブラウザ版と同じ Web (`src/`) を WKWebView / WebView で動かす。
ここには、端末ごとのネイティブの部分だけを置く (設計は docs/iphone_app_design.md)。

| フォルダ | 端末 | 言語 | 状態 |
|---|---|---|---|
| `ios/` | iPhone・iPad | Swift (SwiftUI は外側の枠だけ) | 1.1.0 を App Store に提出 (BLE の機器・ラップタイマー・内蔵カメラ・G センサー・保管場所・アプリ内課金) |
| `android/` | Android | Kotlin | 友人向けの試験版 (Bluetooth Classic の GPS・BLE・内蔵カメラ・選んだフォルダ) |

## 決まり

- Web とネイティブの間の約束は `src/native/contract.ts` だけ。ネイティブはこの形を作るだけにする。
  約束を変えるときは版の番号を上げ、`ios/`・`android/`・ふりをする窓口 (`src/native/mockNative.ts`) を同じに直す。
- ネイティブには、解析・周の判定・機器ごとのデータの読み方を入れない (両方で書くことになるため)。
  たとえばデジスパイスの BLE のバイト列は、ネイティブはそのまま Web に渡し、読むのは `src/services/digspiceBleProtocol.ts`。
- 端末で分けず、「できること」(`caps.get` の features) で画面を出し分ける。

## ネイティブなしで画面を試す

開発サーバーで `?native=mock` を付けると、ネイティブのふりをする窓口が入り、iPhone のアプリと同じ道筋で画面が動く
(デジスパイスのふりをした機器が 2 台見つかり、つなぐと 20 Hz で円を回る測位が届く)。

```
npm run dev
# http://localhost:5173/?native=mock#logger
```

電波が切れたふりは、ブラウザのコンソールで `__dsMockNative.dropConnection()`。

## 通知の記録（仕様の確かめ用）

ロガー設定の Bluetooth のカードの「記録を始める」で、届いた通知をそのままファイルに書き足す (速度・高度の単位、途切れ方、本体の情報を確かめるため)。

- iPhone: 画面を消しても続く。OS がアプリを止めても、Bluetooth の通知でアプリが起こされたときに、同じファイルの続きに書く。
  ファイルは「ファイル」アプリの「このiPhone内 → LapLoupe → ble-captures」にも出る
- ブラウザ (Chrome): このページを開いている間だけ (閉じると消える)
- 「測位の CSV」: 測位にして、速度の欄と位置から求めた速さの比 (1 に近ければ 0.01 m/s で合っている)・高度の幅・途切れをまとめて書き出す

## iPhone (`ios/`)

1. Xcode を一度開いて、追加の部品を入れておく
2. `brew install xcodegen` のあと、`cd mobile/ios && xcodegen` で `DSUniversal.xcodeproj` を作る
3. ふだんは `npm run build` で作った `dist` をアプリに入れて読む (`DS_WEB_URL` は空)。開発中に Mac の開発サーバーを読みたいときは、
   作るときに `DS_WEB_URL=http://<Mac の名前>.local:5173/ xcodegen` とする (http は .local などの近くのネットワークだけ通る)
4. Bluetooth はシミュレーターでは使えないので、実機で試す (Apple の開発者の登録が要る)

シミュレーターで試すときは `xcodebuild … -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build` (docs/maintenance.md の 4・6)。

## TestFlight に送る (2026-10-23)

有料の開発者登録 (チーム A84PUTN545) で、Xcode に Apple ID を入れてあること。App Store Connect にアプリ (バンドル ID `io.github.oud0n.dsuniversal`) を登録してあること。

```sh
npm run build          # アプリに入れる Web (dist) を作る。忘れると、アプリを作るときに止まる
cd mobile/ios
# CURRENT_PROJECT_VERSION (ビルド番号) は、送るたびに project.yml で上げる (同じ番号は送れない)
xcodegen
# 署名とアップロードは、App Store Connect の API キー (役割 Admin) で行う。Xcode の Apple ID が外れていても通る。
# キーのファイル・キー ID・Issuer ID は git に入れない (リポジトリの外の ../private/api_key/。値はそこの README.md)
KEY=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
xcodebuild -project DSUniversal.xcodeproj -scheme DSUniversal -configuration Release \
  -destination 'generic/platform=iOS' -archivePath /tmp/LapLoupe.xcarchive \
  DEVELOPMENT_TEAM=A84PUTN545 DS_WEB_URL= -allowProvisioningUpdates "${KEY[@]}" archive
xcodebuild -exportArchive -archivePath /tmp/LapLoupe.xcarchive -exportPath /tmp/LapLoupe-ipa \
  -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates "${KEY[@]}"
```

- `DS_WEB_URL=` (空) で、アプリに入れた Web (dist) を `laploupe://app/` で読む (BundledWeb.swift)。電波がなくても起動でき、審査を通った版の画面がそのまま動く。
- 前の版 (GitHub Pages を読んでいた版) から上げたときは、初めて開いたときに一度だけ、前の読み込み元のブラウザの保存 (自分のコース・登録した機器・設定・ラップタイマーの控え) を写す (WebMigration.swift)。前の保存は消さない。
- 署名は Apple が管理する配布用の証明書 (クラウド署名) で行う。使えるのは役割 Admin の API キーか、Xcode に入れた Apple ID。役割 Developer のキー (PC 版の公証に使っているもの) では「Cloud signing permission error」になる。
- Xcode の Apple ID は、ときどき外れる (2026-10-26・27。「Failed to Use Accounts」で止まる)。そのため 2026-10-27 から Admin のキーで送る。キーを使わずに送るときは、Xcode の「設定」→「Accounts」で入れ直してから `-exportArchive` をやり直す (アーカイブは作り直さなくてよい)。
- アイコンは `DSUniversal/Assets.xcassets/AppIcon` (元は `build/icon-ios.svg`)。
