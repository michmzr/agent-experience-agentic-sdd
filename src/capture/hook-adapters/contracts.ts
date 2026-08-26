import type { AgentSource } from '../../domain/types.js';
import type { PassiveCaptureRecord } from '../passive-service.js';

export type PassiveHookSource = Extract<AgentSource, 'codex' | 'cursor'>;

export const MAX_HOOK_INPUT_BYTES = 65_536;

export interface PassiveHookAdapter {
  adapt(payload: unknown, receivedAt: string): PassiveCaptureRecord | undefined;
}
