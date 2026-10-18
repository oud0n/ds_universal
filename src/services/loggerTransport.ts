/**
 * ロガーとの送受信の層 (環境ごとに差し替える部分)。
 *
 * つなぐ・切る・バイト列を送る・受け取ったバイト列を渡す・切れたことを知らせる、だけを受け持つ。
 * コマンドの組み立て・応答の解析・設定や吸い出しの手順は、どの環境でも同じものを使う
 * (digspiceProtocol.ts と DigSpiceDevice)。
 *
 * 今ある実装: Web Serial (ブラウザ版・Electron 版、webSerialTransport.ts)。開発用シミュレーターも Web Serial の形で差し込む。
 * Tauri にするときは Rust 側のシリアル通信、iPhone アプリ版では BLE の実装をここに足す。
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
  /** 送る */
  write(data: Uint8Array): Promise<void>;
  /** 切る。受信の待ちを止めてから閉じる */
  close(): Promise<void>;
  isOpen(): boolean;
}
