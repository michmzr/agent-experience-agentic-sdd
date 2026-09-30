import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { LessonKind } from '../domain/types.js';

const IDENTITY_VERSION = 1;

export interface CandidateIdentityInput {
  readonly repositoryId: string;
  readonly kind: LessonKind;
  readonly applicability: { readonly scope: 'repository' | 'subproject'; readonly path?: string; readonly conditions?: readonly string[] };
  readonly propositionKey?: string;
  readonly procedureKey?: string;
  readonly originId: string;
}

export function canonicalCandidateIdentity(input: CandidateIdentityInput): string {
  const repositoryId = requiredKey(input.repositoryId, 'repositoryId');
  const originId = requiredKey(input.originId, 'originId');
  const path = applicabilityPath(input.applicability);
  const conditions = [...new Set((input.applicability.conditions ?? []).map((condition) => requiredKey(condition, 'condition')))].sort();
  const propositionKey = optionalKey(input.propositionKey);
  const procedureKey = optionalKey(input.procedureKey);
  const parts = propositionKey
    ? [IDENTITY_VERSION, repositoryId, input.kind, input.applicability.scope, path, conditions, propositionKey, procedureKey]
    : [IDENTITY_VERSION, repositoryId, input.kind, input.applicability.scope, path, conditions, 'unkeyed', originId];
  return `acl-candidate:v${IDENTITY_VERSION}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

export function groupCandidateOrigins(inputs: readonly CandidateIdentityInput[]): readonly { readonly identity: string; readonly originIds: readonly string[] }[] {
  const groups = new Map<string, Set<string>>();
  for (const input of inputs) {
    const identity = canonicalCandidateIdentity(input);
    const origins = groups.get(identity) ?? new Set<string>();
    origins.add(requiredKey(input.originId, 'originId'));
    groups.set(identity, origins);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right))
    .map(([identity, originIds]) => ({ identity, originIds: [...originIds].sort() }));
}

function requiredKey(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new TypeError(`Invalid candidate ${name}.`);
  return value.normalize('NFC');
}

function optionalKey(value: string | undefined): string | null {
  return value === undefined ? null : requiredKey(value, 'semantic key');
}

function applicabilityPath(applicability: CandidateIdentityInput['applicability']): string | null {
  if (applicability.scope === 'repository') {
    if (applicability.path !== undefined) throw new TypeError('Repository candidate cannot have a subproject path.');
    return null;
  }
  if (applicability.scope !== 'subproject') throw new TypeError('Invalid candidate scope.');
  const path = requiredKey(applicability.path ?? '', 'subproject path');
  if (posix.isAbsolute(path) || path.split('/').some((segment) => !segment || segment === '.' || segment === '..') || path.includes('\\')) {
    throw new TypeError('Invalid candidate subproject path.');
  }
  return path;
}
