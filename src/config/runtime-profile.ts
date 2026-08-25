import type {
  DecisionOutcome,
  OperationClass,
  RuntimeProfile
} from '../runtime/contracts.js';

export type RuntimeProfileId = string;

const learningLineageMetadata = Symbol('runtime-profile-learning-lineage');

type RuntimeProfileRegistryWithMetadata = Readonly<Record<string, RuntimeProfile>> & {
  readonly [learningLineageMetadata]?: Readonly<Record<string, boolean>>;
};

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

export const BUILT_IN_RUNTIME_PROFILES: Readonly<Record<string, RuntimeProfile>> = freezeRegistry({
  [NORMAL_PROFILE.id]: NORMAL_PROFILE,
  [LEARNING_PROFILE.id]: LEARNING_PROFILE,
  [OBSERVE_ONLY_PROFILE.id]: OBSERVE_ONLY_PROFILE
}, {
  [NORMAL_PROFILE.id]: false,
  [LEARNING_PROFILE.id]: true,
  [OBSERVE_ONLY_PROFILE.id]: false
});

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
): Readonly<Record<string, RuntimeProfile>> {
  const validated = definitions.map(validateDefinition);
  const definitionsById = new Map<string, CustomRuntimeProfileDefinition>();

  for (const definition of validated) {
    if (BUILT_IN_RUNTIME_PROFILES[definition.id] !== undefined || definitionsById.has(definition.id)) {
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

  const registry = Object.fromEntries(resolved);
  const lineage = Object.fromEntries(
    [...resolved.keys()].map((id) => [id, learningLineage.get(id) === true])
  );
  return freezeRegistry(registry, lineage);
}

/** Returns validated inheritance lineage without inferring semantics from mutable fields. */
export function hasLearningLineage(
  profiles: Readonly<Record<string, RuntimeProfile>>,
  profileId: string
): boolean {
  const metadata = (profiles as RuntimeProfileRegistryWithMetadata)[learningLineageMetadata];
  return metadata?.[profileId] === true;
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
  profiles: Record<string, RuntimeProfile>,
  learningLineage: Record<string, boolean>
): Readonly<Record<string, RuntimeProfile>> {
  Object.defineProperty(profiles, learningLineageMetadata, {
    value: Object.freeze({ ...learningLineage }),
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(profiles);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
