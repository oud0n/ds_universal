import { TelemetryPoint, Lap, Sector, ControlLine, LapSectorResult } from '../types/telemetry';

/**
 * 2つの線分 (p1-p2) と (p3-p4) が交差しているかを判定し、交点比率 t (0 <= t <= 1) を返す
 */
function lineSegmentIntersection(
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  p3x: number, p3y: number,
  p4x: number, p4y: number
): { intersects: boolean; t: number; u: number } {
  const d = (p4y - p3y) * (p2x - p1x) - (p4x - p3x) * (p2y - p1y);
  if (Math.abs(d) < 1e-12) {
    return { intersects: false, t: 0, u: 0 };
  }

  const t = ((p4x - p3x) * (p1y - p3y) - (p4y - p3y) * (p1x - p3x)) / d;
  const u = ((p2x - p1x) * (p1y - p3y) - (p2y - p1y) * (p1x - p3x)) / d;

  const intersects = t >= 0 && t <= 1 && u >= 0 && u <= 1;
  return { intersects, t, u };
}

/**
 * 軌跡とコントロールラインの交差通過イベント
 */
interface CrossingEvent {
  index: number;
  time: number;
  distance: number;
  interpolatedPoint: TelemetryPoint;
}

/**
 * 線分ゲート（コントロールラインまたはセクターライン）を通過した点を検出
 */
function findGateCrossings(
  points: TelemetryPoint[],
  gate: { latA: number; lonA: number; latB: number; lonB: number },
  minIntervalSec = 10 // 短時間での重複通過を防止
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

    if (result.intersects) {
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

/**
 * セクタータイムの計算
 */
function calculateLapSectors(
  lapPoints: TelemetryPoint[],
  lapStartTime: number,
  sectors: Sector[]
): LapSectorResult[] {
  if (sectors.length === 0) return [];

  const results: LapSectorResult[] = [];
  let prevSplitTime = 0;
  let prevSplitDist = 0;

  sectors.forEach((sec, sIdx) => {
    // セクターラインとの交差を探す。前のセクター通過より後のものだけを対象にする
    // (ラップの先頭はコントロールライン上にあるため、フィニッシュ線を兼ねるセクターが 0 秒で検出されるのを防ぐ)
    const crossing = findGateCrossings(lapPoints, sec, 2).find(c => c.time - lapStartTime > prevSplitTime + 0.5);
    let splitTime = 0;
    let splitDist = 0;

    if (crossing) {
      splitTime = crossing.time - lapStartTime;
      splitDist = crossing.distance - lapPoints[0].distance;
    } else if (sIdx === sectors.length - 1) {
      // 最後のセクターで交差が見つからない場合は、ラップの終わり (フィニッシュ通過) までとする
      splitTime = lapPoints[lapPoints.length - 1].time - lapStartTime;
      splitDist = lapPoints[lapPoints.length - 1].distance - lapPoints[0].distance;
    } else {
      // ゲート通過が検出できない場合は距離または時間の等分推計
      const fraction = (sIdx + 1) / (sectors.length + 1);
      const totalLapTime = lapPoints[lapPoints.length - 1].time - lapStartTime;
      const totalLapDist = lapPoints[lapPoints.length - 1].distance - lapPoints[0].distance;
      splitTime = totalLapTime * fraction;
      splitDist = totalLapDist * fraction;
    }

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
      maxSpeed: Number(maxSpd.toFixed(1)),
      minSpeed: Number((minSpd === 999 ? 0 : minSpd).toFixed(1)),
      avgSpeed: secPoints.length > 0 ? Number((sumSpd / secPoints.length).toFixed(1)) : 0
    });

    prevSplitTime = splitTime;
    prevSplitDist = splitDist;
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

// 計測線の通過が 1 回のログで、通過点より後ろをラップとして扱う最短の長さ (秒)
const PARTIAL_LAP_MIN_SEC = 15;

export function extractLaps(
  points: TelemetryPoint[],
  controlLine?: ControlLine,
  sectors: Sector[] = []
): { laps: Lap[]; bestLapIndex: number; theoreticalBestTime: number } {
  if (points.length < 5) {
    return { laps: [], bestLapIndex: -1, theoreticalBestTime: 0 };
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
    const crossings = findGateCrossings(points, controlLine, 15); // 最低15秒間隔
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
      // 通過点より後ろが短い (末尾近くで通過した) ときは、これまでどおりログ全体を 1 周とする
      const c = crossings[0];
      const last = points[points.length - 1];
      if (last.time - c.time >= PARTIAL_LAP_MIN_SEC && c.index < points.length) {
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

  const laps: Lap[] = [];

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
      time: Number((p.time - t0).toFixed(4)),
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
    const sectorResults = calculateLapSectors(lapPoints, 0, sectors);

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

  // ベストラップの特定
  let bestLapIndex = 0;
  let minLapTime = Infinity;
  laps.forEach((l, idx) => {
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
        if (secRes && secRes.time > 0.5 && secRes.time < minSectorTime) {
          minSectorTime = secRes.time;
          bestLapForSector = lIdx;
        }
      });

      if (bestLapForSector !== -1 && laps[bestLapForSector].sectors[sIdx]) {
        laps[bestLapForSector].sectors[sIdx].isBest = true;
        theoreticalBestTime += minSectorTime;
      }
    });
  } else if (laps[bestLapIndex]) {
    theoreticalBestTime = laps[bestLapIndex].lapTime;
  }

  return {
    laps,
    bestLapIndex,
    theoreticalBestTime: Number(theoreticalBestTime.toFixed(3))
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
