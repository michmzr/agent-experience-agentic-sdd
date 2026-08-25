import { createHash } from 'node:crypto';

import type { Session } from '../domain/types.js';
import type { GateDecision } from '../runtime/gate.js';
import type {
  CaptureEnforcementSnapshot,
  CaptureDiagnostic,
  IncrementalCaptureAppend,
  NormalizedCaptureEvent
} from './contracts.js';

export interface CaptureAppendStore {
  appendIncremental(input: IncrementalCaptureAppend): { readonly inserted: boolean };
  loadCaptureEnforcementSnapshot?(source: NormalizedCaptureEvent['source'], sourceEventId: string): CaptureEnforcementSnapshot | undefined;
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
        const append = incrementalAppend(options.store, session, event, decision);
        const result = options.store.appendIncremental(append);
        return Object.freeze({ status: result.inserted ? 'captured' : 'duplicate', decision });
      } catch {
        return degraded(decision, event.phase);
      }
    }
  });
}

function incrementalAppend(store: CaptureAppendStore, session: Session, event: NormalizedCaptureEvent, decision: GateDecision): IncrementalCaptureAppend {
  if (event.phase === 'pre-action') return { session, event, enforcementSnapshot: enforcementSnapshot(decision) };
  if (event.phase !== 'post-result') return { session, event };
  if (event.relatedEventId === undefined) throw new TypeError('Post-result capture requires its pre-action snapshot.');
  const snapshot = store.loadCaptureEnforcementSnapshot?.(event.source, event.relatedEventId);
  if (snapshot === undefined || snapshot.inputBinding !== decision.inputBinding) throw new TypeError('Post-result decision does not match its pre-action snapshot.');

  if (event.outcome === 'unknown') return { session, event };

  const references = uniqueSnapshotKnowledgeReferences(snapshot);
  if (references.length > 0) {
    const polarity = event.outcome === 'succeeded' ? 'contradicts' : 'confirms';
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

function enforcementSnapshot(decision: GateDecision): CaptureEnforcementSnapshot {
  const enforcingRuleIds = new Set(decision.explanations
    .filter(({ outcome, ruleId }) => outcome !== 'ALLOW' && ruleId !== undefined)
    .map(({ ruleId }) => ruleId!));
  const overrideRuleIds = new Set(decision.override?.overriddenRuleIds ?? []);
  const enforcing = new Map<string, { ruleId: string; knowledgeId: string }>();
  const overrides = new Map<string, { ruleId: string; knowledgeId: string }>();
  for (const reference of decision.references) {
    const value = { ruleId: reference.ruleId, knowledgeId: reference.knowledgeId };
    if (enforcingRuleIds.has(reference.ruleId)) enforcing.set(`${reference.ruleId}\0${reference.knowledgeId}`, value);
    if (overrideRuleIds.has(reference.ruleId)) overrides.set(`${reference.ruleId}\0${reference.knowledgeId}`, value);
  }
  const sort = (values: Iterable<{ ruleId: string; knowledgeId: string }>) => Object.freeze([...values]
    .sort((left, right) => compareText(left.ruleId, right.ruleId) || compareText(left.knowledgeId, right.knowledgeId))
    .map((value) => Object.freeze(value)));
  return Object.freeze({ inputBinding: decision.inputBinding, enforcingReferences: sort(enforcing.values()), overrideReferences: sort(overrides.values()) });
}

function uniqueSnapshotKnowledgeReferences(snapshot: CaptureEnforcementSnapshot): Array<{ knowledgeId: string }> {
  const unique = new Map<string, { knowledgeId: string }>();
  for (const reference of [...snapshot.enforcingReferences, ...snapshot.overrideReferences]) unique.set(reference.knowledgeId, { knowledgeId: reference.knowledgeId });
  return [...unique.values()].sort((left, right) => compareText(left.knowledgeId, right.knowledgeId));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
