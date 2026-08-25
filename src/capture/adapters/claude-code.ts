import type { NormalizedCaptureEvent } from '../contracts.js';
import { normalizeMappedCapture } from '../normalization.js';

const fields = ['eventId', 'sessionId', 'kind', 'timestamp', 'toolName', 'actionName', 'args', 'workingDirectory', 'verb', 'target', 'summary', 'outcome', 'exitStatus', 'relatedEventId'];

export function adaptClaudeCodeCapture(value: unknown): NormalizedCaptureEvent {
  const record = strictRecord(value);
  return normalizeMappedCapture({
    source: 'claude-code', sourceEventId: record.eventId, sessionId: record.sessionId,
    phase: mapKind(record.kind), occurredAt: record.timestamp, tool: record.toolName,
    action: record.actionName, arguments: record.args, path: record.workingDirectory,
    verb: record.verb, target: record.target, summary: record.summary, outcome: record.outcome,
    exitStatus: record.exitStatus, relatedEventId: record.relatedEventId
  });
}

function mapKind(value: unknown): unknown {
  if (value === 'UserIntent') return 'pre-intent';
  if (value === 'PreToolUse') return 'pre-action';
  if (value === 'PostToolUse') return 'post-result';
  return value;
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Claude Code capture must be an object.');
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !fields.includes(key));
  if (unexpected !== undefined) throw new TypeError(`Unsupported Claude Code capture field: ${unexpected}.`);
  return record;
}
