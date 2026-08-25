import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { getSystemErrorName } from 'node:util';

import { resolveProfileTarget, type ResolvedProfileTarget } from '../config/profile-resolver.js';
import { BUILT_IN_RUNTIME_PROFILES } from '../config/runtime-profile.js';
import type { RuntimeInput, RuntimeProfile } from '../runtime/contracts.js';
import { createRuntimeGate, type GateDecision } from '../runtime/gate.js';
import { ResilientRuntime, RuntimeSnapshotUnavailableError, type RuntimeStatus } from '../runtime/resilience.js';
import { createRuleIndex, type RuleIndex } from '../runtime/rule-index.js';
import { compileRuntimeSnapshot, RuntimeSnapshotValidationError, type RuntimeSnapshotV1 } from '../runtime/snapshot.js';
import { activateGitKnowledge, type GitContentAdapter } from '../shared-knowledge/git-activation.js';
import { promoteKnowledge } from '../shared-knowledge/promotion-policy.js';
import type { SharedKnowledgeDocument } from '../shared-knowledge/repository.js';
import { compileActivatedRuntimeRules } from '../shared-knowledge/runtime-compiler.js';
import { RuntimeSnapshotStore, RuntimeSnapshotStorageError, type RuntimeSnapshotPaths } from '../storage/runtime-snapshot-store.js';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_GIT_LIST_BYTES = 1024 * 1024;
const MAX_GIT_PATHS = 1_002;
const DEFAULT_RUNTIME_TARGET_CAPACITY = 32;
const MAX_RUNTIME_TARGET_CAPACITY = 256;
const ACTIVE_TARGET_MAX_BYTES = 1_024;
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
  readonly snapshotStore?: RuntimeSnapshotPersistence;
  readonly snapshotStoreFactory?: (targetHash: string) => RuntimeSnapshotPersistence;
  readonly activeTargetPointer?: RuntimeActiveTargetPointerPersistence;
  readonly runtimeTargetCapacity?: number;
}

export interface RuntimeActiveTargetPointerPersistence {
  read(): unknown;
  write(pointer: { readonly version: 1; readonly kind: RuntimeTargetKind; readonly hash: string }): void;
}

type RuntimeTargetKind = 'global' | 'repository';

export interface RuntimeSnapshotPersistence {
  readonly paths: RuntimeSnapshotPaths;
  publish(snapshot: RuntimeSnapshotV1): RuntimeSnapshotV1;
  recover?(snapshot: RuntimeSnapshotV1, expectedRepositoryId: string): RuntimeSnapshotV1;
  loadCurrent(): RuntimeSnapshotV1;
  loadLastKnownGood(): RuntimeSnapshotV1;
}

interface RuntimeTarget {
  readonly kind: RuntimeTargetKind;
  readonly snapshotRepositoryId: string;
  readonly hash: string;
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

export interface KnowledgeRuntimeRefreshResult {
  readonly repositoryId: string;
  readonly trustedCommit: string;
  readonly rules: number;
  readonly checksum: string;
}

export class RuntimeServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeServiceError';
  }
}

export class RuntimeActiveTargetPointerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeActiveTargetPointerError';
  }
}

export class RuntimeService {
  readonly #legacyStore?: RuntimeSnapshotPersistence;
  readonly #usesProductionTargetStores: boolean;
  readonly #storeFactory: (targetHash: string) => RuntimeSnapshotPersistence;
  readonly #targetCapacity: number;
  readonly #activeTargetPointer?: RuntimeActiveTargetPointerPersistence;
  readonly #knowledgeStateRoot: string;
  readonly #clock: () => Date;
  readonly #gitAdapter: (repository: string) => GitContentAdapter;
  readonly #refreshSnapshot: (input: RuntimeInput, current: RuntimeSnapshotV1 | undefined) => RuntimeSnapshotV1;
  readonly #runtimes = new Map<string, { readonly runtime: ResilientRuntime; readonly snapshotChecksum?: string }>();
  readonly #snapshotsByTarget = new Map<string, RuntimeSnapshotV1>();
  readonly #targetLru = new Map<string, RuntimeTarget>();
  #activeRuntimeKey?: string;
  #activeTarget?: RuntimeTarget;

  constructor(options: RuntimeServiceOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#targetCapacity = validateTargetCapacity(options.runtimeTargetCapacity ?? DEFAULT_RUNTIME_TARGET_CAPACITY);
    if (options.snapshotStore !== undefined && options.snapshotStoreFactory !== undefined) throw new TypeError('Configure one runtime snapshot store injection boundary.');
    this.#usesProductionTargetStores = options.snapshotStore === undefined && options.snapshotStoreFactory === undefined;
    this.#activeTargetPointer = options.activeTargetPointer ?? (this.#usesProductionTargetStores ? {
      read: () => readActiveTarget(options.dataDir),
      write: (pointer) => writeActiveTarget(options.dataDir, pointer)
    } : undefined);
    this.#legacyStore = options.snapshotStore ?? (options.snapshotStoreFactory === undefined
      ? new RuntimeSnapshotStore(join(options.dataDir, 'runtime'), { clock: () => this.#clock().getTime() })
      : undefined);
    this.#storeFactory = options.snapshotStore !== undefined
      ? () => options.snapshotStore!
      : options.snapshotStoreFactory ?? ((targetHash) => {
          ensurePrivateDirectory(join(options.dataDir, 'runtime', 'targets'));
          return new RuntimeSnapshotStore(join(options.dataDir, 'runtime', 'targets', targetHash), { clock: () => this.#clock().getTime() });
        });
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
    const target = runtimeTarget(input.repositoryId);
    this.#touchTarget(target);
    const key = runtimeKey(profile.id, target.hash);
    const cached = this.#runtimes.get(key);
    if (options.refresh !== true && this.#activeTarget?.hash === target.hash && cached !== undefined) {
      this.#activeRuntimeKey = key;
      const resolution = cached.runtime.resolve(input.operationClass);
      const gate = createRuntimeGate({ profile, status: resolution.status, ...(resolution.index === undefined ? {} : { index: resolution.index }) });
      return publicDecision(gate.evaluate(input));
    }
    const store = this.#storeFor(target);
    this.#migrateLegacySnapshot(target, store);
    const snapshotAbsent = !existsSync(store.paths.manifest);
    const current = this.#optionalCurrent(store);
    if (current !== undefined && current.repositoryId !== target.snapshotRepositoryId) {
      throw new RuntimeServiceError('RUNTIME_UNAVAILABLE', 'Runtime snapshot target identity is invalid.');
    }
    if (current !== undefined) this.#snapshotsByTarget.set(target.hash, current);
    const refreshBaseline = options.refresh === true && current === undefined && !snapshotAbsent
      ? this.#optionalLastKnownGood(store)
      : current;
    if (refreshBaseline !== undefined && refreshBaseline.repositoryId !== target.snapshotRepositoryId) {
      throw new RuntimeServiceError('RUNTIME_UNAVAILABLE', 'Runtime snapshot target identity is invalid.');
    }
    let activeChecksum = current?.checksum;
    if (options.refresh === true || snapshotAbsent) {
      let published: RuntimeSnapshotV1;
      try {
        const candidate = this.#refreshSnapshot(input, refreshBaseline);
        if (candidate.repositoryId !== target.snapshotRepositoryId) throw new TypeError('Runtime snapshot compiler returned the wrong repository.');
        published = current === undefined && !snapshotAbsent && store.recover !== undefined
          ? store.recover(candidate, target.snapshotRepositoryId)
          : store.publish(candidate);
      }
      catch { throw new RuntimeServiceError('RUNTIME_UNAVAILABLE', 'Runtime snapshot refresh failed.'); }
      this.#snapshotsByTarget.set(target.hash, published);
      this.#replaceTargetRuntimes(target, profile, store, createRuleIndex(published), published.checksum);
      activeChecksum = published.checksum;
    }

    const runtime = this.#runtimeFor(profile, target, store, undefined, activeChecksum);
    this.#activeRuntimeKey = key;
    this.#activeTarget = target;
    this.#recordActiveTarget(target);
    const resolution = runtime.resolve(input.operationClass);
    const gate = createRuntimeGate({ profile, status: resolution.status, ...(resolution.index === undefined ? {} : { index: resolution.index }) });
    return publicDecision(gate.evaluate(input));
  }

  status(): RuntimeStatus {
    if (this.#activeRuntimeKey !== undefined) {
      const active = this.#runtimes.get(this.#activeRuntimeKey);
      if (active !== undefined) return active.runtime.resolve('normal').status;
    }
    const target = this.#readActiveTarget() ?? runtimeTarget(undefined);
    this.#touchTarget(target);
    const store = this.#storeFor(target);
    this.#migrateLegacySnapshot(target, store);
    const current = this.#optionalCurrent(store);
    if (current !== undefined && current.repositoryId !== target.snapshotRepositoryId) {
      throw new RuntimeServiceError('RUNTIME_UNAVAILABLE', 'Runtime snapshot target identity is invalid.');
    }
    if (current !== undefined) this.#snapshotsByTarget.set(target.hash, current);
    const profile = BUILT_IN_RUNTIME_PROFILES.normal;
    const runtime = this.#runtimeFor(profile, target, store, undefined, current?.checksum);
    this.#activeRuntimeKey = runtimeKey(profile.id, target.hash);
    this.#activeTarget = target;
    return runtime.resolve('normal').status;
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

  refreshKnowledgeRuntime(repository: string, repositoryId: string, trustedRef: string): KnowledgeRuntimeRefreshResult {
    try {
      const activated = activateGitKnowledge(repository, this.#gitAdapter(repository), trustedRef, { stateRoot: this.#knowledgeStateRoot });
      if (activated.trustedCommit === undefined) throw new TypeError('Trusted knowledge commit is required.');
      const rules = compileActivatedRuntimeRules({
        repositoryId,
        trustedCommit: activated.trustedCommit,
        entries: activated.entries
      });
      const snapshot = compileRuntimeSnapshot({
        repositoryId,
        generatedAt: this.#clock().toISOString(),
        repositoryRules: rules.filter(({ effect }) => effect === 'conflict'),
        contextRules: rules.filter(({ effect }) => effect === 'context')
      });
      const target = runtimeTarget(repositoryId);
      this.#touchTarget(target);
      const store = this.#storeFor(target);
      this.#migrateLegacySnapshot(target, store);
      const snapshotAbsent = !existsSync(store.paths.manifest);
      const current = this.#optionalCurrent(store);
      if (current !== undefined && current.repositoryId !== target.snapshotRepositoryId) {
        throw new TypeError('Runtime snapshot target identity is invalid.');
      }
      const published = current === undefined && !snapshotAbsent && store.recover !== undefined
        ? store.recover(snapshot, target.snapshotRepositoryId)
        : store.publish(snapshot);
      const profile = BUILT_IN_RUNTIME_PROFILES.normal;
      this.#snapshotsByTarget.set(target.hash, published);
      this.#replaceTargetRuntimes(target, profile, store, createRuleIndex(published), published.checksum);
      this.#activeRuntimeKey = runtimeKey(profile.id, target.hash);
      this.#activeTarget = target;
      this.#recordActiveTarget(target);
      return {
        repositoryId,
        trustedCommit: activated.trustedCommit,
        rules: published.rules.length,
        checksum: published.checksum
      };
    } catch {
      throw new RuntimeServiceError('KNOWLEDGE_RUNTIME_REFRESH_FAILED', 'Repository runtime knowledge refresh failed.');
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

  #runtimeFor(profile: RuntimeProfile, target: RuntimeTarget, store: RuntimeSnapshotPersistence, currentIndex?: RuleIndex, snapshotChecksum?: string): ResilientRuntime {
    const key = runtimeKey(profile.id, target.hash);
    const existing = this.#runtimes.get(key);
    if (existing !== undefined && (snapshotChecksum === undefined || existing.snapshotChecksum === snapshotChecksum)) return existing.runtime;
    const runtime = new ResilientRuntime({
      profile,
      ...(currentIndex === undefined ? {} : { currentIndex }),
      clock: () => this.#clock().getTime(),
      loadCurrent: () => snapshotForTarget(store.loadCurrent(), target.snapshotRepositoryId, snapshotChecksum),
      loadLastKnownGood: () => snapshotForTarget(store.loadLastKnownGood(), target.snapshotRepositoryId)
    });
    this.#runtimes.set(key, { runtime, ...(snapshotChecksum === undefined ? {} : { snapshotChecksum }) });
    return runtime;
  }

  #replaceTargetRuntimes(target: RuntimeTarget, profile: RuntimeProfile, store: RuntimeSnapshotPersistence, index: RuleIndex, checksum: string): void {
    for (const key of this.#runtimes.keys()) {
      if (key.endsWith(`\u0000${target.hash}`)) this.#runtimes.delete(key);
    }
    this.#runtimeFor(profile, target, store, index, checksum);
  }

  #optionalCurrent(store: RuntimeSnapshotPersistence): RuntimeSnapshotV1 | undefined {
    if (!existsSync(store.paths.manifest)) return undefined;
    try { return store.loadCurrent(); }
    catch (error) {
      if (isSnapshotAvailabilityError(error)) return undefined;
      throw error;
    }
  }

  #optionalLastKnownGood(store: RuntimeSnapshotPersistence): RuntimeSnapshotV1 | undefined {
    try { return store.loadLastKnownGood(); }
    catch (error) {
      if (isSnapshotAvailabilityError(error)) return undefined;
      throw error;
    }
  }

  #storeFor(target: RuntimeTarget): RuntimeSnapshotPersistence {
    return this.#storeFactory(target.hash);
  }

  #migrateLegacySnapshot(target: RuntimeTarget, store: RuntimeSnapshotPersistence): void {
    if (!this.#usesProductionTargetStores || this.#legacyStore === undefined || existsSync(store.paths.manifest)
      || !existsSync(this.#legacyStore.paths.manifest) || target.kind !== 'repository' || target.snapshotRepositoryId === 'global') return;
    let legacy: RuntimeSnapshotV1 | undefined;
    try { legacy = this.#legacyStore.loadCurrent(); }
    catch (error) {
      if (isSnapshotAvailabilityError(error)) return;
      throw error;
    }
    if (legacy.repositoryId !== target.snapshotRepositoryId) return;
    store.publish(legacy);
  }

  #touchTarget(target: RuntimeTarget): void {
    this.#targetLru.delete(target.hash);
    this.#targetLru.set(target.hash, target);
    while (this.#targetLru.size > this.#targetCapacity) {
      const evictedHash = this.#targetLru.keys().next().value as string | undefined;
      if (evictedHash === undefined) return;
      this.#targetLru.delete(evictedHash);
      this.#snapshotsByTarget.delete(evictedHash);
      for (const key of this.#runtimes.keys()) {
        if (key.endsWith(`\u0000${evictedHash}`)) this.#runtimes.delete(key);
      }
      if (this.#activeTarget?.hash === evictedHash) {
        this.#activeTarget = undefined;
        this.#activeRuntimeKey = undefined;
      }
    }
  }

  #recordActiveTarget(target: RuntimeTarget): void {
    if (this.#activeTargetPointer === undefined) return;
    try { this.#activeTargetPointer.write({ version: 1, kind: target.kind, hash: target.hash }); }
    catch (error) {
      if (!isPointerAvailabilityError(error)) throw error;
    }
  }

  #readActiveTarget(): RuntimeTarget | undefined {
    if (this.#activeTargetPointer === undefined) return undefined;
    let pointer: { readonly kind: RuntimeTargetKind; readonly hash: string } | undefined;
    try { pointer = parseActiveTargetPointer(this.#activeTargetPointer.read()); }
    catch (error) {
      if (isPointerAvailabilityError(error)) return undefined;
      throw error;
    }
    if (pointer === undefined) return undefined;
    try {
      const store = this.#storeFactory(pointer.hash);
      const snapshot = this.#optionalCurrent(store) ?? this.#optionalLastKnownGood(store);
      if (snapshot === undefined) return undefined;
      const target = runtimeTarget(pointer.kind === 'global' ? undefined : snapshot.repositoryId);
      return target.hash === pointer.hash ? target : undefined;
    } catch (error) {
      if (isSnapshotAvailabilityError(error)) return undefined;
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

function validateTargetCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RUNTIME_TARGET_CAPACITY) {
    throw new TypeError(`Runtime target cache capacity must be an integer from 1 through ${MAX_RUNTIME_TARGET_CAPACITY}.`);
  }
  return value;
}

function runtimeTarget(repositoryId: string | undefined): RuntimeTarget {
  const kind = repositoryId === undefined ? 'global' : 'repository';
  const snapshotRepositoryId = repositoryId ?? 'global';
  const canonicalIdentity = `${kind}\u0000${snapshotRepositoryId}`;
  return Object.freeze({
    kind,
    snapshotRepositoryId,
    hash: createHash('sha256').update('ael:runtime-target:v1\0').update(canonicalIdentity).digest('hex')
  });
}

export function runtimeTargetSnapshotDirectory(dataDir: string, repositoryId?: string): string {
  return join(dataDir, 'runtime', 'targets', runtimeTarget(repositoryId).hash);
}

function runtimeKey(profileId: string, targetHash: string): string {
  return `${profileId}\u0000${targetHash}`;
}

function snapshotForTarget(snapshot: RuntimeSnapshotV1, target: string, checksum?: string): RuntimeSnapshotV1 {
  if (snapshot.repositoryId !== target || (checksum !== undefined && snapshot.checksum !== checksum)) {
    throw new RuntimeSnapshotUnavailableError('Runtime snapshot is unavailable for the target repository and generation.');
  }
  return snapshot;
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
      assertGitCommit(commit);
      if (!safeGitPath(path)) throw new Error('Git knowledge path is unsafe.');
      const entry = gitTreeEntries(repository, commit, path, 2).find((candidate) => candidate.path === path);
      if (entry === undefined) return undefined;
      assertExpectedGitBlob(entry);
      try {
        const rawSize = git(repository, ['cat-file', '-s', entry.object], 128).trim();
        if (!/^(?:0|[1-9]\d*)$/.test(rawSize) || Number(rawSize) > maxBytes) {
          throw new Error('Git knowledge file resource limit exceeded.');
        }
        const content = git(repository, ['cat-file', 'blob', entry.object], maxBytes);
        if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new Error('Git knowledge file resource limit exceeded.');
        return content;
      }
      catch (error) { if (isMissingGitPath(error)) return undefined; throw error; }
    },
    listFiles(commit: string, prefix: string, maxPaths: number): readonly string[] {
      if (!Number.isSafeInteger(maxPaths) || maxPaths < 0 || maxPaths > MAX_GIT_PATHS) throw new Error('Invalid Git knowledge path limit.');
      assertGitCommit(commit);
      const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      if (normalizedPrefix !== '' && normalizedPrefix !== '.' && !safeGitPath(normalizedPrefix)) throw new Error('Git knowledge prefix is unsafe.');
      return gitTreeEntries(repository, commit, normalizedPrefix, maxPaths).map(({ path }) => path);
    }
  };
}

export interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
  readonly path: string;
}

function gitTreeEntries(repository: string, commit: string, prefix: string, maxPaths: number): readonly GitTreeEntry[] {
  const output = git(repository, [
    'ls-tree', '-r', '-z', '--full-tree', commit, ...(prefix && prefix !== '.' ? ['--', prefix] : [])
  ], MAX_GIT_LIST_BYTES);
  return parseGitTreeListing(output, maxPaths);
}

export function parseGitTreeListing(output: string, maxPaths: number): readonly GitTreeEntry[] {
  if (!Number.isSafeInteger(maxPaths) || maxPaths < 0 || maxPaths > MAX_GIT_PATHS) throw new Error('Invalid Git knowledge path limit.');
  if (Buffer.byteLength(output, 'utf8') > MAX_GIT_LIST_BYTES) throw new Error('Git tree output resource limit exceeded.');
  if (output.length === 0) return [];
  if (!output.endsWith('\0')) throw new Error('Git tree output is malformed.');
  const records = output.slice(0, -1).split('\0');
  if (records.length > maxPaths) throw new Error('Git knowledge path limit exceeded.');
  const paths = new Set<string>();
  return records.map((record) => {
    const match = /^([0-9]{6}) ([a-z]+) ([a-f0-9]{40,64})\t([^\0]+)$/.exec(record);
    if (match === null) throw new Error('Git tree output is malformed.');
    const entry = { mode: match[1]!, type: match[2]!, object: match[3]!, path: match[4]! };
    if (!safeGitPath(entry.path) || paths.has(entry.path)) throw new Error('Git tree contains an unsafe or duplicate path.');
    paths.add(entry.path);
    assertExpectedGitBlob(entry);
    return Object.freeze(entry);
  });
}

function assertExpectedGitBlob(entry: GitTreeEntry): void {
  if (entry.type !== 'blob' || !/^(?:100644|100755)$/.test(entry.mode)) {
    throw new Error('Git knowledge tree contains a non-regular blob entry.');
  }
  if ((entry.path === 'agent-experience/index.json' || /^agent-experience\/knowledge\/[^/]+\.md$/.test(entry.path))
    && entry.mode !== '100644') throw new Error('Git knowledge file mode is invalid.');
}

function assertGitCommit(value: string): void {
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error('Git knowledge commit is invalid.');
}

function safeGitPath(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 512 && !value.startsWith('/') && !value.includes('\\')
    && !/[\u0000-\u001F\u007F]/.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function git(repository: string, args: readonly string[], maxBytes: number): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: maxBytes + 1
  });
}

function writeActiveTarget(
  dataDir: string,
  target: { readonly version: 1; readonly kind: RuntimeTargetKind; readonly hash: string }
): void {
  const root = join(dataDir, 'runtime');
  ensurePrivateDirectory(root);
  const destination = join(root, 'active-target.json');
  const candidate = join(root, `.active-target-${randomUUID()}`);
  const serialized = `${JSON.stringify({ version: 1, kind: target.kind, hash: target.hash })}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, serialized, 'utf8');
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (existsSync(destination)) assertOwnerFile(destination, ACTIVE_TARGET_MAX_BYTES);
    renameSync(candidate, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(candidate); } catch (error) { if (!isMissingFilesystemEntry(error)) throw error; }
  }
}

function readActiveTarget(dataDir: string): { readonly version: 1; readonly kind: RuntimeTargetKind; readonly hash: string } | undefined {
  const path = join(dataDir, 'runtime', 'active-target.json');
  let descriptor: number | undefined;
  try {
    assertOwnerFile(path, ACTIVE_TARGET_MAX_BYTES);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > ACTIVE_TARGET_MAX_BYTES) throw new RuntimeActiveTargetPointerError('Runtime active-target metadata is unsafe.');
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
    return parseActiveTargetPointer(value)!;
  } catch (error) {
    if (isMissingFilesystemEntry(error)) return undefined;
    if (error instanceof SyntaxError) throw new RuntimeActiveTargetPointerError('Runtime active-target metadata is malformed.', { cause: error });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeSnapshotStorageError('Runtime target directory is unsafe.');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new RuntimeSnapshotStorageError('Runtime target directory has a different owner.');
  chmodSync(path, 0o700);
}

function assertOwnerFile(path: string, maxBytes: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || (stat.mode & 0o077) !== 0) {
    throw new RuntimeActiveTargetPointerError('Runtime active-target metadata is unsafe.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new RuntimeActiveTargetPointerError('Runtime active-target metadata has a different owner.');
}

function parseActiveTargetPointer(value: unknown): { readonly version: 1; readonly kind: RuntimeTargetKind; readonly hash: string } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !onlyKeys(value, ['hash', 'kind', 'version']) || value.version !== 1
    || (value.kind !== 'global' && value.kind !== 'repository') || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) {
    throw new RuntimeActiveTargetPointerError('Runtime active-target metadata is malformed.');
  }
  return Object.freeze({ version: 1, kind: value.kind, hash: value.hash });
}

function isMissingFilesystemEntry(error: unknown): boolean {
  return hasTrustedFilesystemCode(error, ['ENOENT']);
}

function isExpectedFilesystemError(error: unknown): boolean {
  return hasTrustedFilesystemCode(error, ['EACCES', 'EDQUOT', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'EPERM', 'EROFS']);
}

function hasTrustedFilesystemCode(error: unknown, allowedCodes: readonly string[]): error is NodeJS.ErrnoException {
  if (!(error instanceof Error) || error instanceof TypeError || error instanceof SyntaxError) return false;
  const systemError = error as NodeJS.ErrnoException;
  if (typeof systemError.errno !== 'number' || typeof systemError.syscall !== 'string') return false;
  try {
    return getSystemErrorName(systemError.errno) === systemError.code && allowedCodes.includes(systemError.code ?? '');
  } catch { return false; }
}

function isSnapshotAvailabilityError(error: unknown): boolean {
  return error instanceof RuntimeSnapshotStorageError || error instanceof RuntimeSnapshotValidationError;
}

function isPointerAvailabilityError(error: unknown): boolean {
  return error instanceof RuntimeActiveTargetPointerError || isExpectedFilesystemError(error);
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
