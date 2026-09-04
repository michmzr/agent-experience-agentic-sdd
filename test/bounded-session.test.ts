import assert from 'node:assert/strict';
import test from 'node:test';

import { createBoundedSessionAccumulator } from '../src/review/bounded-session.js';
import { normalizeSession, type LocalSessionRecord } from '../src/review/contracts.js';

function record(sourceOrdinal: number, occurredAt: string, text?: string): LocalSessionRecord {
  return { kind: 'message', occurredAt, sourceOrdinal, ...(text === undefined ? {} : { text }) };
}

test('retains the latest records while preserving complete session bounds', () => {
  const accumulator = createBoundedSessionAccumulator({ maxEvents: 3 });
  for (let index = 0; index < 5; index += 1) {
    accumulator.add(record(index, `2026-09-04T10:0${index}:00.000Z`));
  }

  const window = accumulator.finish();
  assert.deepEqual(window.records.map(({ sourceOrdinal }) => sourceOrdinal), [2, 3, 4]);
  assert.equal(window.startedAt, '2026-09-04T10:00:00.000Z');
  assert.equal(window.endedAt, '2026-09-04T10:04:00.000Z');
});

test('drops complete oldest text before removing retained metadata when over budget', () => {
  const accumulator = createBoundedSessionAccumulator({ maxTextBytes: 8 });
  accumulator.add(record(0, '2026-09-04T10:00:00.000Z', 'żółw'));
  accumulator.add(record(1, '2026-09-04T10:01:00.000Z', 'test'));

  const window = accumulator.finish();
  assert.deepEqual(window.records, [
    { kind: 'message', occurredAt: '2026-09-04T10:00:00.000Z', sourceOrdinal: 0 },
    { kind: 'message', occurredAt: '2026-09-04T10:01:00.000Z', sourceOrdinal: 1, text: 'test' }
  ]);
});

test('retains an oversized single record with its text omitted', () => {
  const accumulator = createBoundedSessionAccumulator({ maxTextBytes: 4 });
  accumulator.add(record(0, '2026-09-04T10:00:00.000Z', 'żółw'));

  assert.deepEqual(accumulator.finish().records, [
    { kind: 'message', occurredAt: '2026-09-04T10:00:00.000Z', sourceOrdinal: 0 }
  ]);
});

test('rejects an empty window', () => {
  assert.throws(() => createBoundedSessionAccumulator().finish(), /at least one/i);
});

test('assigns an unused implicit ordinal after an explicit ordinal', () => {
  const accumulator = createBoundedSessionAccumulator();
  accumulator.add(record(1, '2026-09-04T10:00:00.000Z'));
  accumulator.add({ kind: 'message', occurredAt: '2026-09-04T10:01:00.000Z' });

  assert.deepEqual(accumulator.finish().records.map(({ sourceOrdinal }) => sourceOrdinal), [1, 2]);
});

test('preserves source order and first and last source timestamps when records are out of chronological order', () => {
  const accumulator = createBoundedSessionAccumulator();
  accumulator.add(record(7, '2026-09-04T10:00:00.000Z'));
  accumulator.add(record(8, '2026-09-04T10:02:00.000Z'));
  accumulator.add(record(9, '2026-09-04T10:01:00.000Z'));

  const window = accumulator.finish();
  const session = normalizeSession({
    source: 'codex',
    artifact: { source: 'codex', id: 'source-order', location: '/fixture/session.jsonl', format: 'observed-jsonl' },
    records: window.records
  });

  assert.deepEqual(session.events.map(({ id }) => id), ['source-order:7', 'source-order:8', 'source-order:9']);
  assert.equal(window.startedAt, '2026-09-04T10:00:00.000Z');
  assert.equal(window.endedAt, '2026-09-04T10:01:00.000Z');
});

test('releases evicted ordinal bookkeeping while rejecting a collision in the retained tail', () => {
  const accumulator = createBoundedSessionAccumulator({ maxEvents: 2 });
  accumulator.add(record(0, '2026-09-04T10:00:00.000Z'));
  accumulator.add(record(1, '2026-09-04T10:01:00.000Z'));
  accumulator.add(record(0, '2026-09-04T10:02:00.000Z'));

  assert.deepEqual(accumulator.finish().records.map(({ sourceOrdinal }) => sourceOrdinal), [1, 0]);
  assert.throws(
    () => accumulator.add(record(0, '2026-09-04T10:03:00.000Z')),
    /ordinal is duplicated/i
  );
});
