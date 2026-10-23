# App Store に出す資料（iPhone のアプリ）

2026-10-24 作成。App Store Connect の LapLoupe（アプリの ID 6826272937、バンドル ID `io.github.oud0n.dsuniversal`）に入れる文章と、審査の準備。
入力と提出は持ち主が App Store Connect で行う。

## 決めたこと

- **iPhone だけ**で出す（`TARGETED_DEVICE_FAMILY: "1"`）。iPad は、iPad の画面も審査されるので、あとで考える。
- **Web はアプリに入れる**（`laploupe://app/`。BundledWeb.swift）。電波がなくても起動でき、審査を通った版の画面がそのまま動く。審査の決まり 2.5.2（審査のあとに中身を変える）の心配もなくなる。
- **価格は無料**。広告なし。最初の申請はアプリ内課金なし。
- **寄付**: アプリの中では、外の寄付のページ (Buy Me a Coffee) への案内を出さない (審査の決まり 3.1.1。`App.tsx` の canDonate)。次の版で、アプリ内課金の投げ銭 (消耗型「ガソリン 1L / 5L / 10L」、製品 ID `io.github.oud0n.dsuniversal.tip.gas1` など。App Store Connect に下書きを作成済み) を足す。要るもの: 有料アプリ契約 (銀行口座・税の書類)、Small Business Program、Swift の StoreKit の処理、購入の画面のスクリーンショット。説明に「投げ銭で、ガソリンが届いたり機能が増えたりはしない」と書く。
- **申請するビルド**: 1.0.2 (5)（Web 入り・寄付の案内なし）。
- **配る国**: EU の国々は外す（EU の決まりで、個人の開発者は住所・電話番号・メールの公開を求められるため）。出すなら「取引業者ではない」の申告を検討する。
- **販売元の名前**: 個人の登録なので、本名（Yoshihiro Takagi）が出る。

## 基本の情報

| 項目 | 日本語 | English |
|---|---|---|
| 名前（30 文字まで） | LapLoupe | LapLoupe |
| サブタイトル（30 文字まで） | 走行ログと車載動画の解析 | Lap timer & track log analyzer |
| カテゴリ | スポーツ（2 つ目: ユーティリティ） | Sports (secondary: Utilities) |
| サポートの URL | https://github.com/oud0n/ds_universal/issues | 同じ |
| マーケティングの URL | https://oud0n.github.io/ds_universal/ | 同じ |
| プライバシーポリシーの URL | https://oud0n.github.io/ds_universal/privacy.html | 同じ |
| 著作権 | 2026 Yoshihiro Takagi | 同じ |

## 説明文

### 日本語

**プロモーション用テキスト（170 文字まで。審査なしで変えられる）**

> デジスパイスなどの GPS ロガーの走行ログを、周ごとのタイム・速度グラフ・コース図・車載動画で振り返れます。走りながらのラップタイマーにも。データは端末とあなたの iCloud Drive にだけ保存します。

**説明（4000 文字まで）**

```
LapLoupe は、サーキット走行・ジムカーナ・カートの走行ログを解析するアプリです。デジスパイスなどの GPS ロガーのログや、車載動画を読み込み、周ごとのタイム・速度・ブレーキの位置を、グラフとコース図で比べられます。

■ 解析
・周ごとのラップタイム・セクタータイム・ベストとの差
・速度・加速度のグラフと、コース図の上の走行ライン
・2 つの周を重ねて、どこで速い・遅いかを比べる
・コーナーごとの最低速度・ブレーキの位置

■ 車載動画
・走行ログと動画を合わせて再生（メーター・G・ラップタイムを重ねて表示）
・2 つの周の動画を並べて、同じ地点で比べる
・動画のコマに合わせて、グラフとコース図も動く

■ ラップタイマー
・Bluetooth でデジスパイスとつなぎ、走りながら周・セクター・ベストとの差を表示
・ロガーがなくても、iPhone の GPS で周を数えられます
・測った走行は、そのまま解析で開けます

■ データの置き場所
・走行ログ・動画・コースは、iPhone の中と、あなたが選んだフォルダ（iCloud Drive など）にだけ保存します
・パソコン版（Mac・Windows）とブラウザ版も無料で、同じフォルダの走行を開けます

■ 読み込めるファイル
デジスパイスのログ（.bon4 など）、NMEA、GPX、CSV（RaceChrono・AiM など）、FIT、GoPro の動画（GPS 入り）ほか

■ 内蔵のサーキット
日本の主なサーキット・カートコースと、海外の主なサーキットの計測線を内蔵しています。自分でコースを作ることもできます。

※ デジスパイスは、株式会社デジスパイスの商標です。LapLoupe は株式会社デジスパイスとは関係のない、個人が作ったアプリです。
```

**キーワード（100 文字まで。カンマ区切り、空白なし）**

```
ラップタイマー,サーキット,走行ログ,デジスパイス,GPS,ロガー,車載動画,ジムカーナ,カート,解析,ラップタイム,テレメトリー
```

### English

**Promotional text**

> Review your laps with lap times, speed graphs, a track map and onboard video from GPS loggers such as DigSpice — or time your laps live. Your data stays on your device and your iCloud Drive.

**Description**

```
LapLoupe analyses logs from track days, gymkhana and karting. Load logs from GPS loggers such as DigSpice, or onboard videos, and compare lap times, speed and braking points on graphs and a track map.

ANALYSIS
- Lap and sector times, and the gap to your best lap
- Speed and acceleration graphs, and your racing line on the track map
- Overlay two laps to see where you gain or lose time
- Minimum corner speeds and braking points

ONBOARD VIDEO
- Play a log and its video together, with gauges, G-meter and lap times on top
- Compare two laps side by side at the same point on track
- Graphs and the map follow the video frame by frame

LAP TIMER
- Connect to a DigSpice over Bluetooth and see laps, sectors and the gap to your best while you drive
- No logger? Count laps with the iPhone's GPS
- Open any recorded run straight in the analysis

YOUR DATA
- Logs, videos and courses are stored only on your iPhone and in a folder you choose (such as iCloud Drive)
- Free desktop (Mac, Windows) and browser versions open the same folder

SUPPORTED FILES
DigSpice logs (.bon4 etc.), NMEA, GPX, CSV (RaceChrono, AiM and others), FIT, GoPro videos with GPS, and more

BUILT-IN CIRCUITS
Timing lines for major circuits and kart tracks in Japan and major circuits abroad. You can also make your own courses.

DigSpice is a trademark of DigSpice Inc. LapLoupe is an independent app and is not affiliated with DigSpice Inc.
```

**Keywords**

```
lap timer,track day,racing,telemetry,GPS logger,DigSpice,onboard video,karting,gymkhana,lap time
```

## App のプライバシー（質問票の答え）

- 「このアプリからデータを収集しますか？」→ **いいえ（データを収集しない）**
  - 走行ログ・位置・動画は端末とユーザーが選んだフォルダにだけ保存し、作者のサーバーには送らない（サーバーはない）。
  - 地図の画像（国土地理院・OpenStreetMap）とサーキットの形の検索（Overpass API）は、その場で表示するための問い合わせで、作者は受け取らない。プライバシーポリシーに書いた。
  - アクセス計測（GoatCounter）はブラウザ版だけで、アプリには入っていない（`vite.config.ts` の PAGES_BUILD）。

## 年齢の区分

すべての質問に「なし」→ 4+（年齢制限なし）。

## 暗号化の申告

Info.plist の `ITSAppUsesNonExemptEncryption = false`（HTTPS などの標準の暗号だけ）。

## 審査の担当者への説明（App Review Information の「メモ」）

サインインは要らない。デジスパイス（Bluetooth の GPS ロガー）は審査の担当者が持っていないので、見本の走行ログと、iPhone の GPS で試す手順を書く。
見本の走行ログは、持ち主の 2026-08-15 の袖ヶ浦の走行（12 周、NMEA の位置と速度だけ。全部の点がサーキットの中心から 280 m 以内）を `public/demo/sodegaura_20260815.nmea` に置いた（持ち主が公開を了承。動画は出さない）。

```
LapLoupe analyses track-day logs from GPS loggers. No account or sign-in is needed.

How to review without a logger:
1. Download the sample log in Safari: https://oud0n.github.io/ds_universal/demo/sodegaura_20260815.nmea
   (Safari saves it to Files > Downloads.)
2. Open LapLoupe, tap "Runs" (走行) at the bottom, then "Choose files" (ファイルを選ぶ) and pick the downloaded file.
3. The run opens in "Analysis" (解析): lap times, speed graph and track map. Tap a lap to compare.
   It is a real 12-lap session at Sodegaura Forest Raceway recorded with a DigSpice logger (NMEA, position and speed only).
4. "Timer" (タイマー) is a live lap timer. Without a DigSpice logger, open the menu and choose the iPhone's GPS; laps are counted when you cross a circuit's timing line, so at your location it will only show speed.

Bluetooth is used only to connect to GPS loggers and sensors the user registers. Location is used only for the lap timer with the iPhone's GPS. All data stays on the device or in a folder the user chooses (iCloud Drive); there is no server.
The app shows the same web-based analysis as our free desktop/browser versions, bundled inside the app (works offline), plus native Bluetooth connection to GPS loggers and sensors, iCloud Drive storage and Files integration.
```

## スクリーンショット

6.9 インチ（1320 × 2868）を 3〜10 枚。iPhone 17 Pro Max の実機の画面がちょうどこの大きさ。

候補: 走行の一覧 / 解析（速度グラフとコース図）/ 2 つの周の比べ / 車載動画の比べる / ラップタイマー
