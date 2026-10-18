# RaceChrono との機能の差（2026-10-18 時点）

PLAN-10「RaceChrono の機能をすべて取り込んだうえで上回る」の最初の作業。RaceChrono Pro の機能を、公開されている説明（App Store の掲載・公式サイト・フォーラム）から拾い、今の DS Universal と比べた。RaceChrono のコードやデータは使わない。

印: ○ あり / △ 一部 / × なし / ? 未確認

## 計測（走りながら使う機能）

| 機能 | RaceChrono | DS Universal | 対応する項目 |
|---|---|---|---|
| スマホで走りながらのラップ計測 | ○ | ×（記録はロガー、解析はあと） | PLAN-01・PLAN-10 |
| 予測ラップタイム・タイム差の表示（走行中） | ○ | ×（解析画面のタイム差グラフはある） | PLAN-01 |
| 外付けの GPS（RaceBox・Qstarz・VBOX Sport・Garmin GLO・Dragy など） | ○ | △（デジスパイスIV の USB だけ） | PLAN-10 |
| OBD-II（ELM327 系・OBDLink など） | ○ | × | PLAN-10 |
| CAN-bus（Android・試験的・DIY の BLE 機器） | △ | × | PLAN-10 |
| 心拍計（Bluetooth LE） | ○ | × | （新規） |
| スマホのカメラで録画 | ○ | × | PLAN-01 |
| 0-100 km/h・ドラッグの計測、音声の読み上げ、ライブタイミング | ? | × | 確認してから |

## コース

| 機能 | RaceChrono | DS Universal | 対応する項目 |
|---|---|---|---|
| コースのライブラリ | ○（2600 以上。利用者の投稿が中心） | △（国内 14・海外 26。公式のコースフォルダを読める） | PLAN-11・PLAN-13 |
| 自作のコース（周回） | ○ | ○（コース編集。保存・.cln / .sci の読み書き） | — |
| スタートとゴールが別のコース（ヒルクライム・ジムカーナなど） | ○ | × | （新規） |
| セクター・オプティマルラップ | ○ | ○（セクター・仮想ベスト） | — |
| 知らないコースでの自動の設定 | ? | △（コース図は OSM から。計測線は仮） | PLAN-12 |

## 解析

| 機能 | RaceChrono | DS Universal | 対応する項目 |
|---|---|---|---|
| 同期したグラフ・地図 | ○ | ○ | — |
| X/Y グラフ（任意の 2 つの値） | ○ | △（フリクションサークルだけ） | （新規） |
| 複数のラップ・セッションの比較 | ○ | ○（最大 4 台） | — |
| コーナー解析・ブレーキング診断・ライン偏差 | ? | ○ | 勝ちどころ |
| 公式ソフトと同じ考え方の G の計算 | — | ○ | 勝ちどころ |

## 動画

| 機能 | RaceChrono | DS Universal | 対応する項目 |
|---|---|---|---|
| アクションカメラの動画を結び付ける | ○ | ○（GoPro は GPS の時刻で自動で合わせる） | 勝ちどころ |
| 複数のカメラ・PinP | ○ | ○ | — |
| 2 本の走りの動画を並べて比べる | ○ | △ | LATER-11 |
| データを重ねた動画の書き出し（重ね方を自由に作るエディタ） | ○ | △（配置は固定） | PLAN-06・PLAN-08 |

## 読み込み・書き出し・共有

| 機能 | RaceChrono | DS Universal | 対応する項目 |
|---|---|---|---|
| 書き出し | ○（ODS・NMEA・VBO・CSV（RaceRender / DashWare 向け）） | ○（NMEA・GPX・CSV・TXT・KML・DTB・地図 HTML・MoTeC CSV） | VBO の書き出しは未対応 |
| 他社の形式の読み込み | ?（VBO など） | ○（VBO・RaceChrono CSV・GPX・NMEA・MoTeC・AiM・GoPro・デジスパイス） | 勝ちどころ |
| 他のサービスへのアップロード（Perfect Apex など。他社が対応） | ○ | × | （新規） |
| インストールなしで使える（ブラウザ） | × | ○ | 勝ちどころ |
| ロガーからの吸い出し・設定の変更 | × | ○（デジスパイスIV） | 勝ちどころ |

## 出典

- [RaceChrono Pro（App Store）](https://apps.apple.com/app/id1129429340)
- [Getting started and reference guides（RaceChrono）](https://racechrono.com/?p=1269)
- [Change log for RaceChrono Pro v8.0.7（オーバーレイのエディタ）](https://racechrono.com/?p=2025)
- [RaceChrono の機能の紹介（mergeek）](https://mergeek.com/en/latest/KvEVrAK3ywA7POx6)
- [RaceChrono Pro（BlueStacks）](https://www.bluestacks.com/apps/sports/racechrono-pro-on-pc.html)
- [RaceChrono forum: CSV V2 / RaceRender / DashWare の書き出し](https://racechrono.com/forum/discussion/comment/4656/)
- [カート向けのライブタイミングのアプリの比較](https://mokadamo.com/en/blogs/guide/die-richtige-live-timing-app)
