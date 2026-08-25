import type {
  DecisionOutcome,
  OperationClass,
  RuntimeProfile
} from '../runtime/contracts.js';

export type RuntimeProfileId = string;

export interface RuntimeProfileRegistry {
  readonly version: 1;
  readonly profiles: Readonly<Record<string, RuntimeProfile>>;
  readonly learningProfileIds: readonly string[];
}

export interface CustomRuntimeProfileDefinition {
  readonly id: string;
  readonly extends: string;
  readonly hardBlocking?: boolean;
  readonly warningsEnabled?: boolean;
  readonly captureEnabled?: boolean;
  readonly retrievalEnabled?: boolean;
  readonly degradedOutcomes?: Readonly<Record<OperationClass, DecisionOutcome>>;
}

export class RuntimeProfileConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeProfileConfigurationError';
  }
}

const defaultDegradedOutcomes = Object.freeze({
  normal: 'ALLOW',
  caution: 'WARN',
  protected: 'BLOCK'
} as const);

export const NORMAL_PROFILE: RuntimeProfile = freezeProfile({
  id: 'normal',
  hardBlocking: true,
  warningsEnabled: true,
  captureEnabled: true,
  retrievalEnabled: true,
  degradedOutcomes: defaultDegradedOutcomes
});

export const LEARNING_PROFILE: RuntimeProfile = freezeProfile({
  ...NORMAL_PROFILE,
  id: 'learning',
  hardBlocking: false
});

export const OBSERVE_ONLY_PROFILE: RuntimeProfile = freezeProfile({
  ...NORMAL_PROFILE,
  id: 'observe-only',
  hardBlocking: false,
  warningsEnabled: false
});

export const BUILT_IN_RUNTIME_PROFILES: Readonly<Record<string, RuntimeProfile>> = Object.freeze(
  nullPrototypeRecord([
    [NORMAL_PROFILE.id, NORMAL_PROFILE],
    [LEARNING_PROFILE.id, LEARNING_PROFILE],
    [OBSERVE_ONLY_PROFILE.id, OBSERVE_ONLY_PROFILE]
  ])
);

export const BUILT_IN_RUNTIME_PROFILE_REGISTRY: RuntimeProfileRegistry = freezeRegistry(
  BUILT_IN_RUNTIME_PROFILES,
  ['learning']
);

const definitionFields = new Set([
  'id',
  'extends',
  'hardBlocking',
  'warningsEnabled',
  'captureEnabled',
  'retrievalEnabled',
  'degradedOutcomes'
]);
const booleanFields = ['hardBlocking', 'warningsEnabled', 'captureEnabled', 'retrievalEnabled'] as const;
const operationClasses = ['normal', 'caution', 'protected'] as const;
const decisionOutcomes = new Set<unknown>(['ALLOW', 'WARN', 'BLOCK']);

/** Validates custom definitions and returns a deeply immutable profile registry. */
export function defineRuntimeProfiles(
  definitions: readonly unknown[] = []
): RuntimeProfileRegistry {
  const validated = definitions.map(validateDefinition);
  const definitionsById = new Map<string, CustomRuntimeProfileDefinition>();

  for (const definition of validated) {
    if (Object.hasOwn(BUILT_IN_RUNTIME_PROFILES, definition.id) || definitionsById.has(definition.id)) {
      throw new RuntimeProfileConfigurationError(`Duplicate runtime profile id: ${definition.id}`);
    }
    definitionsById.set(definition.id, definition);
  }

  const resolved = new Map<string, RuntimeProfile>(Object.entries(BUILT_IN_RUNTIME_PROFILES));
  const learningLineage = new Map<string, boolean>([['learning', true]]);
  const resolving = new Set<string>();

  const resolve = (id: string): RuntimeProfile => {
    const existing = resolved.get(id);
    if (existing !== undefined) return existing;
    if (resolving.has(id)) {
      throw new RuntimeProfileConfigurationError(`Circular runtime profile inheritance involving: ${id}`);
    }

    const definition = definitionsById.get(id);
    if (definition === undefined) {
      throw new RuntimeProfileConfigurationError(`Unknown runtime profile parent: ${id}`);
    }

    resolving.add(id);
    const parent = resolve(definition.extends);
    const inheritsLearning = definition.extends === 'learning'
      || learningLineage.get(definition.extends) === true;
    const profile = freezeProfile({
      ...parent,
      ...runtimeOverrides(definition),
      id: definition.id
    });
    if (inheritsLearning && !profile.captureEnabled) {
      throw new RuntimeProfileConfigurationError(
        `Learning profile ${profile.id} must keep capture enabled.`
      );
    }

    resolving.delete(id);
    resolved.set(id, profile);
    learningLineage.set(id, inheritsLearning);
    return profile;
  };

  for (const definition of validated) resolve(definition.id);

  const profiles = nullPrototypeRecord(resolved.entries());
  const learningProfileIds = [...resolved.keys()].filter((id) => learningLineage.get(id) === true);
  return freezeRegistry(profiles, learningProfileIds);
}

/** Returns validated inheritance lineage without inferring semantics from mutable fields. */
export function hasLearningLineage(
  registry: RuntimeProfileRegistry,
  profileId: string
): boolean {
  return registry.learningProfileIds.includes(profileId);
}

/** Rehydrates untrusted serialized registry data into a validated immutable value. */
export function validateRuntimeProfileRegistry(value: unknown): RuntimeProfileRegistry {
  if (!isRecord(value)) throw new RuntimeProfileConfigurationError('Runtime profile registry must be an object.');
  const fields = Object.keys(value);
  if (fields.length !== 3 || fields.some((field) => !['version', 'profiles', 'learningProfileIds'].includes(field))) {
    throw new RuntimeProfileConfigurationError('Runtime profile registry fields are invalid.');
  }
  if (value.version !== 1 || !isRecord(value.profiles) || !Array.isArray(value.learningProfileIds)) {
    throw new RuntimeProfileConfigurationError('Runtime profile registry structure is invalid.');
  }

  const serializedProfiles = value.profiles;
  const profiles = nullPrototypeRecord(
    Object.keys(serializedProfiles).map((id) => [id, validateCompleteProfile(serializedProfiles[id], id)] as const)
  );
  for (const builtIn of Object.values(BUILT_IN_RUNTIME_PROFILES)) {
    const actual = ownProfile(profiles, builtIn.id);
    if (actual === undefined || !sameProfile(actual, builtIn)) {
      throw new RuntimeProfileConfigurationError('Runtime profile registry built-ins are invalid.');
    }
  }

  const learningProfileIds: string[] = [];
  const seen = new Set<string>();
  for (const id of value.learningProfileIds) {
    if (!isNonEmptyString(id) || seen.has(id) || ownProfile(profiles, id) === undefined) {
      throw new RuntimeProfileConfigurationError('Runtime profile learning lineage is invalid.');
    }
    seen.add(id);
    learningProfileIds.push(id);
  }
  if (!seen.has('learning') || seen.has('normal') || seen.has('observe-only')) {
    throw new RuntimeProfileConfigurationError('Runtime profile learning lineage is invalid.');
  }
  for (const id of learningProfileIds) {
    if (!ownProfile(profiles, id)!.captureEnabled) {
      throw new RuntimeProfileConfigurationError('Learning profiles must keep capture enabled.');
    }
  }

  return freezeRegistry(profiles, learningProfileIds);
}

function validateDefinition(value: unknown): CustomRuntimeProfileDefinition {
  if (!isRecord(value)) throw new RuntimeProfileConfigurationError('Runtime profile definition must be an object.');
  for (const field of Object.keys(value)) {
    if (!definitionFields.has(field)) {
      throw new RuntimeProfileConfigurationError(`Unknown runtime profile field: ${field}`);
    }
  }
  if (!isNonEmptyString(value.id)) throw new RuntimeProfileConfigurationError('Runtime profile id must be a non-empty string.');
  if (!isNonEmptyString(value.extends)) {
    throw new RuntimeProfileConfigurationError(`Runtime profile ${value.id} must extend exactly one profile.`);
  }
  for (const field of booleanFields) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      throw new RuntimeProfileConfigurationError(`Runtime profile field ${field} must be boolean.`);
    }
  }
  if (value.degradedOutcomes !== undefined) validateDegradedOutcomes(value.degradedOutcomes);

  return value as unknown as CustomRuntimeProfileDefinition;
}

function validateDegradedOutcomes(value: unknown): asserts value is Readonly<Record<OperationClass, DecisionOutcome>> {
  if (!isRecord(value)) throw new RuntimeProfileConfigurationError('degradedOutcomes must be an object.');
  const fields = Object.keys(value);
  if (fields.length !== operationClasses.length || fields.some((field) => !operationClasses.includes(field as OperationClass))) {
    throw new RuntimeProfileConfigurationError('degradedOutcomes must declare normal, caution, and protected.');
  }
  for (const operationClass of operationClasses) {
    if (!decisionOutcomes.has(value[operationClass])) {
      throw new RuntimeProfileConfigurationError(`Invalid degraded outcome for ${operationClass}.`);
    }
  }
}

function runtimeOverrides(
  definition: CustomRuntimeProfileDefinition
): Partial<Omit<RuntimeProfile, 'id'>> {
  const overrides: Partial<Omit<RuntimeProfile, 'id'>> = {};
  for (const field of booleanFields) {
    const value = definition[field];
    if (value !== undefined) Object.assign(overrides, { [field]: value });
  }
  if (definition.degradedOutcomes !== undefined) {
    Object.assign(overrides, { degradedOutcomes: definition.degradedOutcomes });
  }
  return overrides;
}

function freezeProfile(profile: RuntimeProfile): RuntimeProfile {
  return Object.freeze({
    ...profile,
    degradedOutcomes: Object.freeze({ ...profile.degradedOutcomes })
  });
}

function freezeRegistry(
  profiles: Readonly<Record<string, RuntimeProfile>>,
  learningProfileIds: readonly string[]
): RuntimeProfileRegistry {
  const frozenProfiles = nullPrototypeRecord(
    Object.entries(profiles).map(([id, profile]) => [id, freezeProfile(profile)] as const)
  );
  Object.freeze(frozenProfiles);
  return Object.freeze({
    version: 1 as const,
    profiles: frozenProfiles,
    learningProfileIds: Object.freeze([...learningProfileIds])
  });
}

function validateCompleteProfile(value: unknown, id: string): RuntimeProfile {
  if (!isRecord(value)) throw new RuntimeProfileConfigurationError('Runtime profile must be an object.');
  const fields = Object.keys(value);
  const expectedFields = ['id', ...booleanFields, 'degradedOutcomes'];
  if (fields.length !== expectedFields.length || fields.some((field) => !expectedFields.includes(field))) {
    throw new RuntimeProfileConfigurationError('Runtime profile fields are invalid.');
  }
  if (value.id !== id) throw new RuntimeProfileConfigurationError('Runtime profile id does not match its registry key.');
  for (const field of booleanFields) {
    if (typeof value[field] !== 'boolean') throw new RuntimeProfileConfigurationError(`Runtime profile field ${field} must be boolean.`);
  }
  validateDegradedOutcomes(value.degradedOutcomes);
  return freezeProfile(value as unknown as RuntimeProfile);
}

function nullPrototypeRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [id, value] of entries) record[id] = value;
  return record;
}

function ownProfile(
  profiles: Readonly<Record<string, RuntimeProfile>>,
  id: string
): RuntimeProfile | undefined {
  return Object.hasOwn(profiles, id) ? profiles[id] : undefined;
}

function sameProfile(left: RuntimeProfile, right: RuntimeProfile): boolean {
  return left.id === right.id
    && left.hardBlocking === right.hardBlocking
    && left.warningsEnabled === right.warningsEnabled
    && left.captureEnabled === right.captureEnabled
    && left.retrievalEnabled === right.retrievalEnabled
    && operationClasses.every(
      (operationClass) => left.degradedOutcomes[operationClass] === right.degradedOutcomes[operationClass]
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
