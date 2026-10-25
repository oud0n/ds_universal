# Android 版 (2026-10-25 に最初の版)

iPhone (`../ios/`) と同じく、Web (`src/`) を WebView で動かし、`src/native/contract.ts` の約束だけを Kotlin で作る。

- 画面: アプリに入れた Web (`npm run build` の `dist`) を `https://appassets.androidplatform.net/app/` で開く (WebViewAssetLoader。通信しない)
- Web から: `window.dsNativeAndroid.postMessage(JSON の文字列)` (`@JavascriptInterface`)
- Web へ: `webView.evaluateJavascript("window.dsNative.receive(…)")` (主スレッドで)
- 時刻は `SystemClock.elapsedRealtimeNanos()`

## 最初の版でできること

- **Bluetooth Classic の GPS (Drogger DG-PRO1S など)**: 機器の登録の「位置」→「Drogger (Bluetooth Classic) を追加」で、OS の機器を選ぶ画面 (CompanionDeviceManager) を出し、そのままペアリングする。
  つないだら NMEA を受け取り、Web の `DroggerStream` (BLE の Drogger と同じ読み方) で位置にしてラップタイマーと記録に流す。切れたら 3 秒ごとにつなぎ直す
- **確かめの記録**: つなぐたびに `files/debug/spp-日時.log` に、機種と Android の版・つなぐ / 切れる / ペアリングの結果・受け取った行をそのまま書く。
  機器の行の「記録を送る」で共有の画面から送れる (`spp.shareLog`)
- 保存はアプリの中 (`files/LapTimer`) だけ。フォルダを選ぶ (Google ドライブなど)・BLE (デジスパイス・RaceBox)・カメラ・課金は、あとの版

## 作る

```sh
brew install openjdk@17 gradle
brew install --cask android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"   # 利用規約への同意が要る
npm run build                       # アプリに入れる Web (dist)。忘れると止まる
cd mobile/android
echo "sdk.dir=/opt/homebrew/share/android-commandlinetools" > local.properties
./gradlew assembleDebug             # app/build/outputs/apk/debug/app-debug.apk
```

## 配る (試してくれる人へ)

`app-debug.apk` をそのまま送り、Android の「提供元不明のアプリ」を許可して入れてもらう (iPhone のような 7 日の期限はない)。
入れ直すときは、同じ鍵で署名した版でないと上書きできない (この Mac の debug の鍵: `~/.android/debug.keystore`)。

## エミュレーターで画面を見る

```sh
avdmanager create avd -n laploupe_test -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_8
$ANDROID_HOME/emulator/emulator -avd laploupe_test &
adb install -r app/build/outputs/apk/debug/app-debug.apk
# WebView を Chrome の DevTools でつなぐ: adb forward tcp:9250 localabstract:webview_devtools_remote_<pid>
```

Bluetooth はエミュレーターでは試せない (機器を選ぶ画面と許可までは出る)。

## あとの版で気をつけること (docs/iphone_app_design.md の 7.6)

- BLE の操作 (つなぐ・探す・読む・書く) は 1 つずつ順に行う。`autoConnect = false` でつなぎ、切れたら自分でつなぎ直す
- つないだら MTU を上げ、`CONNECTION_PRIORITY_HIGH` にする (`ble.connect` の `highThroughput`)
- 画面を消したあとの記録はフォアグラウンドサービス (Android 14 からは種類 `connectedDevice`・`location` と、その許可が要る)
- 電池の節約で止める機種があるので、初めて使うときに案内する

## Android だけの機能 (あとの版): 擬似ロケーション

デジスパイスなどの位置を Android の位置として流し、ほかのアプリも 20 Hz の位置で動くようにする (`LocationManager.addTestProvider` / `setTestProviderLocation`。
使う人が開発者向けオプションでこのアプリを選ぶ)。
