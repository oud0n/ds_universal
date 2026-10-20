import { describe, expect, it } from 'vitest';
import { courseFolder, UNSORTED_FOLDER } from './runRecorder';
import { CIRCUIT_PRESETS } from './circuitDatabase';

describe('記録のフォルダの名前 (サーキット名をローマ字に)', () => {
  it('英語表示の名前があれば、それを使う', () => {
    expect(courseFolder('袖ヶ浦フォレストレースウェイ (Sodegaura)')).toBe('Sodegaura_Forest_Raceway');
    expect(courseFolder('富士スピードウェイ (FSW)')).toBe('Fuji_Speedway_FSW');
  });
  it('なければ、かっこの中の英字を使う', () => {
    expect(courseFolder('明智ヒルトップサーキット (Akechi Hilltop Circuit)')).toBe('Akechi_Hilltop_Circuit');
  });
  it('かっこの中が日本語なら、前の英字を使う。アクセントは外す', () => {
    expect(courseFolder('Adams Motorsports Park (カート)')).toBe('Adams_Motorsports_Park');
    expect(courseFolder('Circuito de Jerez - Ángel Nieto')).toBe('Circuito_de_Jerez_-_Angel_Nieto');
  });
  it('英字が無い名前 (自分で置いたコースなど) は、名前ごとに決まった Course_ の名前', () => {
    const a = courseFolder('うちの近くのコース');
    expect(a).toMatch(/^Course_[0-9a-z]+$/);
    expect(courseFolder('うちの近くのコース')).toBe(a);
    expect(courseFolder('別のコース')).not.toBe(a);
  });
  it('上のフォルダへ出る名前・使えない文字は残らない', () => {
    expect(courseFolder('../A/B:C')).toBe('A_B_C');
    expect(courseFolder('a..b')).toBe('a_b');
  });
  it('名前が無ければ Unsorted', () => {
    expect(courseFolder('')).toBe(UNSORTED_FOLDER);
  });
  it('入っている全部のコースで、英字・数字と _ - . だけの名前になり、ほかのコースと重ならない', () => {
    const names = CIRCUIT_PRESETS.map(c => c.name);
    const folders = names.map(courseFolder);
    folders.forEach(f => expect(f).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/));
    const seen = new Map<string, string>();
    const dup: string[] = [];
    names.forEach((n, i) => { const o = seen.get(folders[i]); if (o && o !== n) dup.push(`${o} / ${n} -> ${folders[i]}`); seen.set(folders[i], n); });
    expect(dup).toEqual([]);
  });
});
