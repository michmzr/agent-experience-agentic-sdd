import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { createLocalGitContentAdapter, parseGitTreeListing, runtimeTargetSnapshotDirectory, RuntimeService } from '../src/application/runtime-service.js';
import type { RuntimeRule } from '../src/runtime/contracts.js';
import { compileRuntimeSnapshot } from '../src/runtime/snapshot.js';
import { RuntimeSnapshotStore } from '../src/storage/runtime-snapshot-store.js';

const action = {
  repositoryId: 'repo-1',
  operationClass: 'protected',
  signature: { kind: 'action', tool: 'git', action: 'push', arguments: ['--force'] }
} as const;

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'ael-runtime-cli-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('evaluates a runtime input from a snapshot with profile-specific exit codes', () => withDirectory((dataDir) => {
  const input = join(dataDir, 'action.json');
  writeFileSync(input, JSON.stringify(action));
  const rule: RuntimeRule = {
    id: 'no-force-push', state: 'verified', authoritative: true, effect: 'conflict', signature: action.signature,
    applicability: { scope: 'repository', repositoryId: 'repo-1' },
    reference: { knowledgeId: 'knowledge-no-force', evidenceIds: ['evidence-reviewed'] }
  };
  new RuntimeSnapshotStore(join(dataDir, 'runtime'), { clock: () => Date.now() }).publish(compileRuntimeSnapshot({
    repositoryId: 'repo-1', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule]
  }));

  const blocked = runCli(['runtime', 'evaluate', '--input', input, '--profile', 'normal', '--json', '--data-dir', dataDir]);
  const learning = runCli(['runtime', 'evaluate', '--input', input, '--profile', 'learning', '--json', '--data-dir', dataDir]);

  assert.equal(blocked.exitCode, 1);
  assert.equal(JSON.parse(blocked.stdout).outcome, 'BLOCK');
  assert.equal(learning.exitCode, 0);
  assert.equal(JSON.parse(learning.stdout).outcome, 'WARN');
  assert.equal(runCli(['runtime', 'evaluate', '--input', input, '--profile', 'observe-only', '--data-dir', dataDir]).stdout, 'ALLOW: 1 matching rule. Runtime healthy (snapshot).\n');
}));

test('creates an empty snapshot only when the target snapshot is absent or refresh is explicit', () => withDirectory((dataDir) => {
  const input = join(dataDir, 'action.json');
  writeFileSync(input, JSON.stringify({ ...action, repositoryId: 'repo-empty', operationClass: 'normal' }));

  const first = runCli(['runtime', 'evaluate', '--input', input, '--json', '--data-dir', dataDir]);
  const second = runCli(['runtime', 'evaluate', '--input', input, '--json', '--data-dir', dataDir]);
  const repeated = runCli(['runtime', 'evaluate', '--input', input, '--json', '--data-dir', dataDir]);
  const refreshed = runCli(['runtime', 'evaluate', '--input', input, '--refresh', '--json', '--data-dir', dataDir]);

  assert.equal(first.exitCode, 0);
  assert.equal(JSON.parse(first.stdout).outcome, 'ALLOW');
  assert.equal(repeated.stdout, second.stdout);
  assert.equal(JSON.parse(refreshed.stdout).outcome, 'ALLOW');
}));

test('rebuilds a validated snapshot for a different repository without serving cross-repository rules', () => withDirectory((dataDir) => {
  const inputA = join(dataDir, 'repo-a.json');
  const inputB = join(dataDir, 'repo-b.json');
  writeFileSync(inputA, JSON.stringify(action));
  writeFileSync(inputB, JSON.stringify({ ...action, repositoryId: 'repo-b' }));
  const rule: RuntimeRule = {
    id: 'repo-a-only', state: 'verified', authoritative: true, effect: 'conflict', signature: action.signature,
    applicability: { scope: 'repository', repositoryId: 'repo-1' }, reference: { knowledgeId: 'repo-a-only', evidenceIds: [] }
  };
  new RuntimeSnapshotStore(join(dataDir, 'runtime'), { clock: Date.now }).publish(compileRuntimeSnapshot({
    repositoryId: 'repo-1', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule]
  }));
  const service = new RuntimeService({ dataDir });

  assert.equal(service.evaluate({ inputPath: inputA }).outcome, 'BLOCK');
  assert.equal(service.evaluate({ inputPath: inputB }).outcome, 'ALLOW');
  const restarted = new RuntimeService({ dataDir });
  assert.equal(restarted.evaluate({ inputPath: inputA }).outcome, 'BLOCK');
  assert.equal(new RuntimeSnapshotStore(runtimeTargetSnapshotDirectory(dataDir, 'repo-1'), { clock: Date.now }).loadCurrent().repositoryId, 'repo-1');
  assert.equal(new RuntimeSnapshotStore(runtimeTargetSnapshotDirectory(dataDir, 'repo-b'), { clock: Date.now }).loadCurrent().repositoryId, 'repo-b');
}));

test('corrupt target state cannot affect another repository after restart', () => withDirectory((dataDir) => {
  const inputA = join(dataDir, 'repo-a.json');
  const inputB = join(dataDir, 'repo-b.json');
  writeFileSync(inputA, JSON.stringify(action));
  writeFileSync(inputB, JSON.stringify({ ...action, repositoryId: 'repo-b', operationClass: 'normal' }));
  new RuntimeSnapshotStore(join(dataDir, 'runtime'), { clock: Date.now }).publish(compileRuntimeSnapshot({
    repositoryId: 'repo-1', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [{
      id: 'repo-a-only', state: 'verified', authoritative: true, effect: 'conflict', signature: action.signature,
      applicability: { scope: 'repository', repositoryId: 'repo-1' }, reference: { knowledgeId: 'repo-a-only', evidenceIds: [] }
    }]
  }));
  const service = new RuntimeService({ dataDir });
  assert.equal(service.evaluate({ inputPath: inputA }).outcome, 'BLOCK');
  assert.equal(service.evaluate({ inputPath: inputB }).outcome, 'ALLOW');
  writeFileSync(join(runtimeTargetSnapshotDirectory(dataDir, 'repo-1'), 'manifest.json'), '{"corrupt":true}', { mode: 0o600 });

  const restarted = new RuntimeService({ dataDir });
  const repositoryB = restarted.evaluate({ inputPath: inputB });
  assert.equal(repositoryB.outcome, 'ALLOW');
  assert.notEqual(repositoryB.status.health, 'degraded');
  assert.equal(restarted.evaluate({ inputPath: inputA }).status.health, 'degraded');
}));

test('does not overwrite corrupt existing snapshot state without explicit refresh', () => withDirectory((dataDir) => {
  const input = join(dataDir, 'action.json');
  const runtimeDirectory = runtimeTargetSnapshotDirectory(dataDir, 'repo-1');
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeDirectory, 'manifest.json'), '{"corrupt":true}', { mode: 0o600 });
  writeFileSync(input, JSON.stringify(action));

  const result = runCli(['runtime', 'evaluate', '--input', input, '--json', '--data-dir', dataDir]);

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).outcome, 'BLOCK');
  assert.equal(JSON.parse(result.stdout).status.fallbackSource, 'degraded-policy');
  assert.equal(readFileSync(join(runtimeDirectory, 'manifest.json'), 'utf8'), '{"corrupt":true}');
}));

test('enforces runtime command option allowlists and returns syntax exit code 2', () => withDirectory((dataDir) => {
  const input = join(dataDir, 'action.json');
  writeFileSync(input, JSON.stringify(action));

  assert.equal(runCli(['runtime', 'evaluate', '--input', input, '--remote', 'x', '--data-dir', dataDir]).exitCode, 2);
  assert.equal(runCli(['runtime', 'evaluate', '--input', input, '--profile', 'custom', '--data-dir', dataDir]).exitCode, 2);
  assert.equal(runCli(['runtime', 'status', '--input', input, '--data-dir', dataDir]).exitCode, 2);
}));

test('does not echo unexpected positional paths or values in command-shape diagnostics', () => withDirectory((dataDir) => {
  const protectedPath = join(dataDir, 'private', 'credential-value');
  for (const args of [
    ['runtime', 'evaluate', protectedPath],
    ['runtime', 'config', 'explain', protectedPath],
    ['knowledge', 'validate', protectedPath],
    [protectedPath]
  ]) {
    const result = runCli(args);
    assert.equal(result.exitCode, 2);
    assert.equal(`${result.stdout}${result.stderr}`.includes(protectedPath), false);
    assert.match(`${result.stdout}${result.stderr}`, /invalid|unknown/i);
  }
}));

test('does not expose input paths or captured sensitive values in runtime diagnostics', () => withDirectory((dataDir) => {
  const input = join(dataDir, 'private-action.json');
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  writeFileSync(input, JSON.stringify({ ...action, signature: { ...action.signature, arguments: [secret] }, unexpected: true }));

  const result = runCli(['runtime', 'evaluate', '--input', input, '--json', '--data-dir', dataDir]);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout), { error: { code: 'INVALID_RUNTIME_INPUT', message: 'Runtime input is invalid.' } });
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdout.includes(input), false);
}));

test('explains target configuration without echoing the workspace or credential-bearing remote', () => withDirectory((dataDir) => {
  const workspace = join(dataDir, 'private-workspace');
  const remote = 'https://user:secret@example.test/team/repository.git';

  const result = runCli(['runtime', 'config', 'explain', '--workspace', workspace, '--remote', remote, '--json', '--data-dir', dataDir]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 0);
  assert.equal(output.profile.id, 'normal');
  assert.equal(output.trace.id.source, 'built-in-default');
  assert.equal(result.stdout.includes(workspace), false);
  assert.equal(result.stdout.includes('secret'), false);

  const human = runCli(['runtime', 'config', 'explain', '--workspace', workspace, '--remote', remote, '--data-dir', dataDir]);
  assert.equal(human.stdout, [
    'Runtime profile normal.',
    'id=normal [built-in-default:normal]',
    'hardBlocking=true [built-in-default:normal]',
    'warningsEnabled=true [built-in-default:normal]',
    'captureEnabled=true [built-in-default:normal]',
    'retrievalEnabled=true [built-in-default:normal]',
    'degradedOutcomes=normal=ALLOW,caution=WARN,protected=BLOCK [built-in-default:normal]'
  ].join('\n') + '\n');
  assert.equal(human.stdout.includes(workspace), false);
  assert.equal(human.stdout.includes('secret'), false);
}));

test('promotes and validates repository knowledge with concise deterministic output', () => withDirectory((directory) => {
  const repository = join(directory, 'repository');
  const input = join(directory, 'knowledge.json');
  mkdirSync(repository);
  writeFileSync(input, JSON.stringify({
    identity: 'fact-1', repositoryScope: 'repository:one', kind: 'project-fact', state: 'verified',
    applicability: { paths: [], tags: ['runtime'], tools: [] }, instructionOrigin: 'code-tool-confirmed',
    supersedes: [], title: 'Runtime fact', context: 'The project uses local evaluation.', lesson: 'Keep evaluation local.',
    recommendedBehavior: 'Use the local snapshot.', evidenceSummary: 'Verified by the test suite.',
    evidence: [{ kind: 'code-or-tool', summary: 'Test suite passed.', deterministic: true }]
  }));

  const promoted = runCli(['knowledge', 'promote', '--repository', repository, '--input', input, '--json', '--data-dir', directory]);
  const validated = runCli(['knowledge', 'validate', '--repository', repository, '--json', '--data-dir', directory]);

  assert.equal(promoted.exitCode, 0);
  assert.deepEqual(JSON.parse(promoted.stdout), { identity: 'fact-1', state: 'verified', activation: 'local' });
  assert.deepEqual(JSON.parse(validated.stdout), { valid: true, entries: 1, authoritativeEntries: 0, trustedRefActive: false });
  assert.equal(runCli(['knowledge', 'promote', '--repository', repository, '--input', input, '--data-dir', directory]).stdout, 'Promoted fact-1 as branch-local knowledge.\n');
  assert.equal(runCli(['knowledge', 'validate', '--repository', repository, '--data-dir', directory]).stdout, 'Validated 1 knowledge entry; trusted-ref activation inactive.\n');
}));

test('activates repository knowledge only from an explicit trusted local Git ref', () => withDirectory((directory) => {
  const repository = join(directory, 'repository');
  const input = join(directory, 'knowledge.json');
  mkdirSync(repository);
  writeFileSync(input, JSON.stringify({
    identity: 'trusted-fact', repositoryScope: 'repository:one', kind: 'project-fact', state: 'verified',
    applicability: { paths: [], tags: [], tools: ['git'] }, instructionOrigin: 'code-tool-confirmed', supersedes: [],
    title: 'Trusted fact', context: 'The fact is repository scoped.', lesson: 'Use the trusted fact.',
    recommendedBehavior: 'Apply the trusted fact.', evidenceSummary: 'Verified by repository tests.',
    evidence: [{ kind: 'code-or-tool', summary: 'Repository tests passed.', deterministic: true }]
  }));
  assert.equal(runCli(['knowledge', 'promote', '--repository', repository, '--input', input, '--data-dir', directory]).exitCode, 0);
  execFileSync('git', ['init'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository });
  execFileSync('git', ['add', 'agent-experience'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'add trusted knowledge'], { cwd: repository });

  const local = JSON.parse(runCli(['knowledge', 'validate', '--repository', repository, '--json', '--data-dir', directory]).stdout);
  const trusted = runCli(['knowledge', 'validate', '--repository', repository, '--trusted-ref', 'HEAD', '--json', '--data-dir', directory]);

  assert.equal(local.authoritativeEntries, 0);
  assert.deepEqual(JSON.parse(trusted.stdout), { valid: true, entries: 1, authoritativeEntries: 1, trustedRefActive: true });
  assert.equal(trusted.exitCode, 0);
}));

test('refreshes a durable repository runtime snapshot only from explicit structured trusted knowledge', () => withDirectory((directory) => {
  const repository = join(directory, 'repository');
  const input = join(directory, 'knowledge.json');
  const runtimeInput = join(directory, 'runtime-input.json');
  mkdirSync(repository);
  writeFileSync(input, JSON.stringify({
    identity: 'no-force-push', repositoryScope: 'repository:one', kind: 'project-fact', state: 'verified',
    applicability: { paths: [], tags: [], tools: ['git'] }, instructionOrigin: 'code-tool-confirmed', supersedes: [],
    title: 'Trusted Git safety rule', context: 'Force push is restricted.', lesson: 'Do not force push.',
    recommendedBehavior: 'Stop force pushes.', evidenceSummary: 'Verified by repository tests.',
    evidence: [{ kind: 'code-or-tool', summary: 'Repository tests passed.', deterministic: true }],
    runtimeDirective: {
      effect: 'conflict',
      signature: { kind: 'action', tool: 'git', action: 'push', arguments: ['--force'] }
    }
  }));
  writeFileSync(runtimeInput, JSON.stringify({ ...action, repositoryId: 'one' }));
  assert.equal(runCli(['knowledge', 'promote', '--repository', repository, '--input', input, '--data-dir', directory]).exitCode, 0);
  execFileSync('git', ['init'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository });
  execFileSync('git', ['add', 'agent-experience'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'add trusted runtime knowledge'], { cwd: repository });

  const refreshed = runCli([
    'knowledge', 'refresh-runtime', '--repository', repository, '--repository-id', 'one',
    '--trusted-ref', 'HEAD', '--json', '--data-dir', directory
  ]);
  assert.equal(refreshed.exitCode, 0);
  assert.equal(JSON.parse(refreshed.stdout).rules, 1);

  const restarted = runCli(['runtime', 'evaluate', '--input', runtimeInput, '--json', '--data-dir', directory]);
  assert.equal(restarted.exitCode, 1);
  assert.equal(JSON.parse(restarted.stdout).outcome, 'BLOCK');
  assert.deepEqual(JSON.parse(restarted.stdout).references, [{
    ruleId: 'shared:no-force-push', knowledgeId: 'no-force-push', evidenceIds: []
  }]);

  writeFileSync(runtimeInput, JSON.stringify({ ...action, repositoryId: 'two' }));
  assert.equal(JSON.parse(runCli(['runtime', 'evaluate', '--input', runtimeInput, '--json', '--data-dir', directory]).stdout).outcome, 'ALLOW');
}));

test('preflights trusted Git blob sizes and path counts before reading content', () => withDirectory((directory) => {
  const repository = join(directory, 'repository');
  mkdirSync(repository);
  execFileSync('git', ['init'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository });
  writeFileSync(join(repository, 'one.txt'), 'content larger than ten bytes');
  writeFileSync(join(repository, 'two.txt'), 'second');
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'add bounded content'], { cwd: repository });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const adapter = createLocalGitContentAdapter(repository);

  assert.throws(() => adapter.readFile(commit, 'one.txt', 10), /resource limit/i);
  assert.throws(() => adapter.listFiles(commit, '.', 1), /path limit/i);
  assert.equal(adapter.readFile(commit, 'two.txt', 10), 'second');
}));

test('rejects trusted-ref symlink modes for the index and Markdown before materializing blobs', () => withDirectory((directory) => {
  for (const target of ['index', 'markdown'] as const) {
    const repository = join(directory, `repository-${target}`);
    const input = join(directory, `${target}-knowledge.json`);
    mkdirSync(repository);
    writeFileSync(input, JSON.stringify({
      identity: 'fact', repositoryScope: 'repository:one', kind: 'project-fact', state: 'verified',
      applicability: { paths: [], tags: [], tools: [] }, instructionOrigin: 'code-tool-confirmed', supersedes: [],
      title: 'Trusted fact', context: 'Repository context.', lesson: 'Use trusted files.',
      recommendedBehavior: 'Keep trusted files regular.', evidenceSummary: 'Verified by repository tests.',
      evidence: [{ kind: 'code-or-tool', summary: 'Repository tests passed.', deterministic: true }]
    }));
    assert.equal(runCli(['knowledge', 'promote', '--repository', repository, '--input', input, '--data-dir', directory]).exitCode, 0);
    execFileSync('git', ['init'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository });
    const path = target === 'index'
      ? join(repository, 'agent-experience', 'index.json')
      : join(repository, 'agent-experience', 'knowledge', 'fact.md');
    rmSync(path);
    symlinkSync(target === 'index' ? '../outside-index' : '../../outside-markdown', path);
    execFileSync('git', ['add', 'agent-experience'], { cwd: repository });
    execFileSync('git', ['commit', '-m', `add symlinked ${target}`], { cwd: repository });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    rmSync(join(repository, 'agent-experience'), { recursive: true, force: true });

    assert.equal(existsSync(join(repository, 'agent-experience')), false);
    assert.throws(() => createLocalGitContentAdapter(repository).listFiles(commit, 'agent-experience', 1_002), /mode|blob|entry|unsafe/i);
    const result = runCli(['knowledge', 'validate', '--repository', repository, '--trusted-ref', 'HEAD', '--json', '--data-dir', directory]);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      error: { code: 'KNOWLEDGE_VALIDATION_FAILED', message: 'Repository knowledge validation failed.' }
    });
  }
}));

test('rejects non-blob, duplicate, unsafe, and excess bounded Git tree metadata', () => {
  const object = 'a'.repeat(40);
  const regular = `100644 blob ${object}\tagent-experience/index.json\0`;
  assert.deepEqual(parseGitTreeListing(regular, 1).map(({ path }) => path), ['agent-experience/index.json']);
  for (const listing of [
    `120000 blob ${object}\tagent-experience/index.json\0`,
    `160000 commit ${object}\tagent-experience/knowledge/fact.md\0`,
    `040000 tree ${object}\tagent-experience/knowledge/fact.md\0`,
    `100644 blob ${object}\t../agent-experience/index.json\0`,
    `${regular}${regular}`
  ]) assert.throws(() => parseGitTreeListing(listing, 2), /blob|duplicate|unsafe|mode/i);
  assert.throws(() => parseGitTreeListing(`${regular}${regular.replace('index', 'other')}`, 1), /limit/i);
});
