import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { realpathSync } from 'node:fs';

export type AelSkillScope = 'workspace' | 'global';
export type AelSkillStatus = 'valid' | 'current' | 'code-changed' | 'invalid' | 'unverified';
export interface AelSkillManifest {
  readonly schemaVersion: 1;
  readonly skillVersion: string;
  readonly compatibleAelVersion: string;
  readonly documentationSnapshotDate: string;
  readonly files: Readonly<Record<string, string>>;
}
export interface AelSkillLocation {
  readonly source: string;
  readonly scope: AelSkillScope;
  readonly workspace: string;
  readonly home: string;
}
export interface AelSkillOperation {
  readonly status: 'installed' | 'updated' | 'unchanged' | 'removed' | 'confirmation-required';
  readonly destination: string;
}
export interface AelSkillInspection {
  readonly status: AelSkillStatus;
  readonly destination: string;
}

const maxFileBytes = 64 * 1024;
const manifestFile = '.ael-skill.json';
const artifactFiles = [
  'SKILL.md',
  'agents/openai.yaml',
  'references/setup-and-health.md',
  'references/session-review.md',
  'references/knowledge-lifecycle.md',
  'references/runtime-and-profiles.md',
  'references/diagnostics.md',
  'references/command-reference.md'
] as const;

export class AelSkillError extends Error {
  constructor(readonly code: 'AEL_SKILL_SOURCE_INVALID' | 'AEL_SKILL_DESTINATION_UNSAFE' | 'AEL_SKILL_LOCATION_INVALID', message: string) {
    super(`${code}: ${message}`);
  }
}

export function validateAelSkill(directory: string): { readonly status: 'valid' | 'invalid'; readonly manifest?: AelSkillManifest } {
  try {
    const files = readArtifactFiles(directory, false);
    return { status: 'valid', manifest: createManifest(files) };
  } catch {
    return { status: 'invalid' };
  }
}

export function inspectAelSkill(input: AelSkillLocation): AelSkillInspection {
  const destination = destinationFor(input);
  if (!existsSync(destination)) return { status: 'unverified', destination };
  const source = validateAelSkill(input.source);
  if (source.status !== 'valid' || source.manifest === undefined) return { status: 'invalid', destination };
  const installed = validateInstalled(destination);
  if (installed.status !== 'valid' || installed.manifest === undefined) return { status: installed.status, destination };
  return { status: manifestsEqual(source.manifest, installed.manifest) ? 'current' : 'code-changed', destination };
}

export function installAelSkill(input: AelSkillLocation & { readonly confirmed?: boolean }): AelSkillOperation {
  const destination = destinationFor(input);
  if (input.scope === 'global' && input.confirmed !== true) return { status: 'confirmation-required', destination };
  const manifest = requiredSourceManifest(input.source);
  const inspection = inspectAelSkill(input);
  if (inspection.status === 'current') return { status: 'unchanged', destination };
  if (existsSync(destination)) throw unsafeDestination(destination, inspection.status);
  publishCandidate(input.source, manifest, destination, false);
  return { status: 'installed', destination };
}

export function updateAelSkill(input: AelSkillLocation & { readonly confirmed?: boolean }): AelSkillOperation {
  const destination = destinationFor(input);
  if (input.scope === 'global' && input.confirmed !== true) return { status: 'confirmation-required', destination };
  const manifest = requiredSourceManifest(input.source);
  const inspection = inspectAelSkill(input);
  if (inspection.status === 'current') return { status: 'unchanged', destination };
  if (inspection.status === 'unverified' && !existsSync(destination)) {
    publishCandidate(input.source, manifest, destination, false);
    return { status: 'installed', destination };
  }
  if (inspection.status !== 'code-changed') throw unsafeDestination(destination, inspection.status);
  publishCandidate(input.source, manifest, destination, true);
  return { status: 'updated', destination };
}

export function uninstallAelSkill(input: Omit<AelSkillLocation, 'source'> & { readonly confirmed?: boolean }): AelSkillOperation {
  const destination = destinationFor(input);
  if (input.scope === 'global' && input.confirmed !== true) return { status: 'confirmation-required', destination };
  if (!existsSync(destination)) return { status: 'unchanged', destination };
  const installed = validateInstalled(destination);
  if (installed.status !== 'valid') throw unsafeDestination(destination, installed.status);
  const rollback = uniqueSibling(destination, 'rollback');
  renameSync(destination, rollback);
  try {
    rmSync(rollback, { recursive: true, force: false });
  } catch (error) {
    renameSync(rollback, destination);
    throw error;
  }
  return { status: 'removed', destination };
}

function requiredSourceManifest(source: string): AelSkillManifest {
  const result = validateAelSkill(source);
  if (result.status !== 'valid' || result.manifest === undefined) {
    throw new AelSkillError('AEL_SKILL_SOURCE_INVALID', 'The bundled AEL skill failed validation.');
  }
  return result.manifest;
}

function destinationFor(input: Pick<AelSkillLocation, 'scope' | 'workspace' | 'home'>): string {
  const root = input.scope === 'workspace' ? input.workspace : input.home;
  try {
    const resolvedRoot = realpathSync(root);
    const destination = join(resolvedRoot, '.agents', 'skills', 'ael');
    assertNoSymbolicLinkPath(resolvedRoot, destination);
    return destination;
  } catch {
    throw new AelSkillError('AEL_SKILL_LOCATION_INVALID', `Cannot resolve ${input.scope} skill root.`);
  }
}

function assertNoSymbolicLinkPath(root: string, destination: string): void {
  let current = root;
  for (const segment of relative(root, destination).split('/')) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('symbolic link');
    } catch (error) {
      if (error instanceof Error && error.message === 'symbolic link') throw error;
    }
  }
}

function validateInstalled(directory: string): { readonly status: 'valid' | 'invalid' | 'unverified'; readonly manifest?: AelSkillManifest } {
  try {
    const manifestPath = join(directory, manifestFile);
    if (!isRegularFile(manifestPath)) return { status: 'unverified' };
    const raw = readFileSync(manifestPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > maxFileBytes) return { status: 'invalid' };
    const declared = parseManifest(raw);
    if (declared === undefined) return { status: 'invalid' };
    const files = readArtifactFiles(directory, true);
    const actual = createManifest(files);
    return manifestsEqual(declared, actual) ? { status: 'valid', manifest: actual } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

function readArtifactFiles(directory: string, installed: boolean): Record<string, Buffer> {
  if (!isDirectory(directory)) throw new Error('skill directory is unavailable');
  const expected = new Set<string>([...artifactFiles, ...(installed ? [manifestFile] : [])]);
  const actual = listFiles(directory);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) throw new Error('unexpected skill files');
  const files: Record<string, Buffer> = {};
  for (const path of artifactFiles) {
    const absolute = join(directory, path);
    if (!isRegularFile(absolute)) throw new Error('skill file is not regular');
    const content = readFileSync(absolute);
    if (content.byteLength > maxFileBytes) throw new Error('skill file is oversized');
    files[path] = content;
  }
  return files;
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symbolic links are not allowed');
      if (entry.isDirectory()) { visit(absolute); continue; }
      if (!entry.isFile()) throw new Error('unsupported directory entry');
      files.push(relative(directory, absolute));
    }
  };
  visit(directory);
  return files.sort();
}

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(); } catch { return false; }
}
function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function createManifest(files: Readonly<Record<string, Buffer>>): AelSkillManifest {
  return {
    schemaVersion: 1,
    skillVersion: '1.0.0',
    compatibleAelVersion: '0.0.0',
    documentationSnapshotDate: '2026-09-03',
    files: Object.fromEntries(artifactFiles.map((path) => [path, sha256(files[path])]))
  };
}
function sha256(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function manifestsEqual(left: AelSkillManifest, right: AelSkillManifest): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function parseManifest(raw: string): AelSkillManifest | undefined {
  try {
    const value = JSON.parse(raw) as Partial<AelSkillManifest>;
    if (value.schemaVersion !== 1 || typeof value.skillVersion !== 'string' || typeof value.compatibleAelVersion !== 'string' || typeof value.documentationSnapshotDate !== 'string' || !value.files || typeof value.files !== 'object') return undefined;
    const files = value.files as Record<string, unknown>;
    if (Object.keys(files).length !== artifactFiles.length || artifactFiles.some((path) => typeof files[path] !== 'string' || !/^[a-f0-9]{64}$/.test(files[path] as string))) return undefined;
    const manifest: AelSkillManifest = { schemaVersion: 1, skillVersion: value.skillVersion, compatibleAelVersion: value.compatibleAelVersion, documentationSnapshotDate: value.documentationSnapshotDate, files: Object.fromEntries(artifactFiles.map((path) => [path, files[path] as string])) };
    return JSON.stringify(manifest) === raw.trim() ? manifest : undefined;
  } catch { return undefined; }
}

function publishCandidate(source: string, manifest: AelSkillManifest, destination: string, replace: boolean): void {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const candidate = mkdtempSync(join(parent, '.ael-skill-'));
  try {
    for (const path of artifactFiles) {
      const target = join(candidate, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(source, path)), { mode: 0o644 });
    }
    writeFileSync(join(candidate, manifestFile), `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
    if (validateInstalled(candidate).status !== 'valid') throw new AelSkillError('AEL_SKILL_SOURCE_INVALID', 'The candidate AEL skill failed validation.');
    if (!replace) { renameSync(candidate, destination); return; }
    const rollback = uniqueSibling(destination, 'rollback');
    renameSync(destination, rollback);
    try {
      renameSync(candidate, destination);
    } catch (error) {
      renameSync(rollback, destination);
      throw error;
    }
    rmSync(rollback, { recursive: true, force: false });
  } finally {
    if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
  }
}

function uniqueSibling(destination: string, purpose: string): string {
  return join(dirname(destination), `.${purpose}-ael-skill-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
function unsafeDestination(destination: string, status: AelSkillStatus | 'valid' | 'unverified'): AelSkillError {
  return new AelSkillError('AEL_SKILL_DESTINATION_UNSAFE', `Refusing to modify ${destination}; status is ${status}.`);
}
