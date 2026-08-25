import type { RepositoryKnowledgeOptions, SharedKnowledgeDocument } from './repository.js';
import { updateSharedKnowledge } from './repository.js';

export interface PromotionEligibility {
  readonly eligible: boolean;
  readonly approvalRequired: boolean;
  readonly reasons: readonly string[];
}

export function evaluatePromotion(document: SharedKnowledgeDocument): PromotionEligibility {
  if (document.state === 'disputed') return rejected(false, 'disputed knowledge cannot be promoted');
  if (document.instructionOrigin === 'task-specific-constraint') return rejected(false, 'task-specific constraints are not reusable repository knowledge');
  if (!document.evidence?.length) return rejected(false, 'promotion requires sanitized evidence');

  if (document.kind === 'preference') {
    if (document.instructionOrigin !== 'user-preference') return rejected(true, 'preference kind requires user-preference origin and approval');
    return approvalResult(document);
  }
  if (document.kind === 'successful-workflow') {
    if (document.instructionOrigin !== 'skill-workflow-candidate') return rejected(true, 'workflow kind requires skill-workflow-candidate origin and approval');
    return approvalResult(document);
  }
  if (document.instructionOrigin === 'user-preference' || document.instructionOrigin === 'skill-workflow-candidate') {
    return rejected(true, 'instruction origin is inconsistent with lesson kind');
  }

  if (document.instructionOrigin === 'code-tool-confirmed') {
    const deterministic = document.evidence.some((evidence) => evidence.kind === 'code-or-tool' && evidence.deterministic);
    return deterministic
      ? { eligible: true, approvalRequired: false, reasons: ['deterministic code/tool evidence'] }
      : rejected(false, 'code/tool facts require deterministic evidence');
  }

  return rejected(false, 'instruction origin is not promotable');
}

export function promoteKnowledge(repositoryRoot: string, document: SharedKnowledgeDocument, options: RepositoryKnowledgeOptions = {}): SharedKnowledgeDocument {
  if (document.activation === 'merged-team-active') throw new Error('Promotion cannot assert merged team activation.');
  if (document.mergedProvenance !== undefined) throw new Error('Promotion cannot accept caller-provided merged provenance.');
  const result = evaluatePromotion(document);
  if (!result.eligible) throw new Error(`Knowledge is not eligible for promotion: ${result.reasons.join('; ')}.`);
  const local: SharedKnowledgeDocument = { ...document, activation: 'local' };
  updateSharedKnowledge(repositoryRoot, (existing) => [...existing.filter((entry) => entry.identity !== local.identity), local], options);
  return local;
}

function approvalResult(document: SharedKnowledgeDocument): PromotionEligibility {
  return document.approval?.kind === 'user'
    ? { eligible: true, approvalRequired: true, reasons: ['recorded user approval'] }
    : rejected(true, 'recorded user approval is required');
}

function rejected(approvalRequired: boolean, reason: string): PromotionEligibility {
  return { eligible: false, approvalRequired, reasons: [reason] };
}
