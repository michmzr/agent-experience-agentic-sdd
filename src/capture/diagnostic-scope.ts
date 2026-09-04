import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';

import type { RepositoryId } from '../domain/types.js';
import { resolveRepository } from '../repository/local-repository.js';

export type DiagnosticScope =
  | { readonly kind: 'repository'; readonly id: RepositoryId }
  | { readonly kind: 'workspace'; readonly id: string }
  | { readonly kind: 'global'; readonly id: 'global' };

interface WorkspaceConfiguration {
  readonly version: 1;
  readonly workspaceId: string;
}

const WORKSPACE_DIRECTORY_MODE = 0o755;
const WORKSPACE_CONFIGURATION_MODE = 0o644;
const workspaceConfigurationName = 'workspace.json';
const workspaceConfigurationDirectory = '.ael';
const WORKSPACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_WORKSPACE_ID_LENGTH = 64;
const resolvedScopes = new WeakSet<object>();

export function resolveDiagnosticScope(directory?: string): DiagnosticScope {
  if (directory === undefined) return resolvedScope({ kind: 'global', id: 'global' });
  const workspaceRoot = normalizeRealDirectory(directory);
  const configuration = readWorkspaceConfiguration(workspaceRoot);
  if (configuration !== undefined) return workspaceScope(configuration.workspaceId);

  const repository = resolveRepository(workspaceRoot);
  if (repository !== undefined) return resolvedScope({ kind: 'repository', id: repository.id as RepositoryId });
  return initializeDiagnosticWorkspace(workspaceRoot);
}

export function initializeDiagnosticWorkspace(directory: string, workspaceId?: string): DiagnosticScope {
  const workspaceRoot = normalizeRealDirectory(directory);
  const existing = readWorkspaceConfiguration(workspaceRoot);
  if (existing !== undefined) return workspaceScope(existing.workspaceId);

  const id = workspaceId === undefined ? slugifyWorkspaceDirectory(workspaceRoot) : checkedWorkspaceId(workspaceId);
  const configurationDirectory = join(workspaceRoot, workspaceConfigurationDirectory);
  const configurationPath = join(configurationDirectory, workspaceConfigurationName);
  ensureWorkspaceConfigurationDirectory(configurationDirectory);
  const serialized = `${JSON.stringify({ version: 1, workspaceId: id }, null, 2)}\n`;
  try {
    writeFileSync(configurationPath, serialized, { encoding: 'utf8', mode: WORKSPACE_CONFIGURATION_MODE, flag: 'wx' });
  } catch (error) {
    if (!isExistingPath(error)) throw error;
    const configuration = readWorkspaceConfiguration(workspaceRoot);
    if (configuration === undefined) throw new TypeError('Diagnostic workspace configuration is invalid.');
    return workspaceScope(configuration.workspaceId);
  }
  return workspaceScope(id);
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

function readWorkspaceConfiguration(workspaceRoot: string): WorkspaceConfiguration | undefined {
  const configurationDirectory = join(workspaceRoot, workspaceConfigurationDirectory);
  const configurationPath = join(configurationDirectory, workspaceConfigurationName);
  let directory;
  try {
    directory = lstatSync(configurationDirectory);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new TypeError('Diagnostic workspace configuration is invalid.');

  let metadata;
  try {
    metadata = lstatSync(configurationPath);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError('Diagnostic workspace configuration is invalid.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configurationPath, 'utf8')) as unknown;
  } catch {
    throw new TypeError('Diagnostic workspace configuration is invalid.');
  }
  const configuration = checkedWorkspaceConfiguration(parsed);
  chmodSync(configurationDirectory, WORKSPACE_DIRECTORY_MODE);
  chmodSync(configurationPath, WORKSPACE_CONFIGURATION_MODE);
  return configuration;
}

function ensureWorkspaceConfigurationDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: WORKSPACE_DIRECTORY_MODE });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError('Diagnostic workspace configuration is invalid.');
  chmodSync(directory, WORKSPACE_DIRECTORY_MODE);
}

function checkedWorkspaceConfiguration(value: unknown): WorkspaceConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Diagnostic workspace configuration is invalid.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 1 || typeof record.workspaceId !== 'string') {
    throw new TypeError('Diagnostic workspace configuration is invalid.');
  }
  try {
    return Object.freeze({ version: 1, workspaceId: checkedWorkspaceId(record.workspaceId) });
  } catch {
    throw new TypeError('Diagnostic workspace configuration is invalid.');
  }
}

function checkedWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_WORKSPACE_ID_LENGTH || !WORKSPACE_ID.test(value)) {
    throw new TypeError('Diagnostic workspace ID is invalid.');
  }
  return value;
}

function slugifyWorkspaceDirectory(directory: string): string {
  const slug = basename(directory).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_WORKSPACE_ID_LENGTH).replace(/-+$/g, '');
  return checkedWorkspaceId(slug || 'workspace');
}

function workspaceScope(id: string): DiagnosticScope {
  return resolvedScope({ kind: 'workspace', id });
}

function resolvedScope<T extends DiagnosticScope>(scope: T): T {
  const frozen = Object.freeze(scope);
  resolvedScopes.add(frozen);
  return frozen;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isExistingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
