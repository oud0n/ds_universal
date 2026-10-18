import { TelemetryPoint } from '../types/telemetry';

// 走行ラインの点を、緯度・経度のます目に分けた索引。
// 車両を追いかけて表示するウインドウは毎コマ描き直すので、点の多いログでも、画面の近くの点だけを調べて描けるようにする (BUG-14)

const CELL_DEG = 0.001; // ます目の大きさ (緯度で約 110 m)

export interface PointGrid {
  points: TelemetryPoint[];
  cells: Map<number, number[]>; // ます目 → そのます目の点の番号 (小さい順)
  // 探す範囲を広げる幅 (度)。ふつうの点の間隔 (99 パーセンタイル) にする。
  // 画面を横切る区間の両端は、画面からこの幅の中にあるので拾える
  padDeg: number;
  // それより長い区間 (測位の途切れ・飛びなど) の終わりの点の番号。少ないので、範囲に掛かるかを 1 本ずつ調べる
  // (最大の間隔で広げると、1 か所の途切れでどのコマも広い範囲を調べることになるため)
  longSegments: number[];
}

const cellKey = (iy: number, ix: number) => iy * 1_000_003 + ix;

// 同じ点の配列には同じ索引を使う (点の配列は作ったあと書き換えないので、配列が同じなら中身も同じ)
const cache = new WeakMap<TelemetryPoint[], PointGrid>();

export function getPointGrid(points: TelemetryPoint[]): PointGrid {
  const hit = cache.get(points);
  if (hit) return hit;
  const cells = new Map<number, number[]>();
  const steps = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const key = cellKey(Math.floor(p.latitude / CELL_DEG), Math.floor(p.longitude / CELL_DEG));
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
    if (i > 0) {
      const q = points[i - 1];
      steps[i] = Math.max(Math.abs(p.latitude - q.latitude), Math.abs(p.longitude - q.longitude));
    }
  }
  const sorted = Array.from(steps.subarray(1)).filter(Number.isFinite).sort((a, b) => a - b);
  const padDeg = sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) * 0.99)] : 0;
  const longSegments: number[] = [];
  for (let i = 1; i < points.length; i++) if (steps[i] > padDeg) longSegments.push(i);
  const grid = { points, cells, padDeg, longSegments };
  cache.set(points, grid);
  return grid;
}

/** 範囲 (度) の中、またはその近くにある点と、範囲に掛かる長い区間の両端の点の番号を、小さい順に返す */
export function pointsInBounds(grid: PointGrid, minLat: number, maxLat: number, minLon: number, maxLon: number): number[] {
  const { points, cells, padDeg, longSegments } = grid;
  const lat0 = minLat - padDeg;
  const lat1 = maxLat + padDeg;
  const lon0 = minLon - padDeg;
  const lon1 = maxLon + padDeg;
  const y0 = Math.floor(lat0 / CELL_DEG);
  const y1 = Math.floor(lat1 / CELL_DEG);
  const x0 = Math.floor(lon0 / CELL_DEG);
  const x1 = Math.floor(lon1 / CELL_DEG);
  const found: number[] = [];
  if ((y1 - y0 + 1) * (x1 - x0 + 1) > cells.size) {
    // 範囲が広い (縮小したとき・小さいコース) ときは、ます目を全部見るより、点を順に見て範囲の中のものを拾うほうが速い (並べ替えも要らない)
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.latitude >= lat0 && p.latitude <= lat1 && p.longitude >= lon0 && p.longitude <= lon1) found.push(i);
    }
  } else {
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const list = cells.get(cellKey(iy, ix));
        if (list) for (const i of list) found.push(i);
      }
    }
  }
  // 長い区間は、区間を囲む四角が範囲に掛かれば両端を入れる
  for (const i of longSegments) {
    const a = points[i - 1];
    const b = points[i];
    if (Math.max(a.latitude, b.latitude) < minLat || Math.min(a.latitude, b.latitude) > maxLat) continue;
    if (Math.max(a.longitude, b.longitude) < minLon || Math.min(a.longitude, b.longitude) > maxLon) continue;
    found.push(i - 1, i);
  }
  // ます目から集めたときと長い区間を足したときは順番がばらばらなので、並べて重なりを除く
  if (found.length === 0) return found;
  found.sort((a, b) => a - b);
  let n = 1;
  for (let k = 1; k < found.length; k++) if (found[k] !== found[n - 1]) found[n++] = found[k];
  found.length = n;
  return found;
}
