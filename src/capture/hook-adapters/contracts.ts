import type { AgentSource } from '../../domain/types.js';
import type { Session } from '../../domain/types.js';
import type { PassiveCaptureRecord } from '../passive-service.js';
import type { CursorCaptureDiagnosticCategory } from '../hook-diagnostics.js';

export type PassiveHookSource = Extract<AgentSource, 'codex' | 'cursor'>;

export const MAX_HOOK_INPUT_BYTES = 65_536;

export interface PassiveHookAdapter {
  adapt(payload: unknown, receivedAt: string, repositoryId?: Session['repositoryId']): PassiveCaptureRecord | undefined;
}

export type CursorHookAdaptation =
  | { readonly state: 'accepted'; readonly record: PassiveCaptureRecord }
  | { readonly state: 'ignored' }
  | {
    readonly state: 'diagnostic';
    readonly category: Exclude<CursorCaptureDiagnosticCategory, 'persistence-failure'>;
    readonly ingressCode?: 'INVALID_INPUT' | 'PRIVATE_INPUT';
  };
