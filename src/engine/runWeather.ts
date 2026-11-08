/**
 * 走行の天候・気温・路面温度 (2026-10-26)。runs.json の行に書く。基本は未設定のまま (使う人だけ走行の詳細で選ぶ)
 */
export const WEATHERS = ['dry', 'damp', 'wet', 'heavy-wet'] as const;
export type Weather = typeof WEATHERS[number];

export const WEATHER_LABELS: Record<Weather, [string, string]> = {
  dry: ['ドライ', 'Dry'],
  damp: ['ダンプ', 'Damp'],
  wet: ['ウェット', 'Wet'],
  'heavy-wet': ['ヘビーウェット', 'Heavy wet']
};

export const isWeather = (v: unknown): v is Weather => typeof v === 'string' && (WEATHERS as readonly string[]).includes(v);

/** 温度として読める値 (-30〜80 ℃) */
export const isTempC = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -30 && v <= 80;

/** 一覧に出す短い文 (例: ウェット · 気温 18℃ · 路面 22℃)。何も無ければ空 */
export function conditionsText(e: { weather?: unknown; airTempC?: unknown; trackTempC?: unknown } | null | undefined, ja: boolean): string {
  if (!e) return '';
  const out: string[] = [];
  if (isWeather(e.weather)) out.push(WEATHER_LABELS[e.weather][ja ? 0 : 1]);
  if (isTempC(e.airTempC)) out.push(`${ja ? '気温' : 'Air'} ${e.airTempC}℃`);
  if (isTempC(e.trackTempC)) out.push(`${ja ? '路面' : 'Track'} ${e.trackTempC}℃`);
  return out.join(' · ');
}
