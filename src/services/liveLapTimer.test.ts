import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LiveLapTimer, formatDelta, formatLapTime, type LiveFix, type LiveTimerEvent } from './liveLapTimer';
import { extractLaps } from './lapCalculator';
import { parseDigispiceRawBinary } from './rawBinaryParser';
import { parseCln, parseSci } from './pthParser';
import type { Sector } from '../types/telemetry';

// ---- 円のコース (半径 150 m) を一定の速さで回る、作った測位 ----
const C_LAT = 35.0;
const C_LON = 140.0;
const R = 150;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((C_LAT * Math.PI) / 180);

function onCircle(angle: number, r = R): { latitude: number; longitude: number } {
  return { latitude: C_LAT + (r * Math.sin(angle)) / M_PER_DEG_LAT, longitude: C_LON + (r * Math.cos(angle)) / M_PER_DEG_LON };
}

/** 角度 angle の所で、コースを横切る線 (内側 120 m から外側 180 m) */
function lineAt(angle: number, id: string): Sector {
  const a = onCircle(angle, 120);
  const b = onCircle(angle, 180);
  return { id, name: id, latA: a.latitude, lonA: a.longitude, latB: b.latitude, lonB: b.longitude };
}

const controlLine = { ...lineAt(0.3, 'cl'), name: 'Start/Finish' };
const sectors = [lineAt(0.3 + (2 * Math.PI) / 3, 's1'), lineAt(0.3 + (4 * Math.PI) / 3, 's2'), { ...lineAt(0.3, 's3'), id: 'x_finish' }];

/** 速さ (m/s) を周ごとに変えながら、20 Hz の測位を作る。少し手前から走り出す */
function circleFixes(speedsPerLap: number[], hz = 20): LiveFix[] {
  const fixes: LiveFix[] = [];
  let angle = 0;
  let tMs = 1_700_000_000_000;
  const circumference = 2 * Math.PI * R;
  for (const v of speedsPerLap) {
    const end = angle + 2 * Math.PI;
    while (angle < end) {
      fixes.push({ tMs, ...onCircle(angle), speedKmh: v * 3.6, valid: true });
      angle += ((v / hz) / circumference) * 2 * Math.PI;
      tMs += 1000 / hz;
    }
  }
  return fixes;
}

function run(timer: LiveLapTimer, fixes: LiveFix[]): LiveTimerEvent[] {
  return fixes.flatMap(f => timer.push(f));
}

describe('LiveLapTimer (円のコース)', () => {
  it('周とセクターのタイムを、測位の間で線を横切った所から出す', () => {
    const timer = new LiveLapTimer({ controlLine, sectors });
    // 1 周目の途中から走り出すので、周を数えるのは 2 周目から
    run(timer, circleFixes([20, 20, 20, 20]));
    const s = timer.getState();
    const lapSec = (2 * Math.PI * R) / 20;
    expect(s.sectorCount).toBe(3);
    expect(s.laps.length).toBe(3);
    for (const lap of s.laps) {
      expect(lap.timeSec).toBeCloseTo(lapSec, 1);
      expect(lap.sectorsSec.length).toBe(3);
      lap.sectorsSec.forEach(sec => expect(sec).toBeCloseTo(lapSec / 3, 1));
    }
  });

  it('ベストとの差: 遅い周は +、速い周は -。終えた周の差とベストを知らせる', () => {
    const timer = new LiveLapTimer({ controlLine, sectors });
    const events = run(timer, circleFixes([20, 20, 18, 22, 22]));
    const laps = events.filter(e => e.kind === 'lap');
    expect(laps.length).toBe(4);
    expect(laps[0].kind === 'lap' && laps[0].diffToBestSec).toBe(null);
    // 周は、その円の 0.3 rad の所から次の円の同じ所まで。3 周目 (18 m/s) は遅く、4 周目 (22 m/s) は速い
    const slow = laps[2];
    expect(slow.kind === 'lap' && slow.diffToBestSec! > 0).toBe(true);
    const fast = laps[3];
    expect(fast.kind === 'lap' && fast.isBest && fast.diffToBestSec! < 0).toBe(true);
    // セクターの差も出る (遅い周は +)
    const sectorEvents = events.filter(e => e.kind === 'sector' && e.diffSec !== null);
    expect(sectorEvents.length).toBeGreaterThan(0);
  });

  it('走っている間の差 (同じ距離でのベストとの差) が、遅い周で増えていく', () => {
    const timer = new LiveLapTimer({ controlLine, sectors });
    const fixes = circleFixes([20, 20, 18]);
    // 3 周目 (遅い) の真ん中まで
    const half = fixes.length - Math.round(fixes.length / 3 / 2);
    run(timer, fixes.slice(0, half));
    const d = timer.getState().deltaSec;
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(1);
  });

  it('逆向きの通過・止まりかけの通過・測位できていない点は数えない', () => {
    const timer = new LiveLapTimer({ controlLine, sectors });
    const fixes = circleFixes([20, 20]);
    // 逆向きに戻ってくる (時刻は進める)
    const last = fixes[fixes.length - 1];
    const back = fixes.slice(-200).reverse().map((f, i) => ({ ...f, tMs: last.tMs + (i + 1) * 50, speedKmh: 3 }));
    const invalid = fixes.slice(-50).map((f, i) => ({ ...f, tMs: last.tMs + 20000 + i * 50, valid: false }));
    run(timer, [...fixes, ...back, ...invalid]);
    expect(timer.getState().laps.length).toBe(1);
  });

  it('測位が 2 秒より途切れた周に印を付ける', () => {
    const timer = new LiveLapTimer({ controlLine, sectors });
    const fixes = circleFixes([20, 20, 20]);
    // 2 周目の途中で 3 秒分を抜く
    const at = Math.round(fixes.length * 0.5);
    run(timer, [...fixes.slice(0, at), ...fixes.slice(at + 60)]);
    const laps = timer.getState().laps;
    expect(laps[0].hadGap).toBe(false);
    expect(laps[1].hadGap).toBe(true);
  });
});

describe('表示の形', () => {
  it('formatLapTime / formatDelta', () => {
    expect(formatLapTime(75.123)).toBe('1:15.123');
    expect(formatLapTime(59.9996)).toBe('1:00.000');
    expect(formatLapTime(65.04, 1)).toBe('1:05.0');
    expect(formatDelta(0.234)).toBe('+0.23');
    expect(formatDelta(-1.5)).toBe('-1.50');
    expect(formatDelta(null)).toBe('');
  });
});

// ---- 袖ヶ浦の実際のログ (公開しない sample/ にあるときだけ) ----
const SAMPLE_DIRS = [path.resolve(__dirname, '../../sample'), path.resolve(__dirname, '../../../ds_universal/sample')];
const sampleRoot = SAMPLE_DIRS.find(d => fs.existsSync(path.join(d, 'Track')));
const sodeDir = sampleRoot ? path.join(sampleRoot, 'Track', '袖ケ浦_ND5RC_RE005') : '';
const sodeLogs = sodeDir && fs.existsSync(sodeDir)
  ? fs.readdirSync(sodeDir).flatMap(d => {
      const dir = path.join(sodeDir, d);
      return fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter(f => f.endsWith('.bon4')).map(f => path.join(dir, f)) : [];
    })
  : [];

describe.skipIf(sodeLogs.length === 0)('LiveLapTimer (袖ヶ浦のログを、走っているように 1 点ずつ渡す)', () => {
  const coursesDir = path.resolve(__dirname, '../../courses');
  const cl = parseCln(fs.readFileSync(path.join(coursesDir, 'sodegaura.cln'), 'utf8'), 'Start/Finish Line')!;
  const sci = parseSci(fs.readFileSync(path.join(coursesDir, 'sodegaura.sci'), 'utf8'), 'sodegaura');

  for (const file of sodeLogs) {
    it(`解析の画面と同じ周のタイムになる: ${path.basename(path.dirname(file))}`, () => {
      const buf = fs.readFileSync(file);
      const parts = parseDigispiceRawBinary(path.basename(file), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const points = parts.flatMap(p => p.points);
      const analysis = extractLaps(points, cl, sci).laps.filter(l => !l.isWholeSession && !l.isPartialLap);

      const timer = new LiveLapTimer({ controlLine: cl, sectors: sci });
      for (const p of points) {
        timer.push({ tMs: Math.round(p.time * 1000), latitude: p.latitude, longitude: p.longitude, speedKmh: p.speed, valid: true });
      }
      const live = timer.getState().laps;
      expect(live.length).toBeGreaterThan(0);
      // 解析の周 (計測線から計測線まで) と、同じタイムの周が並ぶ
      const liveTimes = live.map(l => l.timeSec);
      for (const lap of analysis) {
        const match = liveTimes.find(t => Math.abs(t - lap.lapTime) < 0.01);
        expect(match, `解析の ${lap.lapNumber} 周目 ${lap.lapTime.toFixed(3)} 秒がない (ライブ: ${liveTimes.map(t => t.toFixed(3)).join(', ')})`).toBeDefined();
      }
    });
  }
});
