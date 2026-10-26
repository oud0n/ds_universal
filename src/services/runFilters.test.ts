import { describe, expect, it } from 'vitest';
import { NO_FILTER, conditionsOf, effectiveFilter, filterOptions, hasValues, matchesFilter } from './runFilters';

describe('車種・タイヤ・天候の絞り込み (PLAN-37)', () => {
  const a = conditionsOf({ car: 'ロードスター', tyre: 'RE-71RS', weather: 'wet' });
  const b = conditionsOf({ car: 'ロードスター', tyre: 'A052' });
  const ref = conditionsOf({ car: '自分の車', reference: { car: 'GR86' } });
  const none = conditionsOf({});

  it('参考ラップの車は参考ラップの欄のもの', () => {
    expect(ref.car).toBe('GR86');
    expect(conditionsOf({ car: '  ', weather: 'snow' })).toEqual({});
  });

  it('絞り込みに合うか (未設定は none)', () => {
    expect(matchesFilter(a, NO_FILTER)).toBe(true);
    expect(matchesFilter(a, { car: 'ロードスター', tyre: null, weather: 'wet' })).toBe(true);
    expect(matchesFilter(b, { car: 'ロードスター', tyre: null, weather: 'wet' })).toBe(false);
    expect(matchesFilter(b, { car: null, tyre: null, weather: 'none' })).toBe(true);
    expect(matchesFilter(none, { car: 'none', tyre: 'none', weather: 'none' })).toBe(true);
  });

  it('選べる値と件数。書いた値の無い項目は出さない。今の一覧に無い値は絞らない', () => {
    const o = filterOptions([a, b, none]);
    expect(o.car.get('ロードスター')).toBe(2);
    expect(o.car.get('none')).toBe(1);
    expect(hasValues(o.weather)).toBe(true);
    expect(hasValues(filterOptions([b, none]).weather)).toBe(false);
    expect(effectiveFilter({ car: 'GR86', tyre: null, weather: 'wet' }, o)).toEqual({ car: null, tyre: null, weather: 'wet' });
  });
});
