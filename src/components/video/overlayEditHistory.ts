import { SMALL_PARTS, type OverlayLayout, type OverlayPart } from '../../services/overlayLayout';

type Target = 'large' | 'small';
export type GestureOwner = 'layer' | 'range' | 'label' | 'color';
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
  | { type: 'parts'; parts: OverlayPart[]; owner?: GestureOwner }
  | { type: 'begin' | 'end'; owner?: GestureOwner }
  | { type: 'undo' };

export const EMPTY_EDIT_HISTORY: EditHistory = { layout: null, target: 'large', past: [], gesture: null, recorded: false };

function sameParts(a: OverlayPart[], b: OverlayPart[]): boolean {
  return a.length === b.length && a.every((part, i) => {
    const other = b[i];
    const keys = new Set([...Object.keys(part), ...Object.keys(other)] as (keyof OverlayPart)[]);
    return [...keys].every(key => {
      const left = part[key], right = other[key];
      return Array.isArray(left) && Array.isArray(right)
        ? left.length === right.length && left.every((value, index) => value === right[index])
        : Object.is(left, right);
    });
  });
}

function finishGesture(state: EditHistory): EditHistory {
  const previous = state.past[state.past.length - 1];
  const unchanged = state.recorded && state.layout && previous && previous.target === state.target
    && sameParts(previous.parts, state.layout.parts)
    && sameParts(previous.small ?? SMALL_PARTS, state.layout.small ?? SMALL_PARTS);
  return {
    ...state,
    layout: unchanged ? { ...state.layout!, parts: previous.parts, small: previous.small } : state.layout,
    past: unchanged ? state.past.slice(0, -1) : state.past, gesture: null, recorded: false
  };
}

/** 保存・読込み・並びの切替で履歴を区切る。ドラッグは最初の変更だけを記録する。 */
export function overlayEditReducer(state: EditHistory, action: EditAction): EditHistory {
  switch (action.type) {
    case 'load': return {
      ...EMPTY_EDIT_HISTORY, target: state.target,
      layout: typeof action.layout === 'function' ? action.layout(state.layout) : action.layout
    };
    case 'target': return { ...finishGesture(state), target: action.target };
    case 'name': return state.layout ? { ...state, layout: { ...state.layout, name: action.name } } : state;
    case 'begin': return { ...finishGesture(state), gesture: action.owner ?? 'layer' };
    case 'end': return action.owner && action.owner !== state.gesture ? state : finishGesture(state);
    case 'parts': {
      let layout = state.layout;
      if (!layout) return state;
      const current = state.target === 'small' ? layout.small ?? SMALL_PARTS : layout.parts;
      if (sameParts(current, action.parts)) return state;
      if (state.gesture && action.owner !== state.gesture) {
        state = finishGesture(state); layout = state.layout!;
      }
      const previous = { parts: layout.parts, small: layout.small, target: state.target };
      return {
        ...state,
        layout: state.target === 'small' ? { ...layout, small: action.parts } : { ...layout, parts: action.parts },
        past: action.owner && action.owner === state.gesture && state.recorded ? state.past : [...state.past.slice(-99), previous],
        gesture: action.owner ?? null,
        recorded: !!action.owner
      };
    }
    case 'undo': {
      // 継続操作は呼出し元で終えてから戻す。ポインタのrange操作はmouseupまで待つ。
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
