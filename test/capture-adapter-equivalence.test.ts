import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptClaudeCodeCapture } from '../src/capture/adapters/claude-code.js';
import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import { adaptCursorCapture } from '../src/capture/adapters/cursor.js';
import { normalizeCaptureBatch } from '../src/capture/normalization.js';

const timestamp = '2026-08-25T10:00:00.000Z';

function comparable(value: ReturnType<typeof adaptCodexCapture>): unknown {
  const { source: _source, sourceEventId: _sourceEventId, id: _id, ...common } = value;
  return common;
}

test('normalizes equivalent pre-intent, pre-action, and post-result records across supported agents', () => {
  const fixtures = [
    {
      codex: { event_id: 'c-intent', session_id: 'session-1', event_kind: 'pre_intent', occurred_at: timestamp, verb: 'modify', target: 'repository', tool: 'git', cwd: '/work/repo', summary: 'Modify repository state.' },
      claude: { eventId: 'a-intent', sessionId: 'session-1', kind: 'UserIntent', timestamp, verb: 'modify', target: 'repository', toolName: 'git', workingDirectory: '/work/repo', summary: 'Modify repository state.' },
      cursor: { id: 'u-intent', session: 'session-1', event: 'before-intent', timestamp, verb: 'modify', target: 'repository', tool: 'git', workspacePath: '/work/repo', summary: 'Modify repository state.' }
    },
    {
      codex: { event_id: 'c-action', session_id: 'session-1', event_kind: 'pre_action', occurred_at: timestamp, tool: 'git', action: 'push', arguments: ['--force'], cwd: '/work/repo', summary: 'Run git push.' },
      claude: { eventId: 'a-action', sessionId: 'session-1', kind: 'PreToolUse', timestamp, toolName: 'git', actionName: 'push', args: ['--force'], workingDirectory: '/work/repo', summary: 'Run git push.' },
      cursor: { id: 'u-action', session: 'session-1', event: 'before-action', timestamp, tool: 'git', action: 'push', arguments: ['--force'], workspacePath: '/work/repo', summary: 'Run git push.' }
    },
    {
      codex: { event_id: 'c-result', session_id: 'session-1', event_kind: 'post_result', occurred_at: timestamp, tool: 'git', action: 'push', arguments: ['--force'], cwd: '/work/repo', summary: 'Git push succeeded.', outcome: 'succeeded', exit_status: 0, related_event_id: 'action-1' },
      claude: { eventId: 'a-result', sessionId: 'session-1', kind: 'PostToolUse', timestamp, toolName: 'git', actionName: 'push', args: ['--force'], workingDirectory: '/work/repo', summary: 'Git push succeeded.', outcome: 'succeeded', exitStatus: 0, relatedEventId: 'action-1' },
      cursor: { id: 'u-result', session: 'session-1', event: 'after-action', timestamp, tool: 'git', action: 'push', arguments: ['--force'], workspacePath: '/work/repo', summary: 'Git push succeeded.', outcome: 'succeeded', exitCode: 0, relatedEventId: 'action-1' }
    }
  ] as const;

  for (const fixture of fixtures) {
    const codex = adaptCodexCapture(fixture.codex);
    assert.deepEqual(comparable(adaptClaudeCodeCapture(fixture.claude)), comparable(codex));
    assert.deepEqual(comparable(adaptCursorCapture(fixture.cursor)), comparable(codex));
    assert.equal(Object.isFrozen(codex), true);
    assert.equal(Object.isFrozen(codex.signature), true);
  }
});

test('rejects raw transcripts, credentials, unknown kinds, unstable fields, and oversized values', () => {
  const base = { event_id: 'event-1', session_id: 'session-1', event_kind: 'pre_action', occurred_at: timestamp, tool: 'git', action: 'status', summary: 'Inspect status.' };
  for (const invalid of [
    { ...base, rawTranscript: 'complete conversation' },
    { ...base, payload: { arbitrary: true } },
    { ...base, summary: 'Bearer: abcdefghijklmnopqrstuvwxyz' },
    { ...base, arguments: ['ghp_abcdefghijklmnopqrstuvwxyz123456'] },
    { ...base, arguments: ['User: paste the full transcript here'] },
    { ...base, arguments: ['line one\nline two'] },
    { ...base, arguments: ['arbitrary prose payload'] },
    { ...base, event_kind: 'assistant_message' },
    { ...base, sequence: 42 },
    { ...base, summary: 'x'.repeat(2_049) }
  ]) {
    assert.throws(() => adaptCodexCapture(invalid), /capture|field|credential|limit|kind/i);
  }
});

test('rejects duplicate source-event identities before persistence', () => {
  const event = adaptCodexCapture({ event_id: 'event-1', session_id: 'session-1', event_kind: 'pre_action', occurred_at: timestamp, tool: 'git', action: 'status', summary: 'Inspect status.' });
  assert.throws(() => normalizeCaptureBatch([event, event]), /duplicate source-event/i);
});
