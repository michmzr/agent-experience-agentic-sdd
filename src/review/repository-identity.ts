import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_GIT_CONTROL_FILE_BYTES = 4096;

export interface RepositoryIdentity {
  readonly canonicalTopLevel: string;
  readonly hint: string;
}

export type RepositoryIdentityResolver = (directory: string) => RepositoryIdentity | undefined;

export const resolveRepositoryIdentity: RepositoryIdentityResolver = (directory) => {
  try {
    const supplied = resolve(directory);
    const suppliedStatus = lstatSync(supplied);
    if (!suppliedStatus.isDirectory()) return undefined;
    let current = realpathSync(supplied);

    while (true) {
      const marker = gitMarker(current);
      if (marker === 'valid') {
        return { canonicalTopLevel: current, hint: basename(current) || 'root' };
      }
      if (marker === 'invalid') return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  } catch {
    return undefined;
  }
};

export function isWithinRepository(repository: RepositoryIdentity, candidate: string): boolean {
  try {
    const resolvedCandidate = realpathSync(candidate);
    const pathFromRoot = relative(repository.canonicalTopLevel, resolvedCandidate);
    return pathFromRoot === '' || (
      pathFromRoot !== '..'
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    );
  } catch {
    return false;
  }
}

function gitMarker(repository: string): 'missing' | 'valid' | 'invalid' {
  const marker = join(repository, '.git');
  let status;
  try { status = lstatSync(marker); }
  catch (error) { return isMissing(error) ? 'missing' : 'invalid'; }
  if (status.isSymbolicLink()) return 'invalid';
  if (status.isDirectory()) return isGitControlDirectory(marker) ? 'valid' : 'invalid';
  if (!status.isFile() || status.size > MAX_GIT_CONTROL_FILE_BYTES) return 'invalid';

  try {
    const contents = readFileSync(marker, 'utf8');
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(contents);
    if (!match) return 'invalid';
    const target = resolve(repository, match[1]!);
    return isGitControlDirectory(realpathSync(target)) ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

function isGitControlDirectory(directory: string): boolean {
  try {
    const status = lstatSync(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) return false;
    const head = join(directory, 'HEAD');
    const headStatus = lstatSync(head);
    if (!headStatus.isFile() || headStatus.isSymbolicLink() || headStatus.size > MAX_GIT_CONTROL_FILE_BYTES) return false;
    const contents = readFileSync(head, 'utf8').trim();
    return /^ref: refs\/[A-Za-z0-9._\/-]+$/.test(contents) || /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(contents);
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
