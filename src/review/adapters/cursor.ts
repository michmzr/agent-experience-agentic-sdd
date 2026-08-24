import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';

import { normalizeSession, type NormalizedSession, type SessionArtifact } from '../contracts.js';

export function discoverCursorExports(root: string): readonly SessionArtifact[] {
  const resolvedRoot = resolve(root);
  return readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .map((entry) => ({ source: 'cursor' as const, id: basename(entry.name, extname(entry.name)), location: resolve(resolvedRoot, entry.name), format: 'markdown-export' as const }));
}

export function readCursorMarkdownExport(artifact: SessionArtifact, root: string, occurredAt: string): NormalizedSession {
  if (artifact.source !== 'cursor') throw new Error('Cursor adapter requires a Cursor artifact.');
  if (artifact.format !== 'markdown-export') throw new Error('Cursor adapter requires a Markdown export.');
  const location = resolve(artifact.location); const resolvedRoot = resolve(root);
  if (relative(resolvedRoot, location).startsWith('..')) throw new Error('Cursor export is outside the supplied root.');
  if (lstatSync(location).isSymbolicLink()) throw new Error('Cursor export may not be a symlink.');
  const headings = readFileSync(location, 'utf8').match(/^##\s+(?:User|Assistant)\s*$/gim) ?? [];
  if (headings.length === 0) throw new Error('Cursor export contains no supported message headings.');
  return normalizeSession({ source: 'cursor', artifact, records: headings.map(() => ({ kind: 'message', occurredAt })) });
}
