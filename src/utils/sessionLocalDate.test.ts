import { describe, expect, it } from 'vitest';
import { sessionLocalDate } from './timeFormat';

describe('sessionLocalDate (画面に出す走った日)', () => {
  it('端末の時刻での日付にする (UTC では前の日になる早朝の走行も、その日)', () => {
    const early = new Date(2026, 9, 12, 7, 5); // 端末の時刻で 10/12 7:05
    expect(sessionLocalDate({ date: '2026-10-11', points: [{ timestamp: early }] })).toBe('2026-10-12');
    expect(sessionLocalDate({ date: '2026-10-11', points: [{}, { timestamp: early.toISOString() }] })).toBe('2026-10-12');
  });
  it('時刻がなければ Session.date のまま', () => {
    expect(sessionLocalDate({ date: '2026-10-11', points: [{}] })).toBe('2026-10-11');
    expect(sessionLocalDate({ date: '2026-10-11', points: [{ timestamp: 'bad' }] })).toBe('2026-10-11');
  });
});
