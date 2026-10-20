/** グラフの目盛りと範囲 (X/Y グラフなど) */

/** 目盛りの間隔 (1・2・5 × 10 の何乗) */
export function niceStep(range: number, count = 5): number {
  if (!(range > 0)) return 1;
  const raw = range / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** 値の範囲 (外れた値に引っ張られないよう、0.5%〜99.5% の範囲に少し余白を足す) */
export function valueRange(values: number[]): [number, number] {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return [0, 1];
  const lo = v[Math.floor((v.length - 1) * 0.005)];
  const hi = v[Math.ceil((v.length - 1) * 0.995)];
  const pad = (hi - lo) * 0.05 || Math.abs(hi) * 0.1 || 1;
  return [lo - pad, hi + pad];
}
