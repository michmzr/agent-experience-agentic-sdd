import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { activateGitKnowledge, type GitContentAdapter } from '../src/shared-knowledge/git-activation.js';
import { writeSharedKnowledge, type SharedKnowledgeDocument } from '../src/shared-knowledge/repository.js';
import { initializeGitRepository } from './helpers/git-repository.js';

process.env.AEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'ael-git-state-'));

function doc(identity: string, lesson: string): SharedKnowledgeDocument {
  return { identity, repositoryScope: 'repository:test', kind: 'project-fact', state: 'verified', applicability: { paths: [], tags: [], tools: [] }, instructionOrigin: 'code-tool-confirmed', supersedes: [], title: identity, context: 'context', lesson, recommendedBehavior: 'follow it', evidenceSummary: 'Deterministic code inspection confirmed this.', evidence: [{ kind: 'code-or-tool', summary: 'code', deterministic: true }] };
}

function adapter(repository: string): GitContentAdapter {
  return {
    resolveCommit: (ref) => execFileSync('git', ['-C', repository, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim(),
    readFile: (commit, path, maxBytes) => {
      try {
        const content = execFileSync('git', ['-C', repository, 'show', `${commit}:${path}`], { encoding: 'utf8' });
        if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new Error('Git content limit exceeded.');
        return content;
      }
      catch { return undefined; }
    },
    listFiles: (commit, prefix, maxPaths) => {
      const paths = execFileSync('git', ['-C', repository, 'ls-tree', '-r', '--name-only', commit, '--', prefix], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      if (paths.length > maxPaths) throw new Error('Git path limit exceeded.');
      return paths;
    }
  };
}

function commit(repository: string, message: string): string {
  execFileSync('git', ['-C', repository, 'add', 'agent-experience']);
  execFileSync('git', ['-C', repository, 'commit', '--quiet', '-m', message]);
  return execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

test('trusted ref is authoritative and local additions or modifications are contextual', () => {
  const repository = mkdtempSync(join(tmpdir(), 'ael-git-activation-'));
  initializeGitRepository(repository);
  writeSharedKnowledge(repository, [doc('existing', 'trusted lesson')]);
  commit(repository, 'trusted knowledge');
  execFileSync('git', ['-C', repository, 'branch', 'trusted']);
  execFileSync('git', ['-C', repository, 'switch', '--quiet', '-c', 'feature']);
  writeSharedKnowledge(repository, [doc('existing', 'branch replacement'), doc('addition', 'branch addition')]);

  const activated = activateGitKnowledge(repository, adapter(repository), 'trusted');
  const existing = activated.entries.find((entry) => entry.document.identity === 'existing');
  const addition = activated.entries.find((entry) => entry.document.identity === 'addition');
  assert.equal(existing?.authoritative, true);
  assert.equal(existing?.document.lesson, 'trusted lesson');
  assert.equal(existing?.provenance.commit, activated.trustedCommit);
  assert.equal(addition?.authoritative, false);
});

test('no trusted ref means no authority and merged addition activates only through trusted ref', () => {
  const repository = mkdtempSync(join(tmpdir(), 'ael-git-activation-'));
  initializeGitRepository(repository);
  writeSharedKnowledge(repository, [doc('addition', 'new lesson')]);
  const featureCommit = commit(repository, 'feature knowledge');

  assert.equal(activateGitKnowledge(repository, adapter(repository)).entries[0]?.authoritative, false);
  execFileSync('git', ['-C', repository, 'branch', 'trusted', featureCommit]);
  const activated = activateGitKnowledge(repository, adapter(repository), 'trusted');
  assert.equal(activated.entries[0]?.authoritative, true);
  assert.equal(activated.trustedCommit, featureCommit);
});

test('rejects unrecognized files in a trusted Git generation', () => {
  const repository = mkdtempSync(join(tmpdir(), 'ael-git-activation-'));
  initializeGitRepository(repository);
  writeSharedKnowledge(repository, [doc('existing', 'trusted lesson')]);
  const extra = join(repository, 'agent-experience', 'notes.txt');
  writeFileSync(extra, 'unrecognized');
  commit(repository, 'invalid trusted knowledge');
  execFileSync('git', ['-C', repository, 'branch', 'trusted']);
  rmSync(extra);

  assert.throws(() => activateGitKnowledge(repository, adapter(repository), 'trusted'), /unrecognized|generation/i);
});
