/**
 * 走行を車種・タイヤ・天候で絞り込む (PLAN-37)。走行の一覧とラップタイムの一覧で同じ決まりを使う。
 * 値は runs.json の行 (参考ラップの車は reference.car)。'none' は未設定の走行
 */
import { isWeather, type Weather } from './runWeather';

export interface RunConditions {
  car?: string;
  tyre?: string;
  weather?: Weather;
}

export interface ConditionFilter {
  car: string | null;
  tyre: string | null;
  weather: Weather | 'none' | null;
}

export const NO_FILTER: ConditionFilter = { car: null, tyre: null, weather: null };
export const NONE = 'none';

/** runs.json の行から、絞り込みに使う値 */
export function conditionsOf(entry: { car?: unknown; tyre?: unknown; weather?: unknown; reference?: { car?: unknown } } | null | undefined): RunConditions {
  if (!entry) return {};
  const car = entry.reference ? entry.reference.car : entry.car;
  return {
    ...(typeof car === 'string' && car.trim() ? { car: car.trim() } : {}),
    ...(typeof entry.tyre === 'string' && entry.tyre.trim() ? { tyre: entry.tyre.trim() } : {}),
    ...(isWeather(entry.weather) ? { weather: entry.weather } : {})
  };
}

/** 絞り込みに合うか ('none' は未設定のものだけ) */
export function matchesFilter(c: RunConditions, f: ConditionFilter): boolean {
  const ok = (v: string | undefined, want: string | null) => want === null || (want === NONE ? !v : v === want);
  return ok(c.car, f.car) && ok(c.tyre, f.tyre) && ok(c.weather, f.weather);
}

/** 選べる値と件数 (書いた走行があるものだけ。未設定は 'none')。ほかの項目の絞り込みは効かせない (どれを選んでも出る件数) */
export function filterOptions(list: RunConditions[]): { car: Map<string, number>; tyre: Map<string, number>; weather: Map<string, number> } {
  const out = { car: new Map<string, number>(), tyre: new Map<string, number>(), weather: new Map<string, number>() };
  for (const c of list) {
    for (const k of ['car', 'tyre', 'weather'] as const) {
      const v = c[k] ?? NONE;
      out[k].set(v, (out[k].get(v) ?? 0) + 1);
    }
  }
  return out;
}

/** その項目の絞り込みを出すか (未設定以外の値が 1 つでもあるとき) */
export const hasValues = (m: Map<string, number>) => [...m.keys()].some(k => k !== NONE);

/** 選んだ値が今の一覧に無ければ、その項目は絞らない (コースを替えたときなど) */
export function effectiveFilter(f: ConditionFilter, opts: ReturnType<typeof filterOptions>): ConditionFilter {
  return {
    car: f.car !== null && hasValues(opts.car) && opts.car.has(f.car) ? f.car : null,
    tyre: f.tyre !== null && hasValues(opts.tyre) && opts.tyre.has(f.tyre) ? f.tyre : null,
    weather: f.weather !== null && hasValues(opts.weather) && opts.weather.has(f.weather) ? f.weather : null
  };
}
