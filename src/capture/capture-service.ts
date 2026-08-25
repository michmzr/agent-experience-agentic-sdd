import { createHash } from 'node:crypto';

import type { Session } from '../domain/types.js';
import type { GateDecision } from '../runtime/gate.js';
import type {
  CaptureDiagnostic,
  IncrementalCaptureAppend,
  NormalizedCaptureEvent
} from './contracts.js';

export interface CaptureAppendStore {
  appendIncremental(input: IncrementalCaptureAppend): { readonly inserted: boolean };
}

export interface CaptureServiceOptions {
  readonly store: CaptureAppendStore;
  readonly session: Session;
}

export type CaptureResult =
  | { readonly status: 'captured' | 'duplicate' | 'disabled'; readonly decision: GateDecision }
  | { readonly status: 'degraded'; readonly decision: GateDecision; readonly diagnostic: CaptureDiagnostic };

export interface CaptureService {
  capture(event: NormalizedCaptureEvent, decision: GateDecision): CaptureResult;
}

export function createCaptureService(options: CaptureServiceOptions): CaptureService {
  const session = Object.freeze({ ...options.session });
  return Object.freeze({
    capture(event: NormalizedCaptureEvent, decision: GateDecision): CaptureResult {
      if (!decision.captureEnabled) return Object.freeze({ status: 'disabled', decision });
      if (event.sessionId !== session.id || event.source !== session.source) {
        return degraded(decision, event.phase);
      }
      try {
        const append = incrementalAppend(session, event, decision);
        const result = options.store.appendIncremental(append);
        return Object.freeze({ status: result.inserted ? 'captured' : 'duplicate', decision });
      } catch {
        return degraded(decision, event.phase);
      }
    }
  });
}

function incrementalAppend(session: Session, event: NormalizedCaptureEvent, decision: GateDecision): IncrementalCaptureAppend {
  if (event.phase !== 'post-result') return { session, event };

  const references = uniqueKnowledgeReferences(decision);
  if (references.length > 0) {
    const polarity = event.outcome === 'succeeded' && (decision.outcome !== 'ALLOW' || decision.override !== undefined)
      ? 'contradicts'
      : 'confirms';
    return {
      session,
      event,
      evidenceUpdates: references.map(({ knowledgeId }) => ({
        evidence: {
          id: stableId('evidence', event.source, event.sourceEventId, knowledgeId),
          polarity,
          summary: boundedEvidenceSummary(event, polarity)
        },
        transition: { knowledgeId, occurredAt: event.occurredAt }
      }))
    };
  }

  if (event.outcome === 'failed') {
    const observationId = stableId('observation', event.source, event.sourceEventId);
    const clusterId = stableId('cluster', event.source, event.sourceEventId);
    const candidateId = stableId('candidate', event.source, event.sourceEventId);
    return {
      session,
      event,
      candidate: {
        observation: { id: observationId, statement: event.summary },
        cluster: { id: clusterId },
        candidate: { id: candidateId, kind: 'failure', statement: `Failure observed for ${signatureLabel(event)}.`.slice(0, 2_048) },
        evidence: {
          id: stableId('evidence', event.source, event.sourceEventId),
          candidateId,
          polarity: 'confirms',
          summary: boundedEvidenceSummary(event, 'confirms')
        }
      }
    };
  }

  return { session, event };
}

function uniqueKnowledgeReferences(decision: GateDecision): Array<{ knowledgeId: string }> {
  const enforcingRuleIds = new Set(decision.explanations
    .filter(({ outcome, ruleId }) => outcome !== 'ALLOW' && ruleId !== undefined)
    .map(({ ruleId }) => ruleId!));
  for (const ruleId of decision.override?.overriddenRuleIds ?? []) enforcingRuleIds.add(ruleId);
  const unique = new Map<string, { knowledgeId: string }>();
  for (const reference of decision.references) {
    if (!enforcingRuleIds.has(reference.ruleId)) continue;
    unique.set(reference.knowledgeId, { knowledgeId: reference.knowledgeId });
  }
  return [...unique.values()].sort((left, right) => left.knowledgeId.localeCompare(right.knowledgeId));
}

function boundedEvidenceSummary(event: NormalizedCaptureEvent, polarity: 'confirms' | 'contradicts'): string {
  const prefix = polarity === 'contradicts' ? 'Successful result contradicted an enforcing rule: ' : 'Captured result: ';
  return `${prefix}${event.summary}`.slice(0, 2_048);
}

function signatureLabel(event: NormalizedCaptureEvent): string {
  return event.signature.kind === 'action'
    ? `${event.signature.tool} ${event.signature.action}`
    : `${event.signature.verb} ${event.signature.target}`;
}

function stableId(kind: string, ...parts: readonly string[]): string {
  return createHash('sha256').update(`ael:${kind}:v1\0`).update(parts.join('\0')).digest('hex');
}

function degraded(decision: GateDecision, phase: NormalizedCaptureEvent['phase']): CaptureResult {
  return Object.freeze({
    status: 'degraded',
    decision,
    diagnostic: Object.freeze({ code: 'CAPTURE_PERSISTENCE_FAILED', phase, retryable: true })
  });
}
