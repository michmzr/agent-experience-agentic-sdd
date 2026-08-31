import type { SessionId } from '../../domain/types.js';
import { containsCredentialMaterial } from '../../privacy/structured-arguments.js';
import { MAX_CAPTURE_IDENTIFIER_LENGTH } from '../contracts.js';
import { normalizeMappedCapture } from '../normalization.js';
import type { PassiveCaptureRecord } from '../passive-service.js';
import { technicalSignature } from './technical-signature.js';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/;

export function adaptCursorPassiveHook(payload: unknown, receivedAt: string, repositoryId?: import('../../domain/types.js').Session['repositoryId']): PassiveCaptureRecord | undefined {
  assertCanonicalTimestamp(receivedAt);
  const record = hookRecord(payload);
  switch (record.hook_event_name) {
    case 'sessionStart':
      return Object.freeze({
        kind: 'session-start',
        session: Object.freeze({ id: lifecycleSessionId(record), source: 'cursor', startedAt: receivedAt, ...(repositoryId === undefined ? {} : { repositoryId }) })
      });
    case 'sessionEnd':
      return Object.freeze({
        kind: 'session-end',
        source: 'cursor',
        sessionId: lifecycleSessionId(record),
        endedAt: receivedAt
      });
    case 'preToolUse':
      return technical(record, 'pre-action', receivedAt);
    case 'postToolUse':
      return technical(record, 'post-result', receivedAt);
    default:
      return undefined;
  }
}

function technical(
  record: Readonly<Record<string, unknown>>,
  phase: 'pre-action' | 'post-result',
  receivedAt: string
): PassiveCaptureRecord | undefined {
  const toolName = stringField(record.tool_name);
  const signature = technicalSignature({
    toolName,
    toolInput: record.tool_input,
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {})
  });
  if (signature === undefined) return undefined;
  const toolUseId = stringField(record.tool_use_id);
  const exitStatus = phase === 'post-result' ? optionalExitStatus(record) : undefined;
  const sourceEventId = `${toolUseId}:${phase === 'pre-action' ? 'pre' : 'post'}`;
  return Object.freeze({
    kind: 'technical',
    event: normalizeMappedCapture({
      source: 'cursor',
      sourceEventId,
      sessionId: technicalSessionId(record),
      phase,
      occurredAt: receivedAt,
      tool: signature.tool,
      action: signature.action,
      arguments: signature.arguments,
      path: signature.path,
      summary: signature.summary,
      ...(phase === 'post-result' ? {
        outcome: outcome(exitStatus),
        ...(exitStatus === undefined ? {} : { exitStatus }),
        relatedEventId: `${toolUseId}:pre`
      } : {})
    })
  });
}

function hookRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw rejected();
  return value as Readonly<Record<string, unknown>>;
}

function lifecycleSessionId(record: Readonly<Record<string, unknown>>): SessionId {
  return identifier(record.conversation_id ?? record.session_id) as SessionId;
}

function technicalSessionId(record: Readonly<Record<string, unknown>>): SessionId {
  return identifier(record.conversation_id) as SessionId;
}

function stringField(value: unknown): string {
  if (typeof value !== 'string') throw rejected();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_CAPTURE_IDENTIFIER_LENGTH
    || value !== value.trim()
    || !identifierPattern.test(value)
    || containsCredentialMaterial(value)) {
    throw rejected();
  }
  return value;
}

function optionalExitStatus(record: Readonly<Record<string, unknown>>): number | undefined {
  const value = record.exit_status ?? record.exitStatus ?? record.exit_code;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw rejected();
  return value as number;
}

function outcome(exitStatus: number | undefined): 'succeeded' | 'failed' | 'unknown' {
  if (exitStatus === undefined) return 'unknown';
  return exitStatus === 0 ? 'succeeded' : 'failed';
}

function assertCanonicalTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('Passive hook receivedAt must be canonical ISO time.');
  }
}

function rejected(): TypeError {
  return new TypeError('Passive hook payload is unsupported.');
}
