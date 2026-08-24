import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexSessionAdapter } from '../src/review/adapters/codex.js';
import { discoverClaudeCodeArtifacts, normalizeClaudeCodeArtifact } from '../src/review/adapters/claude-code.js';
import { readCursorMarkdownExport } from '../src/review/adapters/cursor.js';
import { MAX_SESSION_EVENT_TEXT_LENGTH, normalizeSession } from '../src/review/contracts.js';
import { SanitizationError, sanitizeForReview } from '../src/review/sanitizer.js';

const timestamp = '2026-08-24T12:00:00.000Z';

test('all source adapters preserve only representative allowlisted session text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-session-text-'));
  const codexRoot = join(root, 'codex'); mkdirSync(codexRoot);
  writeFileSync(join(codexRoot, 'session.jsonl'), [
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Codex prompt', ignored: 'raw-codex-field' } },
    { timestamp, type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: 'Codex response' }], ignored: 'raw-response-field' } },
    { timestamp, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: 'Codex arguments', ignored: 'raw-call-field' } },
    { timestamp, type: 'response_item', payload: { type: 'function_call_output', output: 'Codex output', ignored: 'raw-output-field' } }
  ].map((value) => JSON.stringify(value)).join('\n'));

  const claudeConfig = join(root, 'claude'); const project = 'workspace'; const claudeRoot = join(claudeConfig, 'projects', project);
  mkdirSync(claudeRoot, { recursive: true });
  writeFileSync(join(claudeRoot, 'session.jsonl'), [
    { type: 'message', timestamp, message: { content: 'Claude prompt', ignored: 'raw-message-field' } },
    { type: 'message', timestamp, message: 'Claude response', ignored: 'raw-record-field' },
    { type: 'tool', timestamp, tool_name: 'Bash', input: { command: 'Claude arguments', ignored: 'raw-input-field' }, output: 'Claude output' }
  ].map((value) => JSON.stringify(value)).join('\n'));

  const cursorRoot = join(root, 'cursor'); mkdirSync(cursorRoot); const cursorExport = join(cursorRoot, 'session.md');
  writeFileSync(cursorExport, '# Export\n\n## User\nCursor prompt\n\n## Assistant\nCursor response\n');

  const codex = await new CodexSessionAdapter(codexRoot).read('session.jsonl');
  const [claudeArtifact] = await discoverClaudeCodeArtifacts({ configDir: claudeConfig, project });
  const claude = await normalizeClaudeCodeArtifact(claudeArtifact!);
  const cursor = readCursorMarkdownExport({ source: 'cursor', id: 'session', location: cursorExport, format: 'markdown-export' }, cursorRoot, timestamp);

  assert.deepEqual(codex.events.map(({ text }) => text), ['Codex prompt', 'Codex response', 'Codex arguments', 'Codex output']);
  assert.deepEqual(claude.events.map(({ text }) => text), ['Claude prompt', 'Claude response', 'Claude arguments\nClaude output']);
  assert.deepEqual(cursor.events.map(({ text }) => text), ['Cursor prompt', 'Cursor response']);
  const serialized = JSON.stringify([codex, claude, cursor]);
  for (const excluded of ['raw-codex-field', 'raw-response-field', 'raw-call-field', 'raw-output-field', 'raw-message-field', 'raw-record-field', 'raw-input-field']) {
    assert.equal(serialized.includes(excluded), false);
  }
});

test('normalized session text is deterministically bounded while raw payload remains excluded', () => {
  const rawPayload = 'payload-must-not-cross-boundary';
  const session = normalizeSession({
    source: 'codex',
    artifact: { source: 'codex', id: 'bounded', location: '/fixture/bounded.jsonl', format: 'observed-jsonl' },
    records: [{ kind: 'message', occurredAt: timestamp, text: `prefix-${'x'.repeat(MAX_SESSION_EVENT_TEXT_LENGTH)}`, payload: rawPayload }]
  });

  assert.equal(session.events[0]?.text?.length, MAX_SESSION_EVENT_TEXT_LENGTH);
  assert.equal(session.events[0]?.text?.startsWith('prefix-'), true);
  assert.equal(JSON.stringify(session).includes(rawPayload), false);
});

test('sanitizer redacts and residual-scans bounded session text before runtime', () => {
  const normalized = normalizeSession({
    source: 'codex',
    artifact: { source: 'codex', id: 'sanitize-text', location: '/fixture/sanitize.jsonl', format: 'observed-jsonl' },
    records: [{ kind: 'message', occurredAt: timestamp, text: 'Prompt token=must-not-leak followed by safe evidence' }]
  });
  const artifact = sanitizeForReview(normalized);

  assert.equal(artifact.session.events[0]?.text?.includes('must-not-leak'), false);
  assert.match(artifact.session.events[0]?.text ?? '', /Prompt \[REDACTED:token\] followed by safe evidence/);
  assert.throws(
    () => sanitizeForReview(normalized, { configuredPatterns: [/(?=safe evidence)/] }),
    (error: unknown) => error instanceof SanitizationError && !error.message.includes('safe evidence')
  );
  assert.throws(
    () => sanitizeForReview({ ...normalized, events: [{ ...normalized.events[0]!, text: 'x'.repeat(MAX_SESSION_EVENT_TEXT_LENGTH + 1) }] }),
    (error: unknown) => error instanceof SanitizationError
  );
});
