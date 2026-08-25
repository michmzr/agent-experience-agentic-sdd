import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readSharedKnowledge, readSharedKnowledgeContent, RepositoryKnowledgeConfigurationError, RepositoryKnowledgeConflictError, writeSharedKnowledge, type SharedKnowledgeDocument } from '../src/shared-knowledge/repository.js';
import { repositoryLockDirectory } from '../src/shared-knowledge/repository-lock.js';

process.env.AEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'ael-shared-state-'));

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ael-shared-knowledge-'));
}

function document(identity = 'safe-reset'): SharedKnowledgeDocument {
  return {
    identity,
    repositoryScope: 'repository:test',
    kind: 'convention',
    state: 'verified',
    applicability: { paths: ['src/**'], tags: ['git', 'safety'], tools: ['git'] },
    instructionOrigin: 'code-tool-confirmed',
    approval: { at: '2026-08-25T10:00:00.000Z', kind: 'user' },
    lastVerification: { at: '2026-08-25T11:00:00.000Z', by: 'tests' },
    supersedes: [],
    title: 'Safe reset',
    context: 'A working tree contains unrelated edits.',
    lesson: 'Destructive reset can discard unrelated work.',
    recommendedBehavior: 'Inspect the diff before changing files.',
    evidenceSummary: 'A deterministic repository diff showed unrelated edits.'
  };
}

test('version 3 repository round-trips a structured runtime directive with byte-stable output', () => {
  const repository = root();
  const directiveDocument: SharedKnowledgeDocument = {
    ...document(),
    applicability: { paths: ['src'], tags: ['git', 'safety'], tools: ['git'] },
    runtimeDirective: {
      effect: 'conflict',
      signature: { kind: 'action', tool: 'git', action: 'reset', arguments: ['--hard'], path: 'src' }
    }
  };
  writeSharedKnowledge(repository, [directiveDocument]);
  const index = join(repository, 'agent-experience', 'index.json');
  const markdown = join(repository, 'agent-experience', 'knowledge', 'safe-reset.md');
  const before = [readFileSync(index, 'utf8'), readFileSync(markdown, 'utf8')];

  writeSharedKnowledge(repository, [directiveDocument]);

  assert.deepEqual([readFileSync(index, 'utf8'), readFileSync(markdown, 'utf8')], before);
  assert.equal((JSON.parse(before[0]) as { version: number }).version, 3);
  assert.deepEqual(readSharedKnowledge(repository), [directiveDocument]);
  assert.match(before[1], /## Lesson\n\nDestructive reset/);
});

test('reads a version 2 index without inventing a runtime directive', () => {
  const repository = root();
  writeSharedKnowledge(repository, [document()]);
  const indexPath = join(repository, 'agent-experience', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { version: number; entries: Array<Record<string, unknown>> };
  index.version = 2;
  for (const entry of index.entries) delete entry.runtimeDirective;
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  assert.deepEqual(readSharedKnowledge(repository), [document()]);
});

test('rejects malformed, noncanonical, private, and oversized runtime directives', () => {
  const base = {
    effect: 'conflict' as const,
    signature: { kind: 'action' as const, tool: 'git', action: 'reset', arguments: ['--hard'], path: 'src' }
  };
  const invalid = [
    { ...base, unexpected: true },
    { ...base, effect: 'BLOCK' },
    { ...base, signature: { ...base.signature, tool: ' git ' } },
    { ...base, signature: { ...base.signature, path: 'src/../repo' } },
    { ...base, signature: { ...base.signature, arguments: Array.from({ length: 101 }, () => '--flag') } },
    { ...base, signature: { ...base.signature, arguments: ['--token=credential-value'] } }
  ];
  for (const runtimeDirective of invalid) {
    assert.throws(
      () => writeSharedKnowledge(root(), [{ ...document(), runtimeDirective } as unknown as SharedKnowledgeDocument]),
      /runtime|directive|canonical|credential|private|limit|field|path/i
    );
  }
});

test('uses capture-equivalent structured argv credential classification for runtime directives', () => {
  const cases = [
    { tool: 'tool', action: 'run', arguments: ['--token', 'value'] },
    { tool: 'tool', action: 'run', arguments: ['--token=value'] },
    { tool: 'tool', action: 'run', arguments: ['--password'] },
    { tool: 'tool', action: 'run', arguments: ['--apiKey', 'value'] },
    { tool: 'tool', action: 'run', arguments: ['--apikey=value'] },
    { tool: 'tool', action: 'run', arguments: ['OPENAI_API_KEY=value'] },
    { tool: 'tool', action: 'run', arguments: ['PREFIX_CLIENTSECRET=value'] },
    { tool: 'tool', action: 'run', arguments: ['-token', 'value'] },
    { tool: 'tool', action: 'run', arguments: ['-token=value'] },
    { tool: 'tool', action: 'run', arguments: ['-tokenvalue'] },
    { tool: 'tool', action: 'run', arguments: ['-apiKey', 'value'] },
    { tool: 'tool', action: 'run', arguments: ['-apikey=value'] },
    { tool: 'tool', action: 'run', arguments: ['-password=value'] },
    { tool: 'curl', action: 'request', arguments: ['-H', 'Authorization:Bearer value'] },
    { tool: 'redis-cli', action: 'connect', arguments: ['-avalue'] },
    { tool: 'redis-cli', action: 'connect', arguments: ['--passvalue'] },
    { tool: 'docker', action: 'login', arguments: ['-pvalue'] },
    { tool: 'curl', action: 'request', arguments: ['-uuser:value'] },
    { tool: 'mysql', action: 'connect', arguments: ['-pvalue'] }
  ];
  for (const signature of cases) {
    const repository = root();
    assert.throws(
      () => writeSharedKnowledge(repository, [{
        ...document(), applicability: { paths: [], tags: [], tools: [signature.tool] },
        runtimeDirective: { effect: 'conflict', signature: { kind: 'action', ...signature } }
      }]),
      (error: unknown) => error instanceof Error && /credential|private/i.test(error.message) && !error.message.includes('value')
    );
  }
});

test('round-trips benign structured argv controls without weakening credential classification', () => {
  const cases = [
    { identity: 'jq-key', tool: 'jq', action: 'query', arguments: ['key', 'value'] },
    { identity: 'single-dash-controls', tool: 'tool', action: 'run', arguments: ['-verbose', '-key', 'value'] },
    { identity: 'sort-key', tool: 'sort', action: 'sort', arguments: ['--key=1', 'file.txt'] },
    { identity: 'ssh-control', tool: 'ssh', action: 'connect', arguments: ['-o', 'StrictHostKeyChecking=yes', 'host'] }
  ];
  const repository = root();
  const documents = cases.map(({ identity, tool, action, arguments: arguments_ }) => ({
    ...document(), identity, applicability: { paths: [], tags: [], tools: [tool] },
    runtimeDirective: { effect: 'context' as const, signature: { kind: 'action' as const, tool, action, arguments: arguments_ } }
  }));
  writeSharedKnowledge(repository, documents);
  assert.deepEqual(readSharedKnowledge(repository), documents);
});

test('rejects credential-bearing structured argv when reading an existing version 3 generation', () => {
  const repository = root();
  writeSharedKnowledge(repository, [{
    ...document(), applicability: { paths: [], tags: [], tools: ['tool'] },
    runtimeDirective: { effect: 'conflict', signature: { kind: 'action', tool: 'tool', action: 'run', arguments: ['--safe'] } }
  }]);
  const indexPath = join(repository, 'agent-experience', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { entries: Array<{ runtimeDirective: { signature: { arguments: string[] } } }> };
  index.entries[0]!.runtimeDirective.signature.arguments = ['-apiKey', 'read-secret-marker'];
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  assert.throws(
    () => readSharedKnowledge(repository),
    (error: unknown) => error instanceof Error && /credential|private/i.test(error.message) && !error.message.includes('read-secret-marker')
  );
});

test('reads a version 1 index and legacy Markdown', () => {
  const repository = root();
  const base = join(repository, 'agent-experience');
  mkdirSync(join(base, 'knowledge'), { recursive: true });
  writeFileSync(join(base, 'index.json'), JSON.stringify({ version: 1, entries: [{ identity: 'legacy', kind: 'convention', state: 'verified', applicability: { tags: ['git'] } }] }));
  writeFileSync(join(base, 'knowledge', 'legacy.md'), '# Legacy title\n\n## Context\n\nLegacy context.\n\n## Recommended behavior\n\nKeep compatibility.\n\n## Evidence summary\n\nReviewed evidence.\n');

  const [legacy] = readSharedKnowledge(repository);
  assert.equal(legacy.identity, 'legacy');
  assert.equal(legacy.lesson, 'Legacy title');
  assert.equal(legacy.instructionOrigin, 'code-tool-confirmed');
});

test('rejects malformed timestamps, duplicate identities, and unsafe document paths', () => {
  const malformed = document();
  assert.throws(() => writeSharedKnowledge(root(), [{ ...malformed, lastVerification: { at: 'yesterday' } }]), /timestamp/i);
  assert.throws(() => writeSharedKnowledge(root(), [document(), document()]), /duplicate/i);

  const repository = root();
  const base = join(repository, 'agent-experience');
  mkdirSync(join(base, 'knowledge'), { recursive: true });
  writeFileSync(join(base, 'index.json'), JSON.stringify({ version: 2, entries: [{ identity: 'safe', document: '../outside.md' }] }));
  assert.throws(() => readSharedKnowledge(repository), /document path|index/i);
});

test('rejects missing and orphan Markdown documents', () => {
  const missing = root();
  writeSharedKnowledge(missing, [document()]);
  const base = join(missing, 'agent-experience');
  writeFileSync(join(base, 'index.json'), readFileSync(join(base, 'index.json'), 'utf8').replace('knowledge/safe-reset.md', 'knowledge/missing.md'));
  assert.throws(() => readSharedKnowledge(missing), /missing|content|document path/i);

  const orphan = root();
  writeSharedKnowledge(orphan, [document()]);
  writeFileSync(join(orphan, 'agent-experience', 'knowledge', 'orphan.md'), '# Orphan');
  assert.throws(() => readSharedKnowledge(orphan), /orphan/i);

  const withoutIndex = root();
  mkdirSync(join(withoutIndex, 'agent-experience', 'knowledge'), { recursive: true });
  writeFileSync(join(withoutIndex, 'agent-experience', 'knowledge', 'orphan.md'), '# Orphan');
  assert.throws(() => readSharedKnowledge(withoutIndex), /orphan/i);

  const nested = root();
  writeSharedKnowledge(nested, [document()]);
  mkdirSync(join(nested, 'agent-experience', 'knowledge', 'nested'));
  writeFileSync(join(nested, 'agent-experience', 'knowledge', 'nested', 'orphan.md'), '# Orphan');
  assert.throws(() => readSharedKnowledge(nested), /orphan|unrecognized/i);
});

test('rejects Markdown identity and content mismatches', () => {
  const repository = root();
  writeSharedKnowledge(repository, [document()]);
  const markdown = join(repository, 'agent-experience', 'knowledge', 'safe-reset.md');
  writeFileSync(markdown, readFileSync(markdown, 'utf8').replace('safe-reset', 'different'));
  assert.throws(() => readSharedKnowledge(repository), /identity|content/i);
});

test('rejects raw, private, local identifiers, credentials, and unsanitized evidence', () => {
  assert.throws(() => writeSharedKnowledge(root(), [{ ...document(), evidenceSummary: 'Raw transcript: user secret text' }]), /raw|sanitized/i);
  assert.throws(() => writeSharedKnowledge(root(), [{ ...document(), evidenceSummary: 'sessionId: local-123' }]), /local|private/i);
  assert.throws(() => writeSharedKnowledge(root(), [{ ...document(), evidenceSummary: 'credential sk-abcdefghijklmnopqrstuvwxyz1234' }]), /credential/i);
  assert.throws(() => writeSharedKnowledge(root(), [{ ...document(), privateReview: 'hidden' } as SharedKnowledgeDocument]), /private review/i);
});

test('rejects content-hash-valid private or unsanitized Markdown when reading', () => {
  for (const unsafe of ['Raw transcript: private exchange', 'Private review: hidden notes', 'localDatabaseId: row-17', 'credential sk-abcdefghijklmnopqrstuvwxyz1234']) {
    const repository = root();
    writeSharedKnowledge(repository, [document()]);
    const base = join(repository, 'agent-experience');
    const markdownPath = join(base, 'knowledge', 'safe-reset.md');
    const indexPath = join(base, 'index.json');
    const markdown = readFileSync(markdownPath, 'utf8').replace('A deterministic repository diff showed unrelated edits.', unsafe);
    writeFileSync(markdownPath, markdown);
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { entries: Array<{ contentHash: string }> };
    index.entries[0]!.contentHash = createHash('sha256').update(markdown).digest('hex');
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    assert.throws(() => readSharedKnowledge(repository), /raw|private|local|credential|sanitized/i);
  }

  const legacy = root();
  const base = join(legacy, 'agent-experience');
  mkdirSync(join(base, 'knowledge'), { recursive: true });
  writeFileSync(join(base, 'index.json'), JSON.stringify({ version: 1, entries: [{ identity: 'legacy', kind: 'convention', state: 'verified', applicability: { tags: [] } }] }));
  writeFileSync(join(base, 'knowledge', 'legacy.md'), '# Legacy\n\n## Context\n\nRaw transcript: private exchange\n\n## Recommended behavior\n\nKeep compatibility.\n\n## Evidence summary\n\nReviewed evidence.\n');
  assert.throws(() => readSharedKnowledge(legacy), /raw|sanitized/i);
});

test('rejects extra, missing, duplicate, out-of-order, unknown, and oversized Markdown sections', () => {
  const mutations = [
    (text: string) => `outside\n${text}`,
    (text: string) => text.replace('## Lesson\n\nDestructive reset can discard unrelated work.\n\n', ''),
    (text: string) => text.replace('## Lesson', '## Context'),
    (text: string) => text.replace('## Context', '## Lesson').replace('## Lesson\n\nDestructive', '## Context\n\nDestructive'),
    (text: string) => text.replace('## Lesson', '## Unknown'),
    (text: string) => text.replace('A working tree contains unrelated edits.', 'x'.repeat(8193))
  ];
  for (const mutate of mutations) {
    const repository = root();
    writeSharedKnowledge(repository, [document()]);
    const base = join(repository, 'agent-experience');
    const markdownPath = join(base, 'knowledge', 'safe-reset.md');
    const indexPath = join(base, 'index.json');
    const markdown = mutate(readFileSync(markdownPath, 'utf8'));
    writeFileSync(markdownPath, markdown);
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { entries: Array<{ contentHash: string }> };
    index.entries[0]!.contentHash = createHash('sha256').update(markdown).digest('hex');
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    assert.throws(() => readSharedKnowledge(repository), /Markdown|content|section/i);
  }
});

test('rejects symlinked repository paths without changing their targets', () => {
  const repository = root();
  const external = join(repository, 'external');
  mkdirSync(external);
  symlinkSync(external, join(repository, 'agent-experience'));
  assert.throws(() => writeSharedKnowledge(repository, [document()]), /symlink/i);
  assert.equal(existsSync(join(external, 'index.json')), false);
});

test('keeps the prior complete generation when a replacement is rejected', () => {
  const repository = root();
  writeSharedKnowledge(repository, [document()]);
  const index = join(repository, 'agent-experience', 'index.json');
  const markdown = join(repository, 'agent-experience', 'knowledge', 'safe-reset.md');
  const before = [readFileSync(index, 'utf8'), readFileSync(markdown, 'utf8')];

  assert.throws(() => writeSharedKnowledge(repository, [{ ...document(), lastVerification: { at: 'invalid' } }]), /timestamp/i);

  assert.deepEqual([readFileSync(index, 'utf8'), readFileSync(markdown, 'utf8')], before);
  assert.deepEqual(readSharedKnowledge(repository), [document()]);
});

test('fails closed on an invalid existing primary and promotion preserves every edited byte', async () => {
  const repository = root();
  const stateRoot = mkdtempSync(join(tmpdir(), 'ael-private-state-'));
  writeSharedKnowledge(repository, [document()], { stateRoot });
  const markdown = join(repository, 'agent-experience', 'knowledge', 'safe-reset.md');
  writeFileSync(markdown, `${readFileSync(markdown, 'utf8')}manual invalid edit\n`);
  const edited = readFileSync(markdown);

  assert.throws(() => readSharedKnowledge(repository, { stateRoot }), /invalid|content|hash/i);
  const { promoteKnowledge } = await import('../src/shared-knowledge/promotion-policy.js');
  assert.throws(() => promoteKnowledge(repository, { ...document('new-fact'), evidence: [{ kind: 'code-or-tool', summary: 'code', deterministic: true }] }, { stateRoot }), /invalid|content|hash/i);
  assert.deepEqual(readFileSync(markdown), edited);
});

test('normalizes CRLF before Markdown hash comparison', () => {
  const repository = root();
  writeSharedKnowledge(repository, [document()]);
  const base = join(repository, 'agent-experience');
  const markdown = join(base, 'knowledge', 'safe-reset.md');
  writeFileSync(markdown, readFileSync(markdown, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(readSharedKnowledge(repository)[0]?.identity, 'safe-reset');
});

test('keeps one owner-only private recovery generation outside Git and restores only an absent primary', () => {
  const repository = root();
  const stateRoot = mkdtempSync(join(tmpdir(), 'ael-private-state-'));
  writeSharedKnowledge(repository, [{ ...document(), lesson: 'generation one' }], { stateRoot });
  writeSharedKnowledge(repository, [{ ...document(), lesson: 'generation two' }], { stateRoot });
  const digest = createHash('sha256').update(realpathSync.native(repository)).digest('hex');
  const privateDirectory = join(stateRoot, digest);

  assert.deepEqual(readdirSync(repository), ['agent-experience']);
  assert.equal(statSync(privateDirectory).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(privateDirectory).sort(), ['recovery']);
  rmSync(join(repository, 'agent-experience'), { recursive: true });

  assert.equal(readSharedKnowledge(repository, { stateRoot })[0]?.lesson, 'generation one');
  assert.equal(existsSync(join(privateDirectory, 'recovery')), true);
});

test('rolls back from private recovery when publication fails after primary removal', () => {
  const repository = root();
  const stateRoot = mkdtempSync(join(tmpdir(), 'ael-private-state-'));
  writeSharedKnowledge(repository, [{ ...document(), lesson: 'stable generation' }], { stateRoot });

  assert.throws(() => writeSharedKnowledge(repository, [{ ...document(), lesson: 'failed generation' }], {
    stateRoot,
    afterPrimaryRemoved: () => { throw new Error('injected removal failure'); }
  }), /injected removal failure/);

  assert.equal(readSharedKnowledge(repository, { stateRoot })[0]?.lesson, 'stable generation');
});

test('preserves an external primary edit when CAS fails before publication mutates it', () => {
  const repository = root();
  const stateRoot = mkdtempSync(join(tmpdir(), 'ael-private-state-'));
  writeSharedKnowledge(repository, [{ ...document(), lesson: 'stable generation' }], { stateRoot });
  const markdown = join(repository, 'agent-experience', 'knowledge', 'safe-reset.md');
  let externallyEdited = Buffer.alloc(0);

  assert.throws(() => writeSharedKnowledge(repository, [{ ...document(), lesson: 'replacement generation' }], {
    stateRoot,
    beforePrimaryPublication: () => {
      externallyEdited = Buffer.concat([readFileSync(markdown), Buffer.from('external edit\n')]);
      writeFileSync(markdown, externallyEdited);
    }
  }), /changed during locked publication/);

  assert.deepEqual(readFileSync(markdown), externallyEdited);
});

test('preflights publication device identity without mutating primary or recovery', () => {
  const repository = root();
  const stateRoot = mkdtempSync(join(tmpdir(), 'ael-private-state-'));
  writeSharedKnowledge(repository, [{ ...document(), lesson: 'generation one' }], { stateRoot });
  writeSharedKnowledge(repository, [{ ...document(), lesson: 'generation two' }], { stateRoot });
  const digest = createHash('sha256').update(realpathSync.native(repository)).digest('hex');
  const primaryIndex = join(repository, 'agent-experience', 'index.json');
  const primaryMarkdown = join(repository, 'agent-experience', 'knowledge', 'safe-reset.md');
  const recoveryIndex = join(stateRoot, digest, 'recovery', 'index.json');
  const recoveryMarkdown = join(stateRoot, digest, 'recovery', 'knowledge', 'safe-reset.md');
  const primaryBefore = [readFileSync(primaryIndex), readFileSync(primaryMarkdown)];
  const recoveryBefore = [readFileSync(recoveryIndex), readFileSync(recoveryMarkdown)];

  let publicationError: unknown;
  try {
    writeSharedKnowledge(repository, [{ ...document(), lesson: 'must not publish' }], {
      stateRoot,
      deviceStat: (path: string) => path.includes('stage-') ? 2 : 1
    });
  } catch (error) { publicationError = error; }
  assert.ok(publicationError instanceof RepositoryKnowledgeConfigurationError);
  assert.match(publicationError.message, /filesystem|publication configuration/i);
  assert.equal(publicationError.message.includes(repository), false);
  assert.equal(publicationError.message.includes(stateRoot), false);
  assert.deepEqual([readFileSync(primaryIndex), readFileSync(primaryMarkdown)], primaryBefore);
  assert.deepEqual([readFileSync(recoveryIndex), readFileSync(recoveryMarkdown)], recoveryBefore);
});

test('preserves a human edit made after stage publication instead of rolling it back', () => {
  const repository = root();
  const stateRoot = mkdtempSync(join(tmpdir(), 'ael-private-state-'));
  writeSharedKnowledge(repository, [{ ...document(), lesson: 'stable generation' }], { stateRoot });
  const markdown = join(repository, 'agent-experience', 'knowledge', 'safe-reset.md');
  let humanBytes = Buffer.alloc(0);

  let publicationError: unknown;
  try {
    writeSharedKnowledge(repository, [{ ...document(), lesson: 'published generation' }], {
      stateRoot,
      afterPrimaryPublished: () => {
        humanBytes = Buffer.concat([readFileSync(markdown), Buffer.from('human edit after publish\n')]);
        writeFileSync(markdown, humanBytes);
      }
    });
  } catch (error) { publicationError = error; }
  assert.ok(publicationError instanceof RepositoryKnowledgeConflictError);
  assert.match(publicationError.message, /conflict|changed after publication/i);
  assert.deepEqual(readFileSync(markdown), humanBytes);
});

test('recovers a stale dead-owner lock but never deletes a live-owner lock', () => {
  const repository = root();
  const stateRoot = mkdtempSync(join(tmpdir(), 'ael-private-state-'));
  readSharedKnowledge(repository, { stateRoot });
  const lock = join(repositoryLockDirectory(repository), 'lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'dead-owner' }));
  assert.deepEqual(readSharedKnowledge(repository, { stateRoot, clock: () => 100_000, wait: () => {} }), []);
  assert.equal(existsSync(lock), false);

  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, timestamp: 0, token: 'live-owner' }));
  let now = 100_000;
  assert.throws(() => readSharedKnowledge(repository, {
    stateRoot, clock: () => now, wait: (milliseconds) => { now += milliseconds; }, lockTimeoutMs: 50, staleLockMs: 1
  }), /Timed out/);
  assert.equal(existsSync(lock), true);
  rmSync(lock, { recursive: true });
});

test('publishes only fully prepared locks and ages out abandoned candidates separately', () => {
  const repository = root();
  const stateRoot = mkdtempSync(join(tmpdir(), 'ael-private-state-'));
  const privateDirectory = repositoryLockDirectory(repository);
  const lock = join(privateDirectory, 'lock');
  let probed = false;

  assert.throws(() => readSharedKnowledge(repository, {
    stateRoot,
    afterLockCandidatePrepared: (candidate: string) => {
      probed = true;
      assert.equal(existsSync(lock), false);
      assert.equal(existsSync(join(candidate, 'owner.json')), true);
      throw new Error('injected pre-acquisition crash');
    }
  }), /injected pre-acquisition crash/);
  assert.equal(probed, true);

  const abandoned = join(privateDirectory, 'lock-candidate-abandoned');
  mkdirSync(abandoned, { recursive: true });
  writeFileSync(join(abandoned, 'owner.json'), '{}');
  utimesSync(abandoned, 0, 0);
  assert.deepEqual(readSharedKnowledge(repository, { stateRoot, clock: () => 100_000, staleLockMs: 1 }), []);
  assert.equal(existsSync(abandoned), false);

  mkdirSync(lock);
  let currentTime = Date.now();
  assert.throws(() => readSharedKnowledge(repository, {
    stateRoot, clock: () => currentTime, wait: (milliseconds) => { currentTime += milliseconds; }, lockTimeoutMs: 50, staleLockMs: 1_000
  }), /Timed out/);
  assert.equal(existsSync(lock), true);

  utimesSync(lock, 0, 0);
  assert.deepEqual(readSharedKnowledge(repository, { stateRoot, clock: () => currentTime, staleLockMs: 1 }), []);
  assert.equal(existsSync(lock), false);
});

test('rejects a state root whose symlink ancestry resolves inside the repository', () => {
  const repository = root();
  const privateTarget = join(repository, 'private-state-target');
  mkdirSync(privateTarget);
  const apparentStateRoot = join(root(), 'external-state-link');
  symlinkSync(privateTarget, apparentStateRoot);

  assert.throws(() => readSharedKnowledge(repository, { stateRoot: apparentStateRoot }), /private state must be outside/i);
  assert.deepEqual(readdirSync(privateTarget), []);
});

test('rejects canonical sensitive durable text and pre-parse resource excess', () => {
  const unsafe = [
    'password=hunter2',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturevalue',
    'xoxb-1234567890-abcdefghijklmnop',
    'session_id: private-17',
    'User: private transcript line',
    '/Users/private/work/repository',
    'private.person@example.com'
  ];
  for (const value of unsafe) assert.throws(() => writeSharedKnowledge(root(), [{ ...document(), evidenceSummary: value }]), /sensitive|sanitized|credential/i);
  assert.throws(() => writeSharedKnowledge(root(), [{ ...document(), applicability: { ...document().applicability, paths: ['/Users/private/repository'] } }]), /sensitive|sanitized/i);

  const repository = root();
  const base = join(repository, 'agent-experience');
  mkdirSync(join(base, 'knowledge'), { recursive: true });
  writeFileSync(join(base, 'index.json'), ' '.repeat(1_048_577));
  assert.throws(() => readSharedKnowledge(repository), /resource|size|limit/i);
});

test('enforces a closed-world generation and never deletes unrecognized content', () => {
  const repository = root();
  writeSharedKnowledge(repository, [document()]);
  const extra = join(repository, 'agent-experience', 'notes.txt');
  writeFileSync(extra, 'must remain');
  assert.throws(() => readSharedKnowledge(repository), /unrecognized|generation|closed/i);
  assert.throws(() => writeSharedKnowledge(repository, [{ ...document(), lesson: 'replacement' }]), /unrecognized|generation|closed/i);
  assert.equal(readFileSync(extra, 'utf8'), 'must remain');

  const nestedRepository = root();
  writeSharedKnowledge(nestedRepository, [document()]);
  const nested = join(nestedRepository, 'agent-experience', 'knowledge', 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'ignored.txt'), 'unknown nesting');
  assert.throws(() => readSharedKnowledge(nestedRepository), /unrecognized|nesting|generation/i);
});

test('bounds local and adapter reads before accepting index or Markdown content', () => {
  const oversizedMarkdown = root();
  writeSharedKnowledge(oversizedMarkdown, [document()]);
  writeFileSync(join(oversizedMarkdown, 'agent-experience', 'knowledge', 'safe-reset.md'), 'x'.repeat(65_537));
  assert.throws(() => readSharedKnowledge(oversizedMarkdown), /resource|size|limit/i);

  const oversizedUnknown = root();
  writeSharedKnowledge(oversizedUnknown, [document()]);
  writeFileSync(join(oversizedUnknown, 'agent-experience', 'unknown.bin'), Buffer.alloc(1_048_577));
  assert.throws(() => readSharedKnowledge(oversizedUnknown), /unrecognized|resource|generation/i);

  const requestedLimits: Array<[string, number | undefined]> = [];
  const index = JSON.stringify({ version: 1, entries: [] });
  assert.deepEqual(readSharedKnowledgeContent({
    readFile: (path: string, maxBytes?: number) => {
      requestedLimits.push([path, maxBytes]);
      return path === 'index.json' ? index : undefined;
    },
    listFiles: (prefix) => prefix === '' ? ['index.json'] : []
  }), []);
  assert.deepEqual(requestedLimits, [['index.json', 1_048_576]]);
});

test('keeps superseded knowledge and its replacement linked and inspectable', () => {
  const repository = root();
  const old = { ...document('old-rule'), state: 'superseded' as const };
  const replacement = { ...document('new-rule'), supersedes: ['old-rule'] };
  writeSharedKnowledge(repository, [old, replacement]);

  const loaded = readSharedKnowledge(repository);
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded.find((entry) => entry.identity === 'new-rule')?.supersedes, ['old-rule']);
  assert.equal(loaded.find((entry) => entry.identity === 'old-rule')?.state, 'superseded');
});
