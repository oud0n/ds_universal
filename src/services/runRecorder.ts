/**
 * ラップタイマーで走っている間の記録 (2026-10-20)。アプリが落ちても、走った測位が消えないようにする。
 *
 * - 受け取った測位をためておき、2 秒ごと (と、周を終えたとき・アプリが裏に回ったとき) に保存する
 * - 保存先 1: ブラウザの中のデータベース (liveRunStore.ts)。どの環境でも使え、ラップタイマーの「走行の記録」に並ぶ
 * - 保存先 2 (iPhone のアプリ): 書類のフォルダの LapTimer/<サーキット名>/<走り始めの時刻>.nmea と .bon4 に、同じ測位を後ろへ足していく
 *   (「ファイル」アプリから取り出せる。前のアプリで書けないときは、保存先 1 だけ)。
 *   サーキット名のフォルダに入れるため、ファイルはコースが決まってから作る (決まらなければ COURSE_WAIT_MS で Unsorted)。フォルダの名前は英字 (courseFolder)。
 *   保管先に選んだフォルダ (iCloud Drive など) へは、LapTimerScreen がときどき写す (system.syncLapFiles)
 */

import { appendFixes, startRun, type RunMeta } from './liveRunStore';
import { UNSORTED_FOLDER } from '../utils/courseNames';
import { bon4Header, bon4Records, fixesToNmea, runFileBase } from './runFiles';
import { getWriteBon4 } from './runFormatSettings';
import type { LiveFix } from './liveLapTimer';
import { callNative, hasNative, toBase64 } from '../native/bridge';

const encoder = new TextEncoder();
/** 始めるのに失敗したとき (データベースが使えないなど)、もう一度試すまで (ミリ秒) */
const RETRY_MS = 5000;
/** 保存できずにためておく測位の上限 (20 Hz で 1 時間ほど)。超えたら古いものから捨てる */
const MAX_BUFFER = 72000;
/** コースが決まるのを待つ長さ (ミリ秒。測位の時刻で数える)。過ぎたら Unsorted のフォルダに書く */
const COURSE_WAIT_MS = 15000;
export { courseFolder, UNSORTED_FOLDER } from '../utils/courseNames';

/** このページで使ったファイルの名前 (同じ秒に新しい走行を始めても、前の走行のファイルに上書きしないように) */
const usedBases = new Set<string>();

/** 走行のファイルの場所: <サーキットのフォルダ>/<走り始めの日付 YYYYMMDD>/<走り始めの日時>。1 日の走行と動画を 1 つのフォルダにまとめる (2026-10-20) */
function uniqueBase(startedMs: number, folder: string): string {
  const stamp = runFileBase(startedMs);
  const base = `${folder}/${stamp.slice(0, 8)}/${stamp}`;
  let name = base;
  for (let i = 2; usedBases.has(name); i++) name = `${base}_${i}`;
  usedBases.add(name);
  return name;
}

/** 同じ名前のファイルがあって作れなかった (前に起動したときの走行。system.appendFile の createNew) */
const isFileExists = (e: unknown) => (e as { code?: string } | null)?.code === 'busy';

export class LiveRunRecorder {
  private run: RunMeta | null = null;
  private starting: Promise<void> | null = null;
  private buffer: LiveFix[] = [];
  private seq = 0;
  private lastFix: LiveFix | null = null;
  private chain: Promise<void> = Promise.resolve();
  private toFiles = false;
  /** この走行で .bon4 も書くか (始めたときの設定。走っている途中では変えない) */
  private bon4 = true;
  private retryAt = 0;
  /** 最初の測位を受け取った時刻 (端末の時計。測位が途切れても、コースを待つのを COURSE_WAIT_MS で止めるため) */
  private firstAddMs = 0;

  constructor(
    private readonly source: 'digspice' | 'phone' | 'racebox' | 'drogger',
    private readonly courseName: () => string,
    private readonly onError: (message: string) => void = () => {},
    /** ファイルを入れるフォルダの名前 (courseFolder。コースが決まっていなければ '') */
    private readonly folderOf: () => string = () => ''
  ) {}

  /** 測位を 1 つ足す (保存は flush でまとめて) */
  add(fix: LiveFix): void {
    if (this.buffer.length === 0 && !this.run) this.firstAddMs ||= Date.now();
    this.buffer.push(fix);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    this.tryBegin(false);
  }

  /**
   * まだなら、走行の記録を始める。ファイルをサーキット名のフォルダに入れるため、アプリではコースが決まるまで
   * (測位の時刻でも端末の時計でも、長くて COURSE_WAIT_MS) 待つ。force (閉じる・裏に回る・数え直す) なら待たない
   */
  private tryBegin(force: boolean): void {
    if (this.run || this.starting || this.buffer.length === 0 || Date.now() < this.retryAt) return;
    // 測位のできた点が来るまでは始めない (衛星をつかむ前に止めた走行の、中身のないファイルを残さないように。LATER-18)。
    // それより前のつかめていない点は捨てる
    const firstValid = this.buffer.findIndex(f => f.valid);
    if (firstValid < 0) {
      if (this.buffer.length > 200) this.buffer.splice(0, this.buffer.length - 200);
      return;
    }
    if (firstValid > 0) this.buffer.splice(0, firstValid);
    const last = this.buffer[this.buffer.length - 1];
    const waitCourse = hasNative() && !force && !this.courseName()
      && last.tMs - this.buffer[0].tMs < COURSE_WAIT_MS && Date.now() - this.firstAddMs < COURSE_WAIT_MS;
    if (waitCourse) return;
    // 始めるのに失敗したら、少しおいてもう一度 (失敗したままにしない)
    this.starting = this.begin(this.buffer[0]).catch(e => {
      this.onError(e instanceof Error ? e.message : String(e));
      this.retryAt = Date.now() + RETRY_MS;
    }).finally(() => { this.starting = null; });
  }

  /**
   * ためた測位を保存する。stats は走行の一覧に出す周の数とベスト。
   * force: コースを待っている途中でも始めて保存する (閉じる・裏に回る・数え直すとき。待っている間の測位を失わないように)
   */
  flush(stats: { lapCount: number; bestLapSec: number | null } = { lapCount: 0, bestLapSec: null }, force = false): Promise<void> {
    this.chain = this.chain.then(() => this.write(stats, force)).catch(e => this.onError(e instanceof Error ? e.message : String(e)));
    return this.chain;
  }

  /** いま書いている走行 (まだ始まっていなければ null) */
  get current(): RunMeta | null {
    return this.run;
  }

  private async begin(first: LiveFix): Promise<void> {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `run-${first.tMs}-${Math.random().toString(36).slice(2)}`;
    let fileBase: string | null = null;
    if (hasNative()) {
      const folder = this.folderOf() || UNSORTED_FOLDER;
      try {
        // 同じ名前のファイル (前に起動したときの、同じ秒に始めた走行) があれば、_2・_3 … にする (上書きしない)
        for (let tries = 0; ; tries++) {
          // 断られた名前は usedBases に入っているので、次は _2・_3 … になる
          const base = uniqueBase(first.tMs, folder);
          this.bon4 = getWriteBon4();
          try {
            // 同じ名前があるかは、.nmea と .bon4 の両方で見る (前の走行の片方だけが残っていても、それと混ぜない)
            await callNative('system.appendFile', { path: `${base}.nmea`, b64: '', truncate: true, createNew: true });
            if (this.bon4) await callNative('system.appendFile', { path: `${base}.bon4`, b64: toBase64(bon4Header(first)), truncate: true, createNew: true });
            fileBase = base;
            break;
          } catch (e) {
            if (!isFileExists(e) || tries >= 20) throw e;
          }
        }
        this.toFiles = true;
      } catch {
        // 前のアプリ (ファイルに書けない) では、データベースにだけ保存する
        this.toFiles = false;
        fileBase = null;
      }
    }
    this.run = await startRun({ id, startedMs: first.tMs, courseName: this.courseName(), source: this.source, fileBase });
  }

  private async write(stats: { lapCount: number; bestLapSec: number | null }, force: boolean): Promise<void> {
    // コースを待っている間でも、測位が途切れて COURSE_WAIT_MS たった・閉じるときは、ここで始める
    this.tryBegin(force);
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
        if (this.bon4) await callNative('system.appendFile', { path: `${run.fileBase}.bon4`, b64: toBase64(bon4Records(batch)) });
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
