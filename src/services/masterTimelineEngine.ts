/**
 * タイムゾーン自動判定 (動画の撮影日時とログの時刻の時差を見つける)。
 * 動画とログの時刻の換算は mediaClock.ts
 */

/**
 * GPS緯度経度から現地タイムゾーンを自動判定
 */
export function detectCircuitTimezone(lat: number, lon: number): string {
  // 日本の領土範囲: 北緯24〜46度、東経122〜154度
  if (lat >= 24 && lat <= 46 && lon >= 122 && lon <= 154) {
    return 'JST';
  }
  // 欧州 (ニュルブルクリンク, スパ等): 北緯35〜60度、東経-10〜25度
  if (lat >= 35 && lat <= 60 && lon >= -10 && lon <= 25) {
    return '+1'; // CET
  }
  // 米国西海岸 (ラグナセカ等): 北緯32〜49度、西経-125〜-114度
  if (lat >= 32 && lat <= 49 && lon >= -125 && lon <= -114) {
    return '-8'; // PST
  }
  return 'UTC';
}

/**
 * 整数時差スキャン (Auto-TZ Scan)
 * カメラ側がUTC記録かローカル記録かによる時差ズレ (0h, ±9h, ±8h等) を自動検知
 */
export function scanBestTimezoneOffset(
  videoRecordedAt: Date,
  sessionStartDate: Date,
  circuitTz: string = 'JST'
): { bestOffsetSec: number; detectedShiftHours: number; confidence: 'high' | 'medium' | 'low'; found: boolean } {
  // 候補となる時差シフト (時間単位)
  const candidateHours = [0, 9, -9, 8, -8, 1, -1, 5, -5];

  let bestShift = 0;
  let minDiffSec = Infinity;
  let bestOffsetSec = 0;

  const vidEpoch = videoRecordedAt.getTime();
  const sessEpoch = sessionStartDate.getTime();

  for (const shiftH of candidateHours) {
    // shiftH 時間の補正を適用した仮想差分
    const shiftMs = shiftH * 3600 * 1000;
    const diffSec = (vidEpoch - (sessEpoch + shiftMs)) / 1000;
    const absDiff = Math.abs(diffSec);

    // サーキット走行セッション内の合理的な時間差 (最長4時間以内)
    if (absDiff < minDiffSec && absDiff < 4 * 3600) {
      minDiffSec = absDiff;
      bestShift = shiftH;
      bestOffsetSec = diffSec;
    }
  }

  // 判定信頼度
  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (minDiffSec <= 600) {
    confidence = 'high'; // 10分以内の差分 = 完全に同一セッション
  } else if (minDiffSec <= 1800) {
    confidence = 'medium'; // 30分以内の差分
  }

  return {
    bestOffsetSec: Number(bestOffsetSec.toFixed(3)),
    detectedShiftHours: bestShift,
    // どの時差の候補でも 4 時間以内に収まらなかったとき (別の日の動画など) は false。bestOffsetSec の 0 は一致ではない
    found: Number.isFinite(minDiffSec),
    confidence
  };
}
