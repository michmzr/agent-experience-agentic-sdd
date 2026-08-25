import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProfileTarget, type ResolvedProfileTarget } from '../config/profile-resolver.js';
import { BUILT_IN_RUNTIME_PROFILES } from '../config/runtime-profile.js';
import type { RuntimeInput, RuntimeProfile } from '../runtime/contracts.js';
import { createRuntimeGate, type GateDecision } from '../runtime/gate.js';
import { ResilientRuntime, type RuntimeStatus } from '../runtime/resilience.js';
import { compileRuntimeSnapshot, type RuntimeSnapshotV1 } from '../runtime/snapshot.js';
import { activateGitKnowledge, type GitContentAdapter } from '../shared-knowledge/git-activation.js';
import { promoteKnowledge } from '../shared-knowledge/promotion-policy.js';
import type { SharedKnowledgeDocument } from '../shared-knowledge/repository.js';
import { RuntimeSnapshotStore, RuntimeSnapshotStorageError } from '../storage/runtime-snapshot-store.js';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_GIT_LIST_BYTES = 1024 * 1024;
const MAX_GIT_PATHS = 1_002;
const profileIds = new Set(['normal', 'learning', 'observe-only'] as const);
const operationClasses = new Set(['normal', 'caution', 'protected'] as const);

export type BuiltInRuntimeProfileId = 'normal' | 'learning' | 'observe-only';

export interface RuntimeEvaluationOptions {
  readonly inputPath: string;
  readonly profileId?: BuiltInRuntimeProfileId;
  readonly refresh?: boolean;
}

export interface RuntimeServiceOptions {
  readonly dataDir: string;
  readonly clock?: () => Date;
  readonly gitAdapter?: (repository: string) => GitContentAdapter;
  readonly refreshSnapshot?: (input: RuntimeInput, current: RuntimeSnapshotV1 | undefined) => RuntimeSnapshotV1;
}

export interface PublicGateDecision extends Omit<GateDecision, 'references'> {
  readonly references: readonly {
    readonly ruleId: string;
    readonly knowledgeId: string;
    readonly evidenceIds: readonly string[];
  }[];
}

export interface KnowledgeValidationResult {
  readonly valid: true;
  readonly entries: number;
  readonly authoritativeEntries: number;
  readonly trustedRefActive: boolean;
}

export class RuntimeServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeServiceError';
  }
}

export class RuntimeService {
  readonly #store: RuntimeSnapshotStore;
  readonly #knowledgeStateRoot: string;
  readonly #clock: () => Date;
  readonly #gitAdapter: (repository: string) => GitContentAdapter;
  readonly #refreshSnapshot: (input: RuntimeInput, current: RuntimeSnapshotV1 | undefined) => RuntimeSnapshotV1;

  constructor(options: RuntimeServiceOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#store = new RuntimeSnapshotStore(join(options.dataDir, 'runtime'), { clock: () => this.#clock().getTime() });
    this.#knowledgeStateRoot = join(options.dataDir, 'repository-knowledge');
    this.#gitAdapter = options.gitAdapter ?? createLocalGitContentAdapter;
    this.#refreshSnapshot = options.refreshSnapshot ?? ((input, current) => compileRuntimeSnapshot({
      repositoryId: input.repositoryId ?? 'global',
      generatedAt: this.#clock().toISOString(),
      globalRules: current?.repositoryId === (input.repositoryId ?? 'global')
        ? current.rules.filter(({ applicability, effect }) => applicability.scope === 'global' && effect === 'conflict')
        : [],
      repositoryRules: current?.repositoryId === (input.repositoryId ?? 'global')
        ? current.rules.filter(({ applicability, effect }) => applicability.scope === 'repository' && effect === 'conflict')
        : [],
      contextRules: current?.repositoryId === (input.repositoryId ?? 'global')
        ? current.rules.filter(({ effect }) => effect === 'context')
        : []
    }));
  }

  evaluate(options: RuntimeEvaluationOptions): PublicGateDecision {
    const input = this.#readRuntimeInput(options.inputPath);
    const profile = runtimeProfile(options.profileId ?? 'normal');
    const snapshotAbsent = !existsSync(this.#store.paths.manifest);
    const current = this.#optionalCurrent();
    if (options.refresh === true || snapshotAbsent) {
      try { this.#store.publish(this.#refreshSnapshot(input, current)); }
      catch { throw new RuntimeServiceError('RUNTIME_UNAVAILABLE', 'Runtime snapshot refresh failed.'); }
    }

    const resolution = this.#resolve(profile);
    const gate = createRuntimeGate({ profile, status: resolution.status, ...(resolution.index === undefined ? {} : { index: resolution.index }) });
    return publicDecision(gate.evaluate(input));
  }

  status(): RuntimeStatus {
    return this.#resolve(BUILT_IN_RUNTIME_PROFILES.normal).status;
  }

  explainConfiguration(workspace: string, remote?: string): ResolvedProfileTarget {
    try {
      return resolveProfileTarget({ facts: { workspacePath: workspace, ...(remote === undefined ? {} : { remoteUrl: remote }) } });
    } catch {
      throw new RuntimeServiceError('INVALID_RUNTIME_CONFIG', 'Runtime target configuration is invalid.');
    }
  }

  validateKnowledge(repository: string, trustedRef?: string): KnowledgeValidationResult {
    try {
      const activated = activateGitKnowledge(repository, this.#gitAdapter(repository), trustedRef, { stateRoot: this.#knowledgeStateRoot });
      return {
        valid: true,
        entries: activated.entries.length,
        authoritativeEntries: activated.entries.filter(({ authoritative }) => authoritative).length,
        trustedRefActive: activated.trustedCommit !== undefined
      };
    } catch {
      throw new RuntimeServiceError('KNOWLEDGE_VALIDATION_FAILED', 'Repository knowledge validation failed.');
    }
  }

  promoteKnowledge(repository: string, inputPath: string): { readonly identity: string; readonly state: string; readonly activation: 'local' } {
    let document: SharedKnowledgeDocument;
    try { document = readJsonFile(inputPath) as SharedKnowledgeDocument; }
    catch { throw new RuntimeServiceError('INVALID_KNOWLEDGE_INPUT', 'Knowledge input is invalid.'); }
    try {
      const promoted = promoteKnowledge(repository, document, { stateRoot: this.#knowledgeStateRoot });
      return { identity: promoted.identity, state: promoted.state, activation: 'local' };
    } catch {
      throw new RuntimeServiceError('KNOWLEDGE_PROMOTION_FAILED', 'Knowledge promotion failed.');
    }
  }

  #resolve(profile: RuntimeProfile) {
    const runtime = new ResilientRuntime({
      profile,
      clock: () => this.#clock().getTime(),
      loadCurrent: () => this.#store.loadCurrent(),
      loadLastKnownGood: () => this.#store.loadLastKnownGood()
    });
    return runtime.resolve('normal');
  }

  #optionalCurrent(): RuntimeSnapshotV1 | undefined {
    if (!existsSync(this.#store.paths.manifest)) return undefined;
    try { return this.#store.loadCurrent(); }
    catch (error) {
      if (error instanceof RuntimeSnapshotStorageError) return undefined;
      throw error;
    }
  }

  #readRuntimeInput(path: string): RuntimeInput {
    let value: unknown;
    try { value = readJsonFile(path); }
    catch { throw new RuntimeServiceError('INVALID_RUNTIME_INPUT', 'Runtime input is invalid.'); }
    try { return parseRuntimeInput(value); }
    catch { throw new RuntimeServiceError('INVALID_RUNTIME_INPUT', 'Runtime input is invalid.'); }
  }
}

export function isBuiltInRuntimeProfileId(value: string): value is BuiltInRuntimeProfileId {
  return profileIds.has(value as BuiltInRuntimeProfileId);
}

function runtimeProfile(id: BuiltInRuntimeProfileId): RuntimeProfile {
  return BUILT_IN_RUNTIME_PROFILES[id];
}

function publicDecision(decision: GateDecision): PublicGateDecision {
  return Object.freeze({
    ...decision,
    references: Object.freeze(decision.references.map(({ ruleId, knowledgeId, evidenceIds }) => Object.freeze({
      ruleId, knowledgeId, evidenceIds: Object.freeze([...evidenceIds])
    })))
  });
}

function readJsonFile(path: string): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('Unsafe input.');
    return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseRuntimeInput(value: unknown): RuntimeInput {
  if (!isRecord(value) || !onlyKeys(value, ['operationClass', 'repositoryId', 'signature', 'tags'])
    || !operationClasses.has(value.operationClass as RuntimeInput['operationClass'])
    || (value.repositoryId !== undefined && !isBoundedString(value.repositoryId))
    || (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 100 || !value.tags.every(isBoundedString)))) {
    throw new TypeError('Invalid runtime input.');
  }
  const signature = parseSignature(value.signature);
  return Object.freeze({
    operationClass: value.operationClass as RuntimeInput['operationClass'],
    ...(value.repositoryId === undefined ? {} : { repositoryId: value.repositoryId as string }),
    ...(value.tags === undefined ? {} : { tags: Object.freeze([...(value.tags as string[])]) }),
    signature
  }) as RuntimeInput;
}

function parseSignature(value: unknown): RuntimeInput['signature'] {
  if (!isRecord(value) || (value.kind !== 'action' && value.kind !== 'intent')) throw new TypeError('Invalid runtime signature.');
  if (value.kind === 'action') {
    if (!onlyKeys(value, ['action', 'arguments', 'kind', 'path', 'tool']) || !isBoundedString(value.tool) || !isBoundedString(value.action)
      || (value.path !== undefined && !isBoundedString(value.path))
      || (value.arguments !== undefined && (!Array.isArray(value.arguments) || value.arguments.length > 100 || !value.arguments.every(isBoundedString)))) {
      throw new TypeError('Invalid runtime action.');
    }
    return Object.freeze({ kind: 'action', tool: value.tool, action: value.action,
      ...(value.arguments === undefined ? {} : { arguments: Object.freeze([...(value.arguments as string[])]) }),
      ...(value.path === undefined ? {} : { path: value.path as string }) });
  }
  if (!onlyKeys(value, ['kind', 'path', 'target', 'tool', 'verb']) || !isBoundedString(value.verb) || !isBoundedString(value.target)
    || (value.tool !== undefined && !isBoundedString(value.tool)) || (value.path !== undefined && !isBoundedString(value.path))) {
    throw new TypeError('Invalid runtime intent.');
  }
  return Object.freeze({ kind: 'intent', verb: value.verb, target: value.target,
    ...(value.tool === undefined ? {} : { tool: value.tool as string }), ...(value.path === undefined ? {} : { path: value.path as string }) });
}

export function createLocalGitContentAdapter(repository: string): GitContentAdapter {
  return {
    resolveCommit(trustedRef: string): string {
      if (!isBoundedString(trustedRef) || trustedRef.startsWith('-')) throw new Error('Invalid trusted Git ref.');
      return git(repository, ['rev-parse', '--verify', `${trustedRef}^{commit}`], 256 * 1024).trim();
    },
    readFile(commit: string, path: string, maxBytes: number): string | undefined {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_INPUT_BYTES) throw new Error('Invalid Git knowledge file limit.');
      const object = `${commit}:${path}`;
      try {
        const rawSize = git(repository, ['cat-file', '-s', object], 128).trim();
        if (!/^(?:0|[1-9]\d*)$/.test(rawSize) || Number(rawSize) > maxBytes) {
          throw new Error('Git knowledge file resource limit exceeded.');
        }
        const content = git(repository, ['cat-file', 'blob', object], maxBytes);
        if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new Error('Git knowledge file resource limit exceeded.');
        return content;
      }
      catch (error) { if (isMissingGitPath(error)) return undefined; throw error; }
    },
    listFiles(commit: string, prefix: string, maxPaths: number): readonly string[] {
      if (!Number.isSafeInteger(maxPaths) || maxPaths < 0 || maxPaths > MAX_GIT_PATHS) throw new Error('Invalid Git knowledge path limit.');
      const paths = git(repository, ['ls-tree', '-r', '--name-only', commit, ...(prefix ? ['--', prefix] : [])], MAX_GIT_LIST_BYTES)
        .split('\n').filter(Boolean);
      if (paths.length > maxPaths) throw new Error('Git knowledge path limit exceeded.');
      return paths;
    }
  };
}

function git(repository: string, args: readonly string[], maxBytes: number): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: maxBytes + 1
  });
}

function isMissingGitPath(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const stderr = error.stderr;
  return typeof stderr === 'string' && /(?:does not exist|exists on disk, but not in|path .* not in)/i.test(stderr);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}
