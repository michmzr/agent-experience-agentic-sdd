import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverClaudeCodeArtifacts, normalizeClaudeCodeArtifact } from '../src/review/adapters/claude-code.js';

async function fixtureProject(): Promise<{ readonly configDir: string; readonly project: string; readonly projectRoot: string }> {
  const configDir = await mkdtemp(join(tmpdir(), 'ael-claude-code-'));
  const project = 'example-project';
  const projectRoot = join(configDir, 'projects', project);
  await mkdir(projectRoot, { recursive: true });
  return { configDir, project, projectRoot };
}

test('discovers only direct Claude Code transcript JSONL files and rejects symlinks', async () => {
  const { configDir, project, projectRoot } = await fixtureProject();
  await writeFile(join(projectRoot, 'session-a.jsonl'), '{"type":"message","timestamp":"2026-08-24T10:00:00.000Z"}\n');
  await writeFile(join(projectRoot, 'subagent-session.jsonl'), '{"type":"message","timestamp":"2026-08-24T10:00:00.000Z"}\n');
  await writeFile(join(projectRoot, 'sidecar.jsonl'), '{"type":"message","timestamp":"2026-08-24T10:00:00.000Z"}\n');
  await mkdir(join(projectRoot, 'nested'));
  await writeFile(join(projectRoot, 'nested', 'nested.jsonl'), '{"type":"message","timestamp":"2026-08-24T10:00:00.000Z"}\n');
  await symlink(join(projectRoot, 'session-a.jsonl'), join(projectRoot, 'linked.jsonl'));

  const artifacts = await discoverClaudeCodeArtifacts({ configDir, project });

  assert.deepEqual(artifacts.map((artifact) => ({ id: artifact.id, format: artifact.format })), [
    { id: 'session-a', format: 'jsonl' }
  ]);
  assert.equal(artifacts[0]?.location.includes(configDir), true);
});

test('normalizes supported Claude Code message, tool and metadata records without raw payloads', async () => {
  const { configDir, project, projectRoot } = await fixtureProject();
  const artifactPath = join(projectRoot, 'session-a.jsonl');
  await writeFile(artifactPath, [
    JSON.stringify({ type: 'message', timestamp: '2026-08-24T10:00:00.000Z', message: { content: 'token=secret' } }),
    JSON.stringify({ type: 'tool', timestamp: '2026-08-24T10:01:00.000Z', tool_name: 'Bash', exit_code: 0, input: { command: 'private-command' } }),
    JSON.stringify({ type: 'metadata', timestamp: '2026-08-24T10:02:00.000Z', cwd: '/private/repository' })
  ].join('\n'));

  const artifacts = await discoverClaudeCodeArtifacts({ configDir, project });
  const session = await normalizeClaudeCodeArtifact(artifacts[0]!);

  assert.deepEqual(session, {
    source: 'claude-code', sessionId: 'session-a', startedAt: '2026-08-24T10:00:00.000Z', endedAt: '2026-08-24T10:02:00.000Z',
    events: [
      { id: 'session-a:0', kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z', outcome: 'unknown' },
      { id: 'session-a:1', kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', tool: 'Bash', exitStatus: 0, outcome: 'passed' },
      { id: 'session-a:2', kind: 'metadata', occurredAt: '2026-08-24T10:02:00.000Z', outcome: 'unknown' }
    ]
  });
  assert.equal(JSON.stringify(session).includes('secret'), false);
  assert.equal(JSON.stringify(session).includes('private-command'), false);
  assert.equal(JSON.stringify(session).includes('/private/repository'), false);
});

test('fails closed for unknown records and artifacts outside the configured projects root', async () => {
  const { configDir, project, projectRoot } = await fixtureProject();
  await writeFile(join(projectRoot, 'unknown.jsonl'), '{"type":"unsupported","timestamp":"2026-08-24T10:00:00.000Z","payload":"secret"}\n');
  const artifacts = await discoverClaudeCodeArtifacts({ configDir, project });
  await assert.rejects(() => normalizeClaudeCodeArtifact(artifacts[0]!), /Unsupported Claude Code session record/);

  const outside = join(configDir, 'outside.jsonl');
  await writeFile(outside, '{"type":"message","timestamp":"2026-08-24T10:00:00.000Z"}\n');
  await assert.rejects(
    () => normalizeClaudeCodeArtifact({ source: 'claude-code', id: 'outside', location: outside, format: 'jsonl', root: join(configDir, 'projects') }),
    /must remain within the configured projects root/
  );
});
