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

test('rejects a symlinked discovery root without enumerating or exposing the external path', () => {
  const containingRoot = exportRoot(); const externalRoot = exportRoot(); const linkedRoot = join(containingRoot, 'linked-root');
  writeFileSync(join(externalRoot, 'private-session.md'), '## User\nprivate'); symlinkSync(externalRoot, linkedRoot);

  let message = '';
  try { discoverCursorExports(linkedRoot); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }

  assert.match(message, /symlink/i);
  assert.equal(message.includes(externalRoot), false);
  assert.equal(message.includes('private-session.md'), false);
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

test('rejects an export reached through a symlinked ancestor without exposing its path', () => {
  const root = exportRoot(); const externalRoot = exportRoot(); const linkedDirectory = join(root, 'linked');
  const external = join(externalRoot, 'private-session.md');
  writeFileSync(external, '## User\nprivate'); symlinkSync(externalRoot, linkedDirectory);

  const artifact = { source: 'cursor' as const, id: 'private-session', location: join(linkedDirectory, 'private-session.md'), format: 'markdown-export' as const };
  let message = '';
  try { readCursorMarkdownExport(artifact, root, '2026-08-24T12:00:00.000Z'); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }

  assert.match(message, /symlink/i);
  assert.equal(message.includes(externalRoot), false);
  assert.equal(message.includes('private-session.md'), false);
});

test('rejects a symlinked export root without exposing the external path', () => {
  const containingRoot = exportRoot(); const externalRoot = exportRoot(); const linkedRoot = join(containingRoot, 'linked-root');
  const external = join(externalRoot, 'private-session.md');
  writeFileSync(external, '## User\nprivate'); symlinkSync(externalRoot, linkedRoot);

  const artifact = { source: 'cursor' as const, id: 'private-session', location: join(linkedRoot, 'private-session.md'), format: 'markdown-export' as const };
  let message = '';
  try { readCursorMarkdownExport(artifact, linkedRoot, '2026-08-24T12:00:00.000Z'); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }

  assert.match(message, /symlink/i);
  assert.equal(message.includes(externalRoot), false);
  assert.equal(message.includes('private-session.md'), false);
});
