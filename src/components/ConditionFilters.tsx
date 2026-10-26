import React from 'react';
import { useT } from '../utils/i18n';
import { WEATHERS, WEATHER_LABELS, isWeather } from '../services/runWeather';
import { NONE, hasValues, type ConditionFilter, type filterOptions } from '../services/runFilters';

/**
 * 車種・タイヤ・天候の絞り込み (ドロップダウン。PLAN-37)。書いた走行がある項目だけ出す (使わない人には出さない)
 */
export const ConditionFilters: React.FC<{
  filter: ConditionFilter;
  options: ReturnType<typeof filterOptions>;
  onChange: (f: ConditionFilter) => void;
  /** 選びの見た目 (並べる親に合わせる) */
  selectClass?: string;
  testIdPrefix: string;
}> = ({ filter, options, onChange, selectClass = '', testIdPrefix }) => {
  const t = useT();
  const ja = t('ja', 'en') === 'ja';
  const base = `min-w-0 bg-surface-2 border rounded-lg text-xs px-2 py-1.5 cursor-pointer ${selectClass}`;
  const cls = (on: boolean) => `${base} ${on ? 'border-cyan-500 text-cyan-200' : 'border-line-2 text-slate-200'}`;
  const text = (key: 'car' | 'tyre', v: string) => (v === NONE ? t('未設定', 'Not set') : v);
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => (a[0] === NONE ? 1 : b[0] === NONE ? -1 : a[0].localeCompare(b[0], 'ja')));
  return (
    <>
      {(['car', 'tyre'] as const).filter(k => hasValues(options[k])).map(k => (
        <select key={k} value={filter[k] ?? ''} onChange={e => onChange({ ...filter, [k]: e.target.value || null })}
          className={cls(filter[k] !== null)} aria-label={k === 'car' ? t('車種', 'Car') : t('タイヤ', 'Tyres')} data-testid={`${testIdPrefix}-${k}`}>
          <option value="">{k === 'car' ? t('車種: すべて', 'Car: all') : t('タイヤ: すべて', 'Tyres: all')}</option>
          {sorted(options[k]).map(([v, n]) => <option key={v} value={v}>{text(k, v)} ({n})</option>)}
        </select>
      ))}
      {hasValues(options.weather) && (
        <select value={filter.weather ?? ''} onChange={e => { const v = e.target.value; onChange({ ...filter, weather: v === NONE ? NONE : isWeather(v) ? v : null }); }}
          className={cls(filter.weather !== null)} aria-label={t('天候', 'Weather')} data-testid={`${testIdPrefix}-weather`}>
          <option value="">{t('天候: すべて', 'Weather: all')}</option>
          {[...WEATHERS, NONE].filter(w => options.weather.has(w)).map(w => (
            <option key={w} value={w}>{w === NONE ? t('未設定', 'Not set') : WEATHER_LABELS[w as typeof WEATHERS[number]][ja ? 0 : 1]} ({options.weather.get(w)})</option>
          ))}
        </select>
      )}
    </>
  );
};
