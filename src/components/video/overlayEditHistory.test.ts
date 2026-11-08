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
    for (const x of [0.41, 0.42, 0.5]) state = reduce(state, { type: 'parts', parts: state.layout!.parts.map(p => p.id === 'new' ? { ...p, x } : p) });
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
});
