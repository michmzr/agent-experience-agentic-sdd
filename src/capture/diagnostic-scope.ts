import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';

import type { RepositoryId } from '../domain/types.js';
import { resolveRepository } from '../repository/local-repository.js';
import { resolvePrivateDataDirectory } from '../storage/database.js';

export type DiagnosticScope =
  | { readonly kind: 'repository'; readonly id: RepositoryId }
  | { readonly kind: 'workspace'; readonly id: string }
  | { readonly kind: 'global'; readonly id: 'global' };

interface WorkspaceConfiguration {
  readonly version: 1;
  readonly workspaceId: string;
}

export interface DiagnosticScopeResolutionOptions {
  readonly dataDirectory?: string;
}

export interface ConfiguredWorkspace {
  readonly id: string;
  readonly root: string;
}

const WORKSPACE_DIRECTORY_MODE = 0o755;
const WORKSPACE_CONFIGURATION_MODE = 0o644;
const WORKSPACE_CLAIM_DIRECTORY_MODE = 0o700;
const WORKSPACE_CLAIM_MODE = 0o600;
const WORKSPACE_HASH_SUFFIX_LENGTH = 8;
const workspaceConfigurationName = 'workspace.json';
const workspaceConfigurationDirectory = '.ael';
const workspaceClaimDirectory = 'workspace-scope-claims';
const WORKSPACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH_HASH_CLAIM = /^[a-f0-9]{64}\n$/;
const MAX_WORKSPACE_ID_LENGTH = 64;
const resolvedScopes = new WeakSet<object>();

export function resolveDiagnosticScope(directory?: string, options: DiagnosticScopeResolutionOptions = {}): DiagnosticScope {
  if (directory === undefined) return resolvedScope({ kind: 'global', id: 'global' });
  const workspaceRoot = normalizeRealDirectory(directory);
  const configuration = readWorkspaceConfiguration(workspaceRoot);
  if (configuration !== undefined) return workspaceScope(configuration.workspaceId);

  const repository = resolveRepository(workspaceRoot);
  if (repository !== undefined) {
    const repositoryRoot = normalizeRealDirectory(repository.root);
    const rootConfiguration = readWorkspaceConfiguration(repositoryRoot);
    if (rootConfiguration !== undefined) return workspaceScope(rootConfiguration.workspaceId);
    return resolvedScope({ kind: 'repository', id: repository.id as RepositoryId });
  }
  return initializeDiagnosticWorkspace(workspaceRoot, undefined, options);
}

export function initializeDiagnosticWorkspace(
  directory: string,
  workspaceId?: string,
  options: DiagnosticScopeResolutionOptions = {}
): DiagnosticScope {
  const workspaceRoot = normalizeRealDirectory(directory);
  const existing = readWorkspaceConfiguration(workspaceRoot);
  if (existing !== undefined) return workspaceScope(existing.workspaceId);

  const id = workspaceId === undefined
    ? claimDefaultWorkspaceId(workspaceRoot, options.dataDirectory ?? resolvePrivateDataDirectory())
    : checkedWorkspaceId(workspaceId);
  const configurationDirectory = join(workspaceRoot, workspaceConfigurationDirectory);
  const configurationPath = join(configurationDirectory, workspaceConfigurationName);
  ensureWorkspaceConfigurationDirectory(configurationDirectory);
  const serialized = `${JSON.stringify({ version: 1, workspaceId: id }, null, 2)}\n`;
  try {
    writeFileSync(configurationPath, serialized, { encoding: 'utf8', mode: WORKSPACE_CONFIGURATION_MODE, flag: 'wx' });
    chmodSync(configurationPath, WORKSPACE_CONFIGURATION_MODE);
  } catch (error) {
    if (!isExistingPath(error)) throw error;
    const configuration = readWorkspaceConfiguration(workspaceRoot);
    if (configuration === undefined) throw new TypeError('Diagnostic workspace configuration is invalid.');
    return workspaceScope(configuration.workspaceId);
  }
  return workspaceScope(id);
}

export function resolveConfiguredWorkspaceRoot(directory: string): ConfiguredWorkspace | undefined {
  try {
    const root = normalizeRealDirectory(directory);
    const configuration = readWorkspaceConfiguration(root);
    return configuration === undefined ? undefined : Object.freeze({ id: configuration.workspaceId, root });
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

export function findConfiguredWorkspaceRoot(directory: string): ConfiguredWorkspace | undefined {
  let current = normalizeRealDirectory(directory);
  while (true) {
    const configuration = readWorkspaceConfiguration(current);
    if (configuration !== undefined) return Object.freeze({ id: configuration.workspaceId, root: current });
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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

function claimDefaultWorkspaceId(workspaceRoot: string, dataDirectory: string): string {
  const readableId = slugifyWorkspaceDirectory(workspaceRoot);
  const pathHash = createHash('sha256').update(workspaceRoot).digest('hex');
  const claimDirectory = join(dataDirectory, workspaceClaimDirectory);
  ensureWorkspaceClaimDirectory(claimDirectory);
  if (claimWorkspaceId(claimDirectory, readableId, pathHash)) return readableId;

  const suffix = pathHash.slice(0, WORKSPACE_HASH_SUFFIX_LENGTH);
  const readableLimit = MAX_WORKSPACE_ID_LENGTH - WORKSPACE_HASH_SUFFIX_LENGTH - 1;
  const prefix = readableId.slice(0, readableLimit).replace(/-+$/g, '') || 'workspace';
  const disambiguatedId = `${prefix}-${suffix}`;
  if (claimWorkspaceId(claimDirectory, disambiguatedId, pathHash)) return disambiguatedId;
  throw new TypeError('Diagnostic workspace ID collision cannot be resolved.');
}

function ensureWorkspaceClaimDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: WORKSPACE_CLAIM_DIRECTORY_MODE });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError('Diagnostic workspace claim registry is invalid.');
  chmodSync(directory, WORKSPACE_CLAIM_DIRECTORY_MODE);
}

function claimWorkspaceId(directory: string, workspaceId: string, pathHash: string): boolean {
  const claimPath = join(directory, workspaceId);
  try {
    writeFileSync(claimPath, `${pathHash}\n`, { encoding: 'utf8', mode: WORKSPACE_CLAIM_MODE, flag: 'wx' });
    chmodSync(claimPath, WORKSPACE_CLAIM_MODE);
    return true;
  } catch (error) {
    if (!isExistingPath(error)) throw error;
  }

  const metadata = lstatSync(claimPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError('Diagnostic workspace claim registry is invalid.');
  const claim = readFileSync(claimPath, 'utf8');
  if (!PATH_HASH_CLAIM.test(claim)) throw new TypeError('Diagnostic workspace claim registry is invalid.');
  chmodSync(claimPath, WORKSPACE_CLAIM_MODE);
  return claim.slice(0, -1) === pathHash;
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
