# DigiSpice Universal Suite (`ds_universal`)

**デジスパイスIV（DigSpice IV）USB通信・ログ吸い出し ＆ モータースポーツ・テレメトリ解析・車載動画同期スイート**

![対応OS](https://img.shields.io/badge/OS-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![検証状況](https://img.shields.io/badge/Verified-Windows%20Only-amber)
![バージョン](https://img.shields.io/badge/Version-0.6.1-red)
![デバイス](https://img.shields.io/badge/Device-DigSpice%20IV-red)
![ライセンス](https://img.shields.io/badge/License-MIT-brightgreen)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-oud0n-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/oud0n)

> [!WARNING]
> ### ⚠️ 動作確認状況について（重要）
> 本ソフトウェアは現在、**Windows 10 / 11 環境でのみ動作確認を行っています**。  
> GitHub Actions により macOS（DMG / ZIP）および Linux（AppImage / DEB）向けのバイナリも自動ビルド・リリースされていますが、実機での完全な動作検証は未完了です。  
> Mac / Linux 環境をご利用の方からの動作報告・不具合フィードバック（Issue / PR）をお待ちしております。

---

## 🏎️ 概要

**DigiSpice Universal Suite (`ds_universal`)** は、サーキット走行用GPSデータロガー「デジスパイスIV」のデータ吸い出し・設定変更から、走行軌跡・車速・Gフォースの本格テレメトリ解析、さらにはGoPro車載動画とのミリ秒精度自動同期・2カメラPinP再生・メーター焼き込みMP4エクスポートまでを1つに統合したオープンソースのデスクトップアプリケーションです。

---

## ✨ 主な機能

### 1. デジスパイスIV USB通信・ロガー設定 (`LoggerTab`)
- **Web Serial API による直接通信**: ネイティブドライバのビルド不要で、USBケーブル1本で接続可能。
- **本体ログ高速ダウンロード**: 走行データを一括ストリーミングダウンロードし、公式互換の `.bnx4` 形式で保存。
- **各種設定変更**: 測位レート（`20Hz` / `10Hz` / `5Hz`）、記録開始/停止速度（10〜35km/h）の即座書き換え。
- **本体メモリ消去**: 次回走行前のフラッシュメモリ全消去（誤消去防止ロック付き）。

### 2. 本格モータースポーツ・テレメトリ解析 (`Graph / DataTab`)
- **速度グラフ比較**: 最大4台（または4ラップ）の車速・距離を重ね合わせ比較。
- **コースマップ & 走行軌跡**: OpenStreetMap / 自作サーキット定義に対応したコースプロット。
- **Gフォース・フリクションサークル**: 加速・減速・コーナリングGの分布とフリクションサークル表示。
- **ドリフト採点・評価**: 車体スリップ角・ヨーレート解析。
- **NMEA-0183 / GPX エクスポート**: RaceChrono 等の外部アプリへ走行ログをワンクリック出力。

### 3. 車載動画（GoPro / DJI / 一般MP4）自動同期 (`VideoSyncWindow`)
- **タイムゾーン完全自動判定 & 9時間時差スキャン**: GPS座標（日本国内ならJST自動判定）と動画メタデータ（UTC/JST）から時差を自動検出・ミリ秒単位でオフセット補正。
- **GoPro 4GBチャプター分割ファイルの自動連続再生**:
  - `GX010017.MP4` $\rightarrow$ `GX020017.MP4` $\rightarrow$ `GX030017.MP4` などの分割ファイルを自動検出・直列連結。
  - チャプター境界を跨ぐシームレス自動連続再生に対応。
- **動画編集ソフト風 NLE マルチトラック・タイムラインインスペクター**:
  - セッション絶対時間に対して、GPS走行ログ（各ラップ区間）と車載動画（各チャプタークリップ）がどの時間帯にマッピングされているかを一目で可視化。
  - タイムライン上を直接クリック＆ドラッグしてスクラブ（シーク）可能。
- **速度ウィンドウとの完全双方向シーク同期**:
  - 選択中ラップ（またはセッション全体）の時間軸にシークバーが完全同期。
- **前後2カメラ / PinP（ピクチャー・イン・ピクチャー）同時同期再生**:
  - 前方車載と後方カメラ（またはペダルカメラ等）を2画面（左右 1:1）またはPinPで完全同期再生。
- **手動キーフレーム同期（Sync Pin）**:
  - 縁石のクリッピングポイントやコントロールライン通過フレームで「ピン留め同期」を押すだけでオフセットを一発固定。
- **動画テレメトリ焼き込みエクスポート（Overlay Burn-in Export）**:
  - 速度計・Gボール・ラップタイムを合成したMP4動画をブラウザ標準機能のみで直接レンダリング・書き出し。
- **フラットデザイン（Flat Design）**:
  - プロ仕様のモータースポーツ解析ツールらしい、無駄な影や丸みを抑えたクリスプな高視認性UI。

---

## 📥 ダウンロード & インストール

[GitHub Releases](https://github.com/oud0n/ds_universal/releases) より、ご利用のOSに合わせた最新のインストーラー / zip版をダウンロードしてください。

| OS | 配布形式（インストーラー版 / zip版） | 動作状況 |
| :--- | :--- | :--- |
| **Windows** | `.exe` (インストーラー) / `.zip` (ポータブル版) | **動作確認済み (推奨)** |
| **macOS** | `.dmg` (インストーラー) / `.zip` (Intel & Apple Silicon) | ビルド配布中（下記 Notice 参照） |
| **Linux** | `.deb` (インストーラー) / `.zip` (x64) | ビルド配布中（未検証） |

---

### 🍎 macOS 版ご利用時の注意事項（「壊れているため開けません」と表示される場合）

macOS で DMG を展開してアプリを起動しようとした際、**「“ds-universal”は壊れているため開けません。ゴミ箱に入れる必要があります。」** という警告ダイアログが表示される場合があります。

#### 💡 原因
本アプリはオープンソース（有志開発）であり、有償の Apple Developer Program による公証（Notarization）および正規の開発者署名を付与していません。  
macOS のセキュリティ機能（Gatekeeper）は、Web ブラウザ等からダウンロードされた未署名・未公証のバイナリに対してダウンロード検疫フラグ（`com.apple.quarantine`）を付与し、セキュリティ保護のために「破損している（BundleIntegrity 警告）」と表示して実行を強制キル（SIGKILL）する仕様になっています（**実際のファイル破損ではありません**）。

#### 🚀 解決方法（ターミナルでの解除コマンド）

1. DMG 内の `ds-universal.app` を「**アプリケーション（/Applications）**」フォルダにコピーします。
2. **ターミナル.app** を開き、以下のコマンドを実行します：

```bash
xattr -cr /Applications/ds-universal.app
```

##### 📖 コマンドの解説
* `xattr`: macOS の拡張ファイル属性（Extended Attributes）を表示・操作するシステム標準コマンドです。
* `-c` (`--clear`): ファイルに付与されているすべての拡張属性を消去します。ブラウザから保存された際に自動付与される **検疫属性（`com.apple.quarantine`）** を剥がすことで、Gatekeeper による起動ブロックを無効化します。
* `-r` (`--recursive`): アプリバンドル（.app）内の全バイナリ・ライブラリ・リソースに対して再帰的に属性削除を適用します。

---

##### ⚠️ それでも開かない場合（Ad-hoc 自己署名の適用）
macOS のセキュリティポリシー（macOS Sequoia / Sonoma 等）によっては、未署名コードの実行が厳格に遮断される場合があります。その場合はターミナルで以下の自己署名コマンドを実行してください：

```bash
codesign --force --deep --sign - /Applications/ds-universal.app
```

##### 📖 コマンドの解説
* `codesign`: macOS のコード署名（Code Signature）を作成・検証するツールです。
* `--force`: 既存の不完全な署名情報を強制的に上書きします。
* `--deep`: アプリバンドルに含まれるすべての埋め込みフレームワーク（Electron Framework / Chromium 等）に対して再帰的に署名を適用します。
* `--sign -`: 開発者証明書（Apple Developer ID）の代わりに「Ad-hoc 署名（ハイフン `-`）」を指定し、ローカル実行を許可する自己完結署名を生成します。

上記を実行後、通常通りダブルクリックするか、**Control キーを押しながらクリック（右クリック）して「開く」** を選択してください。

---

## 🛠️ 開発者向けセットアップ

### 必要要件
- Node.js 20 以降
- npm 9 以降

```bash
# リポジトリのクローン
git clone https://github.com/oud0n/ds_universal.git
cd ds_universal

# 依存パッケージのインストール
npm install

# 開発サーバー起動 (ブラウザ版)
npm run dev

# Electron デスクトップアプリとして起動
npm start

# ビルド (型チェック + Viteバンドル)
npm run build

# 各OS向けパッケージング
npm run dist:win   # Windows用 (.exe, .zip)
npm run dist:mac   # macOS用 (.dmg, .zip)
npm run dist:linux # Linux用 (.deb, .zip)
```

---

## ☕ 開発者を支援（Buy Me a Coffee）

**DigiSpice Universal Suite (`ds_universal`)** は有志による完全オープンソースプロジェクトです。  
サーキット現地での実車走行テスト・GPSログ検証、Mac / Linux 環境への対応・維持、GoPro車載動画とのミリ秒精度同期やテレメトリオーバーレイ機能の開発を継続するため、コーヒー1杯（$3〜）からの温かいご支援をいただけると大変励みになります！☕🏎️

👉 **[Buy Me a Coffee で oud0n を支援する](https://buymeacoffee.com/oud0n)**

---

## ⚖️ 商標および免責事項（Disclaimer）

- **商標について**: 「デジスパイス」および「DigSpice」は、デジスパイス株式会社の商標または登録商標です。その他の製品名、社名等は各社の商標または登録商標です。
- **非公式互換ソフトウェア**: 本ソフトウェア（`ds_universal`）は有志によって開発されている非公式（サードパーティ）の互換ツールであり、デジスパイス株式会社とは一切の関係、提携、公認はありません。
- **免責**: 本ソフトウェアの使用、または使用不能によって生じたいかなる損害・機器の不具合についても、開発者は一切の責任を負いません。各自の責任においてご利用ください。

---

## 📜 ライセンス

MIT License

