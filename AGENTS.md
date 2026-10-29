# エージェント向けの入口 (AGENTS.md)

LapLoupe (旧名 DS Universal) を直すエージェント (Claude・Codex・agy など) と、しばらく空けてから戻る人のための入口。

## このリポジトリ

デジスパイス (DigSpice IV) などの GPS ロガーの走行ログを解析する、非公式のソフト。1 つの Web アプリ (`src/`、React + TypeScript + Vite) を、ブラウザ版 (GitHub Pages)・デスクトップ版 (Electron、`electron/`)・iPhone / iPad のアプリ (WKWebView、`mobile/ios/`)・Android のアプリ (試験版、`mobile/android/`) として配っている。1.1.0 (2026-10-27) からは、不具合の直しが中心。

## 読む順

1. [docs/README.md](docs/README.md): 文書の一覧と状態
2. [docs/architecture.md](docs/architecture.md): 構成・主なファイル・保管場所の形
3. [docs/maintenance.md](docs/maintenance.md): 試験・レビュー・リリースの手順
4. [TODO.md](TODO.md)・[BUGS.md](BUGS.md): 今の状態と残件

## よく使う命令

```sh
npm install
npx tsc --noEmit -p .      # 型
npx vitest run             # 単体の試験
npm run dev                # ブラウザ版 (?native=mock で iPhone のアプリのふり)
npm start                  # デスクトップ版
npm run build              # dist (アプリにも入る)
```

画面の通しの試験 (e2e) とリリースは docs/maintenance.md。

## 守ること

- **公式ソフトのドリフト採点は作らない** (解析・調べるだけ。調べた記録は公開しない)。公式と同じ G・旋回半径の計算は使ってよい。
- **デジスパイスの公式のコースの座標を写さない** (場所・線の位置の手がかりにするのはよい)。内蔵のコースは独自のデータ (`courses/README.md`)。
- **秘密を公開の場所に書かない**: `../private/` (API キー・アクセス数のトークンなど) は git に入らない。中身を issue・コミット・文書に貼らない。
- **本物の保管場所 (iCloud Drive の LapLoupe/) で試さない**。写し (`cp -c -R`) で試す。
- 試験の中で、デジスパイスに USB でつなぐボタン・本体の消去を押さない。
- worktree では `git add -A` を使わない (node_modules のリンクが入る)。足すファイルを名前で指定する。
- main へのマージ・push・タグ・App Store への提出・issue への返信は、持ち主が許してから。
- iPhone 周りの直しは、App Store に出しているものとずれないよう、次の iOS の版まで `ios-next` に置く (docs/maintenance.md の 1)。
- 文言は `t('日本語', 'English')` で両方書く。コメント・文書は短くわかりやすい日本語。
- 変える前に、関係する試験 (vitest・必要なら e2e) を回す。見つけた不具合は BUGS.md に番号で足す。

## 作業の流れ (ふつう)

1. TODO.md / BUGS.md で ID を確かめる (無ければ足す)。
2. `dev` から作業のブランチ (`fix/…`) を切る。
3. 直す → 型・単体・(画面なら) e2e。
4. レビュー (docs/maintenance.md の 4。見つかったものはコードで確かめてから直す)。
5. dev にマージ。出すときは持ち主に聞いてから main・タグ。
6. TODO.md / BUGS.md / release-notes を書き換える。
