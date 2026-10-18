import { TelemetryPoint } from '../types/telemetry';

// 走行ラインの点を、緯度・経度のます目に分けた索引。
// 車両を追いかけて表示するウインドウは毎コマ描き直すので、点の多いログでも、画面の近くの点だけを調べて描けるようにする (BUG-14)

const CELL_DEG = 0.001; // ます目の大きさ (緯度で約 110 m)

export interface PointGrid {
  cells: Map<number, number[]>; // ます目 → そのます目の点の番号 (小さい順)
  maxStepDeg: number;           // となり合う点の間の最大の離れ (度)。画面を横切る長い区間を落とさないよう、探す範囲をこれだけ広げる
}

const cellKey = (iy: number, ix: number) => iy * 1_000_003 + ix;

// 同じ点の配列には同じ索引を使う (配列が作り直されたら作り直す)
const cache = new WeakMap<TelemetryPoint[], PointGrid>();

export function getPointGrid(points: TelemetryPoint[]): PointGrid {
  const hit = cache.get(points);
  if (hit) return hit;
  const cells = new Map<number, number[]>();
  let maxStepDeg = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const key = cellKey(Math.floor(p.latitude / CELL_DEG), Math.floor(p.longitude / CELL_DEG));
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
    if (i > 0) {
      const q = points[i - 1];
      const step = Math.max(Math.abs(p.latitude - q.latitude), Math.abs(p.longitude - q.longitude));
      // 記録の切れ目などの極端に長い区間は、探す範囲を広げすぎないよう数えない (その区間は画面の端で切れることがある)
      if (step < 0.05 && step > maxStepDeg) maxStepDeg = step;
    }
  }
  const grid = { cells, maxStepDeg };
  cache.set(points, grid);
  return grid;
}

/** 範囲 (度) の中、またはその近くにある点の番号を、小さい順に返す */
export function pointsInBounds(grid: PointGrid, minLat: number, maxLat: number, minLon: number, maxLon: number): number[] {
  const pad = grid.maxStepDeg;
  const y0 = Math.floor((minLat - pad) / CELL_DEG);
  const y1 = Math.floor((maxLat + pad) / CELL_DEG);
  const x0 = Math.floor((minLon - pad) / CELL_DEG);
  const x1 = Math.floor((maxLon + pad) / CELL_DEG);
  // 広すぎる範囲 (縮小しきったときなど) は、ます目を全部見るより点を全部返すほうが速い
  if ((y1 - y0 + 1) * (x1 - x0 + 1) > grid.cells.size) {
    const all: number[] = [];
    for (const list of grid.cells.values()) for (const i of list) all.push(i);
    return all.sort((a, b) => a - b);
  }
  const found: number[] = [];
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const list = grid.cells.get(cellKey(iy, ix));
      if (list) for (const i of list) found.push(i);
    }
  }
  return found.sort((a, b) => a - b);
}
