import type {
  DecisionOutcome,
  OperationClass,
  RuntimeProfile
} from '../runtime/contracts.js';
import {
  canonicalRuntimePathIdentity,
  normalizeRuntimePath
} from '../runtime/matcher.js';
import {
  BUILT_IN_RUNTIME_PROFILE_REGISTRY,
  BUILT_IN_RUNTIME_PROFILES,
  hasLearningLineage,
  validateRuntimeProfileRegistry,
  type RuntimeProfileRegistry
} from './runtime-profile.js';

export type ProfileSource =
  | 'session-override'
  | 'local-exact'
  | 'local-wildcard'
  | 'repository-shared'
  | 'global-exact'
  | 'global-wildcard'
  | 'global-default'
  | 'built-in-default';

export interface RuntimeProfileSetting {
  readonly profile?: string;
  readonly hardBlocking?: boolean;
  readonly warningsEnabled?: boolean;
  readonly captureEnabled?: boolean;
  readonly retrievalEnabled?: boolean;
  readonly degradedOutcomes?: Readonly<Record<OperationClass, DecisionOutcome>>;
}

export type RuntimeProfileSelection = string | RuntimeProfileSetting;

export interface ProfileTargetSelector {
  readonly target: 'remote' | 'path';
  readonly pattern: string;
  readonly profile: RuntimeProfileSelection;
}

export interface ProfileTargetFacts {
  readonly workspacePath?: string;
  readonly remoteUrl?: string;
}

export interface ProfileResolutionInput {
  readonly facts: ProfileTargetFacts;
  readonly profiles?: RuntimeProfileRegistry;
  readonly sessionOverride?: RuntimeProfileSelection;
  readonly localSelectors?: readonly ProfileTargetSelector[];
  readonly repositoryShared?: RuntimeProfileSelection;
  readonly globalSelectors?: readonly ProfileTargetSelector[];
  readonly globalDefault?: RuntimeProfileSelection;
  readonly builtInDefault?: keyof typeof BUILT_IN_RUNTIME_PROFILES;
}

export type ResolvedRuntimeProfileField = keyof RuntimeProfile;

export interface ProfileTraceEntry {
  readonly source: ProfileSource;
  readonly profileId?: string;
  readonly selector?: Readonly<{
    readonly target: ProfileTargetSelector['target'];
    readonly pattern: string;
    readonly normalizedPattern: string;
  }>;
}

export type ProfileResolutionTrace = Readonly<Record<ResolvedRuntimeProfileField, ProfileTraceEntry>>;

export interface ResolvedProfileTarget {
  readonly profile: RuntimeProfile;
  readonly trace: ProfileResolutionTrace;
}

export class ProfileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileResolutionError';
  }
}

const profileFields = [
  'id',
  'hardBlocking',
  'warningsEnabled',
  'captureEnabled',
  'retrievalEnabled',
  'degradedOutcomes'
] as const satisfies readonly (keyof RuntimeProfile)[];
const settingFields = new Set([
  'profile',
  'hardBlocking',
  'warningsEnabled',
  'captureEnabled',
  'retrievalEnabled',
  'degradedOutcomes'
]);
const booleanFields = ['hardBlocking', 'warningsEnabled', 'captureEnabled', 'retrievalEnabled'] as const;
const operationClasses = ['normal', 'caution', 'protected'] as const;
const outcomes = new Set<unknown>(['ALLOW', 'WARN', 'BLOCK']);

interface Candidate {
  readonly source: ProfileSource;
  readonly values: Partial<RuntimeProfile>;
  readonly profileId?: string;
  readonly selector?: ProfileTraceEntry['selector'];
}

interface MatchedSelector {
  readonly selector: ProfileTargetSelector;
  readonly normalizedPattern: string;
  readonly matchPattern: string;
  readonly wildcardCount: number;
  readonly literalCount: number;
}

/** Resolves injected target facts without Git, filesystem, subprocess, or environment access. */
export function resolveProfileTarget(input: ProfileResolutionInput): ResolvedProfileTarget {
  const configuredRegistry = validateRuntimeProfileRegistry(
    input.profiles ?? BUILT_IN_RUNTIME_PROFILE_REGISTRY
  );
  const registry = configuredRegistry.profiles;
  if (input.facts.workspacePath !== undefined) normalizeRuntimePath(input.facts.workspacePath);
  if (input.facts.remoteUrl !== undefined) normalizeGitRemoteUrl(input.facts.remoteUrl);
  const localMatches = matchSelectors(input.localSelectors ?? [], input.facts);
  const globalMatches = matchSelectors(input.globalSelectors ?? [], input.facts);
  const defaultId = input.builtInDefault ?? 'normal';
  const builtInDefault = Object.hasOwn(BUILT_IN_RUNTIME_PROFILES, defaultId)
    ? BUILT_IN_RUNTIME_PROFILES[defaultId]
    : undefined;
  if (builtInDefault === undefined) {
    throw new ProfileResolutionError(`Unknown built-in default profile: ${String(defaultId)}`);
  }

  const candidates: Candidate[] = [];
  addSettingCandidate(candidates, 'session-override', input.sessionOverride, registry);
  addSelectorCandidate(candidates, 'local-exact', selectExact(localMatches, 'local'), registry);
  addSelectorCandidate(candidates, 'local-wildcard', selectWildcard(localMatches, 'local'), registry);
  addSettingCandidate(candidates, 'repository-shared', input.repositoryShared, registry);
  addSelectorCandidate(candidates, 'global-exact', selectExact(globalMatches, 'global'), registry);
  addSelectorCandidate(candidates, 'global-wildcard', selectWildcard(globalMatches, 'global'), registry);
  addSettingCandidate(candidates, 'global-default', input.globalDefault, registry);
  addSettingCandidate(candidates, 'built-in-default', defaultId, registry);

  const values: Partial<RuntimeProfile> = {};
  const trace: Partial<Record<ResolvedRuntimeProfileField, ProfileTraceEntry>> = {};
  for (const field of profileFields) {
    const candidate = candidates.find((entry) => entry.values[field] !== undefined);
    if (candidate === undefined) throw new ProfileResolutionError(`No value resolved for runtime profile field: ${field}`);
    Object.assign(values, { [field]: candidate.values[field] });
    trace[field] = freezeTraceEntry(candidate);
  }

  const resolvedId = values.id as string;
  const learningLineage = hasLearningLineage(configuredRegistry, resolvedId);
  const profile = freezeResolvedProfile(values, learningLineage);
  return Object.freeze({ profile, trace: Object.freeze(trace) as ProfileResolutionTrace });
}

/** Canonicalizes common URL and SCP-style Git remote forms without network access. */
export function normalizeGitRemoteUrl(remoteUrl: string): string {
  let value = remoteUrl.trim();
  if (value.length === 0) throw new ProfileResolutionError('Git remote URL must not be empty.');

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (scheme) value = value.slice(scheme[0].length);
  value = value.replace(/[?#].*$/, '').replace(/^\/\//, '');

  const firstSlash = value.indexOf('/');
  const scpColon = value.indexOf(':');
  if (!scheme && scpColon >= 0 && (firstSlash < 0 || scpColon < firstSlash)) {
    value = `${value.slice(0, scpColon)}/${value.slice(scpColon + 1)}`;
  }

  const hostBoundary = value.indexOf('/');
  const authority = hostBoundary < 0 ? value : value.slice(0, hostBoundary);
  const path = hostBoundary < 0 ? '' : value.slice(hostBoundary + 1);
  const host = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  if (host.length === 0 || path.length === 0) {
    throw new ProfileResolutionError('Unsupported Git remote URL.');
  }

  const normalizedPath = path
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (normalizedPath.length === 0) throw new ProfileResolutionError('Unsupported Git remote URL.');
  return `${host}/${normalizedPath}`;
}

function matchSelectors(
  selectors: readonly ProfileTargetSelector[],
  facts: ProfileTargetFacts
): readonly MatchedSelector[] {
  const matches: MatchedSelector[] = [];
  for (const selector of selectors) {
    validateSelector(selector);
    const normalizedPattern = selector.target === 'remote'
      ? normalizeGitRemoteUrl(selector.pattern)
      : normalizeRuntimePath(selector.pattern);
    const matchPattern = selector.target === 'remote'
      ? normalizedPattern
      : canonicalRuntimePathIdentity(selector.pattern);
    const fact = selector.target === 'remote' ? inputRemote(facts.remoteUrl) : inputPath(facts.workspacePath);
    if (fact === undefined || !globMatches(matchPattern, fact)) continue;
    const wildcardCount = countWildcards(matchPattern);
    matches.push({
      selector,
      normalizedPattern,
      matchPattern,
      wildcardCount,
      literalCount: matchPattern.length - wildcardCount
    });
  }
  return matches;
}

function selectExact(matches: readonly MatchedSelector[], scope: 'local' | 'global'): MatchedSelector | undefined {
  return rejectAmbiguity(matches.filter((match) => match.wildcardCount === 0), `${scope} exact`);
}

function selectWildcard(matches: readonly MatchedSelector[], scope: 'local' | 'global'): MatchedSelector | undefined {
  const wildcards = matches.filter((match) => match.wildcardCount > 0);
  if (wildcards.length === 0) return undefined;
  let bestLiteralCount = -1;
  let bestWildcardCount = Number.POSITIVE_INFINITY;
  for (const match of wildcards) {
    if (match.literalCount > bestLiteralCount) {
      bestLiteralCount = match.literalCount;
      bestWildcardCount = match.wildcardCount;
    } else if (match.literalCount === bestLiteralCount && match.wildcardCount < bestWildcardCount) {
      bestWildcardCount = match.wildcardCount;
    }
  }
  return rejectAmbiguity(
    wildcards.filter((match) => match.literalCount === bestLiteralCount && match.wildcardCount === bestWildcardCount),
    `${scope} wildcard`
  );
}

function rejectAmbiguity(matches: readonly MatchedSelector[], description: string): MatchedSelector | undefined {
  if (matches.length > 1) throw new ProfileResolutionError(`Ambiguous ${description} profile selectors.`);
  return matches[0];
}

function addSelectorCandidate(
  candidates: Candidate[],
  source: ProfileSource,
  match: MatchedSelector | undefined,
  registry: Readonly<Record<string, RuntimeProfile>>
): void {
  if (match === undefined) return;
  const resolved = resolveSetting(match.selector.profile, registry);
  candidates.push({
    source,
    values: resolved.values,
    ...(resolved.profileId === undefined ? {} : { profileId: resolved.profileId }),
    selector: Object.freeze({
      target: match.selector.target,
      pattern: match.selector.target === 'remote' ? match.normalizedPattern : match.selector.pattern,
      normalizedPattern: match.normalizedPattern
    })
  });
}

function addSettingCandidate(
  candidates: Candidate[],
  source: ProfileSource,
  selection: RuntimeProfileSelection | undefined,
  registry: Readonly<Record<string, RuntimeProfile>>
): void {
  if (selection === undefined) return;
  const resolved = resolveSetting(selection, registry);
  candidates.push({
    source,
    values: resolved.values,
    ...(resolved.profileId === undefined ? {} : { profileId: resolved.profileId })
  });
}

function resolveSetting(
  selection: RuntimeProfileSelection,
  registry: Readonly<Record<string, RuntimeProfile>>
): { readonly values: Partial<RuntimeProfile>; readonly profileId?: string } {
  if (typeof selection === 'string') return profileValues(selection, registry);
  if (!isRecord(selection)) throw new ProfileResolutionError('Runtime profile setting must be a profile id or object.');
  for (const field of Object.keys(selection)) {
    if (!settingFields.has(field)) throw new ProfileResolutionError(`Unknown runtime profile setting field: ${field}`);
  }

  if (selection.profile !== undefined && !isNonEmptyString(selection.profile)) {
    throw new ProfileResolutionError('Runtime profile setting profile must be a non-empty string.');
  }
  const base = selection.profile === undefined ? {} : profileValues(selection.profile, registry).values;
  for (const field of booleanFields) {
    if (selection[field] !== undefined && typeof selection[field] !== 'boolean') {
      throw new ProfileResolutionError(`Runtime profile setting ${field} must be boolean.`);
    }
  }
  if (selection.degradedOutcomes !== undefined) validateOutcomes(selection.degradedOutcomes);

  const values: Partial<RuntimeProfile> = { ...base };
  for (const field of booleanFields) {
    const value = selection[field];
    if (value !== undefined) Object.assign(values, { [field]: value });
  }
  if (selection.degradedOutcomes !== undefined) {
    Object.assign(values, { degradedOutcomes: selection.degradedOutcomes });
  }
  return {
    values,
    ...(selection.profile === undefined ? {} : { profileId: selection.profile })
  };
}

function profileValues(
  id: string,
  registry: Readonly<Record<string, RuntimeProfile>>
): { readonly values: RuntimeProfile; readonly profileId: string } {
  if (!isNonEmptyString(id)) throw new ProfileResolutionError('Runtime profile id must be a non-empty string.');
  const profile = Object.hasOwn(registry, id) ? registry[id] : undefined;
  if (profile === undefined) throw new ProfileResolutionError(`Unknown runtime profile: ${id}`);
  return { values: profile, profileId: id };
}

function validateSelector(selector: ProfileTargetSelector): void {
  if (!isRecord(selector)) throw new ProfileResolutionError('Profile selector must be an object.');
  if (selector.target !== 'remote' && selector.target !== 'path') {
    throw new ProfileResolutionError('Profile selector target must be remote or path.');
  }
  if (!isNonEmptyString(selector.pattern)) throw new ProfileResolutionError('Profile selector pattern must not be empty.');
  if (selector.profile === undefined) throw new ProfileResolutionError('Profile selector must declare a profile setting.');
}

function validateOutcomes(value: unknown): asserts value is Readonly<Record<OperationClass, DecisionOutcome>> {
  if (!isRecord(value)) throw new ProfileResolutionError('degradedOutcomes must be an object.');
  const fields = Object.keys(value);
  if (fields.length !== operationClasses.length || fields.some((field) => !operationClasses.includes(field as OperationClass))) {
    throw new ProfileResolutionError('degradedOutcomes must declare normal, caution, and protected.');
  }
  for (const operationClass of operationClasses) {
    if (!outcomes.has(value[operationClass])) throw new ProfileResolutionError(`Invalid degraded outcome for ${operationClass}.`);
  }
}

function globMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`, 'u').test(value);
}

function countWildcards(value: string): number {
  let count = 0;
  for (const character of value) if (character === '*') count += 1;
  return count;
}

function inputRemote(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeGitRemoteUrl(value);
}

function inputPath(value: string | undefined): string | undefined {
  return value === undefined ? undefined : canonicalRuntimePathIdentity(value);
}

function freezeTraceEntry(candidate: Candidate): ProfileTraceEntry {
  return Object.freeze({
    source: candidate.source,
    ...(candidate.profileId === undefined ? {} : { profileId: candidate.profileId }),
    ...(candidate.selector === undefined ? {} : { selector: candidate.selector })
  });
}

function freezeResolvedProfile(
  values: Partial<RuntimeProfile>,
  learningLineage: boolean
): RuntimeProfile {
  const profile = values as RuntimeProfile;
  if (learningLineage && !profile.captureEnabled) {
    throw new ProfileResolutionError('Learning runtime profile must keep capture enabled.');
  }
  return Object.freeze({
    ...profile,
    degradedOutcomes: Object.freeze({ ...profile.degradedOutcomes })
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
