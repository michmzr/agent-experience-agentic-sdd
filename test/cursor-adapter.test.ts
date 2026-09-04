import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverCursorExports, readCursorMarkdownExport } from '../src/review/adapters/cursor.js';
import { MAX_SESSION_ARTIFACT_BYTES, MAX_SESSION_ARTIFACT_LINE_BYTES, MAX_SESSION_REVIEW_TEXT_LENGTH } from '../src/review/contracts.js';

function exportRoot(): string { return mkdtempSync(join(tmpdir(), 'ael-cursor-')); }

test('discovers only explicit regular Markdown exports in the supplied root', () => {
  const root = exportRoot();
  writeFileSync(join(root, 'review.md'), '# Cursor chat\n\n## User\nImplement the change.\n\n## Assistant\nDone.\n');
  writeFileSync(join(root, 'ignored.json'), '{}');

  const [artifact] = discoverCursorExports(root);
  assert.deepEqual(
    { source: artifact?.source, id: artifact?.id, location: artifact?.location, format: artifact?.format, repositoryHint: artifact?.repositoryHint, repositoryHintVerified: artifact?.repositoryHintVerified },
    { source: 'cursor', id: 'review', location: join(root, 'review.md'), format: 'markdown-export', repositoryHint: undefined, repositoryHintVerified: undefined }
  );
  assert.equal(Number.isFinite(Date.parse(artifact?.updatedAt ?? '')), true);
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

test('normalizes bounded Markdown message evidence for later sanitization', async () => {
  const root = exportRoot(); const artifact = join(root, 'review.md');
  writeFileSync(artifact, '# Cursor chat\n\n## User\npassword=never-copy\n\n## Assistant\nFinished review.\n');

  const session = await readCursorMarkdownExport({ source: 'cursor', id: 'review', location: artifact, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z');

  assert.deepEqual(session.events.map((event) => ({ kind: event.kind, text: event.text, outcome: event.outcome })), [
    { kind: 'message', text: 'password=never-copy', outcome: 'unknown' },
    { kind: 'message', text: 'Finished review.', outcome: 'unknown' }
  ]);
});

test('rejects a symlinked or out-of-root export before reading it', async () => {
  const root = exportRoot(); const external = join(exportRoot(), 'external.md'); const linked = join(root, 'linked.md');
  writeFileSync(external, '## User\nprivate'); symlinkSync(external, linked);

  await assert.rejects(() => readCursorMarkdownExport({ source: 'cursor', id: 'linked', location: linked, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z'), /symlink/i);
  await assert.rejects(() => readCursorMarkdownExport({ source: 'cursor', id: 'outside', location: external, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z'), /outside/i);
});

test('rejects an export reached through a symlinked ancestor without exposing its path', async () => {
  const root = exportRoot(); const externalRoot = exportRoot(); const linkedDirectory = join(root, 'linked');
  const external = join(externalRoot, 'private-session.md');
  writeFileSync(external, '## User\nprivate'); symlinkSync(externalRoot, linkedDirectory);

  const artifact = { source: 'cursor' as const, id: 'private-session', location: join(linkedDirectory, 'private-session.md'), format: 'markdown-export' as const };
  let message = '';
  try { await readCursorMarkdownExport(artifact, root, '2026-08-24T12:00:00.000Z'); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }

  assert.match(message, /symlink/i);
  assert.equal(message.includes(externalRoot), false);
  assert.equal(message.includes('private-session.md'), false);
});

test('rejects a symlinked export root without exposing the external path', async () => {
  const containingRoot = exportRoot(); const externalRoot = exportRoot(); const linkedRoot = join(containingRoot, 'linked-root');
  const external = join(externalRoot, 'private-session.md');
  writeFileSync(external, '## User\nprivate'); symlinkSync(externalRoot, linkedRoot);

  const artifact = { source: 'cursor' as const, id: 'private-session', location: join(linkedRoot, 'private-session.md'), format: 'markdown-export' as const };
  let message = '';
  try { await readCursorMarkdownExport(artifact, linkedRoot, '2026-08-24T12:00:00.000Z'); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }

  assert.match(message, /symlink/i);
  assert.equal(message.includes(externalRoot), false);
  assert.equal(message.includes('private-session.md'), false);
});

test('retains the newest 1024 Cursor messages with stable source ordinals', async () => {
  const root = exportRoot(); const artifact = join(root, 'review.md');
  writeFileSync(artifact, Array.from({ length: 1026 }, (_, index) => `## ${index % 2 === 0 ? 'User' : 'Assistant'}\nmessage-${index}`).join('\n'));

  const session = await readCursorMarkdownExport({ source: 'cursor', id: 'review', location: artifact, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z');

  assert.deepEqual(session.events.map(({ id }) => id), Array.from({ length: 1024 }, (_, index) => `review:${index + 2}`));
  assert.deepEqual(session.events.map(({ text }) => text), Array.from({ length: 1024 }, (_, index) => `message-${index + 2}`));
});

test('accepts a Markdown line at the shared 4 MiB boundary', async () => {
  const root = exportRoot(); const artifact = join(root, 'review.md');
  writeFileSync(artifact, `## User\n${'x'.repeat(MAX_SESSION_ARTIFACT_LINE_BYTES)}`);

  const session = await readCursorMarkdownExport({ source: 'cursor', id: 'review', location: artifact, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z');

  assert.equal(session.events.length, 1);
  assert.equal(session.events[0]?.text, undefined);
});

test('accepts an exact 64 MiB export with ignored pre-heading lines', async () => {
  const root = exportRoot(); const artifact = join(root, 'review.md');
  const heading = '## User\n'; const body = 'retained';
  let remaining = MAX_SESSION_ARTIFACT_BYTES - Buffer.byteLength(heading) - Buffer.byteLength(body);
  const ignoredLines: string[] = [];
  while (remaining > 0) {
    const length = Math.min(MAX_SESSION_ARTIFACT_LINE_BYTES, remaining - 1);
    ignoredLines.push(`${'x'.repeat(length)}\n`);
    remaining -= length + 1;
  }
  writeFileSync(artifact, `${ignoredLines.join('')}${heading}${body}`);

  const session = await readCursorMarkdownExport({ source: 'cursor', id: 'review', location: artifact, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z');

  assert.deepEqual(session.events.map(({ text }) => text), ['retained']);
});

test('rejects a 1-byte-over export without leaking its marker or root', async () => {
  const root = exportRoot(); const artifact = join(root, 'review.md'); const marker = 'cursor-over-limit-marker';
  writeFileSync(artifact, marker); truncateSync(artifact, MAX_SESSION_ARTIFACT_BYTES + 1);

  let message = '';
  try { await readCursorMarkdownExport({ source: 'cursor', id: 'review', location: artifact, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z'); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }

  assert.match(message, /resource limit/i);
  assert.equal(message.includes(marker), false);
  assert.equal(message.includes(root), false);
});

test('drops a message larger than 256 KiB while preserving its metadata', async () => {
  const root = exportRoot(); const artifact = join(root, 'review.md');
  writeFileSync(artifact, `## User\n${'x'.repeat(MAX_SESSION_REVIEW_TEXT_LENGTH + 1)}\n## Assistant\nretained`);

  const session = await readCursorMarkdownExport({ source: 'cursor', id: 'review', location: artifact, format: 'markdown-export' }, root, '2026-08-24T12:00:00.000Z');

  assert.deepEqual(session.events.map(({ id, kind, text }) => ({ id, kind, text })), [
    { id: 'review:0', kind: 'message', text: undefined },
    { id: 'review:1', kind: 'message', text: 'retained' }
  ]);
});
