import { describe, expect, it } from 'vitest';
import { BUILTIN_LAYOUTS, SMALL_PARTS } from '../../services/overlayLayout';
import { EMPTY_EDIT_HISTORY, overlayEditReducer as reduce } from './overlayEditHistory';

const start = () => reduce(EMPTY_EDIT_HISTORY, { type: 'load', layout: BUILTIN_LAYOUTS[0] });

describe('メーター編集のUndo', () => {
  it('ドラッグ中の複数の移動を1回で戻し、前の追加も別に戻す', () => {
    let state = start();
    const original = state.layout!;
    state = reduce(state, { type: 'parts', parts: [...original.parts, { id: 'new', type: 'speed', x: 0.4, y: 0.4, w: 0.1, h: 0.1 }] });
    const added = state.layout!;
    state = reduce(state, { type: 'begin' });
    for (const x of [0.41, 0.42, 0.5]) state = reduce(state, { type: 'parts', owner: 'layer', parts: state.layout!.parts.map(p => p.id === 'new' ? { ...p, x } : p) });
    state = reduce(state, { type: 'end' });
    expect(state.past).toHaveLength(2);
    state = reduce(state, { type: 'undo' });
    expect(state.layout).toEqual(added);
    state = reduce(state, { type: 'undo' });
    expect(state.layout).toEqual(original);
    expect(reduce(state, { type: 'undo' })).toBe(state);
  });

  it('小さな枠の初回編集を戻すと既定へ戻り、Undo対象の枠も表示する', () => {
    const original = { ...BUILTIN_LAYOUTS[0], small: undefined };
    let state = reduce(EMPTY_EDIT_HISTORY, { type: 'load', layout: original });
    state = reduce(state, { type: 'target', target: 'small' });
    state = reduce(state, { type: 'parts', parts: SMALL_PARTS.slice(1) });
    state = reduce(state, { type: 'target', target: 'large' });
    state = reduce(state, { type: 'undo' });
    expect(state.target).toBe('small');
    expect(state.layout!.small).toBeUndefined();
    expect(state.layout!.parts).toBe(original.parts);
  });

  it('動かないクリックや同じ値への変更では履歴を増やさない', () => {
    let state = start();
    state = reduce(state, { type: 'begin' });
    state = reduce(state, { type: 'parts', parts: state.layout!.parts.map(p => ({ ...p })) });
    state = reduce(state, { type: 'end' });
    expect(state.past).toHaveLength(0);
  });

  it('省略値とundefined、同じチャンネル配列は同じ変更として扱う', () => {
    const parts = [
      { id: 'bar', type: 'bar' as const, channel: 'speed' as const, x: 0, y: 0, w: 0.2, h: 0.2 },
      { id: 'graph', type: 'graph' as const, channels: ['speed' as const], x: 0, y: 0, w: 0.2, h: 0.2 }
    ];
    const state = reduce(EMPTY_EDIT_HISTORY, { type: 'load', layout: { ...BUILTIN_LAYOUTS[0], parts } });
    const next = reduce(state, { type: 'parts', parts: parts.map(p => p.type === 'bar' ? { ...p, label: undefined } : { ...p, channels: ['speed'] }) });
    expect(next).toBe(state);
  });

  it('元へ戻したドラッグ・ラベル編集を履歴に残さず、前の操作を戻せる', () => {
    let state = start();
    const original = state.layout!;
    state = reduce(state, { type: 'parts', parts: original.parts.slice(1) });
    const before = state.layout!;
    state = reduce(state, { type: 'begin', owner: 'layer' });
    state = reduce(state, { type: 'parts', owner: 'layer', parts: before.parts.map(p => ({ ...p, x: 0.5 })) });
    state = reduce(state, { type: 'parts', owner: 'layer', parts: before.parts });
    state = reduce(state, { type: 'end', owner: 'layer' });
    expect(state.past).toHaveLength(1);
    expect(reduce(state, { type: 'undo' }).layout).toEqual(original);
  });

  it('小さな枠を元に戻したら既定への委譲も保ち、次の操作を混ぜない', () => {
    let state = reduce(EMPTY_EDIT_HISTORY, { type: 'load', layout: { ...BUILTIN_LAYOUTS[0], small: undefined } });
    state = reduce(state, { type: 'target', target: 'small' });
    state = reduce(state, { type: 'begin', owner: 'layer' });
    state = reduce(state, { type: 'parts', owner: 'layer', parts: SMALL_PARTS.slice(1) });
    state = reduce(state, { type: 'parts', owner: 'layer', parts: SMALL_PARTS });
    state = reduce(state, { type: 'parts', parts: SMALL_PARTS.slice(1) });
    expect(state.past).toHaveLength(1);
    expect(state.past[0].small).toBeUndefined();
    expect(reduce(state, { type: 'undo' }).layout!.small).toBeUndefined();
  });

  it('削除・設定変更を順番に戻し、保存や並び切替で履歴を区切る', () => {
    let state = start();
    const original = state.layout!;
    state = reduce(state, { type: 'parts', parts: original.parts.slice(1) });
    const deleted = state.layout!;
    state = reduce(state, { type: 'parts', parts: deleted.parts.map((p, i) => i === 0 ? { ...p, opacity: 0.4 } : p) });
    state = reduce(state, { type: 'undo' });
    expect(state.layout).toEqual(deleted);
    state = reduce(state, { type: 'undo' });
    expect(state.layout).toEqual(original);
    state = reduce(state, { type: 'parts', parts: original.parts.slice(1) });
    state = reduce(state, { type: 'load', layout: layout => ({ ...layout!, id: 'user:saved' }) });
    expect(state.past).toHaveLength(0);
    state = reduce(state, { type: 'load', layout: null });
    expect(state.layout).toBeNull();
  });

  it('履歴は100操作までに制限する', () => {
    let state = start();
    for (let n = 0; n < 110; n++) state = reduce(state, { type: 'parts', parts: state.layout!.parts.map((p, i) => i === 0 ? { ...p, x: n / 1000 } : p) });
    expect(state.past).toHaveLength(100);
  });
  it('名前だけ変えても部品のUndo履歴を保ち、Undoで新しい名前は変えない', () => {
    let state = start();
    const parts = state.layout!.parts;
    state = reduce(state, { type: 'parts', parts: parts.slice(1) });
    state = reduce(state, { type: 'name', name: ['新しい名前', 'New name'] });
    state = reduce(state, { type: 'undo' });
    expect(state.layout!.parts).toBe(parts);
    expect(state.layout!.name).toEqual(['新しい名前', 'New name']);
  });
  it('ネイティブつまみの操作中はUndoを待ち、操作終了後に1回で戻す', () => {
    let state = start();
    const original = state.layout;
    state = reduce(state, { type: 'begin', owner: 'range' });
    for (let n = 1; n < 15; n++) state = reduce(state, { type: 'parts', owner: 'range', parts: state.layout!.parts.map((p, i) => i === 0 ? { ...p, opacity: n / 20 } : p) });
    expect(reduce(state, { type: 'undo' })).toBe(state);
    expect(state.past).toHaveLength(1);
    state = reduce(state, { type: 'end' });
    expect(reduce(state, { type: 'undo' }).layout).toEqual(original);
  });
  it('古い描画レイヤーの終了で、設定欄の操作を終了しない', () => {
    let state = start();
    state = reduce(state, { type: 'begin', owner: 'range' });
    expect(reduce(state, { type: 'end', owner: 'layer' })).toBe(state);
    expect(reduce(state, { type: 'end', owner: 'label' })).toBe(state);
    state = reduce(state, { type: 'end', owner: 'range' });
    expect(state.gesture).toBeNull();
  });
  it('色の連続入力はまとめ、次の無関係な編集を同じ操作へ混ぜない', () => {
    let state = start();
    for (const color of ['#ff0000', '#ee1100', '#dd2200']) state = reduce(state, { type: 'parts', owner: 'color', parts: state.layout!.parts.map((p, i) => i === 0 ? { ...p, color } : p) });
    expect(state.past).toHaveLength(1);
    state = reduce(state, { type: 'parts', parts: state.layout!.parts.slice(1) });
    expect(state.past).toHaveLength(2);
    expect(state.gesture).toBeNull();
    expect(reduce(state, { type: 'undo' }).layout!.parts[0]).toMatchObject({ color: '#dd2200' });
  });
});
