import { TelemetryPoint } from '../types/telemetry';

const GRAVITY = 9.80665; // m/s^2

/** 角度差を -180〜+180 度に収める。有限でない値は 0 として扱う (壊れた入力で処理が止まらないように) */
function wrapDegrees(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * 2点間の緯度経度から距離(メートル)と方位角(度)を計算する (Hubeny / Haversine)
 */
export function calculateGeoDistanceAndHeading(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): { distanceMeters: number; headingDeg: number } {
  const R = 6378137; // 地球半径 (m)
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const radLat1 = (lat1 * Math.PI) / 180;
  const radLat2 = (lat2 * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceMeters = R * c;

  const y = Math.sin(dLon) * Math.cos(radLat2);
  const x =
    Math.cos(radLat1) * Math.sin(radLat2) -
    Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(dLon);
  let headingDeg = (Math.atan2(y, x) * 180) / Math.PI;
  if (headingDeg < 0) headingDeg += 360;

  return { distanceMeters, headingDeg };
}

/**
 * テレメトリデータ全体の物理パラメータ（加減速G、コーナリングG、合算G、旋回半径、ドリフト角度）を算出・補正
 */
export function calculatePhysics(points: TelemetryPoint[]): TelemetryPoint[] {
  if (points.length === 0) return [];

  const n = points.length;
  const result: TelemetryPoint[] = points.map((p, i) => ({
    ...p,
    index: i,
    accelG: 0,
    corneringG: 0,
    combinedG: 0,
    turningRadius: 9999,
    driftAngle: 0
  }));

  // 累積距離と進行方向（方位角）の検証・補正 (ds4_convert 準拠)
  // 先頭の点に距離が入っているログでは、そこから積算する (途中で距離欄が 0 に戻っても逆行させない)
  let currentDistKm = result[0].distance > 0 ? result[0].distance : 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const prev = result[i - 1];
      const cur = result[i];
      const { distanceMeters, headingDeg } = calculateGeoDistanceAndHeading(
        prev.latitude,
        prev.longitude,
        cur.latitude,
        cur.longitude
      );

      // 距離が未設定または不整合な場合は計算値を使用
      if (cur.distance === 0 || cur.distance < prev.distance) {
        currentDistKm += distanceMeters / 1000;
        cur.distance = Number(currentDistKm.toFixed(4));
      } else {
        currentDistKm = cur.distance;
      }

      // 進行方向 (Heading) の演算:
      // 5cm以上移動かつ車速2km/h以上の場合は、GPS実移動ベクトルからベアリングを計算・補正
      if (distanceMeters > 0.05 && cur.speed > 2.0) {
        if (!cur.heading || cur.heading === 0) {
          cur.heading = headingDeg;
        } else {
          // GPS方位角と実移動ベクトルの偏差を緩やかにブレンド
          let diff = headingDeg - cur.heading;
          diff = wrapDegrees(diff);
          cur.heading = Number(((cur.heading + diff * 0.4 + 360) % 360).toFixed(1));
        }
      } else {
        // 停止時または微小移動時は直前の向きをキープ
        cur.heading = prev.heading;
      }
    } else if (n > 1) {
      // 始点のヘディングが0の場合、次点から推定
      const next = result[1];
      const { distanceMeters, headingDeg } = calculateGeoDistanceAndHeading(
        result[0].latitude,
        result[0].longitude,
        next.latitude,
        next.longitude
      );
      if (distanceMeters > 0.05 && (!result[0].heading || result[0].heading === 0)) {
        result[0].heading = headingDeg;
      }
    }
  }

  // ヘディングの循環スムージング (360度ループを考慮したローパス平滑化)
  for (let i = 1; i < n - 1; i++) {
    if (result[i].speed > 5.0) {
      let diffPrev = result[i - 1].heading - result[i].heading;
      diffPrev = wrapDegrees(diffPrev);

      let diffNext = result[i + 1].heading - result[i].heading;
      diffNext = wrapDegrees(diffNext);

      // 前後との平均補正
      const smoothed = result[i].heading + (diffPrev + diffNext) * 0.25;
      result[i].heading = Number(((smoothed + 360) % 360).toFixed(1));
    }
  }

  applyGFilter(result);

  return result;
}

/**
 * G のならし方。standard が推奨 (記録レートに応じて旋回半径をならす)。
 * weak は旋回半径をならさず、最後の前後 1 点の平均だけ。strong は standard に加えて前後 0.25 秒の平均をとる
 */
export type GFilterLevel = 'weak' | 'standard' | 'strong';

// 旋回半径の上限 (m)。直線 (3 点が一直線) もこの値にする
const MAX_RADIUS_M = 9999.9;
// strong で G を平均する範囲 (前後、秒)
const STRONG_HALF_WINDOW_SEC = 0.25;
// 円・車速の差に使う隣の点の最小の間隔。記録レートが高いログや、同じ位置・ほぼ同じ時刻の点が続くログでは、
// すぐ隣の点では間隔が小さすぎて座標の丸め・GPS の揺れに埋もれるので、これ以上離れた点まで広げる
const MIN_SPAN_SEC = 0.045;
const MIN_SPAN_M = 0.3;
// これより遅いとき (停止・ピットでの徐行) は旋回半径を求めない (位置の揺れで小さな円ができるため)
const MIN_SPEED_KMH = 7.2;

/** 5 個の中央値。中央の値が他の 4 個より小さい (急な頂点) ときはそのまま残す (keepSharpMin) */
function median5(v: number[], keepSharpMin: boolean): number {
  if (keepSharpMin && v[2] < v[0] && v[2] < v[1] && v[2] < v[3] && v[2] < v[4]) return v[2];
  return [...v].sort((a, b) => a - b)[2];
}

/**
 * 加減速 G・コーナリング G・合算 G・旋回半径を求めて、点に書き込む (位置・車速・時刻だけを使う)。
 * - 旋回半径: 隣り合う 3 点を通る円の半径。記録レートが高いほど点が細かく GPS の揺れの影響が大きいので、
 *   中央値で飛びを除いてから平均してならす (10Hz 以上: 5 点の中央値 → 5 点の重み付き平均、
 *   5〜10Hz: 5 点の中央値 (急な頂点は残す) → 3 点の平均、5Hz 以下: ならさない)
 * - コーナリング G = 車速² ÷ 旋回半径 ÷ 重力加速度。右旋回を正
 * - 加減速 G = 1 つ前の点との車速の差 ÷ 時間の差 ÷ 重力加速度
 * - 最後に、旋回半径・コーナリング G・加減速 G を前後 1 点と平均する (5Hz 以下ではしない)
 * - 合算 G = √(加減速 G² + コーナリング G²)
 */
export function applyGFilter(points: TelemetryPoint[], level: GFilterLevel = getGFilterLevel()): TelemetryPoint[] {
  const n = points.length;
  for (const p of points) {
    p.accelG = 0;
    p.corneringG = 0;
    p.combinedG = 0;
    p.turningRadius = 9999;
    p.driftAngle = 0;
  }
  if (n < 3) return points;

  // 平面の座標 (m)。サーキットの広さなら、先頭の点を基準にした簡単な換算で足りる
  const lat0 = points[0].latitude;
  const cosLat0 = Math.cos((lat0 * Math.PI) / 180);
  const M_PER_DEG = 111320;
  const xs = points.map(p => (p.longitude - points[0].longitude) * cosLat0 * M_PER_DEG);
  const ys = points.map(p => (p.latitude - lat0) * M_PER_DEG);

  // i から前 (dir = -1) / 後 (dir = +1) へ、時間と距離の両方で十分に離れた点を探す (なければ端の点)
  const farEnough = (i: number, dir: -1 | 1) => {
    let j = i + dir;
    while (j > 0 && j < n - 1 && (Math.abs(points[j].time - points[i].time) < MIN_SPAN_SEC || Math.hypot(xs[j] - xs[i], ys[j] - ys[i]) < MIN_SPAN_M)) j += dir;
    return Math.max(0, Math.min(n - 1, j));
  };

  // 生の旋回半径と曲がる向き (右旋回 +1 / 左旋回 -1)
  const rawR = new Array<number>(n).fill(MAX_RADIUS_M);
  const side = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (points[i].speed < MIN_SPEED_KMH) continue;
    const p = farEnough(i, -1), q = farEnough(i, 1);
    if (p === i || q === i) continue;
    const ax = xs[i] - xs[p], ay = ys[i] - ys[p];
    const bx = xs[q] - xs[i], by = ys[q] - ys[i];
    const cx = xs[q] - xs[p], cy = ys[q] - ys[p];
    const cross = ax * by - ay * bx; // 正なら左 (反時計回り) に曲がっている
    const a = Math.hypot(ax, ay), b = Math.hypot(bx, by), c = Math.hypot(cx, cy);
    if (Math.abs(cross) > 1e-9 && a > 0 && b > 0) {
      rawR[i] = Math.min(MAX_RADIUS_M, (a * b * c) / (2 * Math.abs(cross)));
      side[i] = cross > 0 ? -1 : 1;
    }
  }
  // 端の点は円が作れないので、隣の点と同じにする (ログが曲がっている途中で始まっても 0 G にならないように)
  rawR[0] = rawR[1]; side[0] = side[1];
  rawR[n - 1] = rawR[n - 2]; side[n - 1] = side[n - 2];

  // 記録の間隔。隣り合う点の時刻の差の中央値 (間隔が極端に短い点が 1 組あっても、ログ全体の扱いが変わらないように)
  const dts: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = points[i].time - points[i - 1].time;
    if (dt > 1e-6) dts.push(dt);
  }
  dts.sort((a, b) => a - b);
  const dtTypical = dts.length > 0 ? dts[Math.floor(dts.length / 2)] : Infinity;
  // (0.2・0.1 ちょうどの間隔も、浮動小数の誤差で少し大きくなるので余裕を持たせる)
  const lowRate = !(dtTypical <= 0.2 + 1e-6); // 5Hz 以下

  // 旋回半径をならす
  let R = rawR.slice();
  if (level !== 'weak' && !lowRate && n >= 5) {
    const highRate = dtTypical <= 0.1 + 1e-6; // 10Hz 以上
    const med = rawR.slice();
    for (let i = 2; i < n - 2; i++) med[i] = median5([rawR[i - 2], rawR[i - 1], rawR[i], rawR[i + 1], rawR[i + 2]], !highRate);
    if (n > 3) {
      med[1] = (rawR[0] + rawR[1] + rawR[2]) / 3;
      med[n - 2] = (rawR[n - 3] + rawR[n - 2] + rawR[n - 1]) / 3;
    }
    R = med.slice();
    for (let i = 2; i < n - 2; i++) {
      if (highRate) {
        R[i] = (med[i - 2] * 0.5 + med[i - 1] + med[i] + med[i + 1] + med[i + 2] * 0.5) / 4;
      } else if (med[i] < med[i - 1] && med[i] < med[i + 1]) {
        R[i] = (med[i - 1] + med[i] * 2 + med[i + 1]) / 4; // 谷 (頂点) は重く
      } else {
        R[i] = (med[i - 1] + med[i] + med[i + 1]) / 3;
      }
    }
  }

  // 曲がる向きも前後 2 点を含めた多数決でならす (半径だけをならし、向きを 1 点の値のまま掛けると、
  // GPS の揺れで向きが 1 点だけ反転したときに G の符号がそこだけ逆になるため)
  const sideSm = side.map((_, i) => {
    let sum = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) sum += side[k];
    return sum > 0 ? 1 : sum < 0 ? -1 : side[i];
  });

  // G
  const corner = new Array<number>(n).fill(0);
  const accel = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const r = Math.min(MAX_RADIUS_M, R[i]);
    const v = points[i].speed / 3.6;
    corner[i] = r > 0 && points[i].speed >= MIN_SPEED_KMH ? ((v * v) / r / GRAVITY) * sideSm[i] : 0;
    // 車速の差は、時間が十分に離れた前の点との差 (間隔が極端に短い点の組で値が跳ねないように)
    let j = i - 1;
    while (j > 0 && points[i].time - points[j].time < MIN_SPAN_SEC) j--;
    const dt = points[i].time - points[j].time;
    accel[i] = dt > 1e-6 ? (points[i].speed - points[j].speed) / 3.6 / dt / GRAVITY : 0;
  }
  corner[0] = corner[1]; accel[0] = accel[1];

  // 前後 1 点との平均 (5Hz 以下ではしない)
  const mean3 = (v: number[]) => v.map((x, i) => (i === 0 || i === n - 1 ? x : (v[i - 1] + x + v[i + 1]) / 3));
  let outCorner = lowRate ? corner : mean3(corner);
  let outAccel = lowRate ? accel : mean3(accel);
  const outR = lowRate ? R : mean3(R);

  // strong: さらに前後 0.25 秒の平均
  if (level === 'strong') {
    const timeMean = (v: number[]) => {
      const out = new Array<number>(n);
      let lo = 0, hi = 0, sum = 0;
      for (let i = 0; i < n; i++) {
        const t = points[i].time;
        while (hi < n && points[hi].time - t <= STRONG_HALF_WINDOW_SEC) sum += v[hi++];
        while (t - points[lo].time > STRONG_HALF_WINDOW_SEC) sum -= v[lo++];
        out[i] = sum / (hi - lo);
      }
      return out;
    };
    outCorner = timeMean(outCorner);
    outAccel = timeMean(outAccel);
  }

  for (let i = 0; i < n; i++) {
    const p = points[i];
    // GPS の飛びで極端な値になった点は、前後の点の値で置き換える
    let a = outAccel[i];
    let c = outCorner[i];
    if (i > 0 && i < n - 1) {
      if (Math.abs(a) > 3.0) a = (outAccel[i - 1] + outAccel[i + 1]) / 2;
      if (Math.abs(c) > 3.5) c = (outCorner[i - 1] + outCorner[i + 1]) / 2;
    }
    const v = p.speed / 3.6;
    p.accelG = Number(a.toFixed(3));
    p.corneringG = Number(c.toFixed(3));
    p.combinedG = Number(Math.sqrt(a * a + c * c).toFixed(3));
    p.turningRadius = Number(Math.min(9999, outR[i]).toFixed(1));
    // ドリフト角度 (本アプリ独自の簡易指標。GPS ログには車体の向きが記録されないため、
    // 実際の滑り角ではなく旋回の強さを角度に見立てた参考値)
    if (v > 5 && Math.abs(c) > 0.3) {
      const slip = Math.atan2(c * GRAVITY * 0.15, v) * (180 / Math.PI);
      p.driftAngle = Number(Math.min(60, Math.max(-60, slip)).toFixed(1));
    }
  }
  return points;
}

// G のならし方の設定 (端末に保存する)
const G_FILTER_STORAGE_KEY = 'ds_g_filter';
let gFilterLevel: GFilterLevel = (() => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(G_FILTER_STORAGE_KEY) : null;
    if (v === 'weak' || v === 'standard' || v === 'strong') return v;
  } catch {
    // 保存先が使えないときは既定のまま
  }
  // 既定は「強」(フリクションサークルの「なめらか」が ON)。2026-10-19 に「標準」から変えた (選んだことのある人は、選んだまま)
  return 'strong';
})();

export function getGFilterLevel(): GFilterLevel {
  return gFilterLevel;
}

export function setGFilterLevel(level: GFilterLevel) {
  gFilterLevel = level;
  try {
    localStorage.setItem(G_FILTER_STORAGE_KEY, level);
  } catch {
    // 保存できなくても、この画面では使う
  }
}
