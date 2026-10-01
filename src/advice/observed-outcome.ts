import { createHash } from 'node:crypto';

import { isTrustedCodexCliJsonStream, type TrustedCodexCliJsonStream } from '../capture/adapters/codex-cli-json.js';
import type { StoredAdviceBundle } from './usage.js';

export interface DeterministicOutcomeWitness {
  readonly bundleId: string;
  readonly repositoryId: string;
  readonly lessonId: string;
  readonly lessonRevision: string;
  readonly sessionId: string;
  readonly contextRevision: string;
  readonly operationSignature: string;
  readonly appliedEventId: string;
  readonly fixtureDigest: string;
  readonly protocolDigest: string;
  readonly sourceDigest: string;
  readonly witnessRef: string;
  readonly result: 'succeeded';
}

const witnessedStreams = new WeakMap<DeterministicOutcomeWitness, TrustedCodexCliJsonStream>();

/** Register a successful deterministic check only against its verified operation stream. */
export function bindObservedDeterministicOutcome(input: { readonly bundle: StoredAdviceBundle;
  readonly appliedEventId: string; readonly fixtureDigest: string; readonly protocolDigest: string;
  readonly sourceDigest: string; readonly stream: TrustedCodexCliJsonStream }): DeterministicOutcomeWitness | null {
  const { bundle, stream } = input;
  if (!isTrustedCodexCliJsonStream(stream) || stream.sessionId !== bundle.sessionId
    || !/^[a-f0-9]{64}$/.test(input.fixtureDigest)
    || !/^[a-f0-9]{64}$/.test(input.protocolDigest)
    || !/^[a-f0-9]{64}$/.test(input.sourceDigest)) return null;
  const starts = stream.events.filter(event => event.phase === 'pre-action'
    && event.sourceEventId === input.appliedEventId && event.sessionId === bundle.sessionId);
  const results = stream.events.filter(event => event.phase === 'post-result'
    && event.relatedEventId === input.appliedEventId && event.sessionId === bundle.sessionId
    && event.outcome === 'succeeded' && event.exitStatus === 0);
  if (starts.length !== 1 || results.length !== 1) return null;
  const witnessRef = `deterministic-outcome:v1:${createHash('sha256').update(JSON.stringify([
    bundle.id, bundle.repositoryId, bundle.lessonId, bundle.lessonRevision, bundle.sessionId,
    bundle.contextRevision, bundle.operationSignature, input.appliedEventId, input.fixtureDigest,
    input.protocolDigest, input.sourceDigest, 'succeeded'
  ])).digest('hex')}`;
  const witness: DeterministicOutcomeWitness = Object.freeze({ bundleId: bundle.id,
    repositoryId: bundle.repositoryId, lessonId: bundle.lessonId, lessonRevision: bundle.lessonRevision,
    sessionId: bundle.sessionId, contextRevision: bundle.contextRevision,
    operationSignature: bundle.operationSignature, appliedEventId: input.appliedEventId,
    fixtureDigest: input.fixtureDigest, protocolDigest: input.protocolDigest,
    sourceDigest: input.sourceDigest,
    witnessRef, result: 'succeeded' });
  witnessedStreams.set(witness, stream);
  return witness;
}

export function isObservedDeterministicOutcomeForStream(value: unknown,
  stream: TrustedCodexCliJsonStream): value is DeterministicOutcomeWitness {
  return isTrustedCodexCliJsonStream(stream) && typeof value === 'object' && value !== null
    && witnessedStreams.get(value as DeterministicOutcomeWitness) === stream;
}
