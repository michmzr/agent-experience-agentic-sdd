import type { NormalizedCaptureEvent } from '../contracts.js';
import { normalizeMappedCapture } from '../normalization.js';

const fields = ['id', 'session', 'event', 'timestamp', 'tool', 'action', 'arguments', 'workspacePath', 'verb', 'target', 'summary', 'outcome', 'exitCode', 'relatedEventId'];

export function adaptCursorCapture(value: unknown): NormalizedCaptureEvent {
  const record = strictRecord(value);
  return normalizeMappedCapture({
    source: 'cursor', sourceEventId: record.id, sessionId: record.session,
    phase: mapKind(record.event), occurredAt: record.timestamp, tool: record.tool,
    action: record.action, arguments: record.arguments, path: record.workspacePath,
    verb: record.verb, target: record.target, summary: record.summary, outcome: record.outcome,
    exitStatus: record.exitCode, relatedEventId: record.relatedEventId
  });
}

function mapKind(value: unknown): unknown {
  if (value === 'before-intent') return 'pre-intent';
  if (value === 'before-action') return 'pre-action';
  if (value === 'after-action') return 'post-result';
  return value;
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Cursor capture must be an object.');
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !fields.includes(key));
  if (unexpected !== undefined) throw new TypeError(`Unsupported Cursor capture field: ${unexpected}.`);
  return record;
}
