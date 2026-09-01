import * as readline from 'node:readline';

import type { SessionDebrief } from './debrief-model.js';
import { renderSessionDebrief } from './debrief-renderer.js';
import { createDebriefState, reduceDebriefState, type DebriefAction, type DebriefState } from './debrief-state.js';

export interface DebriefKey { readonly name: string; readonly ctrl: boolean; }
export interface DebriefTerminalSize { readonly width: number; readonly height: number; }
export interface DebriefTerminalHost {
  readonly interactive: boolean;
  readonly color: boolean;
  size(): DebriefTerminalSize;
  enter(): void;
  writeFrame(frame: string): void;
  subscribe(handlers: {
    readonly key: (key: DebriefKey) => void;
    readonly resize: (size: DebriefTerminalSize) => void;
    readonly end: () => void;
    readonly error: () => void;
    readonly interrupt: () => void;
  }): () => void;
  leave(): void;
}
export type DebriefRunResult =
  | { readonly status: 'completed' }
  | { readonly status: 'interrupted' }
  | { readonly status: 'unavailable' };

export async function runSessionDebrief(model: SessionDebrief, host: DebriefTerminalHost): Promise<DebriefRunResult> {
  if (!host.interactive) return { status: 'unavailable' };

  return new Promise<DebriefRunResult>((resolve) => {
    let state: DebriefState;
    let unsubscribe: (() => void) | undefined;
    let entered = false;
    let finished = false;

    const finish = (result: DebriefRunResult): void => {
      if (finished) return;
      finished = true;
      try { unsubscribe?.(); } catch { /* cleanup must continue */ }
      try { if (entered) host.leave(); } catch { /* cleanup must still resolve */ }
      resolve(result);
    };
    const redraw = (): boolean => {
      try { host.writeFrame(renderSessionDebrief(model, state)); return true; }
      catch { finish({ status: 'unavailable' }); return false; }
    };
    const apply = (action: DebriefAction): void => {
      if (finished) return;
      const next = reduceDebriefState(state, action, model.insights.length);
      if (next === state) return;
      state = next;
      if (state.exit === 'completed') { finish({ status: 'completed' }); return; }
      if (state.exit === 'interrupted') { finish({ status: 'interrupted' }); return; }
      redraw();
    };

    try {
      const size = host.size();
      state = createDebriefState(model.insights.length, size.width, size.height, host.color, model.initialInsightIndex);
      entered = true;
      host.enter();
      unsubscribe = host.subscribe({
        key: (key) => { const action = actionForKey(key); if (action) apply(action); },
        resize: (nextSize) => apply({ type: 'resize', width: nextSize.width, height: nextSize.height }),
        end: () => finish({ status: 'completed' }),
        error: () => finish({ status: 'unavailable' }),
        interrupt: () => finish({ status: 'interrupted' })
      });
      redraw();
    } catch {
      finish({ status: 'unavailable' });
    }
  });
}

function actionForKey(key: DebriefKey): DebriefAction | undefined {
  if (key.ctrl && key.name === 'c') return { type: 'interrupt' };
  if (key.name === 'down' || key.name === 'j') return { type: 'next-insight' };
  if (key.name === 'up' || key.name === 'k') return { type: 'previous-insight' };
  if (key.name === 'return') return { type: 'open-detail' };
  if (key.name === 'd') return { type: 'toggle-evidence' };
  if (key.name === 'escape') return { type: 'back' };
  if (key.name === 'q') return { type: 'quit' };
  return undefined;
}

export function createProcessDebriefTerminalHost(): DebriefTerminalHost {
  const input = process.stdin;
  const output = process.stdout;
  const interactive = Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
  const color = Boolean(output.isTTY && !('NO_COLOR' in process.env));
  let entered = false;
  let rawMode = false;

  return {
    interactive,
    color,
    size: () => ({ width: output.columns || 1, height: output.rows || 1 }),
    enter: () => {
      output.write(enterScreen);
      rawMode = input.isRaw === true;
      input.setRawMode?.(true);
      input.resume();
      entered = true;
    },
    writeFrame: (frame) => { output.write(`${clearAndHome}${frame}`); },
    subscribe: (handlers) => {
      const key = (_value: string, keypress: { name?: string; ctrl?: boolean }) => handlers.key({ name: keypress.name ?? '', ctrl: keypress.ctrl === true });
      const resize = () => handlers.resize({ width: output.columns || 1, height: output.rows || 1 });
      const end = () => handlers.end();
      const error = () => handlers.error();
      const interrupt = () => handlers.interrupt();
      readline.emitKeypressEvents(input);
      input.on('keypress', key);
      output.on('resize', resize);
      input.on('end', end);
      input.on('error', error);
      process.on('SIGINT', interrupt);
      return () => {
        input.removeListener('keypress', key);
        output.removeListener('resize', resize);
        input.removeListener('end', end);
        input.removeListener('error', error);
        process.removeListener('SIGINT', interrupt);
      };
    },
    leave: () => {
      if (!entered) return;
      entered = false;
      try { input.setRawMode?.(rawMode); }
      finally { output.write(leaveScreen); }
    }
  };
}

const enterScreen = '\u001b[?1049h\u001b[?25l';
const clearAndHome = '\u001b[2J\u001b[H';
const leaveScreen = '\u001b[?25h\u001b[?1049l';
