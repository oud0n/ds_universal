import { beforeEach, describe, expect, it } from 'vitest';
import { profileFor, type Capabilities } from './appProfile';
import { navPlan } from './navPlan';
import { navStore, parseHash } from './navStore';

const all: Capabilities = { hasLibrary: true, hasLapTimer: true, hasLogger: true, hasBle: true };
const none: Capabilities = { hasLibrary: false, hasLapTimer: false, hasLogger: false, hasBle: false };

describe('組み方', () => {
  it('どこで動いているかと広さで決まる', () => {
    expect(profileFor('native', true, all).kind).toBe('app-phone');
    expect(profileFor('native', false, all).kind).toBe('app-tablet');
    expect(profileFor('electron', false, all).kind).toBe('desktop');
    expect(profileFor('electron', true, all).kind).toBe('browser-phone');
    expect(profileFor('browser', true, none).kind).toBe('browser-phone');
    expect(profileFor('browser', false, none).kind).toBe('browser-desktop');
  });

  it('どの組み方でも、並べる画面と最初の画面はその環境にあるもの', () => {
    for (const host of ['native', 'electron', 'browser'] as const) {
      for (const compact of [true, false]) {
        for (const caps of [all, none]) {
          const plan = navPlan(profileFor(host, compact, caps));
          expect(plan.available.has(plan.home)).toBe(true);
          for (const s of [...plan.primary, ...plan.more]) expect(plan.available.has(s)).toBe(true);
          expect(plan.available.has('settings')).toBe(true);
          if (!caps.hasLibrary) expect(plan.available.has('library')).toBe(false);
          if (!caps.hasLogger) expect(plan.available.has('logger')).toBe(false);
          if (!caps.hasLapTimer) expect(plan.available.has('timer')).toBe(false);
        }
      }
    }
  });

  it('iPhone のアプリは 下のタブ (タイマー / 走行 / 解析 / 動画) で、走行から始める', () => {
    const plan = navPlan(profileFor('native', true, all));
    expect(plan.chrome).toBe('bottom');
    expect(plan.primary).toEqual(['timer', 'library', 'analysis', 'video']);
    expect(plan.home).toBe('library');
    expect(plan.more).toContain('data');
  });

  it('ブラウザ版は上のタブで、解析から始める (保管場所はない)', () => {
    const plan = navPlan(profileFor('browser', false, { ...none, hasLogger: true }));
    expect(plan.chrome).toBe('top');
    expect(plan.home).toBe('analysis');
    expect(plan.primary).toEqual(['analysis', 'video', 'data', 'convert', 'logger']);
  });
});

describe('画面の切り替え', () => {
  const phone = navPlan(profileFor('native', true, all));
  const browser = navPlan(profileFor('browser', false, none));
  beforeEach(() => navStore.resetForTest());

  it('URL の末尾: 前の名前 (#graph) も読み、その環境にない画面は読まない', () => {
    expect(parseHash('#graph', browser)).toBe('analysis');
    expect(parseHash('#convert', browser)).toBe('convert');
    expect(parseHash('#laptimer', browser)).toBeNull();
    expect(parseHash('#laptimer', phone)).toBe('timer');
    expect(parseHash('#openrun=x/y', phone)).toBeNull();
    expect(parseHash('', phone)).toBeNull();
  });

  it('はじめは最初の画面。組み方が変わって今の画面がなくなったら最初の画面へ', () => {
    navStore.init(phone);
    expect(navStore.getSnapshot().screen).toBe('library');
    navStore.go('timer');
    navStore.init(browser);
    expect(navStore.getSnapshot().screen).toBe('analysis');
  });

  it('⚙ の中の画面は、戻ると来た画面へ', () => {
    navStore.init(phone);
    navStore.go('video');
    navStore.go('data');
    expect(navStore.getSnapshot()).toMatchObject({ screen: 'data', from: 'video' });
    navStore.back();
    expect(navStore.getSnapshot()).toMatchObject({ screen: 'video', from: null });
  });

  it('測っている間はほかの画面へ行けない。ない画面へは行かない', () => {
    navStore.init(phone);
    navStore.go('timer');
    navStore.setLocked(true);
    navStore.go('analysis');
    expect(navStore.getSnapshot().screen).toBe('timer');
    navStore.setLocked(false);
    navStore.go('analysis');
    expect(navStore.getSnapshot().screen).toBe('analysis');
    navStore.init(browser);
    navStore.go('library');
    expect(navStore.getSnapshot().screen).toBe('analysis');
  });
});
