import { closeSync, openSync, readSync } from 'node:fs';
import type { AgentSource } from '../domain/types.js';
import { containsCredentialMaterial } from '../privacy/structured-arguments.js';
import { MAX_TYPED_IMPORT_BYTES, MAX_TYPED_IMPORT_RECORDS, type AnnotationKind, type AnnotationOrigin,
  type AnnotationState, type TypedAnnotationArtifact, type TypedAnnotationRecord } from './contracts.js';
import { ImportedTypedEvidenceRepository } from './repository.js';

const identifier = /^[A-Za-z0-9._:@/-]{1,256}$/;
const sources = new Set<AgentSource>(['codex', 'cursor', 'claude-code']);
const states = new Set<AnnotationState>(['observed', 'succeeded', 'failed', 'closed']);
const reasons = new Set(['failure', 'instruction', 'superseded', 'verification']);
const kinds = new Set<AnnotationKind>(['task-verification', 'agent-claim', 'user-instruction', 'task-transition']);

export function importTypedEvidence(databasePath: string, repositoryId: string, inputPath: string) {
  const artifact = parseTypedAnnotationArtifact(readBoundedArtifact(inputPath));
  if (artifact.repositoryId !== repositoryId) throw new TypeError('Artifact repository scope conflicts with the selected repository.');
  const repository = new ImportedTypedEvidenceRepository(databasePath);
  try { return repository.save(artifact); }
  finally { repository.close(); }
}

function readBoundedArtifact(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(MAX_TYPED_IMPORT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_TYPED_IMPORT_BYTES) throw new RangeError('Annotation artifact exceeds 256 KiB.');
    return bytes.toString('utf8', 0, length);
  } finally { closeSync(fd); }
}

export function parseTypedAnnotationArtifact(input: string): TypedAnnotationArtifact {
  if (Buffer.byteLength(input, 'utf8') > MAX_TYPED_IMPORT_BYTES) throw new RangeError('Annotation artifact exceeds 256 KiB.');
  const value = JSON.parse(input) as unknown;
  const artifact = object(value, ['version', 'producer', 'repositoryId', 'sessionId', 'contextRevision', 'records']);
  if (artifact.version !== 1 || !Array.isArray(artifact.records) || artifact.records.length < 1 || artifact.records.length > MAX_TYPED_IMPORT_RECORDS) {
    throw new TypeError('Annotation artifact version or record count is invalid.');
  }
  const producer = object(artifact.producer, ['kind', 'version', 'namespace']);
  if (producer.kind !== 'local-annotation') throw new TypeError('Annotation producer is invalid.');
  const producerVersion = key(producer.version);
  const namespace = key(producer.namespace);
  const repositoryId = key(artifact.repositoryId);
  const sessionId = key(artifact.sessionId);
  const contextRevision = key(artifact.contextRevision);
  const seen = new Set<string>();
  const records = artifact.records.map((raw): TypedAnnotationRecord => {
    const record = object(raw, ['id', 'origin', 'kind', 'state', 'decisionKey', 'scopeKey', 'reasonClass', 'operation']);
    const id = key(record.id);
    if (seen.has(id)) throw new TypeError('Annotation artifact contains duplicate evidence identity.');
    seen.add(id);
    const origin = record.origin as AnnotationOrigin;
    const kind = record.kind as AnnotationKind;
    const state = record.state as AnnotationState;
    if (!kinds.has(kind) || !states.has(state) || !reasons.has(record.reasonClass as string)
      || (origin !== 'user-declared' && origin !== 'agent-claimed')
      || (origin === 'agent-claimed' && kind !== 'agent-claim')
      || (origin === 'user-declared' && kind === 'agent-claim')) {
      throw new TypeError('Annotation origin, kind or state is invalid.');
    }
    const operation = object(record.operation, ['source', 'sourceEventId']);
    if (!sources.has(operation.source as AgentSource)) throw new TypeError('Annotation operation source is invalid.');
    return Object.freeze({ id, origin, kind, state, decisionKey: key(record.decisionKey), scopeKey: key(record.scopeKey),
      reasonClass: record.reasonClass as TypedAnnotationRecord['reasonClass'],
      operation: Object.freeze({ source: operation.source as AgentSource, sourceEventId: key(operation.sourceEventId) }) });
  });
  return Object.freeze({ version: 1, producer: Object.freeze({ kind: 'local-annotation', version: producerVersion, namespace }),
    repositoryId, sessionId, contextRevision, records: Object.freeze(records) });
}

export function readIndexedAnnotation(input: {
  readonly payloadJson: string; readonly producerNamespace: string; readonly repositoryId: string;
  readonly sessionId: string; readonly evidenceId: string;
}): { readonly record: TypedAnnotationRecord; readonly contextRevision: string } {
  const payload = JSON.parse(input.payloadJson) as Record<string, unknown>;
  const { producerKind, producerVersion, contextRevision, ...record } = payload;
  const artifact = parseTypedAnnotationArtifact(JSON.stringify({ version: 1,
    producer: { kind: producerKind, version: producerVersion, namespace: input.producerNamespace },
    repositoryId: input.repositoryId, sessionId: input.sessionId, contextRevision, records: [record] }));
  if (artifact.records[0]!.id !== input.evidenceId) throw new TypeError('Indexed annotation identity conflicts with its payload.');
  return Object.freeze({ record: artifact.records[0]!, contextRevision: artifact.contextRevision });
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Annotation object is invalid.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError('Annotation schema contains unknown or missing fields.');
  }
  return record;
}

function key(value: unknown): string {
  if (typeof value !== 'string' || !identifier.test(value) || containsCredentialMaterial(value)) {
    throw new TypeError('Annotation identity or linkage key is invalid.');
  }
  return value;
}
