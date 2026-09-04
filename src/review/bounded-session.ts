import {
  MAX_NORMALIZED_SESSION_EVENTS,
  MAX_SESSION_REVIEW_TEXT_LENGTH,
  type LocalSessionRecord
} from './contracts.js';

export interface BoundedSessionWindow {
  readonly records: readonly LocalSessionRecord[];
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface BoundedSessionAccumulator {
  add(record: LocalSessionRecord): void;
  finish(): BoundedSessionWindow;
}

export function createBoundedSessionAccumulator(limits: { readonly maxEvents?: number; readonly maxTextBytes?: number } = {}): BoundedSessionAccumulator {
  const maxEvents = limits.maxEvents ?? MAX_NORMALIZED_SESSION_EVENTS;
  const maxTextBytes = limits.maxTextBytes ?? MAX_SESSION_REVIEW_TEXT_LENGTH;
  assertLimit(maxEvents, 'Maximum retained events');
  assertLimit(maxTextBytes, 'Maximum retained text bytes');

  const records: LocalSessionRecord[] = [];
  const usedOrdinals = new Set<number>();
  let nextOrdinal = 0;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let startedAtMillis = Number.POSITIVE_INFINITY;
  let endedAtMillis = Number.NEGATIVE_INFINITY;
  let textBytes = 0;

  return {
    add(record): void {
      const occurredAtMillis = Date.parse(record.occurredAt);
      if (!Number.isFinite(occurredAtMillis)) throw new Error('Session record timestamp is invalid.');
      if (record.sourceOrdinal !== undefined && (!Number.isSafeInteger(record.sourceOrdinal) || record.sourceOrdinal < 0)) {
        throw new Error('Session record ordinal is invalid.');
      }
      while (usedOrdinals.has(nextOrdinal)) nextOrdinal += 1;
      if (!Number.isSafeInteger(nextOrdinal)) throw new Error('Session record ordinal is invalid.');
      const sourceOrdinal = record.sourceOrdinal ?? nextOrdinal;
      if (usedOrdinals.has(sourceOrdinal)) throw new Error('Session record ordinal is duplicated.');
      usedOrdinals.add(sourceOrdinal);
      nextOrdinal = Math.max(nextOrdinal, sourceOrdinal + 1);
      const text = record.text;
      const retainedText = typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= maxTextBytes ? text : undefined;
      const retainedRecord: LocalSessionRecord = {
        ...record,
        sourceOrdinal,
        ...(retainedText === undefined ? { text: undefined } : { text: retainedText })
      };
      if (retainedText === undefined) delete (retainedRecord as { text?: string }).text;
      records.push(retainedRecord);
      textBytes += retainedText === undefined ? 0 : Buffer.byteLength(retainedText, 'utf8');
      if (occurredAtMillis < startedAtMillis) {
        startedAtMillis = occurredAtMillis;
        startedAt = record.occurredAt;
      }
      if (occurredAtMillis > endedAtMillis) {
        endedAtMillis = occurredAtMillis;
        endedAt = record.occurredAt;
      }
      while (records.length > maxEvents) {
        const removed = records.shift()!;
        if (typeof removed.text === 'string') textBytes -= Buffer.byteLength(removed.text, 'utf8');
      }
      for (const retained of records) {
        if (textBytes <= maxTextBytes) break;
        if (typeof retained.text === 'string') {
          textBytes -= Buffer.byteLength(retained.text, 'utf8');
          delete (retained as { text?: string }).text;
        }
      }
    },
    finish(): BoundedSessionWindow {
      if (records.length === 0 || startedAt === undefined || endedAt === undefined) {
        throw new Error('A session must contain at least one retained record.');
      }
      return {
        records: [...records].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)),
        startedAt,
        endedAt
      };
    }
  };
}

function assertLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
}
