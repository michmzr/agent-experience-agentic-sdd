import { assertDurableTextSafe } from '../review/sanitizer.js';
import type { RuntimeRule } from '../runtime/contracts.js';
import type { ActivatedKnowledgeEntry } from './git-activation.js';
import { assertIdentity, compare, parseRuntimeDirective } from './schema.js';

export interface ActivatedRuntimeCompilation {
  readonly repositoryId: string;
  readonly trustedCommit: string;
  readonly entries: readonly ActivatedKnowledgeEntry[];
}

const activeStates = new Set(['observed', 'confirmed', 'verified', 'disputed']);
const commitPattern = /^[a-f0-9]{40,64}$/;

/** Compiles only explicit structured directives from one trusted merged Git generation. */
export function compileActivatedRuntimeRules(input: ActivatedRuntimeCompilation): readonly RuntimeRule[] {
  assertRepositoryId(input.repositoryId);
  if (!commitPattern.test(input.trustedCommit)) throw new TypeError('Trusted runtime knowledge commit is invalid.');
  if (!Array.isArray(input.entries) || input.entries.length > 1_000) throw new TypeError('Activated runtime knowledge entry limit exceeded.');
  const expectedScope = `repository:${input.repositoryId}`;
  const rules: RuntimeRule[] = [];
  const identities = new Set<string>();

  for (const entry of input.entries) {
    if (!entry.authoritative || entry.provenance.source !== 'trusted-ref') continue;
    if (entry.provenance.commit !== input.trustedCommit) throw new TypeError('Activated runtime knowledge commit provenance is inconsistent.');
    const document = entry.document;
    assertIdentity(document.identity);
    if (identities.has(document.identity)) throw new TypeError('Activated runtime knowledge contains a duplicate identity.');
    identities.add(document.identity);
    if (document.repositoryScope !== expectedScope || !activeStates.has(document.state) || document.runtimeDirective === undefined) continue;

    const directive = parseRuntimeDirective(document.runtimeDirective);
    assertApplicability(document.applicability, directive.signature);
    const effect = directive.effect === 'context' || document.state === 'observed' || document.state === 'disputed'
      ? 'context' as const : 'conflict' as const;
    const signatureTool = directive.signature.tool;
    const applicability = {
      scope: 'repository' as const,
      repositoryId: input.repositoryId,
      ...(document.applicability.tools.length === 0 ? {} : { tool: signatureTool! }),
      ...(document.applicability.paths.length === 0 ? {} : { path: directive.signature.path! }),
      ...(document.applicability.tags.length === 0 ? {} : { tags: [...document.applicability.tags] })
    };
    rules.push(deepFreeze({
      id: `shared:${document.identity}`,
      state: document.state,
      authoritative: true,
      effect,
      signature: directive.signature,
      applicability,
      reference: {
        knowledgeId: document.identity,
        evidenceIds: [],
        source: `trusted-ref:${input.trustedCommit}`
      }
    }));
  }
  rules.sort((left, right) => compare(left.id, right.id));
  return deepFreeze(rules);
}

function assertRepositoryId(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value !== value.trim() || /[\0\r\n]/.test(value)) {
    throw new TypeError('Runtime repository identity is invalid.');
  }
  assertDurableTextSafe(value);
}

function assertApplicability(
  applicability: ActivatedKnowledgeEntry['document']['applicability'],
  signature: RuntimeRule['signature']
): void {
  const tool = signature.tool;
  if (applicability.tools.length > 0
    && (applicability.tools.length !== 1 || tool === undefined || applicability.tools[0] !== tool)) {
    throw new TypeError('Runtime directive tool applicability is inconsistent.');
  }
  if (applicability.paths.length > 0
    && (applicability.paths.length !== 1 || signature.path === undefined || applicability.paths[0] !== signature.path)) {
    throw new TypeError('Runtime directive path applicability is inconsistent.');
  }
  if (new Set(applicability.tags).size !== applicability.tags.length
    || !applicability.tags.every((value, index) => index === 0 || compare(applicability.tags[index - 1]!, value) < 0)) {
    throw new TypeError('Runtime directive tag applicability is not canonical.');
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
