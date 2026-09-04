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

test('rejects a symlinked configured Claude Code projects root without leaking its target', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'ael-claude-code-containing-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'ael-claude-code-external-'));
  const marker = 'claude-external-project-root-marker';
  await mkdir(join(externalRoot, 'example-project'));
  await writeFile(join(externalRoot, 'example-project', `${marker}.jsonl`), '{"type":"metadata","timestamp":"2026-08-24T10:00:00.000Z"}\n');
  await symlink(externalRoot, join(configDir, 'projects'));

  const message = await discoveryError({ configDir, project: 'example-project' });

  assert.match(message, /projects root.*unavailable/i);
  assert.equal(message.includes(externalRoot), false);
  assert.equal(message.includes(marker), false);
});

test('rejects a symlinked Claude Code project directory without leaking its target', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'ael-claude-code-containing-'));
  const project = 'example-project';
  await mkdir(join(configDir, 'projects'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'ael-claude-code-external-'));
  const marker = 'claude-external-project-directory-marker';
  await writeFile(join(externalRoot, `${marker}.jsonl`), '{"type":"metadata","timestamp":"2026-08-24T10:00:00.000Z"}\n');
  await symlink(externalRoot, join(configDir, 'projects', project));

  const message = await discoveryError({ configDir, project });

  assert.match(message, /project directory.*unavailable/i);
  assert.equal(message.includes(externalRoot), false);
  assert.equal(message.includes(marker), false);
});

test('rejects a symlinked Claude Code artifact root before accessing the artifact', async () => {
  const containingRoot = await mkdtemp(join(tmpdir(), 'ael-claude-code-containing-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'ael-claude-code-external-'));
  const marker = 'claude-external-artifact-root-marker';
  const artifactPath = join(externalRoot, `${marker}.jsonl`);
  await writeFile(artifactPath, '{"type":"metadata","timestamp":"2026-08-24T10:00:00.000Z"}\n');
  const linkedRoot = join(containingRoot, 'projects');
  await symlink(externalRoot, linkedRoot);

  let message = '';
  try {
    await normalizeClaudeCodeArtifact({ source: 'claude-code', id: 'artifact', location: artifactPath, format: 'jsonl', root: linkedRoot });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.match(message, /projects root.*unavailable/i);
  assert.equal(message.includes(externalRoot), false);
  assert.equal(message.includes(marker), false);
});

test('normalizes allowlisted Claude Code evidence text without retaining unrelated metadata', async () => {
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
      { id: 'session-a:0', kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z', text: 'token=secret', outcome: 'unknown' },
      { id: 'session-a:1', kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', tool: 'Bash', exitStatus: 0, text: 'private-command', outcome: 'passed' },
      { id: 'session-a:2', kind: 'metadata', occurredAt: '2026-08-24T10:02:00.000Z', outcome: 'unknown' }
    ]
  });
  assert.equal(JSON.stringify(session).includes('token=secret'), true);
  assert.equal(JSON.stringify(session).includes('private-command'), true);
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

test('retains the latest Claude Code records with source ordinals while preserving full session bounds', async () => {
  const { configDir, project, projectRoot } = await fixtureProject();
  const records = Array.from({ length: 1026 }, (_, index) => JSON.stringify({ type: 'metadata', timestamp: timestampAt(index) }));
  await writeFile(join(projectRoot, 'session-a.jsonl'), records.join('\n'));

  const [artifact] = await discoverClaudeCodeArtifacts({ configDir, project });
  const session = await normalizeClaudeCodeArtifact(artifact!);

  assert.equal(session.events.length, 1024);
  assert.equal(session.events[0]?.id, 'session-a:2');
  assert.equal(session.events.at(-1)?.id, 'session-a:1025');
  assert.equal(session.startedAt, timestampAt(0));
  assert.equal(session.endedAt, timestampAt(1025));
});

test('fails closed on an unsupported early Claude Code record without leaking its payload', async () => {
  const { configDir, project, projectRoot } = await fixtureProject();
  const marker = 'claude-unsupported-early-secret';
  const records = [
    JSON.stringify({ type: 'unsupported', timestamp: timestampAt(0), payload: { marker } }),
    ...Array.from({ length: 1025 }, (_, index) => JSON.stringify({ type: 'metadata', timestamp: timestampAt(index + 1) }))
  ];
  await writeFile(join(projectRoot, 'session-a.jsonl'), records.join('\n'));

  const [artifact] = await discoverClaudeCodeArtifacts({ configDir, project });
  await assert.rejects(
    () => normalizeClaudeCodeArtifact(artifact!),
    (error: unknown) => error instanceof Error && /unsupported claude code session record/i.test(error.message) && !error.message.includes(marker)
  );
});

test('rejects an evicted noncanonical Claude Code timestamp', async () => {
  const { configDir, project, projectRoot } = await fixtureProject();
  const records = [
    JSON.stringify({ type: 'metadata', timestamp: '2026-08-24T10:00:00Z' }),
    ...Array.from({ length: 1025 }, (_, index) => JSON.stringify({ type: 'metadata', timestamp: timestampAt(index + 1) }))
  ];
  await writeFile(join(projectRoot, 'session-a.jsonl'), records.join('\n'));

  const [artifact] = await discoverClaudeCodeArtifacts({ configDir, project });
  await assert.rejects(() => normalizeClaudeCodeArtifact(artifact!), /timestamp is invalid/i);
});

function timestampAt(index: number): string {
  return new Date(Date.parse('2026-08-24T10:00:00.000Z') + index * 1_000).toISOString();
}

async function discoveryError(options: { readonly configDir: string; readonly project: string }): Promise<string> {
  try {
    await discoverClaudeCodeArtifacts(options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}
