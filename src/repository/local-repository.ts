import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

export interface LocalRepository {
  readonly id: string;
  readonly root: string;
  readonly repositoryFamilyKey: string;
  readonly worktreeKey: string;
}

export function resolveRepository(directory: string): LocalRepository | undefined {
  try {
    const workingDirectory = realpathSync(directory);
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workingDirectory,
      encoding: 'utf8'
    });
    if (result.status !== 0) return undefined;
    const root = realpathSync(result.stdout.trim());
    const commonDirectory = gitPath(root);
    if (!commonDirectory) return undefined;
    const canonicalCommonDirectory = realpathSync(commonDirectory.startsWith('/') ? commonDirectory : `${root}/${commonDirectory}`);
    return Object.freeze({ id: createHash('sha256').update(`ael:repository:v1\0${root}`).digest('hex'), root, repositoryFamilyKey: localKey('repository-family:v1', canonicalCommonDirectory), worktreeKey: localKey('worktree:v1', root) });
  } catch {
    return undefined;
  }
}

function gitPath(root: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function localKey(namespace: string, value: string): string {
  return createHash('sha256').update(`ael:${namespace}\0${value}`).digest('hex');
}

export function resolveRepositoryRoot(directory: string): LocalRepository | undefined {
  const repository = resolveRepository(directory);
  if (repository === undefined) return undefined;
  try {
    return realpathSync(directory) === repository.root ? repository : undefined;
  } catch {
    return undefined;
  }
}
