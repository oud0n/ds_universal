/**
 * センサーの値を、走行と同じ名前の .csv に書き足していく (2026-10-20、PLAN-22)。
 * ファイルは <走行のファイルの名前>.<機器のファイル名用の名前>.csv (例: sodegaura/20261024100000.hr_driver.csv)。
 * 1 行目は列の名前、1 列目は UTC の時刻 (ミリ秒) で、.bon4 の時刻と合わせられる。
 * iPhone のアプリだけ (ブラウザにはファイルに書く口がない)
 */

import { callNative, hasNative, toBase64 } from '../native/bridge';

const encoder = new TextEncoder();
/** ためておく行の上限 (書けないときに、古いものから捨てる) */
const MAX_ROWS = 72000;

export class SensorCsvRecorder {
  private rows: string[] = [];
  private started = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    /** 走行のファイルの名前 (拡張子なし。例: sodegaura/20261024100000) */
    private readonly runBase: string,
    /** 機器のファイル名用の名前 (例: hr_driver) */
    private readonly deviceFile: string,
    /** 時刻の後ろの列の名前 (例: ['bpm'] や ['rpm', 'throttle_pct']) */
    private readonly columns: string[]
  ) {}

  get path(): string {
    return `${this.runBase}.${this.deviceFile}.csv`;
  }

  /** 1 行足す (値が無い列は空にする) */
  add(tMs: number, values: Record<string, number | undefined>): void {
    const cells = this.columns.map(c => {
      const v = values[c];
      return v === undefined || !Number.isFinite(v) ? '' : String(Number(v.toFixed(3)));
    });
    this.rows.push(`${Math.round(tMs)},${cells.join(',')}`);
    if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);
  }

  /** ためた行をファイルに書き足す (初めは列の名前の行を書いてから) */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.write()).catch(() => {});
    return this.chain;
  }

  private async write(): Promise<void> {
    if (!hasNative() || this.rows.length === 0) return;
    const batch = this.rows;
    this.rows = [];
    try {
      if (!this.started) {
        await callNative('system.appendFile', { path: this.path, b64: toBase64(encoder.encode(`time_utc_ms,${this.columns.join(',')}\n`)), truncate: true, createNew: true });
        this.started = true;
      }
      await callNative('system.appendFile', { path: this.path, b64: toBase64(encoder.encode(batch.join('\n') + '\n')) });
    } catch (e) {
      // 書けなかった行は戻して、次に書く
      this.rows = batch.concat(this.rows);
      throw e;
    }
  }
}
