/**
 * 速度の単位 (2026-10-20)。中では km/h で持ち、表示のときだけ換算する。
 * mph は換算の部品だけ用意して、画面からは選べないようにしている (表に出すかは未定)。
 * 試すときだけ、開発者ツールで localStorage の ds_speed_unit に 'mph' を入れる
 */

export type SpeedUnit = 'kmh' | 'mph';

/** 1 マイル = 1.609344 km */
export const KM_PER_MILE = 1.609344;
const STORE_KEY = 'ds_speed_unit';

/** km/h を、その単位の値にする */
export function speedIn(kmh: number, unit: SpeedUnit): number {
  return unit === 'mph' ? kmh / KM_PER_MILE : kmh;
}

/** その単位の値を、km/h に戻す */
export function speedToKmh(value: number, unit: SpeedUnit): number {
  return unit === 'mph' ? value * KM_PER_MILE : value;
}

export function speedLabel(unit: SpeedUnit): string {
  return unit === 'mph' ? 'mph' : 'km/h';
}

/** 表示の文字 (例: "131.1 km/h") */
export function formatSpeed(kmh: number, unit: SpeedUnit = getSpeedUnit(), digits = 0): string {
  if (!Number.isFinite(kmh)) return `-- ${speedLabel(unit)}`;
  return `${speedIn(kmh, unit).toFixed(digits)} ${speedLabel(unit)}`;
}

/** 今の単位 (画面では選べない。決めていなければ km/h) */
export function getSpeedUnit(): SpeedUnit {
  try {
    return localStorage.getItem(STORE_KEY) === 'mph' ? 'mph' : 'kmh';
  } catch {
    return 'kmh';
  }
}
