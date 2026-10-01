import type { CapturedEventRecord } from '../capture/contracts.js';
import { isTrustedCodexCliJsonStream, type TrustedCodexCliJsonStream } from '../capture/adapters/codex-cli-json.js';
import type { Session } from '../domain/types.js';
import type { EvidenceObservation, SessionEvidenceInput } from './contracts.js';

/** Project only events produced by CodexCliJsonCapture, never project hook events here. */
export function projectCodexCliJsonEvidence(input: {
  readonly session: Session;
  readonly stream: TrustedCodexCliJsonStream;
}): SessionEvidenceInput {
  if (!isTrustedCodexCliJsonStream(input.stream)) throw new TypeError('Codex CLI JSON stream lacks trusted child provenance.');
  if (input.session.source !== 'codex') throw new TypeError('Codex CLI JSON session source is invalid.');
  if (input.session.id !== input.stream.sessionId) throw new TypeError('Codex CLI JSON session identity is invalid.');
  const observations: EvidenceObservation[] = input.stream.events.map((event: CapturedEventRecord) => {
    if (event.source !== 'codex' || event.sessionId !== input.session.id
      || !/^cli-[0-9a-f]{64}-(start|result)$/.test(event.sourceEventId)
      || event.phase === 'pre-intent') throw new TypeError('Codex CLI JSON event provenance is invalid.');
    const requestId = event.phase === 'pre-action' ? event.sourceEventId : event.relatedEventId;
    if (requestId === undefined || !/^cli-[0-9a-f]{64}-start$/.test(requestId)) {
      throw new TypeError('Codex CLI JSON request relation is invalid.');
    }
    return Object.freeze({
      id: event.id,
      sourceEventId: event.sourceEventId,
      executionKey: requestId,
      kind: event.phase === 'pre-action' ? 'request' as const : 'result' as const,
      occurredAt: event.occurredAt,
      ...(event.phase === 'post-result' ? {
        relatedEventId: requestId,
        resultProvenance: 'cli-json-item' as const,
        outcome: event.outcome,
        ...(event.exitStatus === undefined ? { resultUnknownReason: 'source-field-absent' as const } : { exitStatus: event.exitStatus })
      } : {})
    });
  });
  return Object.freeze({ schemaVersion: 1, source: 'codex', sessionId: input.session.id,
    startedAt: input.session.startedAt,
    ...(input.session.endedAt === undefined ? {} : { sourceEndedAt: input.session.endedAt }),
    observations: Object.freeze(observations),
    coverage: Object.freeze({ supportedClasses: Object.freeze(['command-execution-request', 'command-execution-result']),
      unsupportedClasses: Object.freeze(['hook-result', 'async-poll-relation', 'task-verification', 'human-wait']),
      synthetic: false }) });
}
