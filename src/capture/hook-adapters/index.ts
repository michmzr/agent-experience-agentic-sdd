import { adaptCodexPassiveHook } from './codex.js';
import type { PassiveHookAdapter, PassiveHookSource } from './contracts.js';
import { adaptCursorPassiveHook } from './cursor.js';
import type { PassiveCaptureRecord } from '../passive-service.js';
import type { Session } from '../../domain/types.js';

const adapters: Readonly<Record<PassiveHookSource, PassiveHookAdapter>> = Object.freeze({
  codex: Object.freeze({ adapt: adaptCodexPassiveHook }),
  cursor: Object.freeze({ adapt: adaptCursorPassiveHook })
});

export function adaptPassiveHook(
  source: PassiveHookSource,
  payload: unknown,
  receivedAt: string,
  repositoryId?: Session['repositoryId']
): PassiveCaptureRecord | undefined {
  return adapters[source].adapt(payload, receivedAt, repositoryId);
}

export type { PassiveHookAdapter, PassiveHookSource } from './contracts.js';
export { MAX_HOOK_INPUT_BYTES } from './contracts.js';
