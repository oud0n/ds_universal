# ダウンロードとインストール

**日本語** | [English](install.en.md)

[README に戻る](../README.md)

[GitHub Releases](https://github.com/oud0n/ds_universal/releases) より、ご利用のOSに合わせた最新のインストーラー / zip版をダウンロードしてください。

| OS | 配布形式（インストーラー版 / zip版） | 動作状況 |
| :--- | :--- | :--- |
| **Windows** | `.exe` (インストーラー) / `.zip` (ポータブル版) | ビルド配布中（実機での動作確認は未完了。[README の注意](../README.md)を参照） |
| **macOS** | `.dmg` (インストーラー) / `.zip`（Apple Silicon `arm64` 専用） | **動作確認済み** |

---

## 🍎 macOS 版の動作要件

- **Apple Silicon（M1 以降）搭載 Mac 専用**です。`arm64` ネイティブバイナリのみを配布しており、Rosetta 2 は使用しません。
- **Intel Mac では動作しません**（`x64` 版は配布していません）。
- ネイティブ動作の確認: アクティビティモニタの「種類」列が **Apple** と表示されます（Rosetta 経由の場合は Intel）。

## 🍎 macOS 版ご利用時の注意事項（「壊れているため開けません」と表示される場合）

macOS で DMG を展開してアプリを起動しようとした際、**「“LapLoupe”は壊れているため開けません。ゴミ箱に入れる必要があります。」** という警告ダイアログが表示される場合があります。

### 💡 原因

**v1.0.2 以降の Mac 版は、Apple の公証 (Notarization) を受けた Developer ID の署名付きなので、この警告は出ません。** 以下は、それより前の版で出たときの説明です。

本アプリは有志による個人開発であり、有償の Apple Developer Program による公証（Notarization）および正規の開発者署名を付与していません。  
macOS のセキュリティ機能（Gatekeeper）は、Web ブラウザ等からダウンロードされた未署名・未公証のバイナリに対してダウンロード検疫フラグ（`com.apple.quarantine`）を付与し、セキュリティ保護のために「破損している（BundleIntegrity 警告）」と表示して実行を強制キル（SIGKILL）する仕様になっています（**実際のファイル破損ではありません**）。

### 🚀 解決方法（ターミナルでの解除コマンド）

1. DMG 内の `LapLoupe.app` を「**アプリケーション（/Applications）**」フォルダにコピーします。
2. **ターミナル.app** を開き、以下のコマンドを実行します：

```bash
xattr -cr "/Applications/LapLoupe.app"
```

#### 📖 コマンドの解説
* `xattr`: macOS の拡張ファイル属性（Extended Attributes）を表示・操作するシステム標準コマンドです。
* `-c` (`--clear`): ファイルに付与されているすべての拡張属性を消去します。ブラウザから保存された際に自動付与される **検疫属性（`com.apple.quarantine`）** を剥がすことで、Gatekeeper による起動ブロックを無効化します。
* `-r` (`--recursive`): アプリバンドル（.app）内の全バイナリ・ライブラリ・リソースに対して再帰的に属性削除を適用します。

---

#### ⚠️ それでも開かない場合（Ad-hoc 自己署名の適用）
macOS のセキュリティポリシー（macOS Sequoia / Sonoma 等）によっては、未署名コードの実行が厳格に遮断される場合があります。その場合はターミナルで以下の自己署名コマンドを実行してください：

```bash
codesign --force --deep --sign - "/Applications/LapLoupe.app"
```

#### 📖 コマンドの解説
* `codesign`: macOS のコード署名（Code Signature）を作成・検証するツールです。
* `--force`: 既存の不完全な署名情報を強制的に上書きします。
* `--deep`: アプリバンドルに含まれるすべての埋め込みフレームワーク（Electron Framework / Chromium 等）に対して再帰的に署名を適用します。
* `--sign -`: 開発者証明書（Apple Developer ID）の代わりに「Ad-hoc 署名（ハイフン `-`）」を指定し、ローカル実行を許可する自己完結署名を生成します。

上記を実行後、通常通りダブルクリックするか、**Control キーを押しながらクリック（右クリック）して「開く」** を選択してください。
