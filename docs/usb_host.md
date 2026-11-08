# USBのRustホストとElectron試験接続（PLAN-62）

2026-11-08。[通信契約](device_host.md)のUSBを実装した。Electronの開発版で明示的に選べる試験経路で、通常の配布版では有効にならない。BLEのOSホスト・Tauri・動画は今回の対象外。

## 経路

```text
LoggerTab / DigSpiceDevice
  → HostSerialTransport
  → Electron preload（文書ごとの権限）
  → mainのUsbHostBroker
  → Rust子プロセスのJSON標準入出力
  → serialport → OSのUSBシリアル
```

既存の命令・チェックサム・設定取得・ログ取得は同じDigSpiceDeviceを使う。Rustはプロトコルを再実装せず、ポートの所有とバイト列の入出力を受け持つ。

- `native-usb/`: Rustホスト。標準入力1行に要求、標準出力1行に応答/通知。起動時にversion 1のreadyを送る。
- `electron/usb-host.cjs`: 子プロセスの起動、契約/長さ/部分書込み応答の検査、要求の対応付けと終了待ち。
- `electron/usb-ipc.cjs`: 同じ窓のmainFrameと読み込み先を確認し、文書ごとのbindingを発行する。bindingはpreloadだけが保持する。
- `src/services/deviceHost/electronHost.ts`: 既存DeviceHostの契約へ変換し、試験経路を選ぶ。

## 起動

Rust/Cargoと既存のNode依存が必要。リポジトリのルートで実行する。

```sh
npm run start:usb
```

Rustの通常ビルド後、`LAPLOUPE_USB_HOST=1`を付けて従来の`npm start`を起動する。実行ファイルはmain側で`native-usb/target/debug/laploupe-usb-host`（Windowsは`.exe`）へ固定し、画面からパスや起動引数を受け取らない。通常の`npm start`は従来の経路。試験経路を選んだ後の失敗をWeb Serialへ迂回しない。

`npm run usb:build`はRustだけをビルドする。今回は配布物への同梱、署名、公証、更新経路は接続していない。

## ポートと寿命

- VID/PID `2dcf:6002`だけを列挙し、115200 baud・8N1・フロー制御なしで開く。DTR/RTSは設定を試し、未対応なら標準エラーへ診断する。
- macOSの`/dev/cu.*`と対応する`/dev/tty.*`は一つの機器として扱う。二台以上の候補がある場合は曖昧なまま選ばず、エラーにする。
- 一つのRustプロセスが一つの接続を所有する。受信/送信は一つのworkerが行い、読取りの待ちは25ms。writeは実際に受け付けた長さを返し、アダプターが残りを送る。
- closeは先に画面からの通知/要求を無効にする。Rustは終了フラグを確認し、保留writeへ取消しを返し、ポートを解放してから応答する。mainはRustのpipeも閉じた`close`イベントまで待つ。
- OSのopen等が返らない場合は、mainが500ms後に終了要求、1000ms後に強制終了し、実際のprocess終了を待つ。保留要求は取消し/通信失敗で決着し、成功へ変えない。
- 文書の切替が確定したdid-frame-navigate、renderer停止、窓の破棄、終了が確定したwill-quitで旧bindingを失効させ、所有processを終了する。次の文書の接続は旧processの終了を待つ。will-navigate/beforeunloadで画面移動・再読み込み・終了を取り消した場合は、同じ文書と接続を維持する。preloadのbinding取得はDOMContentLoaded以後とし、新文書が旧bindingを予約しない。
- close前着のsessionを再び開かない。sessionの墓標は文書あたり4096までで、それ以上は再読み込みを求めるエラーにする。要求は同時32件、バイト配列64KiB、フレーム512KiBまで。

## 再現用検査

```sh
npm run test:usb-host
npx tsc --noEmit -p .
npx vitest run
npm run build
```

`test:usb-host`は次を実行する。

1. Rust単体：部分write、受信、取消し先着、open中の取消しと保留write決着、close応答前のポート解放、候補の重複/曖昧性、要求とフレーム上限。
2. Node：本物の子プロセスを使った停止/無応答/異常終了/不正な応答、IPC送信元/文書世代/配布版無効の検査。
3. macOS等のPOSIX：OSの疑似シリアル（PTY）をPython標準ライブラリで作り、Rustのserialportを実際に通す。既存WebSerialTransportと同じ合成機器から設定・取得全バイト・送信全バイトを比較する。欠落/矛盾/チェックサム破損/疑似ケーブル断も含める。
4. 非表示のElectron試験窓：隔離した一時プロファイルで本物のpreload/IPCを通す。Web Serialを参照したら失敗する状態で設定/取得を確認し、開いたままの再読み込み後にも同じ結果を確認する。画面移動/再読み込み/終了を取り消した後、同じ接続での継続取得も確認する。USB接続ボタンは操作しない。

試験用Rustバイナリは`native-usb/target/test-host/`へ分ける。`test-port` feature付きのビルドだけが`--test-port`を受け付ける。通常ビルドはこの引数を拒否し、任意portへ接続できない。macOSのPTYは速度設定用IOSSIOSPEED ioctlに対応しないため、この試験モードだけそのioctlを省く。通常の実機経路は115200を設定する。したがってPTY合格を物理USBの通信速度やDTR/RTSの実機検証と数えない。

WindowsではRustの条件分岐をクロスコンパイル検査する。POSIX専用のPTY検査とMac上のElectron検査を、Windows実機の成功に数えない。Windowsで`test:usb-host`を実行するとRust/Node検査を行い、PTY/Electron検査の省略を明示する。

## 実機で残る確認

実物のUSBロガーの接続・電源・OS権限・115200/DTR/RTS、実ログ全バイトの照合、抜き差し・スリープ復帰、Mac/Windowsの実機確認は別に残る。記録内容が変わらない条件で旧新の設定と取得ファイルを比較する。自動試験は実USB、本体の設定変更/消去、利用者の保管場所を使用しない。

現行Electronの基準メモリ計測は今回の完了条件に含めない。USBのブラウザAPI依存を外す実行経路を確認する段階であり、Tauriへの移行可否や動画の成立を確定するものではない。

## 今回の確認結果

固定した実装/試験ソースは`170ed0301bcc4221e998b559a88ba414e455a3f1`。

- Rust単体8件、Nodeのプロセス/IPC検査17件、実Rust＋OS疑似シリアル6件、非表示Electronの一連の実証1件が成功。
- 型検査、通常のTS試験598成功・21skip、製品build、Rustfmt/Clippy、WindowsターゲットのRust検査が成功。21skipのうち7件は上記の明示的な統合試験で別途成功し、残り14件は既存のskip。
- 旧Web経路と新経路の設定・取得全バイト・送信全バイトを照合。欠落/矛盾/破損も同じ失敗。疑似ケーブル断は単独で8回連続成功。
- 実ElectronではWeb Serialを参照すると失敗する状態で取得に成功。画面移動/reload/quitの取消し後も同じ接続で取得し、実際の文書切替後は旧process終了を待って再接続した。
- Sol highの範囲別/全境界レビュー、Gemini Flash highの全実装2会話と最終差分2会話はCLEAN。いずれもソースレビューで、実機検証や試験の独立実行を意味しない。

Astra highの単発候補は、stdoutの未完フレームで改行探索の済んだ範囲を再走査しない案1件。未計測・未実装。今回は機能成立と等価性を確認し、速度やメモリ削減を達成したとは扱わない。
