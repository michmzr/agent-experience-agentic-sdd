import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readSharedKnowledge, writeSharedKnowledge, type SharedKnowledgeDocument } from '../src/shared-knowledge/repository.js';

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

test('version 2 repository round-trips with byte-stable output', () => {
  const repository = root();
  writeSharedKnowledge(repository, [document()]);
  const index = join(repository, 'agent-experience', 'index.json');
  const markdown = join(repository, 'agent-experience', 'knowledge', 'safe-reset.md');
  const before = [readFileSync(index, 'utf8'), readFileSync(markdown, 'utf8')];

  writeSharedKnowledge(repository, [document()]);

  assert.deepEqual([readFileSync(index, 'utf8'), readFileSync(markdown, 'utf8')], before);
  assert.deepEqual(readSharedKnowledge(repository), [document()]);
  assert.match(before[1], /## Lesson\n\nDestructive reset/);
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
  assert.throws(() => readSharedKnowledge(nested), /orphan/i);
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

test('serves the prior complete generation during the directory swap and restores it on publication failure', () => {
  const repository = root();
  writeSharedKnowledge(repository, [document()]);
  let duringSwap: SharedKnowledgeDocument[] | undefined;

  assert.throws(() => writeSharedKnowledge(repository, [{ ...document(), lesson: 'replacement' }], {
    afterCurrentMovedToBackup: () => {
      duringSwap = readSharedKnowledge(repository);
      throw new Error('injected publication failure');
    }
  }), /injected publication failure/);

  assert.equal(duringSwap?.[0]?.lesson, document().lesson);
  assert.equal(readSharedKnowledge(repository)[0]?.lesson, document().lesson);
});

test('recovers an interrupted stable backup and safely cleans a leftover stage before publishing', () => {
  const repository = root();
  writeSharedKnowledge(repository, [document()]);
  const primary = join(repository, 'agent-experience');
  const backup = join(repository, '.agent-experience-backup');
  const stage = join(repository, '.agent-experience-stage');
  renameSync(primary, backup);
  cpSync(backup, stage, { recursive: true });

  assert.equal(readSharedKnowledge(repository)[0]?.lesson, document().lesson);
  writeSharedKnowledge(repository, [{ ...document(), lesson: 'recovered replacement' }]);

  assert.equal(readSharedKnowledge(repository)[0]?.lesson, 'recovered replacement');
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(stage), false);
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
