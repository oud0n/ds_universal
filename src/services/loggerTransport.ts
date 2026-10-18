/**
 * ロガーとの送受信の層 (環境ごとに差し替える部分)。
 *
 * つなぐ・切る・バイト列を送る・受け取ったバイト列を渡す・切れたことを知らせる、だけを受け持つ。
 * コマンドの組み立て・応答の解析・設定や吸い出しの手順は、どの環境でも同じものを使う
 * (digspiceProtocol.ts と DigSpiceDevice)。
 *
 * 今ある実装: Web Serial (ブラウザ版・Electron 版、webSerialTransport.ts)。開発用シミュレーターも Web Serial の形で差し込む。
 * Tauri にするときは Rust 側のシリアル通信の実装をここに足す。
 * iPhone アプリ版の BLE は、位置などを標準の Location and Navigation Service の通知 (バイナリ) で送る別の仕組みで、
 * NMEA のコマンドが通る経路は分かっていない。コマンドの経路が見つかったときだけ、ここに BLE の実装を足せる
 *
 * 実装するときの決まり:
 * - onData・onInterrupted・onLost は、open() を呼んだ後ならいつ呼んでもよい (open() の完了前でもよい)
 * - 相手側の都合で切れたら、自分の後片付け (閉じるなど) を待たずに、先に onLost で知らせる。close() で切ったときは知らせない
 * - write() は、渡されたバイト列を全部送るまで終わらない。BLE などで小分け・間隔が要るなら、それは送受信の層の役目
 * - onData の中で例外が起きたら、読み込みのエラーとして扱ってよい
 * - 利用者に見せるエラーの文言は tr() で日本語と英語の両方を用意する
 */
export interface TransportHandlers {
  /** 受け取ったバイト列 (行の区切りとは無関係に、届いた分ずつ) */
  onData: (chunk: Uint8Array) => void;
  /** 受信が途中で途切れた (読み込みのエラー) とき。組み立て途中の行を捨てるのに使う */
  onInterrupted?: () => void;
  /** 相手側の都合 (ケーブル抜けなど) で切れたとき。close() で切ったときは呼ばない */
  onLost: (err: Error) => void;
  /** 送受信の層のログ (接続中・オープンしたなど) */
  onLog?: (type: 'sys' | 'err', msg: string) => void;
}

export interface LoggerTransport {
  /** つなぐ。失敗したら例外 (利用者に見せるメッセージ) */
  open(handlers: TransportHandlers): Promise<void>;
  /** 送る (全部送るまで終わらない) */
  write(data: Uint8Array): Promise<void>;
  /** 切る。受信の待ちを止めてから閉じる */
  close(): Promise<void>;
  /** 送れる状態か */
  isOpen(): boolean;
}
