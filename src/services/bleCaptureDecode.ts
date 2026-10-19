/**
 * BLE の通知の記録 (ネイティブの recorder かブラウザが書いたもの。形は src/native/contract.ts の RecordingFile) を読んで、
 * 測位の一覧と、仕様の確かめに使う数字 (速度・高度の単位が合っているか) にする。
 *
 * 速度の単位の確かめ: 通知の速度の欄と、位置の移動から求めた速さを、動いている間 (1 m/s 以上) だけ比べる。
 * 単位が 0.01 m/s で合っていれば、比はおよそ 1 になる
 */

import { BleFixAssembler, type BleFix } from './digspiceBleProtocol';
import { calculateGeoDistanceAndHeading } from './physics';

export interface CaptureRow {
  /** 記録を始めてからの受け取った時刻 (秒) */
  receivedSec: number;
  fix: BleFix;
  /** 速度の欄の生の値 (0.01 m/s と推定) */
  speedRaw: number;
  /** 高度の欄の生の値 (0.01 m と推定) */
  altitudeRaw: number;
  /** 位置の移動から求めた速さ (km/h。前後 0.5 秒の測位から。求められないときは null) */
  speedFromPositionsKmh: number | null;
}

export interface CaptureSummary {
  header: string[];
  notifications: number;
  fixes: number;
  validFixes: number;
  /** GPS の時刻で数えた測位の間隔の中央値 (秒) */
  medianIntervalSec: number | null;
  /** 0.5 秒より長く測位が空いた回数 */
  gaps: number;
  /** つなぎの状態が変わった記録 (受け取った時刻の秒, 状態) */
  states: Array<{ receivedSec: number; state: string }>;
  /** 動いている間の「速度の欄 ÷ 位置から求めた速さ」の中央値 (1 に近ければ単位が合っている) */
  speedRatioMedian: number | null;
  speedRatioSamples: number;
  /** 高度の幅 (m、測位できている間) */
  altitudeRangeM: { min: number; max: number } | null;
}

export interface DecodedCapture {
  rows: CaptureRow[];
  summary: CaptureSummary;
}

const SPEED_WINDOW_SEC = 0.5;
const MOVING_MS = 1;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function decodeCapture(text: string): DecodedCapture {
  const header: string[] = [];
  const states: CaptureSummary['states'] = [];
  const rows: CaptureRow[] = [];
  const assembler = new BleFixAssembler();
  let firstNs: number | null = null;
  let notifications = 0;
  const secOf = (ns: number) => {
    firstNs ??= ns;
    return (ns - firstNs) / 1e9;
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('#')) {
      const body = line.slice(1).trim();
      const state = /^state,(\d+),(\S+)/.exec(body);
      if (state) {
        states.push({ receivedSec: secOf(Number(state[1])), state: state[2] });
        assembler.reset();
      } else if (/^resumed,/.test(body)) {
        assembler.reset();
        states.push({ receivedSec: secOf(Number(body.split(',')[1])), state: 'resumed' });
      } else if (!body.startsWith('ds-ble-capture')) {
        header.push(body);
      }
      continue;
    }
    const [tText, , characteristic, hex] = line.split(',');
    if (!/^\d+$/.test(tText ?? '') || characteristic !== '2a67') continue;
    const bytes = hexToBytes(hex ?? '');
    if (!bytes) continue;
    notifications++;
    const receivedSec = secOf(Number(tText));
    const fix = assembler.push(bytes);
    if (!fix) continue;
    rows.push({
      receivedSec,
      fix,
      speedRaw: Math.round((fix.speedKmh / 3.6) * 100),
      altitudeRaw: Math.round(fix.altitude * 100),
      speedFromPositionsKmh: null
    });
  }

  // 位置の移動から求めた速さ: 前後 0.5 秒の測位 (GPS の時刻) の間の距離 ÷ 時間
  const valid = rows.filter(r => r.fix.valid);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < valid.length; i++) {
    const t = valid[i].fix.timestamp.getTime() / 1000;
    while (lo < i && t - valid[lo].fix.timestamp.getTime() / 1000 > SPEED_WINDOW_SEC) lo++;
    hi = Math.max(hi, i);
    while (hi + 1 < valid.length && valid[hi + 1].fix.timestamp.getTime() / 1000 - t <= SPEED_WINDOW_SEC) hi++;
    const a = valid[lo].fix, b = valid[hi].fix;
    const dt = (b.timestamp.getTime() - a.timestamp.getTime()) / 1000;
    if (dt <= 0) continue;
    const { distanceMeters } = calculateGeoDistanceAndHeading(a.latitude, a.longitude, b.latitude, b.longitude);
    valid[i].speedFromPositionsKmh = (distanceMeters / dt) * 3.6;
  }

  const intervals: number[] = [];
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = (rows[i].fix.timestamp.getTime() - rows[i - 1].fix.timestamp.getTime()) / 1000;
    if (dt > 0) intervals.push(dt);
    if (dt > 0.5) gaps++;
  }
  const ratios = valid
    .filter(r => r.speedFromPositionsKmh !== null && r.speedFromPositionsKmh / 3.6 >= MOVING_MS)
    .map(r => r.fix.speedKmh / (r.speedFromPositionsKmh as number));
  const altitudes = valid.map(r => r.fix.altitude);

  return {
    rows,
    summary: {
      header,
      notifications,
      fixes: rows.length,
      validFixes: valid.length,
      medianIntervalSec: median(intervals),
      gaps,
      states,
      speedRatioMedian: median(ratios),
      speedRatioSamples: ratios.length,
      altitudeRangeM: altitudes.length ? { min: Math.min(...altitudes), max: Math.max(...altitudes) } : null
    }
  };
}

/** 測位の一覧の CSV (頭に、見出しとまとめを # の行で付ける) */
export function decodedCaptureCsv(decoded: DecodedCapture): string {
  const { summary: s } = decoded;
  const lines = [
    '# ds-ble-capture decoded',
    ...s.header.map(h => `# ${h}`),
    `# notifications=${s.notifications} fixes=${s.fixes} valid=${s.validFixes} median_interval_s=${s.medianIntervalSec ?? ''} gaps=${s.gaps}`,
    `# speed_ratio_median=${s.speedRatioMedian ?? ''} speed_ratio_samples=${s.speedRatioSamples} (speed field / speed from positions, moving only)`,
    `# altitude_m_min=${s.altitudeRangeM?.min ?? ''} altitude_m_max=${s.altitudeRangeM?.max ?? ''}`,
    ...s.states.map(st => `# state received_s=${st.receivedSec.toFixed(3)} ${st.state}`),
    'received_s,utc,valid,latitude,longitude,speed_kmh,speed_raw,speed_from_positions_kmh,altitude_m,altitude_raw'
  ];
  for (const r of decoded.rows) {
    lines.push([
      r.receivedSec.toFixed(3),
      r.fix.timestamp.toISOString(),
      r.fix.valid ? 1 : 0,
      r.fix.latitude.toFixed(7),
      r.fix.longitude.toFixed(7),
      r.fix.speedKmh.toFixed(2),
      r.speedRaw,
      r.speedFromPositionsKmh === null ? '' : r.speedFromPositionsKmh.toFixed(2),
      r.fix.altitude.toFixed(2),
      r.altitudeRaw
    ].join(','));
  }
  return lines.join('\n') + '\n';
}
