import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { normalizeSession, type NormalizedSession, type SessionArtifact } from '../contracts.js';

export function discoverCursorExports(root: string): readonly SessionArtifact[] {
  const resolvedRoot = resolve(root);
  return readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .map((entry) => ({ source: 'cursor' as const, id: basename(entry.name, extname(entry.name)), location: resolve(resolvedRoot, entry.name), format: 'markdown-export' as const }));
}

class CursorPathBoundaryError extends Error {}

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

export function readCursorMarkdownExport(artifact: SessionArtifact, root: string, occurredAt: string): NormalizedSession {
  if (artifact.source !== 'cursor') throw new Error('Cursor adapter requires a Cursor artifact.');
  if (artifact.format !== 'markdown-export') throw new Error('Cursor adapter requires a Markdown export.');
  const location = resolveCursorExport(root, artifact.location);
  let contents: string;
  try { contents = readFileSync(location, 'utf8'); }
  catch { throw new Error('Cursor export could not be read.'); }
  const headings = contents.match(/^##\s+(?:User|Assistant)\s*$/gim) ?? [];
  if (headings.length === 0) throw new Error('Cursor export contains no supported message headings.');
  return normalizeSession({ source: 'cursor', artifact, records: headings.map(() => ({ kind: 'message', occurredAt })) });
}
