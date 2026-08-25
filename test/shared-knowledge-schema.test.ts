import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
