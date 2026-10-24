import { describe, expect, it } from 'vitest';
import { buildLapGeometry, detectCorners, originOf, type LapGeometry } from './drivingAnalysis';
import { applySpanCorner, carryNames, tapSpan, cornersFromDetection, mergeCorners, newCornerFile, parseCornerFile, placeCorners, serializeCornerFile, splitCorner } from './cornerNames';
import type { Lap } from '../types/telemetry';

/** 長方形に近いコース (直線 300 m と、半径 40 m の 90 度の角 4 つ。時計回り) を 10 Hz・100 km/h で 1 周 */
function rectLap(shift = 0): Lap {
  const pts: Array<{ x: number; y: number }> = [];
  const step = 2.8;
  const R = 40;
  const L = 300;
  // 直線 → 角 (右に 90 度) を 4 回
  let x = 0, y = 0, h = 0; // h: 北 0、時計回り
  for (let side = 0; side < 4; side++) {
    for (let d = 0; d < L; d += step) { pts.push({ x, y }); x += step * Math.sin(h); y += step * Math.cos(h); }
    const arc = (Math.PI / 2) * R;
    for (let d = 0; d < arc; d += step) { pts.push({ x, y }); h += step / R; x += step * Math.sin(h); y += step * Math.cos(h); }
  }
  const lat0 = 35, lon0 = 140;
  const points = pts.map((p, i) => ({
    time: i * 0.1,
    latitude: lat0 + (p.y + shift) / 111320,
    longitude: lon0 + (p.x + shift) / (111320 * Math.cos((lat0 * Math.PI) / 180)),
    speed: 100
  }));
  return { lapNumber: 1, points, lapTime: points.length * 0.1, startIndex: 0, endIndex: points.length - 1 } as unknown as Lap;
}

const geoOf = (lap: Lap): LapGeometry => buildLapGeometry(lap, originOf(lap));

describe('コーナーの名前', () => {
  it('見つけたコーナーから作り、同じ周に置くと同じ所になる。少しずれた周にも置ける', () => {
    const geo = geoOf(rectLap());
    const found = detectCorners(geo);
    expect(found.length).toBe(4);
    const named = cornersFromDetection(geo, found);
    expect(named.map(c => c.name)).toEqual(['C1', 'C2', 'C3', 'C4']);
    const placed = placeCorners(geo, named);
    for (const [k, p] of placed.entries()) {
      expect(p?.startIndex).toBe(found[k].startIndex);
      expect(p?.endIndex).toBe(found[k].endIndex);
      expect(p?.name).toBe(named[k].name);
    }
    // 5 m ずれた周
    const other = placeCorners(geoOf(rectLap(5)), named);
    expect(other.every(p => p !== null)).toBe(true);
  });

  it('遠い所 (コースの外) のコーナーは置けない', () => {
    const geo = geoOf(rectLap());
    const named = cornersFromDetection(geo, detectCorners(geo));
    const far = named.map(c => ({ ...c, entry: { lat: c.entry.lat + 0.01, lon: c.entry.lon } }));
    expect(placeCorners(geo, far).every(p => p === null)).toBe(true);
  });

  it('まとめる・分ける・名前を引き継ぐ', () => {
    const geo = geoOf(rectLap());
    const named = cornersFromDetection(geo, detectCorners(geo));
    const merged = mergeCorners(named, 0, '1-2');
    expect(merged.length).toBe(3);
    expect(merged[0].name).toBe('1-2');
    expect(merged[0].exit).toEqual(named[1].exit);
    const placed = placeCorners(geo, merged);
    expect(placed[0]!.endIndex).toBeGreaterThan(placed[0]!.startIndex);
    // 直線を含む長いコーナーは、直線の所で 2 つに分かれる
    const split = splitCorner(merged, 0, geo);
    expect(split.length).toBe(4);
    expect(split.map(c => c.name)).toEqual(['1-2a', '1-2b', 'C3', 'C4']);
    // 作り直しても、近い所の名前は残る
    const renamed = named.map((c, k) => ({ ...c, name: ['1', 'ヘアピン', 'ダンロップ', '最終'][k] }));
    expect(carryNames(named, renamed).map(c => c.name)).toEqual(['1', 'ヘアピン', 'ダンロップ', '最終']);
  });

  it('ファイルの読み書き。形の違うファイルは読まない', () => {
    const geo = geoOf(rectLap());
    const file = newCornerFile('test', cornersFromDetection(geo, detectCorners(geo)), true);
    const back = parseCornerFile(serializeCornerFile(file));
    expect(back?.corners).toEqual(file.corners);
    expect(back?.auto).toBe(true);
    expect(parseCornerFile('{"version":2,"corners":[]}')).toBeNull();
    expect(parseCornerFile('{"version":1,"corners":[{"name":"1"}]}')).toBeNull();
    expect(parseCornerFile('not json')).toBeNull();
  });
  it('なぞった範囲を 1 つのコーナーにする (中のコーナーは置き換え、前後は範囲の外に縮める)', () => {
    const geo = geoOf(rectLap());
    const named = cornersFromDetection(geo, detectCorners(geo));
    const placed = placeCorners(geo, named);
    // C2 と C3 をまたいでなぞる
    const r = applySpanCorner(named, geo, placed[1]!.startIndex, placed[2]!.endIndex);
    expect(r).not.toBeNull();
    expect(r!.list.map(c => c.name)).toEqual(['C1', 'C2-C3', 'C4']);
    expect(r!.index).toBe(1);
    expect(r!.list[1].direction).toBe('R');
    expect(placeCorners(geo, r!.list).every(p => p !== null)).toBe(true);
    // C1 の後ろ半分だけをなぞる: C1 は置き換え、名前は C1 のまま
    const p0 = placed[0]!;
    const half = applySpanCorner(named, geo, p0.apexIndex - 2, p0.endIndex);
    expect(half!.list.map(c => c.name)).toEqual(['C1', 'C2', 'C3', 'C4']);
    // 直線の途中 (中にコーナーなし) は新しい名前で、走る順に入る
    const mid = Math.round((p0.endIndex + placed[1]!.startIndex) / 2);
    const added = applySpanCorner(named, geo, mid - 10, mid + 10);
    expect(added!.list.map(c => c.name)).toEqual(['C1', 'C5', 'C2', 'C3', 'C4']);
    // 頂点のすぐ手前までなぞったとき: そのコーナーを置き換え、名前を引き継ぐ
    const edge = applySpanCorner(named, geo, p0.startIndex - 20, p0.apexIndex - 1);
    expect(edge!.list.map(c => c.name)).toEqual(['C1', 'C2', 'C3', 'C4']);
    // 短すぎる範囲は作らない
    expect(applySpanCorner(named, geo, mid, mid + 1)).toBeNull();
    // 周の始めと終わりをまたいだ (ほぼ 1 周の) 範囲は作らない
    expect(applySpanCorner(named, geo, geo.s.length - 4, 3)).toBeNull();
    // 消したあとに足しても、今ある名前と重ならない
    const gap = [named[0], named[1], { ...named[3], name: 'C4' }];
    expect(applySpanCorner(gap, geo, mid - 10, mid + 10)!.list.map(c => c.name)).toContain('C3');
  });
  it('押して足すコーナーは、前後のコーナーの頂点にかからず、どのコーナーも置けなくならない', () => {
    const geo = geoOf(rectLap());
    const named = cornersFromDetection(geo, detectCorners(geo));
    const placed = placeCorners(geo, named);
    // コーナーの中を押したときは足さない
    expect(tapSpan(named, geo, placed[1]!.apexIndex)).toBeNull();
    // C1 の出口のすぐ後ろ (40 m 以内) を押す
    const near = placed[0]!.endIndex + 3;
    const span = tapSpan(named, geo, near)!;
    expect(span.a).toBeGreaterThan(placed[0]!.apexIndex);
    const r = applySpanCorner(named, geo, span.a, span.b)!;
    expect(r.list.length).toBe(5);
    expect(placeCorners(geo, r.list).every(p => p !== null)).toBe(true);
  });
});
