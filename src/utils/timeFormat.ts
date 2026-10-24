/**
 * 秒を「分:秒.小数」にする。表示する桁で先に丸めてから分と秒に分ける
 * (秒の部分だけを丸めると、119.9996 秒が「1:60.000」になる)
 */
export function formatMinSec(sec: number, decimals: number, padMinutes = false): string {
  // 数値でない時刻は「--:--.---」のように出す (NaN をそのまま計算すると「NaN:00NaN」になる)
  if (!Number.isFinite(sec)) return `${padMinutes ? '--' : '-'}:--${decimals > 0 ? '.' + '-'.repeat(decimals) : ''}`;
  const unit = 10 ** decimals;
  const total = Math.round(Math.max(0, sec) * unit);
  const m = Math.floor(total / (60 * unit));
  const s = ((total - m * 60 * unit) / unit).toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0');
  return `${padMinutes ? String(m).padStart(2, '0') : m}:${s}`;
}

/**
 * ログの走った日 (この端末の時刻での日付、YYYY-MM-DD)。画面に出すとき用 (BUG-35 の (1))。
 * Session.date は UTC の日付 (動画の同期の照合などに使う) なので、日本の朝 9 時より前の走行は前の日になってしまう。
 * 最初の点の時刻から求め、時刻がなければ Session.date のまま
 */
export function sessionLocalDate(s: { date: string; points: { timestamp?: unknown }[] }): string {
  const p = s.points.find(x => x.timestamp !== undefined && x.timestamp !== null);
  const ts = p?.timestamp;
  const d = ts instanceof Date ? ts : typeof ts === 'string' ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return s.date;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
