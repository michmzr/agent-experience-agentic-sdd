import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexSessionAdapter } from '../src/review/adapters/codex.js';
import { discoverClaudeCodeArtifacts, normalizeClaudeCodeArtifact } from '../src/review/adapters/claude-code.js';
import { readCursorMarkdownExport } from '../src/review/adapters/cursor.js';

test('normalizes equivalent local source fixtures to the same review-relevant events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-source-equivalence-'));
  const timestamp = '2026-08-24T12:00:00.000Z';
  const codexRoot = join(root, 'codex'); mkdirSync(codexRoot);
  writeFileSync(join(codexRoot, 'session.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: timestamp, payload: 'private Codex prompt' })}\n`);
  const claudeConfig = join(root, 'claude'); const project = 'workspace'; mkdirSync(join(claudeConfig, 'projects', project), { recursive: true });
  writeFileSync(join(claudeConfig, 'projects', project, 'session.jsonl'), `${JSON.stringify({ type: 'message', timestamp, message: 'private Claude prompt' })}\n`);
  const cursorRoot = join(root, 'cursor'); mkdirSync(cursorRoot); const cursorExport = join(cursorRoot, 'session.md');
  writeFileSync(cursorExport, '## User\nprivate Cursor prompt\n');

  const codex = new CodexSessionAdapter(codexRoot);
  const [codexSession] = await Promise.all([(async () => codex.read('session.jsonl'))()]);
  const [claudeArtifact] = await discoverClaudeCodeArtifacts({ configDir: claudeConfig, project });
  const claudeSession = await normalizeClaudeCodeArtifact(claudeArtifact);
  const cursorSession = readCursorMarkdownExport({ source: 'cursor', id: 'session', location: cursorExport, format: 'markdown-export' }, cursorRoot, timestamp);

  const projection = (session: { events: readonly { kind: string; occurredAt: string; outcome: string }[] }) => session.events.map(({ kind, occurredAt, outcome }) => ({ kind, occurredAt, outcome }));
  const expected = [{ kind: 'message', occurredAt: timestamp, outcome: 'unknown' }];
  assert.deepEqual(projection(codexSession), expected);
  assert.deepEqual(projection(claudeSession), expected);
  assert.deepEqual(projection(cursorSession), expected);
  assert.equal(JSON.stringify([codexSession, claudeSession, cursorSession]).includes('private'), false);
});
