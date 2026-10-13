/**
 * ドライビング診断 (コーナー別速度・ブレーキング・走行ライン偏差)
 *
 * いずれも 1 ラップ分の GPS ログ (位置・車速・時刻) だけから算出する。
 * 複数ラップの比較は、基準ラップ上の位置に最も近い相手ラップ上の点を対応させて行う。
 */

import { Lap, TelemetryPoint } from '../types/telemetry';

const GRAVITY = 9.80665;
const DEG = Math.PI / 180;

// ---- コーナー検出のしきい値 ----
// 旋回半径がこの値以下になったらコーナー開始、次の値を超えたらコーナー終了 (ヒステリシス)
const CORNER_ENTER_RADIUS_M = 150;
const CORNER_EXIT_RADIUS_M = 300;
// 直線の蛇行や GPS のふらつきをコーナーと誤認しないための下限
const CORNER_MIN_HEADING_CHANGE_DEG = 20;
const CORNER_MIN_LENGTH_M = 12;
// 同じ向きに曲がり続ける区間でも、途中で曲率がこの割合まで緩んだら別のコーナーとして分ける (複合コーナー)
const CORNER_SPLIT_VALLEY_RATIO = 0.5;
// 曲率を求めるときの前後の距離幅
const CURVATURE_HALF_WINDOW_M = 8;

// ---- ブレーキング検出のしきい値 ----
// GPS の車速だけではブレーキ操作そのものは分からないため、アクセルオフ (エンジンブレーキ) 相当の
// 0.1〜0.15G を超える減速を「制動」として扱う
const BRAKE_START_G = -0.2;      // ここを下回ったら制動中とみなす
const BRAKE_END_G = -0.12;       // ここを上回ったら制動終了
const BRAKE_ONSET_G = -0.15;     // 踏み始めの位置を遡って探すときの基準
const BRAKE_MIN_PEAK_G = 0.3;
const BRAKE_MIN_SPEED_DROP_KMH = 8;
const BRAKE_MIN_DURATION_S = 0.4;
// これ以上の横 G が出ている制動区間を「トレイルブレーキング」とみなす
const TRAIL_LATERAL_G = 0.3;

// 比較ラップ上の対応点を探す範囲と、対応なしとみなす距離
const MATCH_SEARCH_WINDOW_M = 80;
const MATCH_MAX_DISTANCE_M = 30;

export interface GeoOrigin {
  latitude: number;
  longitude: number;
}

/** 1 ラップ分の幾何・運動量 (配列はすべて lap.points と同じ並び) */
export interface LapGeometry {
  lap: Lap;
  x: Float64Array;          // 東方向 (m)
  y: Float64Array;          // 北方向 (m)
  s: Float64Array;          // ラップ先頭からの走行距離 (m)
  t: Float64Array;          // ラップ先頭からの時間 (s)
  speed: Float64Array;      // km/h
  curvature: Float64Array;  // 1/m。右旋回が正
  longG: Float64Array;      // 前後 G。加速が正
  latG: Float64Array;       // 横 G。右旋回が正
}

export function originOf(lap: Lap): GeoOrigin {
  const p = lap.points[0];
  return { latitude: p.latitude, longitude: p.longitude };
}

function wrapAngle(rad: number): number {
  while (rad > Math.PI) rad -= 2 * Math.PI;
  while (rad < -Math.PI) rad += 2 * Math.PI;
  return rad;
}

function movingAverage(src: Float64Array, t: Float64Array, halfWindowS: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && t[hi] <= t[i] + halfWindowS) sum += src[hi++];
    while (t[lo] < t[i] - halfWindowS) sum -= src[lo++];
    out[i] = sum / (hi - lo);
  }
  return out;
}

/** ラップの位置を平面座標へ投影し、曲率・前後 G・横 G を求める */
export function buildLapGeometry(lap: Lap, origin: GeoOrigin): LapGeometry {
  const pts = lap.points;
  const n = pts.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const s = new Float64Array(n);
  const t = new Float64Array(n);
  const speed = new Float64Array(n);

  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(origin.latitude * DEG);
  for (let i = 0; i < n; i++) {
    x[i] = (pts[i].longitude - origin.longitude) * mPerDegLon;
    y[i] = (pts[i].latitude - origin.latitude) * mPerDegLat;
    t[i] = pts[i].time;
    speed[i] = pts[i].speed;
    // ログの距離欄は丸めが粗いことがあるため、座標から積算し直す
    s[i] = i === 0 ? 0 : s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  }

  // 曲率: 前後 CURVATURE_HALF_WINDOW_M 離れた 2 区間の進行方向の差 / 距離
  const curvature = new Float64Array(n);
  let back = 0;
  let fwd = 0;
  for (let i = 0; i < n; i++) {
    while (back < i && s[i] - s[back + 1] >= CURVATURE_HALF_WINDOW_M) back++;
    while (fwd < n - 1 && s[fwd] - s[i] < CURVATURE_HALF_WINDOW_M) fwd++;
    const dIn = s[i] - s[back];
    const dOut = s[fwd] - s[i];
    if (dIn < 1 || dOut < 1) continue;
    // 方位は北を 0、時計回りを正とする (右旋回で増加)
    const headingIn = Math.atan2(x[i] - x[back], y[i] - y[back]);
    const headingOut = Math.atan2(x[fwd] - x[i], y[fwd] - y[i]);
    curvature[i] = wrapAngle(headingOut - headingIn) / ((dIn + dOut) / 2);
  }

  // 前後 G: 車速の時間微分 (前後 0.25 秒の差分) を平滑化
  const rawLongG = new Float64Array(n);
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    while (a < i && t[i] - t[a + 1] >= 0.25) a++;
    while (b < n - 1 && t[b] - t[i] < 0.25) b++;
    const dt = t[b] - t[a];
    rawLongG[i] = dt > 0.05 ? (speed[b] - speed[a]) / 3.6 / dt / GRAVITY : 0;
  }
  const longG = movingAverage(rawLongG, t, 0.1);

  const latG = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = speed[i] / 3.6;
    latG[i] = (v * v * curvature[i]) / GRAVITY;
  }

  return { lap, x, y, s, t, speed, curvature, longG, latG };
}

// ============================================================================
// コーナー検出
// ============================================================================

export interface Corner {
  number: number;            // 1 始まり
  direction: 'L' | 'R';
  startIndex: number;        // ターンイン
  apexIndex: number;         // 曲率最大の点
  endIndex: number;          // コーナー出口
  startDistanceM: number;
  apexDistanceM: number;
  endDistanceM: number;
  headingChangeDeg: number;
  minRadiusM: number;
}

export interface CornerMetrics {
  entrySpeed: number;        // ターンイン時の車速 (km/h)
  bottomSpeed: number;       // コーナー内の最低車速 (km/h)
  exitSpeed: number;         // コーナー出口の車速 (km/h)
  bottomIndex: number;
  maxLatG: number;
  timeS: number;             // コーナー通過時間
}

/** 同じ向きに曲がり続ける区間 [start, end] を、曲率が大きく緩む位置で分割する */
function splitCompound(curvature: Float64Array, start: number, end: number): Array<[number, number]> {
  // 区間内で曲率が最も緩む点を探し、その両側のピークと比べて十分に緩んでいれば分割する
  let split = -1;
  let bestRatio = CORNER_SPLIT_VALLEY_RATIO;
  let peakLeft = 0;
  const peakRight = new Float64Array(end - start + 1);
  for (let k = end, m = 0; k >= start; k--) {
    m = Math.max(m, Math.abs(curvature[k]));
    peakRight[k - start] = m;
  }
  for (let k = start; k <= end; k++) {
    peakLeft = Math.max(peakLeft, Math.abs(curvature[k]));
    const ratio = Math.abs(curvature[k]) / Math.min(peakLeft, peakRight[k - start]);
    if (ratio < bestRatio) { bestRatio = ratio; split = k; }
  }
  if (split <= start || split >= end) return [[start, end]];
  return [...splitCompound(curvature, start, split), ...splitCompound(curvature, split + 1, end)];
}

/** 基準ラップからコーナーを検出する */
export function detectCorners(geo: LapGeometry): Corner[] {
  const { curvature, s } = geo;
  const n = s.length;
  const enter = 1 / CORNER_ENTER_RADIUS_M;
  const exit = 1 / CORNER_EXIT_RADIUS_M;
  const corners: Corner[] = [];

  let i = 0;
  while (i < n) {
    if (Math.abs(curvature[i]) < enter) {
      i++;
      continue;
    }
    const sign = Math.sign(curvature[i]);
    // 同じ向きに曲がり続けている範囲を前後へ広げる
    let runStart = i;
    while (runStart > 0 && curvature[runStart - 1] * sign > exit) runStart--;
    let runEnd = i;
    while (runEnd < n - 1 && curvature[runEnd + 1] * sign > exit) runEnd++;

    for (const [start, end] of splitCompound(curvature, runStart, runEnd)) {
      let apex = start;
      let headingChange = 0;
      for (let k = start; k <= end; k++) {
        if (Math.abs(curvature[k]) > Math.abs(curvature[apex])) apex = k;
        if (k > start) headingChange += ((curvature[k] + curvature[k - 1]) / 2) * (s[k] - s[k - 1]);
      }

      const lengthM = s[end] - s[start];
      if (Math.abs(headingChange) / DEG >= CORNER_MIN_HEADING_CHANGE_DEG && lengthM >= CORNER_MIN_LENGTH_M) {
        corners.push({
          number: corners.length + 1,
          direction: sign > 0 ? 'R' : 'L',
          startIndex: start,
          apexIndex: apex,
          endIndex: end,
          startDistanceM: s[start],
          apexDistanceM: s[apex],
          endDistanceM: s[end],
          headingChangeDeg: Math.abs(headingChange) / DEG,
          minRadiusM: 1 / Math.abs(curvature[apex])
        });
      }
    }
    i = runEnd + 1;
  }
  return corners;
}

function metricsForRange(geo: LapGeometry, start: number, end: number): CornerMetrics {
  let bottomIndex = start;
  let maxLatG = 0;
  for (let k = start; k <= end; k++) {
    if (geo.speed[k] < geo.speed[bottomIndex]) bottomIndex = k;
    maxLatG = Math.max(maxLatG, Math.abs(geo.latG[k]));
  }
  return {
    entrySpeed: geo.speed[start],
    bottomSpeed: geo.speed[bottomIndex],
    exitSpeed: geo.speed[end],
    bottomIndex,
    maxLatG,
    timeS: geo.t[end] - geo.t[start]
  };
}

/**
 * 基準ラップ上の点 (index) に最も近い、相手ラップ上の点を探す。
 * ラップの周回方向・スタート位置が同じである前提で、走行距離の割合が近い範囲だけを調べる。
 * 対応する点がない (離れすぎている) 場合は -1
 */
export function matchIndex(ref: LapGeometry, refIndex: number, target: LapGeometry): number {
  const n = target.s.length;
  if (n === 0) return -1;
  const refTotal = ref.s[ref.s.length - 1] || 1;
  const hint = (ref.s[refIndex] / refTotal) * target.s[n - 1];

  // 二分探索で hint 付近の添字を求め、その前後を調べる
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (target.s[mid] < hint) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestD2 = MATCH_MAX_DISTANCE_M * MATCH_MAX_DISTANCE_M;
  for (let k = lo; k >= 0 && hint - target.s[k] <= MATCH_SEARCH_WINDOW_M; k--) {
    const d2 = (target.x[k] - ref.x[refIndex]) ** 2 + (target.y[k] - ref.y[refIndex]) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = k; }
  }
  for (let k = lo + 1; k < n && target.s[k] - hint <= MATCH_SEARCH_WINDOW_M; k++) {
    const d2 = (target.x[k] - ref.x[refIndex]) ** 2 + (target.y[k] - ref.y[refIndex]) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = k; }
  }
  return best;
}

/** コーナーごとの進入・ボトム・脱出速度。相手ラップでは基準ラップと同じ位置の区間で評価する */
export function measureCorners(ref: LapGeometry, corners: Corner[], target: LapGeometry): Array<CornerMetrics | null> {
  return corners.map(c => {
    if (target === ref) return metricsForRange(ref, c.startIndex, c.endIndex);
    const start = matchIndex(ref, c.startIndex, target);
    const end = matchIndex(ref, c.endIndex, target);
    if (start < 0 || end < 0 || end <= start) return null;
    return metricsForRange(target, start, end);
  });
}

// ============================================================================
// ブレーキング診断
// ============================================================================

export interface BrakingZone {
  number: number;
  onsetIndex: number;        // 踏み始め
  peakIndex: number;         // 減速 G 最大
  endIndex: number;          // 制動終了
  onsetDistanceM: number;
  startSpeed: number;        // 踏み始めの車速 (km/h)
  endSpeed: number;          // 制動終了時の車速 (km/h)
  durationS: number;
  distanceM: number;
  peakG: number;             // 最大減速 G (正の値)
  averageG: number;
  buildUpS: number;          // 踏み始めから最大減速の 80% に達するまでの時間
  buildUpRate: number;       // 立ち上がりの速さ (G/s)
  releaseS: number;          // 最大減速の 80% を最後に下回ってから制動終了までの時間
  releaseMaxRate: number;    // リリース中の減速 G の最大変化率 (G/s)。小さいほど滑らか
  trailS: number;            // 旋回しながら制動している時間 (トレイルブレーキング)
  trailMaxLatG: number;
}

export function detectBrakingZones(geo: LapGeometry): BrakingZone[] {
  const { longG, latG, speed, s, t } = geo;
  const n = t.length;
  const zones: BrakingZone[] = [];

  let i = 0;
  while (i < n) {
    if (longG[i] > BRAKE_START_G) {
      i++;
      continue;
    }
    let onset = i;
    while (onset > 0 && longG[onset - 1] < BRAKE_ONSET_G) onset--;
    let end = i;
    while (end < n - 1 && longG[end + 1] < BRAKE_END_G) end++;

    let peak = onset;
    let sum = 0;
    for (let k = onset; k <= end; k++) {
      if (longG[k] < longG[peak]) peak = k;
      sum += longG[k];
    }
    const peakG = -longG[peak];
    const durationS = t[end] - t[onset];

    if (peakG >= BRAKE_MIN_PEAK_G && speed[onset] - speed[end] >= BRAKE_MIN_SPEED_DROP_KMH && durationS >= BRAKE_MIN_DURATION_S) {
      const level80 = -0.8 * peakG;
      let reach = onset;
      while (reach < peak && longG[reach] > level80) reach++;
      let lastAbove = end;
      while (lastAbove > peak && longG[lastAbove] > level80) lastAbove--;

      let releaseMaxRate = 0;
      for (let k = lastAbove + 1; k <= end; k++) {
        const dt = t[k] - t[k - 1];
        if (dt > 0) releaseMaxRate = Math.max(releaseMaxRate, (longG[k] - longG[k - 1]) / dt);
      }

      let trailS = 0;
      let trailMaxLatG = 0;
      for (let k = Math.max(peak, onset + 1); k <= end; k++) {
        if (Math.abs(latG[k]) >= TRAIL_LATERAL_G) {
          trailS += t[k] - t[k - 1];
          trailMaxLatG = Math.max(trailMaxLatG, Math.abs(latG[k]));
        }
      }

      const buildUpS = t[reach] - t[onset];
      zones.push({
        number: zones.length + 1,
        onsetIndex: onset,
        peakIndex: peak,
        endIndex: end,
        onsetDistanceM: s[onset],
        startSpeed: speed[onset],
        endSpeed: speed[end],
        durationS,
        distanceM: s[end] - s[onset],
        peakG,
        averageG: -sum / (end - onset + 1),
        buildUpS,
        buildUpRate: buildUpS > 0 ? (0.8 * peakG) / buildUpS : 0,
        releaseS: t[end] - t[lastAbove],
        releaseMaxRate,
        trailS,
        trailMaxLatG
      });
    }
    i = end + 1;
  }
  return zones;
}

/** 基準ラップの各制動区間に対応する、相手ラップの制動区間を位置で対応付ける */
export function matchBrakingZones(ref: LapGeometry, refZones: BrakingZone[], target: LapGeometry, targetZones: BrakingZone[]): Array<BrakingZone | null> {
  if (target === ref) return refZones;
  return refZones.map(z => {
    const idx = matchIndex(ref, z.peakIndex, target);
    if (idx < 0) return null;
    // 最大減速の位置が、相手の制動区間 (前後に少し余裕を持たせる) に入っているものを選ぶ
    let best: BrakingZone | null = null;
    let bestGap = 60;
    for (const tz of targetZones) {
      const gap = idx < tz.onsetIndex ? target.s[tz.onsetIndex] - target.s[idx]
        : idx > tz.endIndex ? target.s[idx] - target.s[tz.endIndex]
        : 0;
      if (gap < bestGap) { bestGap = gap; best = tz; }
    }
    return best;
  });
}

// ============================================================================
// 走行ライン偏差
// ============================================================================

export interface LineDelta {
  // 相手ラップの各点について、基準ラインからの左右のズレ (m)。基準の進行方向に対して右が正。対応なしは NaN
  offsetM: Float32Array;
  // その位置での基準ラインの曲率 (右旋回が正)。イン / アウトの判定に使う
  refCurvature: Float32Array;
  // 対応する基準ラップの区間 (refIndex 〜 refIndex + 1)。対応なしは -1
  refIndex: Int32Array;
  // GPS の位置ずれ補正として相手ラップから差し引いた平行移動量 (m)。補正なしは 0
  shiftEastM: number;
  shiftNorthM: number;
}

export interface GpsShift {
  eastM: number;
  northM: number;
}

/** 点 (px, py) から線分 a-b への符号付き距離。線分の進行方向に対して右が正 */
function signedDistanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; d2: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const cx = ax + u * dx;
  const cy = ay + u * dy;
  const d2 = (px - cx) ** 2 + (py - cy) ** 2;
  // 外積 dx*vy - dy*vx は左側で正になるため符号を反転する
  const cross = dx * (py - ay) - dy * (px - ax);
  return { d: cross > 0 ? -Math.sqrt(d2) : Math.sqrt(d2), d2 };
}

/**
 * 相手ラップの走行ラインが、基準ラップのラインから左右にどれだけ離れているかを求める。
 * shift を渡すと、相手ラップの位置からその量を差し引いてから比較する (GPS の位置ずれ補正)
 */
export function computeLineDelta(ref: LapGeometry, target: LapGeometry, shift: GpsShift = { eastM: 0, northM: 0 }): LineDelta {
  const n = target.s.length;
  const m = ref.s.length;
  const offsetM = new Float32Array(n).fill(NaN);
  const refCurvature = new Float32Array(n);
  const refIndex = new Int32Array(n).fill(-1);
  const result = { offsetM, refCurvature, refIndex, shiftEastM: shift.eastM, shiftNorthM: shift.northM };
  if (m < 2) return result;

  let j = 0;
  for (let i = 0; i < n; i++) {
    const px = target.x[i] - shift.eastM;
    const py = target.y[i] - shift.northM;
    // 前回の対応位置の少し手前から先を調べる (周回方向に沿って進む)
    let best = -1;
    let bestD2 = MATCH_MAX_DISTANCE_M * MATCH_MAX_DISTANCE_M;
    let bestD = 0;
    const from = Math.max(0, j - 10);
    for (let k = from; k < m - 1; k++) {
      if (ref.s[k] - ref.s[j] > MATCH_SEARCH_WINDOW_M) break;
      const r = signedDistanceToSegment(px, py, ref.x[k], ref.y[k], ref.x[k + 1], ref.y[k + 1]);
      if (r.d2 < bestD2) { bestD2 = r.d2; bestD = r.d; best = k; }
    }
    if (best < 0) {
      // 見失った場合 (ピットイン等) は全体から探し直す
      for (let k = 0; k < m - 1; k += 5) {
        const d2 = (px - ref.x[k]) ** 2 + (py - ref.y[k]) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = k; }
      }
      if (best >= 0) j = best;
      continue;
    }
    j = best;
    offsetM[i] = bestD;
    refCurvature[i] = ref.curvature[best];
    refIndex[i] = best;
  }
  return result;
}

/**
 * 2 つのラップ間の GPS の位置ずれ (平行移動) を推定する。
 *
 * GPS の誤差は数分の単位ではほぼ一定の向き・大きさのずれとして現れる。平行移動によるずれは、
 * コースを 1 周する間に「ある直線では左、反対向きの直線では右」と向きが入れ替わるのに対し、
 * ライン取りの違いは進行方向に対する左右として現れるため、周回コースであれば両者を分離できる。
 *
 * 進行方向が十分にばらけていない (直線だけ等) 場合は分離できないので null を返す
 */
export function estimateGpsShift(ref: LapGeometry, target: LapGeometry): GpsShift | null {
  let shift: GpsShift = { eastM: 0, northM: 0 };
  for (let iter = 0; iter < 4; iter++) {
    const delta = computeLineDelta(ref, target, shift);
    // 外れ値 (ピットインやコースアウト) を除くため、ズレの大きい上位 10% は使わない
    const abs: number[] = [];
    for (let i = 0; i < delta.offsetM.length; i++) if (delta.refIndex[i] >= 0) abs.push(Math.abs(delta.offsetM[i]));
    if (abs.length < 50) return null;
    abs.sort((p, q) => p - q);
    const limit = abs[Math.floor(abs.length * 0.9)];

    // ズレ o_i ≒ n_i・d (n_i: 基準ラインの右向き法線) を最小二乗で解く
    let axx = 0, axy = 0, ayy = 0, bx = 0, by = 0;
    for (let i = 0; i < delta.offsetM.length; i++) {
      const k = delta.refIndex[i];
      if (k < 0 || Math.abs(delta.offsetM[i]) > limit) continue;
      const dx = ref.x[k + 1] - ref.x[k];
      const dy = ref.y[k + 1] - ref.y[k];
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const nx = dy / len;
      const ny = -dx / len;
      axx += nx * nx; axy += nx * ny; ayy += ny * ny;
      bx += delta.offsetM[i] * nx; by += delta.offsetM[i] * ny;
    }
    const det = axx * ayy - axy * axy;
    // 法線の向きが偏っていると解が不安定になる (行列の 2 つの固有値の比で判定)
    const trace = axx + ayy;
    const minEigen = trace / 2 - Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
    if (trace <= 0 || minEigen / trace < 0.1) return null;
    const stepE = (bx * ayy - by * axy) / det;
    const stepN = (by * axx - bx * axy) / det;
    shift = { eastM: shift.eastM + stepE, northM: shift.northM + stepN };
    if (Math.hypot(stepE, stepN) < 0.01) break;
  }
  return shift;
}

/** GPS の位置ずれを推定できる場合は補正したうえで、走行ラインの偏差を求める */
export function computeCorrectedLineDelta(ref: LapGeometry, target: LapGeometry): LineDelta {
  return computeLineDelta(ref, target, estimateGpsShift(ref, target) ?? undefined);
}

/** ズレの向きを、その地点のコーナーに対するイン / アウトで表す。直線では null */
export function insideOutside(offsetM: number, refCurvature: number): 'IN' | 'OUT' | null {
  if (!Number.isFinite(offsetM) || Math.abs(refCurvature) < 1 / CORNER_EXIT_RADIUS_M || Math.abs(offsetM) < 0.05) return null;
  return Math.sign(offsetM) === Math.sign(refCurvature) ? 'IN' : 'OUT';
}

/** 距離 (km) に最も近い点の添字 */
export function indexAtDistance(points: TelemetryPoint[], distanceKm: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].distance < distanceKm) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
