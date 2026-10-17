/**
 * 秒を「分:秒.小数」にする。表示する桁で先に丸めてから分と秒に分ける
 * (秒の部分だけを丸めると、119.9996 秒が「1:60.000」になる)
 */
export function formatMinSec(sec: number, decimals: number, padMinutes = false): string {
  const unit = 10 ** decimals;
  const total = Math.round(Math.max(0, sec) * unit);
  const m = Math.floor(total / (60 * unit));
  const s = ((total - m * 60 * unit) / unit).toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0');
  return `${padMinutes ? String(m).padStart(2, '0') : m}:${s}`;
}
