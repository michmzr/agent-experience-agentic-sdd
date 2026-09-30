import type { CapturedEventRecord } from '../capture/contracts.js';
import type { Session } from '../domain/types.js';
import type { EvidenceObservation, ResultInterpretation, SessionEvidenceInput } from './contracts.js';

export function interpretCapturedProcess(request: CapturedEventRecord, result: CapturedEventRecord): ResultInterpretation {
  if (request.phase !== 'pre-action' || result.phase !== 'post-result' || request.source !== result.source
    || request.sessionId !== result.sessionId || result.relatedEventId !== request.sourceEventId) {
    throw new TypeError('Process interpretation requires a linked request and result.');
  }
  if (result.exitStatus === 0) return Object.freeze({ version: 1, kind: 'unknown' });
  if (result.exitStatus === 1 && request.signature.kind === 'action' && request.signature.action === 'rg') {
    return Object.freeze({ version: 1, kind: 'no-match' });
  }
  return Object.freeze({ version: 1, kind: result.exitStatus === undefined ? 'unknown' : 'unclassified-nonzero' });
}

export function projectCapturedSessionEvidence(input: {
  readonly session: Session;
  readonly events: readonly CapturedEventRecord[];
}): SessionEvidenceInput {
  const observations: EvidenceObservation[] = [];
  const skipped = new Set<string>();
  for (const event of input.events) {
    if (event.sessionId !== input.session.id || event.source !== input.session.source) {
      throw new TypeError('Captured event does not match session provenance.');
    }
    if (event.phase === 'pre-intent') {
      skipped.add('pre-intent');
      continue;
    }
    observations.push(Object.freeze({
      id: event.id,
      sourceEventId: event.sourceEventId,
      ...(event.phase === 'pre-action' ? { executionKey: event.sourceEventId }
        : event.relatedEventId === undefined ? {} : { executionKey: event.relatedEventId }),
      kind: event.phase === 'pre-action' ? 'request' : 'result',
      occurredAt: event.occurredAt,
      ...(event.relatedEventId === undefined ? {} : { relatedEventId: event.relatedEventId }),
      ...(event.signature.tool === undefined ? {} : { tool: event.signature.tool }),
      ...(event.outcome === undefined ? (event.phase === 'post-result' ? { outcome: 'unknown' as const } : {}) : { outcome: event.outcome }),
      ...(event.exitStatus === undefined ? {} : { exitStatus: event.exitStatus })
      ,...(event.phase === 'post-result' ? { resultProvenance: 'hook-envelope' as const } : {})
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    source: input.session.source,
    sessionId: input.session.id,
    startedAt: input.session.startedAt,
    ...(input.session.endedAt === undefined ? {} : { sourceEndedAt: input.session.endedAt }),
    observations: Object.freeze(observations),
    coverage: Object.freeze({
      supportedClasses: Object.freeze(['request', 'result']),
      skippedClasses: Object.freeze([...skipped].sort()),
      unsupportedClasses: Object.freeze(['human-wait', 'task-verification']),
      synthetic: false
    })
  });
}
