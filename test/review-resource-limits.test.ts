import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexSessionAdapter } from '../src/review/adapters/codex.js';
import { discoverClaudeCodeArtifacts, normalizeClaudeCodeArtifact } from '../src/review/adapters/claude-code.js';
import { readCursorMarkdownExport } from '../src/review/adapters/cursor.js';
import {
  MAX_NORMALIZED_SESSION_EVENTS,
  MAX_SESSION_ARTIFACT_BYTES,
  MAX_SESSION_EVENT_TEXT_LENGTH,
  MAX_SESSION_REVIEW_TEXT_LENGTH,
  normalizeSession,
  type LocalSessionRecord
} from '../src/review/contracts.js';
import { sanitizeForReview } from '../src/review/sanitizer.js';

const timestamp = '2026-08-24T12:00:00.000Z';

test('sanitizes complete untrusted text before truncating reviewer-visible output', () => {
  const privateKey = '-----BEGIN PRIVATE KEY-----\nboundary-secret-material\n-----END PRIVATE KEY-----';
  const normalized = normalizeSession({
    source: 'codex',
    artifact: { source: 'codex', id: 'boundary', location: '/fixture/boundary.jsonl', format: 'observed-jsonl' },
    records: [{ kind: 'message', occurredAt: timestamp, text: `${'x'.repeat(MAX_SESSION_EVENT_TEXT_LENGTH - 20)}${privateKey}` }]
  });
  const artifact = sanitizeForReview(normalized);
  const serialized = JSON.stringify(artifact);

  assert.equal(serialized.includes('boundary-secret-material'), false);
  assert.equal(serialized.includes('BEGIN PRIVATE KEY'), false);
  assert.equal((artifact.session.events[0]?.text?.length ?? 0) <= MAX_SESSION_EVENT_TEXT_LENGTH, true);
});

test('enforces normalized event-count and aggregate text limits at their boundaries', () => {
  const record = (index: number): LocalSessionRecord => ({ kind: 'message', occurredAt: timestamp, text: `event-${index}` });
  assert.doesNotThrow(() => normalizeSession({
    source: 'codex', artifact: artifact('event-boundary'), records: Array.from({ length: MAX_NORMALIZED_SESSION_EVENTS }, (_, index) => record(index))
  }));
  assert.throws(
    () => normalizeSession({
      source: 'codex', artifact: artifact('event-over-limit'), records: Array.from({ length: MAX_NORMALIZED_SESSION_EVENTS + 1 }, (_, index) => record(index))
    }),
    (error: unknown) => genericLimitError(error, 'event-over-limit')
  );

  assert.doesNotThrow(() => normalizeSession({
    source: 'codex', artifact: artifact('text-boundary'), records: [{ kind: 'message', occurredAt: timestamp, text: 'x'.repeat(MAX_SESSION_REVIEW_TEXT_LENGTH) }]
  }));
  assert.throws(
    () => normalizeSession({
      source: 'codex', artifact: artifact('text-over-limit'), records: [{ kind: 'message', occurredAt: timestamp, text: 'x'.repeat(MAX_SESSION_REVIEW_TEXT_LENGTH + 1) }]
    }),
    (error: unknown) => genericLimitError(error, 'text-over-limit')
  );
});

test('all adapters reject over-limit artifacts without exposing source paths or values', async () => {
  const marker = 'source-value-must-not-leak';
  const oversized = `${marker}${'x'.repeat(MAX_SESSION_ARTIFACT_BYTES)}`;

  const codexRoot = mkdtempSync(join(tmpdir(), 'ael-codex-over-limit-'));
  writeFileSync(join(codexRoot, 'oversized.jsonl'), JSON.stringify({ kind: 'message', occurredAt: timestamp, text: oversized }));
  await assert.rejects(
    () => new CodexSessionAdapter(codexRoot).read('oversized.jsonl'),
    (error: unknown) => genericLimitError(error, marker, codexRoot)
  );

  const claudeConfig = mkdtempSync(join(tmpdir(), 'ael-claude-over-limit-')); const project = 'workspace';
  const claudeRoot = join(claudeConfig, 'projects', project); mkdirSync(claudeRoot, { recursive: true });
  writeFileSync(join(claudeRoot, 'oversized.jsonl'), JSON.stringify({ type: 'message', timestamp, message: oversized }));
  const [claudeArtifact] = await discoverClaudeCodeArtifacts({ configDir: claudeConfig, project });
  await assert.rejects(
    () => normalizeClaudeCodeArtifact(claudeArtifact!),
    (error: unknown) => genericLimitError(error, marker, claudeConfig)
  );

  const cursorRoot = mkdtempSync(join(tmpdir(), 'ael-cursor-over-limit-')); const cursorPath = join(cursorRoot, 'oversized.md');
  writeFileSync(cursorPath, `## User\n${oversized}`);
  assert.throws(
    () => readCursorMarkdownExport({ source: 'cursor', id: 'oversized', location: cursorPath, format: 'markdown-export' }, cursorRoot, timestamp),
    (error: unknown) => genericLimitError(error, marker, cursorRoot)
  );
});

function artifact(id: string) {
  return { source: 'codex' as const, id, location: '/fixture/session.jsonl', format: 'observed-jsonl' as const };
}

function genericLimitError(error: unknown, ...sensitiveValues: readonly string[]): boolean {
  return error instanceof Error
    && /resource limit/i.test(error.message)
    && sensitiveValues.every((value) => !error.message.includes(value));
}
