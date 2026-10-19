# Android (まだ作っていない)

iPhone (`../ios/`) と同じく、Web (`src/`) を WebView で動かし、`src/native/contract.ts` の約束だけを Kotlin で作る。

- Web から: `window.dsNativeAndroid.postMessage(JSON の文字列)` (`@JavascriptInterface`)
- Web へ: `webView.evaluateJavascript("window.dsNative.receive(…)")` (主スレッドで)
- 時刻は `SystemClock.elapsedRealtimeNanos()`

作るときに気をつけること (docs/iphone_app_design.md の 7.6):

- BLE の操作 (つなぐ・探す・読む・書く) は 1 つずつ順に行う。`autoConnect = false` でつなぎ、切れたら自分でつなぎ直す
- つないだら MTU を上げ、`CONNECTION_PRIORITY_HIGH` にする (`ble.connect` の `highThroughput`)
- 画面を消したあとの記録はフォアグラウンドサービス (Android 14 からは種類 `connectedDevice`・`location` と、その許可が要る)
- 電池の節約で止める機種があるので、初めて使うときに案内する
- 開閉で Activity と WebView が作り直されないよう `configChanges` を書く
