# 開発者向けセットアップ

**日本語** | [English](development.en.md)

[README に戻る](../README.md)

## 必要要件
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
npm run dist:mac   # macOS用 (.dmg, .zip / Apple Silicon arm64)
```

## そのほかの資料

- 構成: [architecture.md](architecture.md)
- 試験・レビュー・リリースの手順: [maintenance.md](maintenance.md)
- 文書の一覧と残件: [README.md](README.md)・[../TODO.md](../TODO.md)

試験は `npx vitest run`、型は `npx tsc --noEmit -p .`。
