export type DebriefView = 'overview' | 'detail';
export type DebriefExit = 'active' | 'completed' | 'interrupted';

export interface DebriefState {
  readonly selectedInsightIndex: number | null;
  readonly view: DebriefView;
  readonly evidenceExpanded: boolean;
  readonly width: number;
  readonly height: number;
  readonly color: boolean;
  readonly exit: DebriefExit;
}

export type DebriefAction =
  | { readonly type: 'next-insight' }
  | { readonly type: 'previous-insight' }
  | { readonly type: 'open-detail' }
  | { readonly type: 'toggle-evidence' }
  | { readonly type: 'back' }
  | { readonly type: 'quit' }
  | { readonly type: 'interrupt' }
  | { readonly type: 'resize'; readonly width: number; readonly height: number };

export function createDebriefState(insightCount: number, width: number, height: number, color: boolean, initialInsightIndex: number | null): DebriefState {
  const count = Math.max(0, insightCount);
  return {
    selectedInsightIndex: count === 0 || initialInsightIndex === null ? null : modulo(initialInsightIndex, count),
    view: 'overview',
    evidenceExpanded: false,
    width: clampDimension(width),
    height: clampDimension(height),
    color,
    exit: 'active'
  };
}

export function reduceDebriefState(state: DebriefState, action: DebriefAction, insightCount: number): DebriefState {
  if (state.exit !== 'active' && action.type !== 'resize') return state;
  if (action.type === 'resize') return { ...state, width: clampDimension(action.width), height: clampDimension(action.height) };
  if (action.type === 'quit') return { ...state, exit: 'completed' };
  if (action.type === 'interrupt') return { ...state, exit: 'interrupted' };

  const count = Math.max(0, insightCount);
  if (action.type === 'next-insight' || action.type === 'previous-insight') {
    if (count === 0) return state.selectedInsightIndex === null ? state : { ...state, selectedInsightIndex: null, view: 'overview', evidenceExpanded: false };
    const selected = state.selectedInsightIndex ?? 0;
    const offset = action.type === 'next-insight' ? 1 : -1;
    return { ...state, selectedInsightIndex: modulo(selected + offset, count), view: 'overview', evidenceExpanded: false };
  }
  if (action.type === 'open-detail') return state.selectedInsightIndex === null ? state : { ...state, view: 'detail' };
  if (action.type === 'toggle-evidence') return state.selectedInsightIndex === null || state.view !== 'detail' ? state : { ...state, evidenceExpanded: !state.evidenceExpanded };
  if (action.type === 'back') return state.view === 'detail'
    ? { ...state, view: 'overview', evidenceExpanded: false }
    : { ...state, exit: 'completed' };
  return state;
}

function clampDimension(value: number): number { return Math.max(1, Math.floor(value)); }
function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }
