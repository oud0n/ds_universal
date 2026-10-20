import { describe, expect, it } from 'vitest';
import { courseFolder, UNSORTED_FOLDER } from './runRecorder';
import { CIRCUIT_PRESETS } from './circuitDatabase';
import { checkEnglishName, checkFolderName, guessEnglishName } from '../utils/courseNames';

describe('記録のフォルダの名前 (サーキット名をローマ字に)', () => {
  it('英語表示の名前があれば、それを使う', () => {
    expect(courseFolder('袖ヶ浦フォレストレースウェイ (Sodegaura)')).toBe('sodegaura_forest_raceway');
    expect(courseFolder('富士スピードウェイ (FSW)')).toBe('fuji_speedway_fsw');
  });
  it('なければ、かっこの中の英字を使う', () => {
    expect(courseFolder('明智ヒルトップサーキット (Akechi Hilltop Circuit)')).toBe('akechi_hilltop_circuit');
  });
  it('かっこの中が日本語なら、前の英字を使う。アクセントは外す', () => {
    expect(courseFolder('Adams Motorsports Park (カート)')).toBe('adams_motorsports_park');
    expect(courseFolder('Circuito de Jerez - Ángel Nieto')).toBe('circuito_de_jerez_angel_nieto');
  });
  it('英字が無い名前 (自分で置いたコースなど) は、名前ごとに決まった Course_ の名前', () => {
    const a = courseFolder('うちの近くのコース');
    expect(a).toMatch(/^course_[0-9a-z]+$/);
    expect(courseFolder('うちの近くのコース')).toBe(a);
    expect(courseFolder('別のコース')).not.toBe(a);
  });
  it('上のフォルダへ出る名前・使えない文字は残らない', () => {
    expect(courseFolder('../A/B:C')).toBe('a_b_c');
    expect(courseFolder('a..b')).toBe('a_b');
  });
  it('名前が無ければ Unsorted', () => {
    expect(courseFolder('')).toBe(UNSORTED_FOLDER);
  });
  it('入っているコースは、コースのファイルと同じ ID を使う (英小文字・数字と _ だけ)', () => {
    expect(courseFolder('袖ヶ浦フォレストレースウェイ (Sodegaura)', undefined, 'sodegaura')).toBe('sodegaura');
    CIRCUIT_PRESETS.forEach(c => expect(courseFolder(c.name, undefined, c.id)).toBe(c.id));
  });

  it('名前から作っても、入っている全部のコースで英小文字・数字と _ だけになり、ほかのコースと重ならない', () => {
    const names = CIRCUIT_PRESETS.map(c => c.name);
    const folders = names.map(n => courseFolder(n));
    folders.forEach(f => expect(f).toMatch(/^[a-z0-9][a-z0-9_]*$/));
    const seen = new Map<string, string>();
    const dup: string[] = [];
    names.forEach((n, i) => { const o = seen.get(folders[i]); if (o && o !== n) dup.push(`${o} / ${n} -> ${folders[i]}`); seen.set(folders[i], n); });
    expect(dup).toEqual([]);
  });
});

describe('コース編集の英語名・保存フォルダ名', () => {
  it('コース編集で付けたフォルダ名があれば、それを使う', () => {
    expect(courseFolder('うちの近くのコース (ユーザー設置)', 'uchi_kart')).toBe('uchi_kart');
    // 決まりに合わない名前 (古いデータなど) は使わない
    expect(courseFolder('My Track', '../bad')).toBe('my_track');
    expect(courseFolder('My Track', 'Uchi_Kart')).toBe('my_track');
  });
  it('英語名の候補は、確かめに通る形', () => {
    for (const n of CIRCUIT_PRESETS.map(c => c.name)) {
      const g = guessEnglishName(n);
      expect(g).not.toBe('');
      expect(checkEnglishName(g)).toBeNull();
    }
  });
  it('英語名: 全角の文字・記号は、使えない文字を挙げてエラーにする', () => {
    expect(checkEnglishName('Sodegaura Forest Raceway')).toBeNull();
    expect(checkEnglishName("Fuji Speedway (Short), Driver's & Co.")).toBeNull();
    expect(checkEnglishName('')?.ja).toBe('英語名を入れてください');
    expect(checkEnglishName('袖ヶ浦')?.ja).toContain('袖');
    expect(checkEnglishName('Ｓｏｄｅｇａｕｒａ')).not.toBeNull();
    expect(checkEnglishName('Sode/gaura')?.ja).toContain('/');
    expect(checkEnglishName('Track 🏁')).not.toBeNull();
    expect(checkEnglishName('---')).not.toBeNull();
    expect(checkEnglishName('a'.repeat(61))).not.toBeNull();
  });
  it('保存フォルダ名: 半角の英字・数字と _ - だけ。先頭は英字か数字', () => {
    expect(checkFolderName('sodegaura_forest_raceway2')).toBeNull();
    expect(checkFolderName('Sodegaura')).not.toBeNull();
    expect(checkFolderName('sode-gaura')?.ja).toContain('-');
    expect(checkFolderName('')).not.toBeNull();
    expect(checkFolderName('sodegaura forest')?.ja).toContain('(空白)');
    expect(checkFolderName('袖ヶ浦')).not.toBeNull();
    expect(checkFolderName('a.b')).not.toBeNull();
    expect(checkFolderName('..')).not.toBeNull();
    expect(checkFolderName('_sodegaura')?.ja).toContain('先頭');
    expect(checkFolderName('a'.repeat(61))).not.toBeNull();
  });
});
