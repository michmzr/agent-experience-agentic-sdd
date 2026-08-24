import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverCursorExports, readCursorMarkdownExport } from '../src/review/adapters/cursor.js';

function exportRoot(): string { return mkdtempSync(join(tmpdir(), 'ael-cursor-')); }

test('discovers only explicit regular Markdown exports in the supplied root', () => {
  const root = exportRoot();
  writeFileSync(join(root, 'review.md'), '# Cursor chat\n\n## User\nImplement the change.\n\n## Assistant\nDone.\n');
  writeFileSync(join(root, 'ignored.json'), '{}');

  assert.deepEqual(discoverCursorExports(root), [{ source: 'cursor', id: 'review', location: join(root, 'review.md'), format: 'markdown-export' }]);
});

test('normalizes Markdown export headings without retaining message content', () => {
  const root = exportRoot(); const artifact = join(root, 'review.md');
  writeFileSync(artifact, '# Cursor chat\n\n## User\npassword=never-copy\n\n## Assistant\nFinished review.\n');

  const session = readCursorMarkdownExport({ source: 'cursor', id: 'review', location: artifact, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z');

  assert.deepEqual(session.events.map((event) => ({ kind: event.kind, outcome: event.outcome })), [{ kind: 'message', outcome: 'unknown' }, { kind: 'message', outcome: 'unknown' }]);
  assert.equal(JSON.stringify(session).includes('never-copy'), false);
});

test('rejects a symlinked or out-of-root export before reading it', () => {
  const root = exportRoot(); const external = join(exportRoot(), 'external.md'); const linked = join(root, 'linked.md');
  writeFileSync(external, '## User\nprivate'); symlinkSync(external, linked);

  assert.throws(() => readCursorMarkdownExport({ source: 'cursor', id: 'linked', location: linked, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z'), /symlink/i);
  assert.throws(() => readCursorMarkdownExport({ source: 'cursor', id: 'outside', location: external, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z'), /outside/i);
});
