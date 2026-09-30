import type { LessonKind } from '../domain/types.js';
import { containsCredentialMaterial } from '../privacy/structured-arguments.js';

export interface VerifiedAdviceEntry {
  readonly candidateId: string;
  readonly revision: string;
  readonly repositoryId: string;
  readonly kind: LessonKind;
  readonly statement: string;
  readonly applicability: { readonly scope: 'repository' | 'subproject'; readonly path?: string; readonly conditions?: readonly string[] };
  readonly operationSignature: string | null;
  readonly contextRevision: string | null;
  readonly evidenceRefs: readonly string[];
  readonly contradictionState: 'clear' | 'disputed';
  readonly state: 'verified' | 'observed';
}
export interface AdviceContext {
  readonly repositoryId: string;
  readonly subproject?: string;
  readonly operationSignature: string;
  readonly contextRevision: string;
  readonly conditions: readonly string[];
}
export interface AdviceSelection { readonly status: 'ready' | 'unavailable'; readonly entries: readonly VerifiedAdviceEntry[] }

export function selectLocalAdvice(entries: readonly VerifiedAdviceEntry[], context: AdviceContext,
  options: { readonly deadline?: number; readonly now?: () => number } = {}): AdviceSelection {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + 200;
  const selected: VerifiedAdviceEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...entries].sort((left, right) => left.candidateId.localeCompare(right.candidateId)
    || left.revision.localeCompare(right.revision))) {
    if (now() > deadline) return Object.freeze({ status: 'unavailable', entries: Object.freeze([]) });
    if (entry.state !== 'verified' || entry.contradictionState !== 'clear'
      || entry.repositoryId !== context.repositoryId || entry.contextRevision !== context.contextRevision
      || entry.operationSignature !== context.operationSignature
      || entry.applicability.scope === 'subproject' && entry.applicability.path !== context.subproject
      || entry.applicability.scope !== 'repository' && entry.applicability.scope !== 'subproject'
      || !entry.applicability.conditions?.every(condition => context.conditions.includes(condition))
      || entry.evidenceRefs.length === 0 || containsCredentialMaterial(entry.statement)) continue;
    const identity = `${entry.candidateId}\0${entry.revision}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const proposed = [...selected, entry];
    if (Buffer.byteLength(JSON.stringify(proposed), 'utf8') > 4096) continue;
    selected.push(entry);
    if (selected.length === 3) break;
  }
  if (now() > deadline) return Object.freeze({ status: 'unavailable', entries: Object.freeze([]) });
  return Object.freeze({ status: 'ready', entries: Object.freeze(selected) });
}
