import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { readBoundedJsonl } from '../src/review/adapters/bounded-jsonl.js';
import { MAX_SESSION_ARTIFACT_BYTES, MAX_SESSION_ARTIFACT_LINE_BYTES } from '../src/review/contracts.js';

async function fixturePath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'ael-bounded-jsonl-')), name);
}

async function sparseJsonl(path: string, byteLength: number): Promise<void> {
  const handle = await open(path, 'w+');
  try {
    await handle.truncate(byteLength);
    for (let offset = MAX_SESSION_ARTIFACT_LINE_BYTES - 1; offset < byteLength; offset += MAX_SESSION_ARTIFACT_LINE_BYTES) {
      await handle.write(Buffer.from('\n'), 0, 1, offset);
    }
  } finally {
    await handle.close();
  }
}

test('reads LF and CRLF lines in order and ignores blank lines', async () => {
  const path = await fixturePath('lines.jsonl');
  await writeFile(path, 'first\n\r\nsecond\r\n\nthird');
  const lines: string[] = [];

  await readBoundedJsonl({
    path,
    async onLine(line) { lines.push(line); },
    streamFactory(streamPath) { return createReadStream(streamPath, { highWaterMark: 3 }); }
  });

  assert.deepEqual(lines, ['first', 'second', 'third']);
});

test('sanitizes callback failures without exposing input content', async () => {
  const path = await fixturePath('callback-error.jsonl');
  const marker = 'callback-secret-marker';
  await writeFile(path, `first\n${marker}\nlast\n`);

  await assert.rejects(
    () => readBoundedJsonl({ path, onLine(line) { if (line === marker) throw new Error(marker); } }),
    (error: unknown) => error instanceof Error && error.message === 'Session artifact could not be read.' && !error.message.includes(marker)
  );
});

test('accepts an artifact at the byte limit and rejects one byte over it', async () => {
  const atLimit = await fixturePath('at-limit.jsonl');
  await sparseJsonl(atLimit, MAX_SESSION_ARTIFACT_BYTES);
  let received = 0;

  await readBoundedJsonl({ path: atLimit, onLine() { received += 1; } });
  assert.equal(received, MAX_SESSION_ARTIFACT_BYTES / MAX_SESSION_ARTIFACT_LINE_BYTES);

  const overLimit = await fixturePath('over-limit.jsonl');
  await sparseJsonl(overLimit, MAX_SESSION_ARTIFACT_BYTES + 1);
  await assert.rejects(
    () => readBoundedJsonl({ path: overLimit, onLine() {} }),
    (error: unknown) => error instanceof Error && error.message === 'Session artifact could not be read.'
  );
});

test('accepts a nonempty line at the line limit and rejects one byte over it', async () => {
  const atLimit = await fixturePath('line-at-limit.jsonl');
  await writeFile(atLimit, 'x'.repeat(MAX_SESSION_ARTIFACT_LINE_BYTES));
  const lines: string[] = [];

  await readBoundedJsonl({ path: atLimit, onLine(line) { lines.push(line); } });
  assert.equal(Buffer.byteLength(lines[0] ?? '', 'utf8'), MAX_SESSION_ARTIFACT_LINE_BYTES);

  const overLimit = await fixturePath('line-over-limit.jsonl');
  await writeFile(overLimit, 'x'.repeat(MAX_SESSION_ARTIFACT_LINE_BYTES + 1));
  await assert.rejects(
    () => readBoundedJsonl({ path: overLimit, onLine() {} }),
    (error: unknown) => error instanceof Error && error.message === 'Session artifact could not be read.'
  );
});

test('hands an oversized record to its overflow sink before reading the following line', async () => {
  const path = await fixturePath('overflow-handoff.jsonl');
  const oversized = Buffer.from('x'.repeat(MAX_SESSION_ARTIFACT_LINE_BYTES + 1));
  await writeFile(path, Buffer.concat([oversized, Buffer.from('\r\nafter\n')]));
  const received: Buffer[] = [];
  const lines: string[] = [];
  let factoryCalls = 0;
  let finishCalls = 0;
  let observedOrdinal = -1;

  await readBoundedJsonl({
    path,
    onLine(line) { lines.push(line); },
    overflowRecordFactory({ prefix, sourceOrdinal }) {
      factoryCalls += 1;
      observedOrdinal = sourceOrdinal;
      received.push(prefix);
      return {
        write(chunk) { received.push(chunk); },
        finish() { finishCalls += 1; }
      };
    },
    streamFactory(streamPath) { return createReadStream(streamPath, { highWaterMark: 1024 }); }
  });

  assert.equal(factoryCalls, 1);
  assert.equal(observedOrdinal, 0);
  assert.equal(finishCalls, 1);
  assert.deepEqual(Buffer.concat(received), oversized);
  assert.deepEqual(lines, ['after']);
});

test('turns stream failures into a generic error and destroys the stream', async () => {
  const path = await fixturePath('stream-error.jsonl');
  const marker = 'stream-secret-marker';
  let stream: PassThrough | undefined;

  await assert.rejects(
    () => readBoundedJsonl({
      path,
      onLine() {},
      streamFactory() {
        stream = new PassThrough();
        queueMicrotask(() => stream?.destroy(new Error(marker)));
        return stream as unknown as ReturnType<typeof createReadStream>;
      }
    }),
    (error: unknown) => error instanceof Error && error.message === 'Session artifact could not be read.' && !error.message.includes(marker)
  );
  assert.equal(stream?.destroyed, true);
});
