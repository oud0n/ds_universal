import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('../../native/bridge', () => ({ hasNative: () => false, callNative: async () => ({}), onNative: () => () => {}, toBase64: () => '' }));
vi.mock('../liveRunStore', () => ({
  startRun: async (meta: Record<string, unknown>) => ({ ...meta, updatedMs: 0, fixCount: 0, lapCount: 0, bestLapSec: null }),
  appendFixes: async (run: Record<string, unknown>) => run
}));

const { TimerRuntime } = await import('./timerRuntime');
const { parseNmea } = await import('../nmeaParser');
const { CIRCUIT_PRESETS } = await import('../circuitDatabase');

const PAIR = `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs/LapLoupe/sodegaura/20260913/20260913092357.nmea`;

function fixesFrom(path: string) {
  const { points } = parseNmea(readFileSync(path, 'utf8'), 'x.nmea');
  const t0 = Date.parse(points[0].timestamp!);
  return points.map(p => ({ tMs: t0 + (p.time - points[0].time) * 1000, latitude: p.latitude, longitude: p.longitude, speedKmh: p.speed, valid: true }));
}

const make = (source: 'replay' | 'digspice') =>
  new TimerRuntime({ replayLogs: () => [], phoneMessages: () => ({ unavailable: '', denied: '' }) }, source);

describe.skipIf(!existsSync(PAIR))('ラップタイマーの中身 (実際の袖ヶ浦の走行で)', () => {
  const fixes = existsSync(PAIR) ? fixesFrom(PAIR) : [];
  const sode = CIRCUIT_PRESETS.find(c => c.id === 'sodegaura')!;

  it('測っていない間は、コースを選んでも周を数えない', () => {
    const rt = make('digspice');
    rt.chooseCourse(sode);
    fixes.forEach(f => rt.handleFix(f));
    rt.refresh();
    expect(rt.getSnapshot().lap?.laps.length ?? 0).toBe(0);
    expect(rt.getSnapshot().lastPos).not.toBeNull();
  });

  it('ログの再生は、測定開始を押さなくても数える (試すため)', () => {
    const rt = make('replay');
    rt.chooseCourse(sode);
    fixes.forEach(f => rt.handleFix(f));
    rt.refresh();
    expect(rt.getSnapshot().lap!.laps.length).toBeGreaterThan(5);
  });

  it('測定開始で数え始め、周をはじめから数えると 0 に戻る。数え直すたびに epoch が進む', () => {
    const rt = make('digspice');
    rt.chooseCourse(sode);
    const e0 = rt.getSnapshot().epoch;
    rt.startMeasuring();
    expect(rt.getSnapshot().measuring).toBe(true);
    fixes.forEach(f => rt.handleFix(f));
    rt.refresh();
    expect(rt.getSnapshot().lap!.laps.length).toBeGreaterThan(5);
    rt.resetRun();
    expect(rt.getSnapshot().lap?.laps.length ?? 0).toBe(0);
    expect(rt.getSnapshot().epoch).toBe(e0 + 2);
  });

  it('手でコースを選んだら、自動では選び直さない', () => {
    const rt = make('replay');
    const other = CIRCUIT_PRESETS.find(c => c.controlLine && c.id !== 'sodegaura')!;
    rt.chooseCourse(other, { manual: true });
    fixes.slice(0, 2000).forEach(f => rt.handleFix(f));
    expect(rt.getSnapshot().course?.id).toBe(other.id);
  });
});
