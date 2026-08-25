import type { NormalizedCaptureEvent } from '../contracts.js';
import { normalizeMappedCapture } from '../normalization.js';

const fields = ['event_id', 'session_id', 'event_kind', 'occurred_at', 'tool', 'action', 'arguments', 'cwd', 'verb', 'target', 'summary', 'outcome', 'exit_status', 'related_event_id'];

export function adaptCodexCapture(value: unknown): NormalizedCaptureEvent {
  const record = strictRecord(value, fields);
  return normalizeMappedCapture({
    source: 'codex', sourceEventId: record.event_id, sessionId: record.session_id,
    phase: mapKind(record.event_kind), occurredAt: record.occurred_at, tool: record.tool,
    action: record.action, arguments: record.arguments, path: record.cwd, verb: record.verb,
    target: record.target, summary: record.summary, outcome: record.outcome,
    exitStatus: record.exit_status, relatedEventId: record.related_event_id
  });
}

function mapKind(value: unknown): unknown {
  if (value === 'pre_intent') return 'pre-intent';
  if (value === 'pre_action') return 'pre-action';
  if (value === 'post_result') return 'post-result';
  return value;
}

function strictRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Codex capture must be an object.');
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new TypeError(`Unsupported Codex capture field: ${unexpected}.`);
  return record;
}
