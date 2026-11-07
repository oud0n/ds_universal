# スマートフォン向けの共通窓口

iOS / Android のホスト本体・専用試験・ビルド設定は別の作業場で管理する。このフォルダにはホストのソースを置かない。

共有する約束は`src/native/contract.ts`、呼出しと通知は`src/native/bridge.ts`。解析と機器ごとのデータの読み方は共通TypeScriptに置く。

画面の確認は`npm run dev`で起動し、`?native=mock`を付ける。模擬窓口は`src/native/mockNative.ts`。
