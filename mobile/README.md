# スマートフォンのアプリ (ネイティブの部分)

画面と解析は、ブラウザ版と同じ Web (`src/`) を WKWebView / WebView で動かす。
ここには、端末ごとのネイティブの部分だけを置く (設計は docs/iphone_app_design.md)。

| フォルダ | 端末 | 言語 | 状態 |
|---|---|---|---|
| `ios/` | iPhone・iPad | Swift (SwiftUI は外側の枠だけ) | デジスパイスとのつなぎ (BLE) まで |
| `android/` | Android | Kotlin | まだ作っていない |

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

## iPhone (`ios/`)

1. Xcode を一度開いて、追加の部品を入れておく
2. `brew install xcodegen` のあと、`cd mobile/ios && xcodegen` で `DSUniversal.xcodeproj` を作る
3. 開発中は、`project.yml` の `DS_WEB_URL` に Mac の開発サーバー (`npm run dev -- --host` で出る `http://192.168.x.x:5173/`) を書くと、
   その画面を読み込む (Web を直すとすぐ反映される)。空なら公開版のページを読む
4. Bluetooth はシミュレーターでは使えないので、実機で試す (Apple の開発者の登録が要る)

まだないもの: アプリに入れた Web を `app://` で読む (動画の範囲の読み出しと一緒に作る)、保存 (files)、記録 (recorder)、カメラ、センサー。
