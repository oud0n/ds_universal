# DashWare との機能の差（2026-10-18 時点）

PLAN-08「DashWare が持っている機能をすべて実装する」の最初の作業。DashWare の機能を、公開されている説明（利用者の解説・フォーラム・配布サイト）から拾い、今の DS Universal と比べた。DashWare のコードや部品のデータは使わない。

印: ○ あり / △ 一部 / × なし / ? 未確認

## DashWare の今の状況

- 走行データ（ロガー・スマホのアプリ・ドローンの記録など）を読み込み、動画にメーターやグラフを重ねて書き出す Windows のアプリ。
- GoPro が買い取ったあと無料で配られていたが、最後の版は 1.9.1（2017 年）で、開発は止まっている。公式サイトも閉じていて、今は他のサイトから入手するしかないとされる。
- 同じ用途で今も開発が続いているのは RaceRender（有料）。PLAN-08 では RaceRender も比べる相手にするとよい（未調査）。

## 比べた結果

| 機能 | DashWare | DS Universal | 対応する項目 |
|---|---|---|---|
| 動画にデータを重ねて書き出す | ○（動画のファイルを作る） | ○（メーター・G・ラップタイムを焼き込んだ MP4。ブラウザだけで作る） | — |
| 部品（ゲージ）の数 | ○（速度計・回転計・高度計など 100 以上） | △（速度・G・ラップタイムなど決まったもの） | PLAN-06・PLAN-08 |
| 部品を自分で作るエディタ | ○ | × | PLAN-08 |
| 部品を動画の上でドラッグして並べる | ○（部品の箱から動画の上へ） | × | PLAN-08 |
| テンプレート（部品の並びを保存して使い回す）・部品のファイルの配布 | ○ | × | PLAN-08 |
| 読み込めるデータ | ○（データプロファイルで、いろいろなロガー・アプリの CSV の列を部品の入力に割り当てる） | ○（デジスパイス・NMEA・GPX・VBO・RaceChrono・MoTeC・AiM・GoPro の動画など。列の割り当ては決まったもの） | 任意の CSV の列の割り当ては（新規） |
| 計算した値（例: 電圧と電流から電力） | ○（計算の部品） | △（G・旋回半径などアプリが決めたものだけ） | （新規） |
| データと動画の同期 | △（手で合わせる。加速の山などで目合わせ） | ○（撮影時刻・GPS の時刻で自動。ピンで手でも合わせられる） | 勝ちどころ |
| 動画の切り出し（書き出す範囲） | ○（赤い印で範囲を決める） | ○（ラップ・動画全体） | 時間を指定した範囲は（新規） |
| 書き出す動画の形式・コーデックの選択 | ?（ほかの編集ソフトで読めないと言われる） | △（MP4。使えないブラウザでは WebM） | PLAN-06 |
| 地図（走行の軌跡）を重ねる | ○ | △（解析画面のコース図はある。動画への焼き込みは未確認） | PLAN-08 |
| 動く OS | Windows | Windows・macOS・ブラウザ | 勝ちどころ |
| 開発が続いているか | ×（2017 年で止まっている） | ○ | 勝ちどころ |

## 出典

- [RaceCapture DashWare Guide（Autosport Labs）](https://wiki.autosportlabs.com/RaceCapture_DashWare_Guide)
- [ChaseCam と DashWare の紹介（PistonHeads）](https://www.pistonheads.com/news/trackdays-email/chasecam-dashware/19521)
- [DashWare（Free Download Manager）](https://en.freedownloadmanager.org/Windows-PC/DashWare.html)
- [DashWare の使い方（DJI フォーラム）](https://forum.dji.com/thread-207319-1-1.html)
- [DashWare のチュートリアル（Yuneec Pilots）](https://yuneecpilots.com/threads/dashware-tutorial-flight-data-video-overlay.14558/)
- [DashWare（AlternativeTo）](https://alternativeto.net/software/dashware/about)
- [DashWare から RaceRender への乗り換え（Mavic Pilots）](https://mavicpilots.com/threads/switched-from-dashware-to-racerender-so-worth-it.36681/post-427138)
- [Mini 3 の DashWare プロファイル（Mavic Pilots）](https://mavicpilots.com/threads/dashware-profile-for-mini-3.145324/post-1634399)
