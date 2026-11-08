import { SMALL_PARTS, type OverlayLayout, type OverlayPart } from '../../services/overlayLayout';

type Target = 'large' | 'small';
type GestureOwner = 'layer' | 'range' | 'label';
type Snapshot = { parts: OverlayPart[]; small: OverlayPart[] | undefined; target: Target };
export type EditHistory = {
  layout: OverlayLayout | null;
  target: Target;
  past: Snapshot[];
  gesture: GestureOwner | null;
  recorded: boolean;
};
export type EditAction =
  | { type: 'load'; layout: OverlayLayout | null | ((layout: OverlayLayout | null) => OverlayLayout | null) }
  | { type: 'target'; target: Target }
  | { type: 'name'; name: [string, string] }
  | { type: 'parts'; parts: OverlayPart[] }
  | { type: 'begin' | 'end'; owner?: GestureOwner }
  | { type: 'undo' };

export const EMPTY_EDIT_HISTORY: EditHistory = { layout: null, target: 'large', past: [], gesture: null, recorded: false };

function sameParts(a: OverlayPart[], b: OverlayPart[]): boolean {
  return a.length === b.length && a.every((part, i) => {
    const other = b[i];
    const keys = Object.keys(part) as (keyof OverlayPart)[];
    return keys.length === Object.keys(other).length && keys.every(key => Object.is(part[key], other[key]));
  });
}

/** 保存・読込み・並びの切替で履歴を区切る。ドラッグは最初の変更だけを記録する。 */
export function overlayEditReducer(state: EditHistory, action: EditAction): EditHistory {
  switch (action.type) {
    case 'load': return {
      ...EMPTY_EDIT_HISTORY, target: state.target,
      layout: typeof action.layout === 'function' ? action.layout(state.layout) : action.layout
    };
    case 'target': return { ...state, target: action.target, gesture: null, recorded: false };
    case 'name': return state.layout ? { ...state, layout: { ...state.layout, name: action.name } } : state;
    case 'begin': return { ...state, gesture: action.owner ?? 'layer', recorded: false };
    case 'end': return action.owner && action.owner !== state.gesture ? state : { ...state, gesture: null, recorded: false };
    case 'parts': {
      const layout = state.layout;
      if (!layout) return state;
      const current = state.target === 'small' ? layout.small ?? SMALL_PARTS : layout.parts;
      if (sameParts(current, action.parts)) return state;
      const previous = { parts: layout.parts, small: layout.small, target: state.target };
      return {
        ...state,
        layout: state.target === 'small' ? { ...layout, small: action.parts } : { ...layout, parts: action.parts },
        past: state.gesture && state.recorded ? state.past : [...state.past.slice(-99), previous],
        recorded: !!state.gesture
      };
    }
    case 'undo': {
      // ネイティブのrange操作中は、mouseup/keyupまで待つ。独自ドラッグは呼出し元で中断してから戻す。
      if (state.gesture) return state;
      const previous = state.past[state.past.length - 1];
      if (!state.layout || !previous) return state;
      return {
        ...state, layout: { ...state.layout, parts: previous.parts, small: previous.small },
        target: previous.target, past: state.past.slice(0, -1), gesture: null, recorded: false
      };
    }
  }
}
