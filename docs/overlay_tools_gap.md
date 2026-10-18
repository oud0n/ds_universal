# RaceRender・Telemetry Overlay との機能の差（2026-10-18 時点）

PLAN-08 の続き。DashWare（docs/dashware_gap.md）は開発が止まっているので、今も開発が続いている 2 つの動画オーバーレイのソフトと比べた。公式サイト・公式のマニュアルに書かれている機能だけを拾った。どちらのソフトのコードや部品のデザインも使わない。

メーターの形・色・装飾など見た目だけの違いは比べない。部品の配置と、こちらにない部品（表示できる値）は差として残す。

印: ○ あり / △ 一部 / × なし / ? 未確認

## 2 つのソフトの今の状況

- **RaceRender 3**（HP Tuners）: Windows・macOS。最新は 3.7.3。無料版（書き出しは 3 分まで・ロゴ入り・部品は 32 個まで）と有料版（39.95〜59.95 USD の買い切り）。TrackAddict（同じ会社のスマホのラップタイマー）と組み合わせて使う前提の作り。
- **Telemetry Overlay**（goprotelemetryextractor.com）: Windows・macOS・Linux。199 USD の買い切り（1 年分の更新つき）。GoPro・DJI・Insta360 などカメラに記録された GPS とセンサーの値が出発点で、自転車・ドローン・ダイビングなど用途が広い。データを書き出すだけの別売りソフト（Telemetry Extractor）もある。

## 比べた結果

### 読み込み・同期

| 機能 | RaceRender | Telemetry Overlay | DS Universal | 対応する項目 |
|---|---|---|---|---|
| 読み込める形式 | ○（CSV・VBO・NMEA・GPX・TCX・FIT。AiM・MoTeC・Qstarz・RaceChrono・Harry's LapTimer など） | ○（80 種類近く。AiM・MoTeC の CSV、RaceBox、RaceChrono、VBOX、Alfano、OBD-II のアプリなど） | ○（デジスパイス・NMEA・GPX・VBO・RaceChrono・MoTeC・AiM（.xrk も）・GoPro の動画） | FIT・TCX・RaceBox・Alfano は（新規） |
| カメラの中の GPS を使う | △（NMEA 入りの MP4・MOV） | ○（GoPro・DJI・Insta360・Sony など） | △（GoPro だけ） | DJI・Insta360 は（新規） |
| 自分で列を割り当てる CSV | ○ | ○（Custom CSV） | × | DashWare の項と同じ（新規） |
| データと動画の同期 | ?（トリムと同期の道具がある） | △（時刻での自動は「あてにならないことが多い」と自分で書いている。オフセットの手入力、ほかのデータに合わせる、LTC 音声タイムコード） | ○（撮影時刻・GPS の時刻で自動。ピンで手でも合わせられる） | 勝ちどころ |
| データの速さを動画に合わせる（タイムラプス） | ? | ○ | × | （新規・優先度低） |
| 複数のデータを 1 本の動画に | ? | ○（データごとに同期を設定） | △（4 台まで比べられるが、動画に焼くのは 1 台） | LATER-11 |
| 分割された GoPro の動画をつなぐ | ? | ○ | ○ | — |

### 部品（ゲージ）と配置

| 機能 | RaceRender | Telemetry Overlay | DS Universal | 対応する項目 |
|---|---|---|---|---|
| 部品の種類（表示できる値） | ○（速度・回転数・シフトライト・ギア・G・ラップ・コース図・値のグラフ） | ○（速度・高度・距離・勾配・方位・GPS の加速度・加速度センサー・ジャイロ・燃料・電圧・水温と圧力・心拍・パワー・時刻・最大／最小／平均・セクター・コーナー速度・カメラの設定（ISO・シャッター速度など）） | △（速度・G・ラップタイムだけ） | PLAN-06・PLAN-08 |
| こちらにない部品 | — | — | 回転数・ギア・シフトライト・高度・距離・勾配・方位・ジャイロ・燃料・電圧・水温・心拍・時刻・統計（最大／最小／平均）・値のグラフ・コース図・セクター | PLAN-08（ロガーにない値は、読み込んだデータにあるときだけ） |
| 任意のデータの部品 | ○（補助チャンネル） | ○（Custom・Dynamic Text） | × | PLAN-08 |
| 部品を画面の上で並べる（位置・大きさ・重ね順） | ○ | ○ | × | PLAN-08 |
| 並びを保存して使い回す（テンプレート） | ○（同梱あり） | ○（Patterns。用途別の同梱あり） | × | PLAN-08 |
| 値をなめらかにする | ? | ○（前後の平均） | ? | 確認してから |
| 表示単位（km/h・mph） | ? | ○ | △（km/h） | 英語の画面と合わせて（新規） |

### ラップ・コース

| 機能 | RaceRender | Telemetry Overlay | DS Universal | 対応する項目 |
|---|---|---|---|---|
| ラップタイムを動画に出す | ○ | ○（GPS と自分で置いたゴールの線から。ベスト・前の周との差） | ○ | — |
| セクタータイムを動画に出す | ? | ○（印は手で置く） | ×（解析画面にはある。動画に焼くのは速度・G・ラップタイムだけ） | PLAN-08 |
| コーナーごとの速度を比べる | ? | ○（コーナーに印を置いて周回ごとに比べる） | ○（コーナー解析。動画には出ない） | 勝ちどころ（解析） |
| 走行ラインの図（コース図） | ○ | ○ | △（解析画面だけ。動画には焼かない） | PLAN-08 |
| 基準の周との差（デルタ）を動画に出す | ? | △（前の周との差） | △（解析画面のタイム差グラフ） | PLAN-08（勝ちどころにできる） |
| サーキットの計測線のデータ | ×（自分で置く。TrackAddict に頼る） | ×（自分で置く） | ○（国内 13 コース。公式のコースフォルダ） | 勝ちどころ |

### 動画

| 機能 | RaceRender | Telemetry Overlay | DS Universal | 対応する項目 |
|---|---|---|---|---|
| 書き出し | ○（4K まで） | ○（MP4（H.264・H.265）） | ○（MP4。使えないブラウザでは WebM） | — |
| 部品だけの透明な動画（ほかの編集ソフトで重ねる） | ? | ○（MOV（PNG・ProRes 4444）・WebM・WebP・PNG の連番） | × | PLAN-06・PLAN-08 |
| 複数のカメラ（PinP・画面分割・切り替え） | ○ | ? | △（2 本並べて見られるが、書き出すのは 1 本） | LATER-11 |
| 360° の動画 | ○ | ○ | × | （新規・優先度低） |
| 書き出しの順番待ち（まとめて書き出す） | ? | ○ | × | （新規・優先度低） |
| 撮影時刻を動画に埋め込む | ? | ○ | × | （新規・優先度低） |

### そのほか

| 機能 | RaceRender | Telemetry Overlay | DS Universal | 対応する項目 |
|---|---|---|---|---|
| 走行の解析（グラフ・比較・ブレーキング） | ×（動画づくりが中心） | △（グラフと地図だけ。データの書き出しは別売り） | ○ | 勝ちどころ |
| ロガーからの吸い出し・設定 | ×（TrackAddict のデータを Wi-Fi で受け取る） | × | ○（デジスパイスIV） | 勝ちどころ |
| 動く OS | Windows・macOS | Windows・macOS・Linux | Windows・macOS・ブラウザ | Linux 版は（新規・優先度低） |
| 値段 | 無料版あり（3 分まで）・有料 40〜60 USD | 199 USD | 無料 | 勝ちどころ |

## まとめ

- 2 つとも「動画づくりの道具」で、解析はほとんどない。DS Universal が勝てるのは、解析・ロガーの吸い出し・国内コースの計測線・時刻での自動同期・無料・ブラウザ。
- 足りないのは、ほぼ PLAN-08 の中身（足りない部品、配置、テンプレート、任意のデータの部品、透明な動画の書き出し）と同じ。次の 3 つは対応する予定（TODO の PLAN-14〜16）。
  - 部品だけの透明な動画の書き出し（編集ソフトで重ねたい人向け。ブラウザなら WebM の透明動画が作りやすい）
  - 基準の周とのタイム差（デルタ）・セクタータイムを動画に出す（解析の結果をそのまま動画にできるのは強み）
  - 読み込める形式を増やす（FIT・TCX・RaceBox の CSV。DJI・Insta360 のカメラの GPS）

## 出典

- [RaceRender 3 の機能と値段（公式）](https://racerender.com/RR3/Features.html)
- [RaceRender が対応するロガー・アプリ（公式）](https://racerender.com/RR3/docs/Dataloggers.html)
- [RaceRender でデータを重ねる手順（公式）](https://racerender.com/RR3/docs/HowTo-Datalogger.html)
- [RaceRender（HP Tuners）](https://www.hptuners.com/product/racerender/)
- [Telemetry Overlay（公式）](https://goprotelemetryextractor.com/)
- [Telemetry Overlay のマニュアル（公式・PDF）](https://goprotelemetryextractor.com/docs/telemetry-overlay-manual.pdf)
