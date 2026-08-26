import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptPassiveHook } from '../src/capture/hook-adapters/index.js';
import { normalizeCaptureBatch } from '../src/capture/normalization.js';
import type { PassiveCaptureRecord } from '../src/capture/passive-service.js';

const preTime = '2026-08-26T08:00:00.000Z';
const postTime = '2026-08-26T08:00:01.000Z';

function technical(record: PassiveCaptureRecord | undefined): Extract<PassiveCaptureRecord, { kind: 'technical' }> {
  assert.equal(record?.kind, 'technical');
  return record;
}

function comparableTechnical(record: PassiveCaptureRecord | undefined): unknown {
  const event = technical(record).event;
  const {
    id: _id,
    source: _source,
    sourceEventId: _sourceEventId,
    ...common
  } = event;
  return common;
}

test('normalizes equivalent public shell hooks without raw output', () => {
  const codexPre = adaptPassiveHook('codex', {
    session_id: 'session-1',
    cwd: '/work/repo',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    tool_input: { command: 'git status --short' },
    tool_response: { output: 'working tree details' },
    model: 'private-model-metadata'
  }, preTime);
  const cursorPre = adaptPassiveHook('cursor', {
    conversation_id: 'session-1',
    hook_event_name: 'preToolUse',
    cwd: '/work/repo',
    tool_name: 'Shell',
    tool_use_id: 'tool-1',
    tool_input: { command: 'git status --short' },
    tool_response: { output: 'working tree details' },
    agent_message: 'assistant text'
  }, preTime);

  assert.deepEqual(comparableTechnical(cursorPre), comparableTechnical(codexPre));
  assert.equal(JSON.stringify(codexPre).includes('tool_response'), false);
  assert.equal(JSON.stringify(cursorPre).includes('working tree details'), false);
});

test('maps session start and end without transcript or user identity fields', () => {
  assert.deepEqual(adaptPassiveHook('codex', {
    session_id: 'session-1',
    cwd: '/work/repo',
    hook_event_name: 'SessionStart',
    source: 'startup',
    transcript_path: '/private/transcript.jsonl',
    prompt: 'private prompt text'
  }, preTime), {
    kind: 'session-start',
    session: { id: 'session-1', source: 'codex', startedAt: preTime }
  });

  assert.deepEqual(adaptPassiveHook('cursor', {
    conversation_id: 'session-1',
    hook_event_name: 'sessionEnd',
    reason: 'completed',
    user_email: 'private@example.test'
  }, postTime), {
    kind: 'session-end',
    source: 'cursor',
    sessionId: 'session-1',
    endedAt: postTime
  });
});

test('ignores Codex non-startup lifecycle starts without changing immutable session state', () => {
  const startup = adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'SessionStart',
    source: 'startup'
  }, preTime);
  assert.deepEqual(startup, {
    kind: 'session-start',
    session: { id: 'session-1', source: 'codex', startedAt: preTime }
  });

  for (const source of ['resume', 'compact', 'clear']) {
    assert.equal(adaptPassiveHook('codex', {
      session_id: 'session-1',
      hook_event_name: 'SessionStart',
      source
    }, postTime), undefined, source);
  }
});

test('ignores Codex resume after session end instead of reopening the session', () => {
  assert.deepEqual(adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'SessionEnd'
  }, postTime), {
    kind: 'session-end',
    source: 'codex',
    sessionId: 'session-1',
    endedAt: postTime
  });

  assert.equal(adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'SessionStart',
    source: 'resume'
  }, '2026-08-26T08:00:02.000Z'), undefined);
});

test('correlates pre and post tool hooks with stable source identities', () => {
  const pre = technical(adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    tool_input: { command: 'git diff --stat' }
  }, preTime));
  const post = technical(adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    tool_input: { command: 'git diff --stat' },
    exit_status: 1
  }, postTime));

  assert.equal(pre.event.sourceEventId, 'tool-1:pre');
  assert.equal(post.event.sourceEventId, 'tool-1:post');
  assert.equal(post.event.relatedEventId, 'tool-1:pre');
  assert.equal(post.event.outcome, 'failed');
  assert.equal(post.event.exitStatus, 1);
  assert.doesNotThrow(() => normalizeCaptureBatch([pre.event, post.event]));
});

test('maps MCP calls to top-level scalar arguments without nested raw payloads', () => {
  const record = technical(adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__github__create_issue',
    tool_use_id: 'mcp-1',
    tool_input: { owner: 'octo', repo: 'repo', draft: false, count: 2 }
  }, preTime));

  assert.equal(record.event.signature.kind, 'action');
  if (record.event.signature.kind === 'action') {
    assert.equal(record.event.signature.tool, 'mcp');
    assert.equal(record.event.signature.action, 'github/create-issue');
    assert.deepEqual(record.event.signature.arguments, ['count=2', 'draft=false', 'owner=octo', 'repo=repo']);
  }
  assert.equal(JSON.stringify(record).includes('tool_input'), false);

  assert.throws(() => adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__github__create_issue',
    tool_use_id: 'mcp-2',
    tool_input: { owner: 'octo', metadata: { nested: true } }
  }, preTime), /passive hook|private|credential|limit/i);
});

test('sorts MCP scalar arguments so reordered pre and post payloads correlate', () => {
  const pre = technical(adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__github__create_issue',
    tool_use_id: 'mcp-reordered',
    tool_input: { repo: 'repo', owner: 'octo', count: 2, draft: false }
  }, preTime));
  const post = technical(adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__github__create_issue',
    tool_use_id: 'mcp-reordered',
    tool_input: { draft: false, count: 2, owner: 'octo', repo: 'repo' }
  }, postTime));

  assert.equal(post.event.relatedEventId, pre.event.sourceEventId);
  assert.deepEqual(post.event.signature, pre.event.signature);
  assert.equal(post.event.signature.kind, 'action');
  if (post.event.signature.kind === 'action') {
    assert.deepEqual(post.event.signature.arguments, ['count=2', 'draft=false', 'owner=octo', 'repo=repo']);
  }
});

test('omits MCP prompt, content, output, and user identity scalar keys', () => {
  const record = technical(adaptPassiveHook('cursor', {
    conversation_id: 'session-1',
    hook_event_name: 'preToolUse',
    tool_name: 'mcp__github__create_issue',
    tool_use_id: 'mcp-private-scalars',
    tool_input: {
      owner: 'octo',
      repo: 'repo',
      prompt: 'private prompt value',
      user_email: 'person@example.test',
      user: 'private-user',
      author: 'private-author',
      response: 'private response',
      output: 'private output',
      message_text: 'private message text',
      transcriptPath: '/private/transcript.jsonl'
    }
  }, preTime));

  assert.equal(record.event.signature.kind, 'action');
  if (record.event.signature.kind === 'action') {
    assert.deepEqual(record.event.signature.arguments, ['owner=octo', 'repo=repo']);
  }
  const serialized = JSON.stringify(record);
  for (const marker of [
    'private prompt value',
    'person@example.test',
    'private-user',
    'private-author',
    'private response',
    'private output',
    'private message text',
    '/private/transcript.jsonl'
  ]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
});

test('rejects non-finite and unsafe MCP numeric scalar values without leaking them', () => {
  for (const value of [1e400, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(
      () => adaptPassiveHook('codex', {
        session_id: 'session-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__github__create_issue',
        tool_use_id: 'mcp-unsafe-number',
        tool_input: { owner: 'octo', repo: 'repo', count: value }
      }, preTime),
      (error: unknown) => error instanceof Error
        && /passive hook/i.test(error.message)
        && !error.message.includes(String(value))
    );
  }
});

test('maps file edits without patch or content fields', () => {
  const record = technical(adaptPassiveHook('cursor', {
    conversation_id: 'session-1',
    hook_event_name: 'preToolUse',
    tool_name: 'Edit',
    tool_use_id: 'edit-1',
    tool_input: {
      file_path: 'src/index.ts',
      old_string: 'secret-looking but not persisted',
      new_string: 'replacement content'
    }
  }, preTime));

  assert.equal(record.event.signature.kind, 'action');
  if (record.event.signature.kind === 'action') {
    assert.equal(record.event.signature.tool, 'file');
    assert.equal(record.event.signature.action, 'edit');
    assert.equal(record.event.signature.path, 'src/index.ts');
    assert.equal(record.event.signature.arguments, undefined);
  }
  assert.equal(JSON.stringify(record).includes('replacement content'), false);
});

test('rejects credential-bearing technical input without returning its value', () => {
  const marker = 'classified-private-value';
  assert.throws(
    () => adaptPassiveHook('codex', {
      session_id: 'session-1',
      cwd: '/work/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tool-secret',
      tool_input: { command: `curl --header Authorization:Bearer=${marker} https://example.test` }
    }, preTime),
    (error: unknown) => error instanceof Error
      && /private|credential/i.test(error.message)
      && !error.message.includes(marker)
  );
});

test('rejects oversized values and complex shell syntax with generic errors', () => {
  const cases = [
    { command: 'git status\nrm -rf repo' },
    { command: 'git status; git push' },
    { command: 'echo $(secret)' },
    { command: 'echo `secret`' },
    { command: `git ${'x'.repeat(65_536)}` }
  ];

  for (const tool_input of cases) {
    assert.throws(() => adaptPassiveHook('cursor', {
      conversation_id: 'session-1',
      hook_event_name: 'preToolUse',
      tool_name: 'Shell',
      tool_use_id: 'unsafe-shell',
      tool_input
    }, preTime), /passive hook|credential|private|limit/i);
  }
});

test('rejects unsafe lifecycle identifiers without returning their values', () => {
  const marker = 'Bearer=classified-private-value';
  assert.throws(
    () => adaptPassiveHook('codex', {
      session_id: marker,
      hook_event_name: 'SessionStart',
      source: 'startup'
    }, preTime),
    (error: unknown) => error instanceof Error
      && /passive hook/i.test(error.message)
      && !error.message.includes(marker)
  );
  assert.throws(() => adaptPassiveHook('cursor', {
    conversation_id: 's'.repeat(513),
    hook_event_name: 'sessionEnd'
  }, postTime), /passive hook/i);
});

test('ignores unknown, prompt, and nontechnical hook events', () => {
  for (const payload of [
    { session_id: 'session-1', hook_event_name: 'UserPromptSubmit', prompt: 'private prompt' },
    { conversation_id: 'session-1', hook_event_name: 'beforeSubmitPrompt', prompt: 'private prompt' },
    { session_id: 'session-1', hook_event_name: 'Notification', agent_message: 'assistant text' },
    { conversation_id: 'session-1', hook_event_name: 'unknownEvent' },
    { session_id: 'session-1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/index.ts' } }
  ]) {
    assert.equal(adaptPassiveHook('codex', payload, preTime), undefined);
  }
  assert.equal(adaptPassiveHook('cursor', {
    conversation_id: 'session-1',
    hook_event_name: 'preToolUse',
    tool_name: 'ListDirectory',
    tool_input: { path: 'src' }
  }, preTime), undefined);
});

test('validates canonical receivedAt before using hook timestamps', () => {
  assert.throws(() => adaptPassiveHook('codex', {
    session_id: 'session-1',
    hook_event_name: 'SessionStart'
  }, '2026-08-26T10:00:00+02:00'), /canonical/i);

  const record = technical(adaptPassiveHook('cursor', {
    conversation_id: 'session-1',
    hook_event_name: 'preToolUse',
    timestamp: '2025-01-01T00:00:00.000Z',
    tool_name: 'Shell',
    tool_use_id: 'tool-1',
    tool_input: { command: 'git status' }
  }, preTime));
  assert.equal(record.event.occurredAt, preTime);
});
