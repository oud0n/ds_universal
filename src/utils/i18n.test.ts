import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { circuitLabel } from './i18n';

describe('circuitLabel', () => {
  it('日本語のときはそのまま', () => {
    expect(circuitLabel('筑波サーキット コース2000 (TC2000)', 'ja')).toBe('筑波サーキット コース2000 (TC2000)');
  });
  it('表にある名前は表の英語名', () => {
    expect(circuitLabel('袖ヶ浦フォレストレースウェイ (Sodegaura)', 'en')).toBe('Sodegaura Forest Raceway');
  });
  it('表に無い名前は括弧の中の英語名', () => {
    expect(circuitLabel('茂原ツインサーキット (Mobara Twin Circuit)', 'en')).toBe('Mobara Twin Circuit');
  });
  it('後ろの日本語の書き添えも英語にする', () => {
    expect(circuitLabel('Adams Motorsports Park (カート)', 'en')).toBe('Adams Motorsports Park (kart)');
    expect(circuitLabel('袖ヶ浦フォレストレースウェイ (Sodegaura) (ユーザー設置)', 'en')).toBe('Sodegaura Forest Raceway (user)');
    expect(circuitLabel('うちの近所 (ユーザー設置)', 'en')).toBe('うちの近所 (user)');
  });
  it('英語の名前や括弧の中も英語の名前はそのまま', () => {
    expect(circuitLabel('Circuit Bugatti (Le Mans)', 'en')).toBe('Circuit Bugatti (Le Mans)');
    expect(circuitLabel('THE MAGARIGAWA CLUB', 'en')).toBe('THE MAGARIGAWA CLUB');
  });
  it('内蔵のコースは英語のとき日本語の文字が残らない', () => {
    const idx = JSON.parse(readFileSync(new URL('../../courses/index.json', import.meta.url), 'utf8'));
    const names: string[] = (Array.isArray(idx) ? idx : idx.courses).map((c: { name: string }) => c.name);
    const left = names.filter(n => /[^\x00-\x7fÀ-ɏ]/.test(circuitLabel(n, 'en')));
    expect(left).toEqual([]);
  });
});
