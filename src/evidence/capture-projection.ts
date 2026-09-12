import type { CapturedEventRecord } from '../capture/contracts.js';
import type { Session } from '../domain/types.js';
import type { EvidenceObservation, SessionEvidenceInput } from './contracts.js';

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
