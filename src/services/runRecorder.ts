/**
 * ラップタイマーで走っている間の記録 (2026-10-20)。アプリが落ちても、走った測位が消えないようにする。
 *
 * - 受け取った測位をためておき、2 秒ごと (と、周を終えたとき・アプリが裏に回ったとき) に保存する
 * - 保存先 1: ブラウザの中のデータベース (liveRunStore.ts)。どの環境でも使え、ラップタイマーの「走行の記録」に並ぶ
 * - 保存先 2 (iPhone のアプリ): 書類のフォルダの LapTimer/<走り始めの時刻>.nmea と .bon4 に、同じ測位を後ろへ足していく
 *   (「ファイル」アプリから取り出せる。前のアプリで書けないときは、保存先 1 だけ)
 */

import { appendFixes, startRun, type RunMeta } from './liveRunStore';
import { bon4Header, bon4Records, fixesToNmea, runFileBase } from './runFiles';
import type { LiveFix } from './liveLapTimer';
import { callNative, hasNative, toBase64 } from '../native/bridge';

const encoder = new TextEncoder();
/** 始めるのに失敗したとき (データベースが使えないなど)、もう一度試すまで (ミリ秒) */
const RETRY_MS = 5000;
/** 保存できずにためておく測位の上限 (20 Hz で 1 時間ほど)。超えたら古いものから捨てる */
const MAX_BUFFER = 72000;
/** このページで使ったファイルの名前 (同じ秒に新しい走行を始めても、前の走行のファイルに上書きしないように) */
const usedBases = new Set<string>();

function uniqueBase(startedMs: number): string {
  const base = runFileBase(startedMs);
  let name = base;
  for (let i = 2; usedBases.has(name); i++) name = `${base}_${i}`;
  usedBases.add(name);
  return name;
}

export class LiveRunRecorder {
  private run: RunMeta | null = null;
  private starting: Promise<void> | null = null;
  private buffer: LiveFix[] = [];
  private seq = 0;
  private lastFix: LiveFix | null = null;
  private chain: Promise<void> = Promise.resolve();
  private toFiles = false;
  private retryAt = 0;

  constructor(
    private readonly source: 'digspice' | 'phone',
    private readonly courseName: () => string,
    private readonly onError: (message: string) => void = () => {}
  ) {}

  /** 測位を 1 つ足す (保存は flush でまとめて) */
  add(fix: LiveFix): void {
    this.buffer.push(fix);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    if (!this.run && !this.starting && Date.now() >= this.retryAt) {
      // 始めるのに失敗したら、少しおいてもう一度 (失敗したままにしない)
      this.starting = this.begin(this.buffer[0]).catch(e => {
        this.onError(e instanceof Error ? e.message : String(e));
        this.retryAt = Date.now() + RETRY_MS;
      }).finally(() => { this.starting = null; });
    }
  }

  /** ためた測位を保存する。stats は走行の一覧に出す周の数とベスト */
  flush(stats: { lapCount: number; bestLapSec: number | null } = { lapCount: 0, bestLapSec: null }): Promise<void> {
    this.chain = this.chain.then(() => this.write(stats)).catch(e => this.onError(e instanceof Error ? e.message : String(e)));
    return this.chain;
  }

  /** いま書いている走行 (まだ始まっていなければ null) */
  get current(): RunMeta | null {
    return this.run;
  }

  private async begin(first: LiveFix): Promise<void> {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `run-${first.tMs}-${Math.random().toString(36).slice(2)}`;
    const fileBase = hasNative() ? uniqueBase(first.tMs) : null;
    this.run = await startRun({ id, startedMs: first.tMs, courseName: this.courseName(), source: this.source, fileBase });
    if (!fileBase) return;
    try {
      await callNative('system.appendFile', { path: `${fileBase}.bon4`, b64: toBase64(bon4Header(first)), truncate: true });
      await callNative('system.appendFile', { path: `${fileBase}.nmea`, b64: '', truncate: true });
      this.toFiles = true;
    } catch {
      // 前のアプリ (ファイルに書けない) では、データベースにだけ保存する
      this.toFiles = false;
      this.run = { ...this.run, fileBase: null };
    }
  }

  private async write(stats: { lapCount: number; bestLapSec: number | null }): Promise<void> {
    if (this.starting) await this.starting;
    const run = this.run;
    if (!run) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.run = await appendFixes(run, this.seq, batch, { ...stats, courseName: this.courseName() || run.courseName, fileBase: run.fileBase });
    } catch (e) {
      // 保存できなかった測位は戻して、次に保存する (捨てない)
      this.buffer = batch.concat(this.buffer);
      throw e;
    }
    if (batch.length) this.seq++;
    if (this.toFiles && run.fileBase && batch.length) {
      try {
        await callNative('system.appendFile', { path: `${run.fileBase}.nmea`, b64: toBase64(encoder.encode(fixesToNmea(batch, this.lastFix))) });
        await callNative('system.appendFile', { path: `${run.fileBase}.bon4`, b64: toBase64(bon4Records(batch)) });
      } catch (e) {
        // ファイルに書けなくなっても、データベースには残っている。途中までのファイルを渡さないよう、この走行のファイルは使わない印にする
        this.toFiles = false;
        this.run = { ...this.run!, fileBase: null };
        await appendFixes(this.run, this.seq, [], { fileBase: null }).then(r => { this.run = r; }, () => {});
        this.onError(e instanceof Error ? e.message : String(e));
      }
    }
    if (batch.length) this.lastFix = batch[batch.length - 1];
  }
}
