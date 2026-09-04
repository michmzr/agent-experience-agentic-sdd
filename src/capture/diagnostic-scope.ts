import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

import type { RepositoryId } from '../domain/types.js';
import { resolveRepository } from '../repository/local-repository.js';

export type DiagnosticScope =
  | { readonly kind: 'repository'; readonly id: RepositoryId }
  | { readonly kind: 'workspace'; readonly id: string }
  | { readonly kind: 'global'; readonly id: 'global' };

const WORKSPACE_DIRECTORY_MODE = 0o700;
const WORKSPACE_MARKER_MODE = 0o600;
const workspaceMarkerName = 'workspace-id';
const workspaceMarkerDirectory = '.ael';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const resolvedScopes = new WeakSet<object>();

export function resolveDiagnosticScope(directory?: string): DiagnosticScope {
  if (directory === undefined) return resolvedScope({ kind: 'global', id: 'global' });
  const repository = resolveRepository(directory);
  if (repository !== undefined) return resolvedScope({ kind: 'repository', id: repository.id as RepositoryId });

  const workspaceRoot = normalizeRealDirectory(directory);
  const workspaceId = workspaceMarker(workspaceRoot);
  return resolvedScope({ kind: 'workspace', id: createHash('sha256').update(workspaceId).digest('hex') });
}

export function isResolvedDiagnosticScope(scope: unknown): scope is DiagnosticScope {
  return typeof scope === 'object' && scope !== null && resolvedScopes.has(scope);
}

function normalizeRealDirectory(directory: string): string {
  if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('Diagnostic workspace directory is invalid.');
  const workspace = lstatSync(directory);
  if (!workspace.isDirectory() && !workspace.isSymbolicLink()) throw new TypeError('Diagnostic workspace directory is invalid.');
  return normalize(realpathSync(directory));
}

function workspaceMarker(workspaceRoot: string): string {
  const markerDirectory = join(workspaceRoot, workspaceMarkerDirectory);
  const markerPath = join(markerDirectory, workspaceMarkerName);
  mkdirSync(markerDirectory, { recursive: true, mode: WORKSPACE_DIRECTORY_MODE });
  const directory = lstatSync(markerDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new TypeError('Diagnostic workspace marker directory is invalid.');
  chmodSync(markerDirectory, WORKSPACE_DIRECTORY_MODE);

  try {
    const metadata = lstatSync(markerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError('Diagnostic workspace marker is invalid.');
    const marker = readFileSync(markerPath, 'utf8');
    if (!UUID.test(marker)) throw new TypeError('Diagnostic workspace marker is invalid.');
    chmodSync(markerPath, WORKSPACE_MARKER_MODE);
    return marker.toLowerCase();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }

  const marker = randomUUID();
  try {
    writeFileSync(markerPath, marker, { encoding: 'utf8', mode: WORKSPACE_MARKER_MODE, flag: 'wx' });
    return marker;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    return workspaceMarker(workspaceRoot);
  }
}

function resolvedScope<T extends DiagnosticScope>(scope: T): T {
  const frozen = Object.freeze(scope);
  resolvedScopes.add(frozen);
  return frozen;
}
