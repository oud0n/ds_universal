# LapLoupe の構成

2026-10-27 (1.1.0) 時点。新しく入る人・ほかのエージェントが、どこに何があるかをつかむための資料。細かい設計は各設計書 ([docs/README.md](README.md) の一覧) にある。

## 1. 全体

LapLoupe は、1 つの Web アプリ (React + TypeScript、`src/`) を 4 つの形で配っている。

| 形 | 中身 | Web の読み込み元 | 端末の機能 |
|---|---|---|---|
| ブラウザ版 | `src/` を Vite でビルドし GitHub Pages に置く | https://oud0n.github.io/ds_universal/ | Web Serial (USB)・Web Bluetooth (Chrome)。保管場所なし |
| デスクトップ版 (Mac・Windows) | Electron (`electron/main.cjs`・`preload.cjs`) が `dist/` を開く | アプリに入れた `dist/` | `window.electronAPI` (保管場所のフォルダ・保存の画面・USB) |
| iPhone / iPad のアプリ | WKWebView (`mobile/ios/DSUniversal/*.swift`) | アプリに入れた `dist/` を `laploupe://app/` で返す (BundledWeb.swift) | ネイティブの窓口 (下の 3) |
| Android のアプリ (友人向けの試験版) | WebView (`mobile/android/…/laploupe/*.kt`) | アプリに入れた `dist/` | ネイティブの窓口 (iPhone と同じ約束) |

画面・解析・書き出しは全部 Web の側にあり、ネイティブの側は「Web ではできないこと」だけを受け持つ (Bluetooth・カメラ・G センサー・保管場所のファイル・画面の向き・アプリ内課金)。画面のネイティブ化はしない方針 (docs/ios_native_study.md の結論)。

## 2. Web アプリ (`src/`)

### 2.1 入口と画面の組み方

- `main.tsx` → `App.tsx`。App.tsx が状態 (読み込んだログ = Session、Car 1〜4 の割り当て、再生の時刻、コース) を持ち、画面へ配る。大きいので、触るときは関数名で検索して部分だけ読む。
- 画面の種類と並べ方: `src/app/`
  - `appProfile.ts`: 今の形 (`app-phone` / `app-tablet` / `desktop` / `browser-phone` / `browser-desktop`)。
  - `navPlan.ts`: 形ごとに、どの画面 (`timer`・`library`・`analysis`・`video`・`data`・`convert`・`logger`・`settings`) をどこに出すか (下のタブ・サイドバー・⚙)。
  - `navStore.ts`: 今の画面と戻る。
- 配置の段 (スマートフォン・中くらい・パソコン) は画面の幅で決める: `src/hooks/useCompactLayout.ts` (docs/duo_layout_design.md)。

### 2.2 画面 (主な部品)

| 画面 | 部品 |
|---|---|
| 走行 (ライブラリ) | `screens/LibraryScreen.tsx`、取り込み `components/import/ImportSheet.tsx`、ラップタイム `LapHistoryPanel.tsx` |
| 解析 | `SpeedGraphWindow.tsx`・`TrackMapWindow.tsx`・`FrictionCircleWindow.tsx`・`CornerAnalysisWindow.tsx`・`BrakingAnalysisWindow.tsx`・`XYGraphWindow.tsx`・`PlayBar.tsx`、走行とコース `DataTab.tsx` |
| 動画 | `VideoSyncWindow.tsx` (見る・比べる・合わせる・書き出す)、`video/VideoStage.tsx`・`VideoTile.tsx`、メーターの配置 `video/OverlayLayoutEditor.tsx` |
| ラップタイマー | `LapTimerScreen.tsx`・`LapTimerControls.tsx`・`TimerCameraSettings.tsx` |
| 変換 | `ConvertTab.tsx`・`TrimPreview.tsx` |
| ロガー・機器 | `LoggerTab.tsx`・`DevicesCard.tsx`・`BleLoggerCard.tsx` |
| 設定 | `screens/SettingsScreen.tsx`・`StorageSettings.tsx`・`CsvFormatSettings.tsx` |
| 使い方 | `HelpOverlay.tsx` (public/help/ のページを重ねて出す) |

### 2.3 サービス (`src/services/`)

| 分野 | ファイル |
|---|---|
| ログの読み込み | `logLoader.ts` (拡張子と中身で振り分け)、`rawBinaryParser.ts` (.bnx4/.bon4)、`dtbParser.ts`、`nmeaParser.ts`、`csvParser.ts`・`csvFormats.ts` (CSV の形式の定義)、`externalFormats.ts` (VBO・GPX・RaceChrono など)、`aimFormats.ts`、`fitParser.ts`、`ibtParser.ts`、`gpmfParser.ts` (GoPro の GPS) |
| 解析 | `lapCalculator.ts` (計測線・セクター・周)、`physics.ts` (G・旋回半径。公式と同じ計算は使ってよい)、`drivingAnalysis.ts` (コーナー・ブレーキ)、`pairAnalysis.ts` (+ worker)、`autoCourseLines.ts` (知らないコースの計測線)、`clockOffsetEstimator.ts` (ログごとの時計の補正) |
| コース | `circuitDatabase.ts` (内蔵 `courses/` と自分のコース)、`userCircuitStorage.ts`、`storageCourses.ts`・`courseFolderSync.ts` (保管場所の `course/`)、`courseCorners.ts`・`cornerNames.ts` (コーナーの名前)、`osmCircuitService.ts` (OpenStreetMap のコース図) |
| 保管場所 (走行のライブラリ) | `runStore.ts` (保管場所の窓口: iPhone / Android のネイティブ・デスクトップ版の IPC)、`runs.ts`・`runsFile.ts` (runs.json の 2 版)、`lapIndex.ts`・`lapHistory.ts` (laptimes.json)、`runOpener.ts` (走行を開く: ログ・動画・同期)、`runSync.ts`、`runDelete.ts`、`analysisSessions.ts` (保存した比べ方)、`import/` (取り込み) |
| 動画 | `videoSyncManager.ts` (動画の時刻 = clock、同期)、`videoSyncPinManager.ts`、`videoChapterManager.ts` (GoPro のチャプター)、`videoMetadataParser.ts`、`clockMaster.ts`・`mediaClock.ts`・`playbackController.ts` (再生の時計)、`videoLaps.ts` (動画に映る周)、`remoteVideo.ts` (lapfile:// の動画) |
| 書き出し | `encodeVideoExporter.ts` (mediabunny で 1 コマずつ)、`telemetryVideoExporter.ts` (再生しながら録る・ダウンロード)、`overlayOnlyExporter.ts` (メーターだけ: PNG の ZIP・透明な WebM)、`exportSink.ts` (OPFS のディスク)、`logConverter.ts`・`nmeaExporter.ts`・`bon4Writer.ts` |
| メーター | `overlayLayout.ts` (部品と並び・自分で名前を付けた値)、`overlayStore.ts` (保管場所の overlays/)、`components/overlayParts.ts`・`overlayRender.ts` (描く)、`calcChannels.ts`・`csvFormatStore.ts` (計算式・CSV の形式) |
| ラップタイマー | `timer/timerRuntime.ts` (測る流れの中心)、`timer/positionFeeds.ts` (位置の出どころ)、`timer/gpsImuFusion.ts`・`phoneImu.ts`・`imuG.ts` (G センサーで GPS の間を埋める)、`timer/phoneCamera.ts` (内蔵カメラ)、`liveLapTimer.ts`、`runRecorder.ts`・`liveRunStore.ts`・`sensorCsvRecorder.ts` (走行のファイルを書く) |
| 機器 | `digspiceDevice.ts`・`digspiceProtocol.ts`・`webSerialTransport.ts` (USB)、`digspiceBleProtocol.ts`・`bleLoggerLink.ts`・`bleCentral.ts`・`nativeBleCentral.ts`・`webBluetoothCentral.ts`・`sppCentral.ts` (Bluetooth)、`devices/` (RaceBox・Drogger・心拍計・OBD・GoPro の読み方と登録) |

### 2.4 言語・文言

- 画面の文言は `useT()` の `t('日本語', 'English')`、React の外は `tr()` (`src/utils/i18n.ts`)。文言を足すときは両方書く。
- iPhone では「iPhone / iPad」を端末に合わせて出す (`utils/device.ts`)。

## 3. ネイティブの窓口 (`src/native/`)

- 約束は `src/native/contract.ts` に 1 か所。名前空間ごと: `system.*` (ファイル・保管場所・共有・画面の向き・G センサー・設定アプリを開く)、`ble.*`、`spp.*` (Android の Bluetooth Classic)、`camera.*`、`recorder.*` (画面を消している間の BLE の記録)、`iap.*` (アプリ内課金の投げ銭)、`caps` (使える機能)。
- 呼ぶ: `callNative(method, params)`、知らせを受ける: `onNative(event, cb)` (`bridge.ts`)。
- iPhone: `NativeBridge.swift` が受けて、`SystemModule`・`BleModule`・`CameraModule`・`MotionRecorder`・`IapModule`・`RunFiles` (保管場所のファイル・lapfile:// の範囲読み) に回す。WKUIDelegate (alert・confirm・prompt)・ダウンロード → 共有の画面は `WebDownloads.swift`。画面の向き `Orientation.swift`。
- Android: `NativeBridge.kt` → `SystemModule`・`BleModule`・`SppModule`・`CameraModule`・`MotionModule`・`SafStore` (選んだフォルダ)。
- ブラウザで試すとき: `?native=mock` で `mockNative.ts` が iPhone のアプリのふりをする (e2e と GUI の洗い出しで使う)。

## 4. 保管場所 (走行のライブラリ)

利用者が選んだフォルダ (iPhone は iCloud Drive の `LapLoupe/` が多い。デスクトップ版は任意のフォルダ)。ブラウザ版には無い。

```
<保管場所>/
  <サーキットのフォルダ>/            内蔵コースは ID (sodegaura など)、自分のコースは保存フォルダ名、分からないものは unsorted
    <YYYYMMDD>/
      <YYYYMMDDhhmmss>.nmea           走行の基準のファイル (無ければ .bon4)
      <YYYYMMDDhhmmss>.bon4           公式ソフト向け
      <走行>.<名前>.csv               センサーの値 (心拍計・OBD・CSV の形式)
      <走行>.iphone_imu.csv           iPhone の G センサー
      <走行>.mov / _front.mov / _2…   内蔵カメラの動画
      GX010017.MP4 など               付けた車載動画
    runs.json                         走行ごとの行 (2 版。名前・メモ・車種・天候・付けた動画と同期・参考ラップの印)
    laptimes.json                     周の控え (作り直せる)
  course/                             Circuit/*.pth・ControlLine/*.cln・Sector/*.sci・Corner/<フォルダ>.json・courses.json
  formats/                            CSV の形式 (*.csvformat.json)・計算式 (calc.json)
  overlays/                           メーターの並び
  sessions/                           保存した比べ方 (*.lapsession.json)
  digspice/                           公式ソフトのコースフォルダ (読むだけ)
  exports/                            書き出し (一覧には出さない)
```

- 形の決まり: docs/run_storage_v2.md (runs.json)、docs/session_storage_design.md、docs/csv_format_design.md、docs/meter_layout_design.md。
- iPhone は測っている間だけアプリの中 (`Documents/LapTimer/`) に書き、終わったら選んだフォルダへ移す (`system.syncLapFiles`)。
- 知らない項目は消さずに残す (古い版と新しい版が同じフォルダを書くため)。

## 5. コースのデータ (`courses/`)

内蔵のコースは独自に作ったもの (OpenStreetMap・国土地理院などの航空写真から)。デジスパイスの公式のコースの座標は写さない (docs の方針と `courses/README.md`)。作る道具は `tools/courses/`。

## 6. 試験

| 種類 | 場所 | 回し方 |
|---|---|---|
| 単体 | `src/**/*.test.ts` (vitest) | `npx vitest run`・型は `npx tsc --noEmit -p .` |
| 画面の通し (e2e) | `e2e/run.mjs`・`journeys.mjs`・`layout.mjs` | docs/maintenance.md の 3 |
| iPhone の実機の計測 | `e2e/ios_compare_trace.mjs` | 同上 |

## 7. 使っていない古いファイル

ルートの `main.js`・`preload.js`・`renderer.js`・`styles.css` は v0.7.0 (DS Universal Suite) の頃のもので、今のビルドでは使っていない (Electron の入口は `electron/main.cjs`)。`digspice_cli.ps1`・`extract_pcap.py` は通信の解析に使った道具。消すかは持ち主の判断待ち (TODO の CLEAN-01)。
