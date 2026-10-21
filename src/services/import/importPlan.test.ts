import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { planImport, splitByPlace } from './importPlan';
import { parseLogBuffer } from '../logLoader';
import type { CircuitPreset, TelemetryPoint } from '../../types/telemetry';

const tr = (ja: string) => ja;

/** 2 つのサーキット (A は北緯 35、B は北緯 36) と、その間の移動 */
const A = { id: 'a', name: 'A', centerLat: 35, centerLon: 140 } as CircuitPreset;
const B = { id: 'b', name: 'B', centerLat: 36, centerLon: 140 } as CircuitPreset;
const find = (lat: number) => (Math.abs(lat - 35) < 0.02 ? A : Math.abs(lat - 36) < 0.02 ? B : undefined);
const pt = (time: number, lat: number): TelemetryPoint => ({ time, latitude: lat, longitude: 140, speed: 50 } as TelemetryPoint);

describe('取り込みの案: 場所で分ける', () => {
  it('A → 移動 → B を 3 つに分ける', () => {
    const pts: TelemetryPoint[] = [];
    let t = 0;
    for (let i = 0; i < 600; i++) pts.push(pt(t++, 35));          // A で 10 分
    for (let i = 0; i < 600; i++) pts.push(pt(t++, 35.5));        // 移動 10 分
    for (let i = 0; i < 600; i++) pts.push(pt(t++, 36));          // B で 10 分
    const r = splitByPlace(pts, { findCircuit: lat => find(lat) });
    expect(r.map(x => x[2])).toEqual(['a', '', 'b']);
    expect(r[0][0]).toBe(0);
    expect(r[2][1]).toBe(pts.length);
  });

  it('1 分より短い場所の替わり (GPS の跳び) は分けない', () => {
    const pts: TelemetryPoint[] = [];
    let t = 0;
    for (let i = 0; i < 300; i++) pts.push(pt(t++, 35));
    for (let i = 0; i < 20; i++) pts.push(pt(t++, 35.5));         // 20 秒だけ外れる
    for (let i = 0; i < 300; i++) pts.push(pt(t++, 35));
    const r = splitByPlace(pts, { findCircuit: lat => find(lat) });
    expect(r.map(x => x[2])).toEqual(['a']);
  });
});

const LL = `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs/LapLoupe`;
const NIKKO = `${LL}/nikko/20260830/20260830095701.nmea`;
const TC = `${LL}/tsukuba2000/20261012/20261012133132.nmea`;

describe.skipIf(!existsSync(NIKKO) || !existsSync(TC))('取り込みの案: 実際のログ (日光と筑波を 1 つのファイルにしたもの)', () => {
  it('2 つのサーキットに分け、それぞれのフォルダ・日付・周の数を出す。取り込み済みは外す', async () => {
    const text = readFileSync(NIKKO, 'utf8') + readFileSync(TC, 'utf8');
    const parsed = await parseLogBuffer('both.nmea', new TextEncoder().encode(text).buffer, tr);
    const existing = new Set(['nikko/20260830/20260830095701']);
    const plan = planImport(parsed, 'both.nmea', existing);
    const main = plan.parts.filter(p => p.kind === 'laps');
    // 名前は走り始めの時刻 (ログの最初の点。記録したときの名前と 1 秒ほど違うことがある)
    expect(main.map(p => p.base.replace(/\d{2}$/, ''))).toEqual(['nikko/20260830/202608300957', 'tsukuba2000/20261012/202610121331']);
    expect(main[0].laps).toBeGreaterThan(10);
    expect(main[1].laps).toBeGreaterThan(5);
    expect(main[0].already).toBe(true);
    expect(main[0].checked).toBe(false);
    expect(main[1].checked).toBe(true);
    expect(main[1].sparkline.length).toBeGreaterThan(10);
  });
});
