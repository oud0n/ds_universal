import { describe, expect, it } from 'vitest';
import { sameCourseName } from './courseNames';

describe('sameCourseName (Car 2 として足せるか・比べられるか)', () => {
  it('同じ名前は同じコース', () => {
    expect(sameCourseName('袖ヶ浦フォレストレースウェイ (Sodegaura)', '袖ヶ浦フォレストレースウェイ (Sodegaura)')).toBe(true);
  });
  it('自分で直したコースの印が付いていても同じコース', () => {
    expect(sameCourseName('袖ヶ浦フォレストレースウェイ (Sodegaura) (ユーザー設置)', '袖ヶ浦フォレストレースウェイ (Sodegaura)')).toBe(true);
    expect(sameCourseName('袖ヶ浦フォレストレースウェイ (Sodegaura) (user)', '袖ヶ浦フォレストレースウェイ (Sodegaura)')).toBe(true);
  });
  it('違うコースは違う', () => {
    expect(sameCourseName('筑波サーキット コース2000 (TC2000)', '筑波サーキット コース1000 (TC1000)')).toBe(false);
    expect(sameCourseName('日光サーキット (Nikko Circuit)', '袖ヶ浦フォレストレースウェイ (Sodegaura)')).toBe(false);
    // 括弧の中 (コースの形の名前) だけが同じでも、違うコース
    expect(sameCourseName('鈴鹿サーキット (East)', '筑波サーキット (East)')).toBe(false);
  });
  it('名前がないときは同じとみなさない', () => {
    expect(sameCourseName(null, '袖ヶ浦フォレストレースウェイ (Sodegaura)')).toBe(false);
    expect(sameCourseName('', '')).toBe(false);
  });
});
