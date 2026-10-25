<p align="center"><img src="build/icon.svg" width="128" height="128" alt="LapLoupe のアイコン"></p>

# LapLoupe（ラップルーペ、旧名 DS Universal）— Lap / Track Analyzer

**日本語** | [English](README.en.md)

**デジスパイス（DigSpice IV）を Mac・Windows・ブラウザで使える、非公式の走行ログ解析ソフト（ラップ・サーキットの走行解析 / Lap & Track Analyzer）**

デジスパイスのログの吸い出し・本体の設定、走行ライン・車速・G の解析、GoPro などの車載動画との同期

![対応OS](https://img.shields.io/badge/OS-Windows%20x64%20%7C%20macOS%20Apple%20Silicon-blue)
![検証状況](https://img.shields.io/badge/Verified-macOS%20Only-amber)
![バージョン](https://img.shields.io/badge/Version-1.0.0-red)
![デバイス](https://img.shields.io/badge/Device-DigSpice%20IV-red)
![ライセンス](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-oud0n-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/oud0n)

> [!WARNING]
> **動作確認は macOS（Apple Silicon）だけです。** Windows（x64）版も自動でビルドして配布していますが、実機ではまだ確かめていません。Windows でお使いの方の報告（Issue / PR）をお待ちしています。
> Linux と Intel Mac（Rosetta 2 を含む）には対応しておらず、配布もしていません。

> [!NOTE]
> 2026-10-19 に「DS Universal」から **LapLoupe（ラップルーペ）** に名前を変えました。リポジトリの名前（`ds_universal`）とブラウザ版の URL は変わりません。

---

## 🏎️ 概要

**LapLoupe（旧名 DS Universal）** は、サーキット走行用の GPS データロガー「デジスパイスIV」のための、非公式の走行ログ解析ソフトです。公式の解析ソフトは Windows 専用ですが、LapLoupe は **Mac・Windows・ブラウザ** で動き、スマートフォンのブラウザでもログを見られます。

- デジスパイスを USB でつないで、ログの吸い出しと本体の設定ができます（Mac でも使えます）
- 走行ライン・車速・G・コーナーごとの速度を、ラップや車どうしで重ねて比べられます
- GoPro などの車載動画を走行ログと自動で合わせ、メーターを重ねた動画を書き出せます
- 無料で、ソースコードを公開しています。ログはお使いの端末の中で処理し、サーバーへ送りません

---

## ✨ 主な機能

| 分野 | できること |
| :--- | :--- |
| **ロガー** | デジスパイスIV との USB 通信、ログの吸い出し（`.bnx4`）、サンプリングレート（5 / 10 / 20 Hz）・記録開始速度の変更、本体のメモリの消去 |
| **走行の解析** | 最大 4 台（4 ラップ）の車速グラフの比較、コース図と走行ライン（国土地理院の航空写真を背景に）、G・フリクションサークル、コーナー解析、ブレーキング診断、走行ラインのずれのヒートマップ、X/Y グラフ |
| **走行の管理**（デスクトップ版） | 保管場所の走行を日付ごとに一覧、ログを走行・サーキットごとに分けて取り込み、ラップタイムの記録、コーナーの名前（`corners.json`） |
| **コースデータ** | 国内 101 コース・海外 26 サーキットを内蔵、知らないコースは計測線とセクター線を自動で配置、コース編集、公式ソフトのコースフォルダの読み込み |
| **車載動画** | GoPro / DJI / 一般の MP4 と走行ログの自動同期、GoPro のチャプター分割ファイルの連続再生、最大 4 台のマルチカメラ、周どうしの走行比較、メーター付きの動画・透明なメーターだけの動画の書き出し |
| **読み込める形式** | デジスパイス（.bnx4 / .bon4）、Racelogic VBO、RaceChrono CSV、GPX、NMEA、MoTeC CSV、AiM（CSV・.xrk / .xrz）、Garmin などの FIT・TCX、RaceBox、iRacing（.ibt）、GoPro の動画の GPS |
| **ログ変換** | NMEA・GPX・VBO・CSV・KML・DTB・MoTeC CSV・地図 HTML・.bon4 などに書き出し。ラップや時間で切り出し、時差の調整 |

機能の詳しい説明は **[機能の一覧](docs/features.md)** にあります。

---

## 📸 画面サンプル

**グラフ解析**: 車速グラフ、コース図（国土地理院の航空写真を背景に表示。車を追いかけて拡大し、セクターから一斉にスタートもできる）、フリクションサークル

![グラフ解析画面](docs/images/analysis.png)

**コーナー解析とラップ比較**: 2 つのラップの車速・タイム差・走行ラインのずれ、コーナーごとの進入・ボトム・脱出速度

![コーナー解析画面](docs/images/corner_analysis.png)

**ログ変換**: 読み込んだログの一部（ラップ・時間）を切り出して、NMEA / GPX / CSV / 地図 HTML などに書き出し

![ログ変換画面](docs/images/convert.png)

**ロガー設定**: ロガーを USB でつないで、サンプリングレートとログ記録開始速度の変更、ログの吸い出し

![ロガー設定画面](docs/images/logger.png)

---

## 🌐 ブラウザ版（インストール不要）

- 解析画面: <https://oud0n.github.io/ds_universal/>
- ログ変換ページ: <https://oud0n.github.io/ds_universal/#convert>

ロガーとの USB 通信は **パソコンの Chrome / Edge だけ** で動きます（Web Serial API を使うため）。Safari・Firefox・スマートフォンでは、ログの読み込み・解析・変換が使えます。
ログは端末の中で処理し、サーバーへ送りません（地図の表示などで外部と通信するものは [機能の一覧](docs/features.md#-ブラウザ版で外部と通信するもの) に書いています）。

---

## 📥 ダウンロード & インストール

[GitHub Releases](https://github.com/oud0n/ds_universal/releases) から、お使いの OS の最新版をダウンロードしてください。

| OS | ファイル | 動作状況 |
| :--- | :--- | :--- |
| **Windows**（x64） | `.exe`（インストーラー） / `.zip`（ポータブル版） | 配布中（実機での確認はまだ） |
| **macOS**（Apple Silicon `arm64`） | `.dmg`（インストーラー） / `.zip` | **動作確認済み** |

### 🍎 macOS で「壊れているため開けません」と出るとき

署名していないアプリなので、macOS がこう表示します（ファイルが壊れているわけではありません）。

1. DMG の中の `LapLoupe.app` を「アプリケーション」フォルダにコピーします。
2. ターミナル.app で、次のコマンドを実行します（ダウンロードしたときに付く印を外します）。

```bash
xattr -cr "/Applications/LapLoupe.app"
```

それでも開かないときは、次のコマンドを実行してから、Control キーを押しながらクリックして「開く」を選んでください。

```bash
codesign --force --deep --sign - "/Applications/LapLoupe.app"
```

- **Apple Silicon（M1 以降）の Mac 専用** です。Intel Mac では動きません。
- コマンドの意味と、うまくいかないときの詳しい手順は **[インストールの手順](docs/install.md)** にあります。

---

## 📚 ドキュメント

| 資料 | 内容 |
| :--- | :--- |
| [機能の一覧](docs/features.md) | 各機能の詳しい説明、コースデータ（計測線）の出どころ、実装していない機能 |
| [インストールの手順](docs/install.md) | 動作要件、macOS で開けないときの詳しい手順 |
| [リリースノート](docs/release-notes.md) | 版ごとの変更点（最新は v1.0.0） |
| [開発者向けセットアップ](docs/development.md) | ソースからの起動・ビルド・パッケージング |
| [コースデータ](courses/README.md) | 内蔵コースのファイルと、その作り方 |
| [Zenn の記事](https://zenn.dev/oud0n/articles/ace1347602c574) | このアプリを作った経緯と、デジスパイスの USB 通信の仕組み |

不具合の報告や要望は [Issue](https://github.com/oud0n/ds_universal/issues) へ。計測線の位置が違うときは [コースデータの Issue](https://github.com/oud0n/ds_universal/issues/new?template=course.yml) でお知らせください。

---

## ☕ 開発者を支援（Buy Me a Coffee）

LapLoupe は個人で作っている、無料のソフトです。走行費や Mac 版の維持、動画の機能の開発を続けるため、コーヒー 1 杯（$3〜）から支援していただけると励みになります。

👉 **[Buy Me a Coffee で oud0n を支援する](https://buymeacoffee.com/oud0n)**

---

## ⚖️ 商標および免責事項（Disclaimer）

- **商標について**: 「デジスパイス」および「DigSpice」は、デジスパイス株式会社の商標または登録商標です。その他の製品名、社名等は各社の商標または登録商標です。
- **非公式互換ソフトウェア**: 本ソフトウェア（`ds_universal`）は有志によって開発されている非公式（サードパーティ）の互換ツールであり、デジスパイス株式会社とは一切の関係、提携、公認はありません。
- **免責**: 本ソフトウェアの使用、または使用不能によって生じたいかなる損害・機器の不具合についても、開発者は一切の責任を負いません。各自の責任においてご利用ください。

---

## 📜 ライセンス

[PolyForm Noncommercial License 1.0.0](LICENSE)（Copyright 2026 oud0n）

- **非商用であれば自由に使えます**: 個人的な目的（趣味・学習・研究など、商用につながらないもの）での利用と、非営利団体・教育機関・公的な研究機関・政府機関での利用は、改変・再配布を含めて自由です。再配布するときは、`LICENSE`（またはライセンスの URL）と `Required Notice:` の行を一緒に渡してください。
- **商用利用には事前の許諾が必要です**: 業務での利用、有償の製品・サービスへの組み込み、販売などを考えている方は、[caliber.trivia66@icloud.com](mailto:caliber.trivia66@icloud.com) までご連絡ください。
- **改変版を公開・配布するときのお願い**: 出どころが分かるよう、次を守ってください。
  - 本ソフトウェア（[oud0n/ds_universal](https://github.com/oud0n/ds_universal)）をもとにしていることと、改変したことを、README など利用者の目に入る場所に書く
  - 改変版には別の名前を付け、本家の公式版・公認版と誤解されるような名前や表示を使わない
- v0.7.1 までは MIT License として公開していました。すでに入手した v0.7.1 までの版の扱いは変わりません。
