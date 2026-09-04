import { lstatSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  MAX_SESSION_REVIEW_TEXT_LENGTH,
  assertSessionArtifactSize,
  normalizeSession,
  type NormalizedSession,
  type SessionArtifact
} from '../contracts.js';
import { isWithinRepository, resolveRepositoryIdentity } from '../repository-identity.js';
import { createBoundedSessionAccumulator } from '../bounded-session.js';
import { readBoundedLines } from './bounded-lines.js';

class CursorPathBoundaryError extends Error {}

function resolveCursorDiscoveryRoot(root: string): string {
  try {
    const suppliedRoot = resolve(root);
    if (lstatSync(suppliedRoot).isSymbolicLink()) throw new CursorPathBoundaryError('Cursor export root may not be a symlink.');
    realpathSync(suppliedRoot);
    return suppliedRoot;
  } catch (error) {
    if (error instanceof CursorPathBoundaryError) throw error;
    throw new CursorPathBoundaryError('Cursor export root could not be validated.');
  }
}

export function discoverCursorExports(root: string): readonly SessionArtifact[] {
  const resolvedRoot = resolveCursorDiscoveryRoot(root);
  const repository = resolveRepositoryIdentity(resolvedRoot);
  let entries: Dirent<string>[];
  try { entries = readdirSync(resolvedRoot, { withFileTypes: true }); }
  catch { throw new CursorPathBoundaryError('Cursor export root could not be read.'); }
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .map((entry) => {
      const location = resolve(resolvedRoot, entry.name);
      if (repository && !isWithinRepository(repository, location)) throw new CursorPathBoundaryError('Cursor export repository scope could not be verified.');
      return {
        source: 'cursor' as const,
        id: basename(entry.name, extname(entry.name)),
        location,
        format: 'markdown-export' as const,
        ...(repository ? {
          repositoryHint: repository.hint,
          repositoryHintVerified: true,
          repositoryIdentity: repository.canonicalTopLevel
        } : {}),
        updatedAt: lstatSync(location).mtime.toISOString()
      };
    });
}

function isOutsideRoot(root: string, location: string): boolean {
  const pathFromRoot = relative(root, location);
  return pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
}

function resolveCursorExport(root: string, location: string): string {
  try {
    const suppliedRoot = resolve(root); const suppliedLocation = resolve(location);
    if (lstatSync(suppliedRoot).isSymbolicLink()) throw new CursorPathBoundaryError('Cursor export root may not be a symlink.');
    if (isOutsideRoot(suppliedRoot, suppliedLocation)) throw new CursorPathBoundaryError('Cursor export is outside the supplied root.');

    let current = suppliedRoot;
    for (const segment of relative(suppliedRoot, suppliedLocation).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) throw new CursorPathBoundaryError('Cursor export path may not contain symlinks.');
    }

    const realRoot = realpathSync(suppliedRoot); const realLocation = realpathSync(suppliedLocation);
    if (isOutsideRoot(realRoot, realLocation)) throw new CursorPathBoundaryError('Cursor export is outside the supplied root.');
    return realLocation;
  } catch (error) {
    if (error instanceof CursorPathBoundaryError) throw error;
    throw new CursorPathBoundaryError('Cursor export path could not be validated.');
  }
}

export async function readCursorMarkdownExport(artifact: SessionArtifact, root: string, occurredAt: string): Promise<NormalizedSession> {
  if (artifact.source !== 'cursor') throw new Error('Cursor adapter requires a Cursor artifact.');
  if (artifact.format !== 'markdown-export') throw new Error('Cursor adapter requires a Markdown export.');
  const location = resolveCursorExport(root, artifact.location);
  assertSessionArtifactSize(lstatSync(location).size);
  const accumulator = createBoundedSessionAccumulator();
  const heading = /^##\s+(?:User|Assistant)\s*$/i;
  let foundHeading = false;
  let text: string | undefined;
  let textBytes = 0;

  const submitMessage = (): void => {
    if (!foundHeading) return;
    accumulator.add({ kind: 'message', occurredAt, ...(text?.trim() ? { text } : {}) });
  };
  const appendLine = (line: string): void => {
    if (text === undefined) return;
    const next = text ? `\n${line}` : line;
    const nextBytes = Buffer.byteLength(next, 'utf8');
    if (textBytes + nextBytes > MAX_SESSION_REVIEW_TEXT_LENGTH) {
      text = undefined;
      return;
    }
    text += next;
    textBytes += nextBytes;
  };

  await readBoundedLines({
    path: location,
    errorMessage: 'Cursor export could not be read.',
    onLine: (line) => {
      if (heading.test(line)) {
        submitMessage();
        foundHeading = true;
        text = '';
        textBytes = 0;
        return;
      }
      if (foundHeading) appendLine(line);
    }
  });
  if (!foundHeading) throw new Error('Cursor export contains no supported message headings.');
  submitMessage();
  const window = accumulator.finish();
  return normalizeSession({ source: 'cursor', artifact, records: window.records, startedAt: window.startedAt, endedAt: window.endedAt });
}
