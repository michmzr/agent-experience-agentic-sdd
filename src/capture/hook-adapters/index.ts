import { adaptCodexPassiveHook } from './codex.js';
import type { PassiveHookAdapter, PassiveHookSource } from './contracts.js';
import { adaptCursorPassiveHook } from './cursor.js';
import type { PassiveCaptureRecord } from '../passive-service.js';
import type { Session } from '../../domain/types.js';

const adapters: Readonly<Record<'codex', PassiveHookAdapter>> = Object.freeze({
  codex: Object.freeze({ adapt: adaptCodexPassiveHook })
});

export function adaptPassiveHook(
  source: PassiveHookSource,
  payload: unknown,
  receivedAt: string,
  repositoryId?: Session['repositoryId']
): PassiveCaptureRecord | undefined {
  if (source === 'codex') return adapters.codex.adapt(payload, receivedAt, repositoryId);
  const adaptation = adaptCursorPassiveHook(payload, receivedAt, repositoryId);
  return adaptation.state === 'accepted' ? adaptation.record : undefined;
}

export { adaptCursorPassiveHook } from './cursor.js';
export type { CursorHookAdaptation, PassiveHookAdapter, PassiveHookSource } from './contracts.js';
export { MAX_HOOK_INPUT_BYTES } from './contracts.js';
export { cursorCaptureDiagnosticCategories } from '../hook-diagnostics.js';
export type { CursorCaptureDiagnosticCategory } from '../hook-diagnostics.js';
