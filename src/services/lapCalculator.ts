import { TelemetryPoint, Lap, Sector, ControlLine, LapSectorResult } from '../types/telemetry';

/**
 * 2つの線分 (p1-p2) と (p3-p4) が交差しているかを判定し、交点比率 t (0 <= t <= 1) を返す
 */
function lineSegmentIntersection(
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  p3x: number, p3y: number,
  p4x: number, p4y: number
): { intersects: boolean; t: number; u: number; side: number } {
  const d = (p4y - p3y) * (p2x - p1x) - (p4x - p3x) * (p2y - p1y);
  if (Math.abs(d) < 1e-12) {
    return { intersects: false, t: 0, u: 0, side: 0 };
  }

  const t = ((p4x - p3x) * (p1y - p3y) - (p4y - p3y) * (p1x - p3x)) / d;
  const u = ((p2x - p1x) * (p1y - p3y) - (p2y - p1y) * (p1x - p3x)) / d;

  const intersects = t >= 0 && t <= 1 && u >= 0 && u <= 1;
  // 通過の向き (ゲートのどちら側からどちら側へ横切ったか)。+1 / -1
  return { intersects, t, u, side: Math.sign(d) };
}

export type Gate = { latA: number; lonA: number; latB: number; lonB: number };

/**
 * ゲートを通過する向きを決める。コースデータの線には向きがないので、ログの中で多い方の向きをコースの進行方向とみなす
 * (逆向きの通過は、ピットロード・隣のストレート・スピンなどで線をかすめたもの)。通過がなければ 0
 */
export function gateDirection(points: TelemetryPoint[], gate: Gate): number {
  // 向きごとに、通過したときの車速を足し合わせる。逆向きの通過 (ピットロードの出入り・スピンなど) は遅いので、
  // 通過の回数が同じでも、速く通過した向き (周回中の通過) が勝つ
  let score = 0;
  let lastSide = 0;
  let lastTime = -Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const r = lineSegmentIntersection(p1.longitude, p1.latitude, p2.longitude, p2.latitude, gate.lonA, gate.latA, gate.lonB, gate.latB);
    if (!r.intersects) continue;
    const t = p1.time + r.t * (p2.time - p1.time);
    // 点がちょうど線上にあると前後の 2 区間で同じ通過を数えるので、同じ向きの 1 秒以内の通過は 1 回とする
    if (r.side === lastSide && t - lastTime < 1) continue;
    lastSide = r.side;
    lastTime = t;
    score += r.side * Math.max(1, p1.speed + r.t * (p2.speed - p1.speed));
  }
  return Math.sign(score);
}

/**
 * 軌跡とコントロールラインの交差通過イベント
 */
export interface CrossingEvent {
  index: number;
  time: number;
  distance: number;
  interpolatedPoint: TelemetryPoint;
}

/**
 * 線分ゲート（コントロールラインまたはセクターライン）を通過した点を検出
 */
export function findGateCrossings(
  points: TelemetryPoint[],
  gate: Gate,
  minIntervalSec = 10, // 短時間での重複通過を防止
  // 数える通過の向き (gateDirection の値)。省略するとこの点列の中で多い方の向き
  direction = gateDirection(points, gate)
): CrossingEvent[] {
  const crossings: CrossingEvent[] = [];
  let lastCrossingTime = -9999;

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];

    const result = lineSegmentIntersection(
      p1.longitude, p1.latitude,
      p2.longitude, p2.latitude,
      gate.lonA, gate.latA,
      gate.lonB, gate.latB
    );

    // 逆向きの通過は数えない (重複通過の間隔の判定にも使わない)
    if (result.intersects && (direction === 0 || result.side === direction)) {
      const interpTime = p1.time + result.t * (p2.time - p1.time);
      if (interpTime - lastCrossingTime >= minIntervalSec) {
        const interpDist = p1.distance + result.t * (p2.distance - p1.distance);
        const interpSpeed = p1.speed + result.t * (p2.speed - p1.speed);
        const interpLat = p1.latitude + result.t * (p2.latitude - p1.latitude);
        const interpLon = p1.longitude + result.t * (p2.longitude - p1.longitude);

        const interpPoint: TelemetryPoint = {
          ...p1,
          ...interpolateClock(p1, p2, result.t),
          time: Number(interpTime.toFixed(4)),
          distance: Number(interpDist.toFixed(4)),
          speed: Number(interpSpeed.toFixed(2)),
          latitude: Number(interpLat.toFixed(7)),
          longitude: Number(interpLon.toFixed(7))
        };

        crossings.push({
          index: i + 1,
          time: interpTime,
          distance: interpDist,
          interpolatedPoint: interpPoint
        });
        lastCrossingTime = interpTime;
      }
    }
  }

  return crossings;
}

// 最後のセクター線をフィニッシュと同じ線とみなす、ラップの末尾 (計測線上) からの距離 (m)
const FINISH_GATE_TOLERANCE_M = 30;

/** 点からゲート (線分) までの距離 (m)。緯度経度を局所的な平面とみなして求める */
function distanceToGateMeters(p: TelemetryPoint, gate: Gate): number {
  const cosLat = Math.cos((p.latitude * Math.PI) / 180);
  const toXY = (lat: number, lon: number) => [(lon - p.longitude) * cosLat * 111320, (lat - p.latitude) * 111320];
  const [ax, ay] = toXY(gate.latA, gate.lonA);
  const [bx, by] = toXY(gate.latB, gate.lonB);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}

// 周の区切りとして数えない、止まっているような遅い通過 (km/h)。ピットやグリッドで計測線の上に止まっている間の GPS の揺れを周と数えないように
const SLOW_CROSSING_KMH = 5;

/**
 * 周回の区切りとして数える、計測線の通過の最短の間隔 (秒)。ふつうは 15 秒 (GPS の揺れで同じ通過を 2 回数えないように)。
 * 1 周が 15 秒より短いコース (小さなカートコース・ポケバイコース) では、周の時間の中央値の半分まで縮める (最短 4 秒)。
 * 周の時間は、走っている (15 km/h 以上の) 通過どうしで、間に 50 m 以上走ったものだけから見積もる (止まっている間の揺れを除く)
 */
function lapMinInterval(points: TelemetryPoint[], gate: Gate): number {
  // distance は km (0.05 = 50 m)
  const c = findGateCrossings(points, gate, 4).filter(x => x.interpolatedPoint.speed >= 15);
  const gaps = c.slice(1).map((x, i) => ({ dt: x.time - c[i].time, dd: x.distance - c[i].distance })).filter(g => g.dd >= 0.05).map(g => g.dt).sort((a, b) => a - b);
  if (gaps.length === 0) return 15;
  // 中央値 (偶数個のときは小さい方。遅い周が混ざっても縮められるように)
  const median = gaps[Math.floor((gaps.length - 1) / 2)];
  return median < 30 ? Math.max(4, Math.min(15, median / 2)) : 15;
}

/** 周回の区切りとする計測線の通過。止まっているような遅い通過は数えない */
function lapCrossings(points: TelemetryPoint[], gate: Gate): CrossingEvent[] {
  const c = findGateCrossings(points, gate, lapMinInterval(points, gate));
  return c.filter(x => x.interpolatedPoint.speed >= SLOW_CROSSING_KMH);
}

/** 計測線 (ゲート) を進行方向に通過した回数 (コースの自動判定で、どのコースの計測線を走ったかを比べるのに使う) */
export function countGateCrossings(points: TelemetryPoint[], gate: Gate): number {
  return lapCrossings(points, gate).length;
}

/** 点列がゲートを最初に通過した時刻 (点列の時刻の基準のまま)。通過しなければ undefined */
export function firstGateCrossingTime(points: TelemetryPoint[], gate: Gate, direction?: number): number | undefined {
  // 向きを渡さないときは、この点列の中で多い方の向き
  return findGateCrossings(points, gate, 2, direction ?? gateDirection(points, gate))[0]?.time;
}

/**
 * セクタータイムの計算
 */
function calculateLapSectors(
  lapPoints: TelemetryPoint[],
  lapStartTime: number,
  sectors: Sector[],
  // ラップの先頭 / 末尾が計測線上か (ログ全体を 1 周としたときはどちらも違う、途中までの周は末尾が違う)
  startsAtLine = true,
  endsAtLine = true,
  // 各セクター線を通過する向き (セッション全体で決めたもの)。1 周の中だけで決めると、逆向きにかすめた周で向きを取り違える
  sectorDirections?: number[]
): LapSectorResult[] {
  if (sectors.length === 0) return [];

  const first = lapPoints[0];
  const last = lapPoints[lapPoints.length - 1];
  const lapTotalTime = last.time - lapStartTime;
  const lapTotalDist = last.distance - first.distance;

  // 1. 実測の通過を探す。探し始めは直前の「実測の」通過より後にする
  //    (推定値から探すと、推定が実際の次の通過より後ろになったときに、実測の通過を取りこぼすため)
  const splits: Array<{ time: number; dist: number; measured: boolean } | null> = [];
  let lastMeasuredTime = 0;
  sectors.forEach((sec, sIdx) => {
    // ラップの先頭はコントロールライン上にあるため、フィニッシュ線を兼ねるセクターが 0 秒で検出されるのを防ぐ
    const crossing = findGateCrossings(lapPoints, sec, 2, sectorDirections?.[sIdx]).find(c => c.time - lapStartTime > lastMeasuredTime + 0.5);
    if (crossing) {
      splits.push({ time: crossing.time - lapStartTime, dist: crossing.distance - first.distance, measured: true });
      lastMeasuredTime = crossing.time - lapStartTime;
    } else if (sIdx === sectors.length - 1 && endsAtLine && distanceToGateMeters(last, sec) <= FINISH_GATE_TOLERANCE_M) {
      // 最後のセクター線がフィニッシュ (計測線) と同じ所にあり、ラップの末尾がちょうど線上なので交差として検出できないとき。
      // 最後のセクター線が途中にあって通らなかった (ショートカットなど) ときは、ここに入らず推定になる
      splits.push({ time: lapTotalTime, dist: lapTotalDist, measured: true });
    } else {
      splits.push(null);
    }
  });

  // 2. 通過を検出できなかったセクター線は、前後の実測の通過 (なければラップの先頭・末尾) の間を等分して推定する。
  //    前後の通過の間に収まるので、区間の時間が負になったり重なったりしない
  for (let i = 0; i < splits.length; i++) {
    if (splits[i]) continue;
    let j = i;
    while (j < splits.length && !splits[j]) j++;
    const before = i > 0 ? splits[i - 1]! : { time: 0, dist: 0 };
    const after = j < splits.length ? splits[j]! : { time: lapTotalTime, dist: lapTotalDist };
    // 後ろに実測の通過がない (末尾まで見つからない) ときは、最後のセクター線をラップの末尾に置く
    const gaps = j < splits.length ? j - i + 1 : j - i;
    for (let k = i; k < j; k++) {
      const f = (k - i + 1) / gaps;
      splits[k] = {
        time: before.time + (after.time - before.time) * f,
        dist: before.dist + (after.dist - before.dist) * f,
        measured: false
      };
    }
    i = j - 1;
  }

  const results: LapSectorResult[] = [];
  let prevSplitTime = 0;
  let prevSplitDist = 0;
  // 区間の始まり (1 つ前のセクター線) が推定かどうか。先頭が計測線でなければ最初から推定
  let prevEstimated = !startsAtLine;

  sectors.forEach((sec, sIdx) => {
    const split = splits[sIdx]!;
    const splitTime = split.time;
    const splitDist = split.dist;
    const measured = split.measured;

    const sectorDuration = Math.max(0.01, splitTime - prevSplitTime);
    const sectorDist = Math.max(0.001, splitDist - prevSplitDist);

    // セクター内ポイントの抽出
    const secPoints = lapPoints.filter(
      p => p.time - lapStartTime >= prevSplitTime && p.time - lapStartTime <= splitTime
    );

    let maxSpd = 0;
    let minSpd = 999;
    let sumSpd = 0;

    if (secPoints.length > 0) {
      for (const sp of secPoints) {
        if (sp.speed > maxSpd) maxSpd = sp.speed;
        if (sp.speed < minSpd) minSpd = sp.speed;
        sumSpd += sp.speed;
      }
    } else {
      maxSpd = minSpd = sumSpd = 0;
    }

    results.push({
      sectorId: sec.id,
      sectorName: sec.name || `S${sIdx + 1}`,
      time: Number(sectorDuration.toFixed(3)),
      splitTime: Number(splitTime.toFixed(3)),
      distance: Number(sectorDist.toFixed(3)),
      splitDistance: Number(splitDist.toFixed(3)),
      maxSpeed: Number(maxSpd.toFixed(1)),
      minSpeed: Number((minSpd === 999 ? 0 : minSpd).toFixed(1)),
      avgSpeed: secPoints.length > 0 ? Number((sumSpd / secPoints.length).toFixed(1)) : 0,
      ...(prevEstimated || !measured ? { isEstimated: true } : {})
    });

    prevSplitTime = splitTime;
    prevSplitDist = splitDist;
    prevEstimated = !measured;
  });

  return results;
}

/**
 * テレメトリデータからラップを自動分割・解析
 */
/**
 * 2 点の間を比率 t で補間した記録時刻 (timestamp / oleDate)。どちらも無い点では何も返さない
 */
function interpolateClock(p1: TelemetryPoint, p2: TelemetryPoint, t: number): Partial<TelemetryPoint> {
  const out: Partial<TelemetryPoint> = {};
  if (p1.timestamp != null && p2.timestamp != null) {
    const a = new Date(p1.timestamp).getTime();
    const b = new Date(p2.timestamp).getTime();
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const d = new Date(a + t * (b - a));
      // 元の点と同じ型 (文字列 / Date) で持つ
      out.timestamp = (typeof p1.timestamp === 'string' ? d.toISOString() : d) as TelemetryPoint['timestamp'];
    }
  }
  if (typeof p1.oleDate === 'number' && typeof p2.oleDate === 'number' && p1.oleDate > 0 && p2.oleDate > 0) {
    out.oleDate = p1.oleDate + t * (p2.oleDate - p1.oleDate);
  }
  return out;
}

export const VIRTUAL_CONTROL_LINE_NAME = '仮の計測線';

/**
 * コースの計測線が分からないときに、ログの走り始め (初めて 10 km/h を超えた所) に、進行方向と直角な仮の計測線を置く。
 * 他のログはこの線の通過点を 0 m として重ねられる。線の長さは 40 m (コース幅に余裕を持たせる)
 */
export function createVirtualControlLine(points: TelemetryPoint[]): ControlLine | undefined {
  const i = points.findIndex((p, k) => k > 0 && p.speed > 10);
  if (i < 1 || i >= points.length - 1) return undefined;
  const a = points[i];
  const b = points[i + 1];
  // 2 点の中間に置く (点の真上に置くと、交差の判定が端にかかる)
  const lat = (a.latitude + b.latitude) / 2;
  const lon = (a.longitude + b.longitude) / 2;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dx = (b.longitude - a.longitude) * cosLat;
  const dy = b.latitude - a.latitude;
  const len = Math.hypot(dx, dy);
  if (len === 0) return undefined;
  const halfDeg = 20 / 111320;
  // 進行方向 (dx, dy) に直角な向き (-dy, dx)
  const nx = (-dy / len) * halfDeg;
  const ny = (dx / len) * halfDeg;
  return {
    name: VIRTUAL_CONTROL_LINE_NAME,
    latA: lat + ny,
    lonA: lon + nx / cosLat,
    latB: lat - ny,
    lonB: lon - nx / cosLat
  };
}

/** ログのどこかが (lat, lon) から maxMeters 以内を通るか */
export function passesNearPoint(points: TelemetryPoint[], lat: number, lon: number, maxMeters: number): boolean {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const maxDeg2 = (maxMeters / 111320) ** 2;
  return points.some(p => (p.latitude - lat) ** 2 + ((p.longitude - lon) * cosLat) ** 2 <= maxDeg2);
}

/** ログのどこかが計測線の中点から maxMeters 以内を通るか (同じコースのログかどうかの目安) */
export function passesNearControlLine(points: TelemetryPoint[], line: ControlLine, maxMeters = 1000): boolean {
  const lat = (line.latA + line.latB) / 2;
  const lon = (line.lonA + line.lonB) / 2;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const maxDeg2 = (maxMeters / 111320) ** 2;
  return points.some(p => (p.latitude - lat) ** 2 + ((p.longitude - lon) * cosLat) ** 2 <= maxDeg2);
}

/**
 * セクター線 (最後のフィニッシュ = 計測線を除く) の並びが走る向きと逆なら並べ直す。
 * 走る向きの分からないコースで作ったセクター (内蔵のコースの仮のセクターなど) や、逆の順に並んだ .sci のため。
 * 各周で最初に通過した時刻 (周の始めからの割合) の中央値が、並びの順にちょうど減っていくときだけ逆にする。
 * 名前 (S1, S2 …) は位置ごとに元のものを使う
 */
function orderSectorsByTravel(
  points: TelemetryPoint[],
  controlLine: ControlLine,
  sectors: Sector[],
  lapRanges: Array<{ startTime: number; endTime: number }>
): Sector[] {
  const isFinish = (s: Sector) =>
    Math.abs(s.latA - controlLine.latA) < 1e-7 && Math.abs(s.lonA - controlLine.lonA) < 1e-7 &&
    Math.abs(s.latB - controlLine.latB) < 1e-7 && Math.abs(s.lonB - controlLine.lonB) < 1e-7;
  const hasFinish = sectors.length > 0 && isFinish(sectors[sectors.length - 1]);
  const mids = hasFinish ? sectors.slice(0, -1) : sectors;
  if (mids.length < 2 || lapRanges.length === 0) return sectors;
  const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const fractions = mids.map(g => {
    const times = findGateCrossings(points, g, 2).map(c => c.time);
    const f: number[] = [];
    for (const r of lapRanges) {
      const t = times.find(x => x > r.startTime && x < r.endTime);
      if (t !== undefined) f.push((t - r.startTime) / (r.endTime - r.startTime));
    }
    return f.length > 0 ? median(f) : NaN;
  });
  if (!fractions.every(Number.isFinite)) return sectors;
  const reversed = fractions.every((f, i) => i === 0 || f < fractions[i - 1]);
  if (!reversed) return sectors;
  const flipped = [...mids].reverse().map((g, i) => ({ ...g, name: mids[i].name }));
  return hasFinish ? [...flipped, sectors[sectors.length - 1]] : flipped;
}

// 計測線の通過が 1 回のログで、通過点より後ろをラップとして扱う最短の長さ (秒)
const PARTIAL_LAP_MIN_SEC = 15;

export function extractLaps(
  points: TelemetryPoint[],
  controlLine?: ControlLine,
  sectors: Sector[] = []
): { laps: Lap[]; bestLapIndex: number; theoreticalBestTime: number; sectors: Sector[] } {
  if (points.length < 5) {
    return { laps: [], bestLapIndex: -1, theoreticalBestTime: 0, sectors };
  }

  let lapRanges: Array<{
    startIndex: number;
    endIndex: number;
    startTime: number;
    endTime: number;
    // コントロールライン上に補間した通過点 (ラップの先頭と末尾)
    startPoint?: TelemetryPoint;
    endPoint?: TelemetryPoint;
  }> = [];
  let isPartialLap = false;

  // コントロールラインがある場合は交差検出でラップ分割
  if (controlLine) {
    const crossings = lapCrossings(points, controlLine); // ふつうは最低 15 秒間隔
    if (crossings.length >= 2) {
      for (let c = 0; c < crossings.length - 1; c++) {
        const c1 = crossings[c];
        const c2 = crossings[c + 1];
        lapRanges.push({
          startIndex: c1.index,
          endIndex: c2.index,
          startTime: c1.time,
          endTime: c2.time,
          startPoint: c1.interpolatedPoint,
          endPoint: c2.interpolatedPoint
        });
      }
    } else if (crossings.length === 1) {
      // 通過が 1 回だけのログ (1 周ぶんの書き出しで、計測線の少し手前から始まり次の通過の前で終わるものなど) は、
      // 通過点から末尾までを、終わりが不完全な 1 周として扱う。先頭を計測線にそろえることで、他のラップと重ねてもずれない
      // 通過点より後ろが短いとき、または通過点より前の方が長いとき (計測線の後ろから始まり、1 周して通過した後も記録が続いたログなど) は、
      // 本編を捨てないよう、これまでどおりログ全体を 1 周とする
      const c = crossings[0];
      const last = points[points.length - 1];
      const after = last.time - c.time;
      const before = c.time - points[0].time;
      if (after >= PARTIAL_LAP_MIN_SEC && after >= before && c.index < points.length) {
        lapRanges.push({
          startIndex: c.index,
          endIndex: points.length - 1,
          startTime: c.time,
          endTime: last.time,
          startPoint: c.interpolatedPoint
        });
        isPartialLap = true;
      }
    }
  }

  // 交差が2回未満（単一ラップデータなど）の場合は全体を1つのラップとする
  const isWholeSession = lapRanges.length === 0;
  if (lapRanges.length === 0) {
    lapRanges.push({
      startIndex: 0,
      endIndex: points.length - 1,
      startTime: points[0].time,
      endTime: points[points.length - 1].time
    });
  }

  if (controlLine && !isWholeSession) sectors = orderSectorsByTravel(points, controlLine, sectors, lapRanges);

  const laps: Lap[] = [];
  const sectorDirections = sectors.map(s => gateDirection(points, s));

  lapRanges.forEach((r, idx) => {
    // コントロールラインで区切ったラップは、通過点 (補間) を先頭と末尾に置き、その間の実測点を挟む。
    // こうすると先頭が 0 秒・0 km、末尾がちょうどラップタイム・1 周の距離になる
    const rawPoints = r.startPoint && r.endPoint
      ? [r.startPoint, ...points.slice(r.startIndex, r.endIndex), r.endPoint]
      : r.startPoint
        ? [r.startPoint, ...points.slice(r.startIndex, r.endIndex + 1)]
        : points.slice(r.startIndex, r.endIndex + 1);
    if (rawPoints.length < 2) return;

    // 各ラップ内のタイムと距離を t=0, dist=0 からに正規化
    const t0 = rawPoints[0].time;
    const d0 = rawPoints[0].distance;
    const lapPoints: TelemetryPoint[] = rawPoints.map((p, pIdx) => ({
      ...p,
      index: pIdx,
      time: Number((p.time - t0).toFixed(4)) || 0, // -0 を 0 にする (表示が -0.00 になるため)
      distance: Number((p.distance - d0).toFixed(4))
    }));

    const lapDuration = r.endTime - r.startTime;
    const lapDist = rawPoints[rawPoints.length - 1].distance - rawPoints[0].distance;

    let topSpeed = 0;
    let bottomSpeed = 999;
    let sumSpeed = 0;

    for (const p of lapPoints) {
      if (p.speed > topSpeed) topSpeed = p.speed;
      if (p.speed < bottomSpeed) bottomSpeed = p.speed;
      sumSpeed += p.speed;
    }

    const avgSpeed = lapPoints.length > 0 ? sumSpeed / lapPoints.length : 0;
    const sectorResults = calculateLapSectors(lapPoints, 0, sectors, !isWholeSession, !isWholeSession && !isPartialLap, sectorDirections);

    laps.push({
      lapNumber: idx + 1,
      lapTime: Number(lapDuration.toFixed(3)),
      startTime: r.startTime,
      endTime: r.endTime,
      startIndex: r.startIndex,
      endIndex: r.endIndex,
      distance: Number(lapDist.toFixed(3)),
      topSpeed: Number(topSpeed.toFixed(1)),
      bottomSpeed: Number((bottomSpeed === 999 ? 0 : bottomSpeed).toFixed(1)),
      avgSpeed: Number(avgSpeed.toFixed(1)),
      sectors: sectorResults,
      points: lapPoints,
      ...(isWholeSession ? { isWholeSession: true } : {}),
      ...(isPartialLap ? { isPartialLap: true } : {})
    });
  });

  // ベストラップの特定。計測線から計測線までの周があれば、途中までの周・ログ全体の周は候補にしない
  const hasFullLap = laps.some(l => !l.isPartialLap && !l.isWholeSession);
  let bestLapIndex = 0;
  let minLapTime = Infinity;
  laps.forEach((l, idx) => {
    if (hasFullLap && (l.isPartialLap || l.isWholeSession)) return;
    if (l.lapTime > 5 && l.lapTime < minLapTime) {
      minLapTime = l.lapTime;
      bestLapIndex = idx;
    }
  });

  if (laps[bestLapIndex]) {
    laps[bestLapIndex].isBestLap = true;
  }

  // セクターベストと理論ベスト (Theoretical Best) の計算
  let theoreticalBestTime = 0;
  if (sectors.length > 0 && laps.length > 0) {
    sectors.forEach((_, sIdx) => {
      let minSectorTime = Infinity;
      let bestLapForSector = -1;

      laps.forEach((l, lIdx) => {
        const secRes = l.sectors[sIdx];
        // 推定値 (セクター線を通らなかった区間) はセクターベストにしない
        if (secRes && !secRes.isEstimated && secRes.time > 0.5 && secRes.time < minSectorTime) {
          minSectorTime = secRes.time;
          bestLapForSector = lIdx;
        }
      });

      if (bestLapForSector !== -1 && laps[bestLapForSector].sectors[sIdx]) {
        laps[bestLapForSector].sectors[sIdx].isBest = true;
        theoreticalBestTime += minSectorTime;
      } else {
        // 実測のないセクターがあると理論ベストは出せない
        theoreticalBestTime = NaN;
      }
    });
    if (!Number.isFinite(theoreticalBestTime)) theoreticalBestTime = 0;
  } else if (laps[bestLapIndex]) {
    theoreticalBestTime = laps[bestLapIndex].lapTime;
  }

  return {
    laps,
    bestLapIndex,
    theoreticalBestTime: Number(theoreticalBestTime.toFixed(3)),
    sectors
  };
}

/**
 * 基準車両（Car 0: 赤）と対象車両の走行距離基準でのタイム差 (Delta Time) を計算
 * 赤車両の各ポイントにおける相手車両との到達時間差（赤が先ならプラス[秒]、遅れならマイナス）
 */
export function calculateDeltaTimes(
  baseLapPoints: TelemetryPoint[],
  targetLapPoints: TelemetryPoint[]
): number[] {
  if (baseLapPoints.length === 0 || targetLapPoints.length === 0) return [];

  const deltas: number[] = [];
  let targetIdx = 0;

  for (let i = 0; i < baseLapPoints.length; i++) {
    const baseP = baseLapPoints[i];
    const baseDist = baseP.distance;

    // 相手車両の同じ距離地点を探す
    while (
      targetIdx < targetLapPoints.length - 1 &&
      targetLapPoints[targetIdx + 1].distance < baseDist
    ) {
      targetIdx++;
    }

    const t1 = targetLapPoints[targetIdx];
    const t2 = targetLapPoints[Math.min(targetIdx + 1, targetLapPoints.length - 1)];

    let targetTimeAtDist = t1.time;
    const distDiff = t2.distance - t1.distance;
    if (distDiff > 0.0001) {
      const ratio = Math.max(0, Math.min(1, (baseDist - t1.distance) / distDiff));
      targetTimeAtDist = t1.time + ratio * (t2.time - t1.time);
    }

    // タイム差: 相手の時間 - 基準の時間
    // (相手の方が時間がかかっていれば正 = 基準車が速い / 相手が速ければ負 = 基準車が遅れている)
    const delta = targetTimeAtDist - baseP.time;
    deltas.push(Number(delta.toFixed(3)));
  }

  return deltas;
}
