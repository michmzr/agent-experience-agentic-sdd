import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { KnowledgeEntry } from '../src/domain/types.js';
import { writeRepositoryKnowledge, type RepositoryKnowledgeDocument } from '../src/storage/repository-knowledge.js';

function mergedRepositoryKnowledge(): RepositoryKnowledgeDocument {
  return {
    entry: {
      id: 'knowledge-destructive-reset' as KnowledgeEntry['id'],
      candidateId: 'candidate-destructive-reset' as KnowledgeEntry['candidateId'],
      evidenceIds: ['evidence-destructive-reset' as KnowledgeEntry['evidenceIds'][number]],
      state: 'verified',
      statement: 'Prevent destructive reset'
    },
    kind: 'convention',
    context: 'When restoring a working tree with unrelated local edits.',
    recommendedBehavior: 'Inspect the diff and use a recoverable operation before resetting files.',
    evidenceSummary: 'Two reviewed changes recovered unintended local edits without losing history.',
    applicability: { tool: 'git', path: 'src', tags: ['safety', 'git', 'safety'] },
    lastVerification: { at: '2026-08-24T10:00:00.000Z', by: 'codex' },
    approval: { at: '2026-08-24T11:00:00.000Z', kind: 'user' },
    activation: 'merged-team-active',
    mergedProvenance: 'abc123: PR #42'
  };
}

function repositoryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ael-repository-knowledge-'));
}

test('writes byte-stable, deterministically ordered repository index and Markdown', () => {
  const root = repositoryRoot();
  const first = mergedRepositoryKnowledge();
  const second = { ...mergedRepositoryKnowledge(), applicability: { tags: ['git', 'safety'], path: 'src', tool: 'git' } };

  writeRepositoryKnowledge(root, first);
  const indexPath = join(root, 'agent-experience', 'index.json');
  const entryPath = join(root, 'agent-experience', 'knowledge', 'knowledge-destructive-reset.md');
  const initialIndex = readFileSync(indexPath, 'utf8');
  const initialMarkdown = readFileSync(entryPath, 'utf8');

  writeRepositoryKnowledge(root, second);

  assert.equal(readFileSync(indexPath, 'utf8'), initialIndex);
  assert.equal(readFileSync(entryPath, 'utf8'), initialMarkdown);
  assert.equal(initialIndex, `{
  "entries": [
    {
      "applicability": {
        "path": "src",
        "tags": [
          "git",
          "safety"
        ],
        "tool": "git"
      },
      "approval": {
        "at": "2026-08-24T11:00:00.000Z",
        "kind": "user"
      },
      "identity": "knowledge-destructive-reset",
      "kind": "convention",
      "lastVerification": {
        "at": "2026-08-24T10:00:00.000Z",
        "by": "codex"
      },
      "mergedProvenance": "abc123: PR #42",
      "state": "verified"
    }
  ],
  "version": 1
}
`);
  assert.equal(initialMarkdown, `# Prevent destructive reset

## Context

When restoring a working tree with unrelated local edits.

## Recommended behavior

Inspect the diff and use a recoverable operation before resetting files.

## Evidence summary

Two reviewed changes recovered unintended local edits without losing history.
`);
});

test('rejects merged team activation without merged provenance', () => {
  const root = repositoryRoot();
  const document = { ...mergedRepositoryKnowledge(), mergedProvenance: undefined };

  assert.throws(() => writeRepositoryKnowledge(root, document), /merged provenance/);
});

test('rejects a knowledge identifier that could traverse the output path', () => {
  const root = repositoryRoot();
  const document = { ...mergedRepositoryKnowledge(), entry: { ...mergedRepositoryKnowledge().entry, id: '../outside' as KnowledgeEntry['id'] } };

  assert.throws(() => writeRepositoryKnowledge(root, document), /safe filename/);
});

test('rejects raw transcript and private review fields at the export boundary', () => {
  const root = repositoryRoot();
  const withTranscript = { ...mergedRepositoryKnowledge(), rawTranscript: 'User: private request\nAssistant: private response' };
  const withPrivateReview = { ...mergedRepositoryKnowledge(), privateReview: 'Private reviewer notes are not Git-reviewable knowledge.' };

  assert.throws(() => writeRepositoryKnowledge(root, withTranscript), /raw transcript/i);
  assert.throws(() => writeRepositoryKnowledge(root, withPrivateReview), /private review/i);
});

test('rejects credential-like text at the export boundary before writing files', () => {
  const root = repositoryRoot();
  const document = { ...mergedRepositoryKnowledge(), evidenceSummary: 'Observed key sk-abcdefghijklmnopqrstuvwxyz1234 in a session.' };

  assert.throws(() => writeRepositoryKnowledge(root, document), /credential-like/i);
  assert.throws(() => readFileSync(join(root, 'agent-experience', 'index.json'), 'utf8'), /ENOENT/);
});

test('orders tags by Unicode code units instead of locale collation', () => {
  const root = repositoryRoot();
  const document = { ...mergedRepositoryKnowledge(), applicability: { tags: ['ä', 'Z', 'a', 'Ä'] } };

  writeRepositoryKnowledge(root, document);

  const index = readFileSync(join(root, 'agent-experience', 'index.json'), 'utf8');
  assert.match(index, /"tags": \[\n          "Z",\n          "a",\n          "Ä",\n          "ä"/);
});
