import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';

import type { NormalizedCaptureEvent } from './contracts.js';
import { observeVerifiedCodexCliJsonChild, type TrustedCodexCliJsonStream } from './adapters/codex-cli-json.js';
import { startCaptureDrain } from './drain-scheduler.js';
import type { PassiveCaptureRecord } from './passive-service.js';
import { CaptureSpool } from './spool.js';
import { isVerifiedCodexChild } from '../host/codex-cli-launcher.js';
import { runningBuild, type BuildManifest } from '../installation/build-manifest.js';
import { assertWriterCompatible } from '../installation/writer-contract.js';
import { resolveRepository } from '../repository/local-repository.js';
import type { RepositoryId, SessionId } from '../domain/types.js';

export interface DirectCliPassiveOptions {
  readonly databasePath: string;
  readonly repositoryId: RepositoryId;
  readonly workingDirectory: string;
  readonly now?: () => string;
  readonly scheduleDrain?: (dataDirectory: string) => void;
}

export interface DirectCliPassiveResult {
  readonly source: 'cli-json-item';
  readonly stream: TrustedCodexCliJsonStream;
  readonly status: 'captured' | 'degraded';
  readonly admitted: number;
}

const directResults = new WeakMap<DirectCliPassiveResult, ChildProcess>();

export function isDirectCliPassiveResultForChild(result: DirectCliPassiveResult, child: ChildProcess): boolean {
  return directResults.get(result) === child;
}

/** Storage sink. Its public methods do not confer host provenance; only attach does. */
class DirectCliPassiveAdmission {
  private readonly dataDirectory: string;
  private readonly scheduleDrain: (dataDirectory: string) => void;
  private readonly repositoryId: RepositoryId;
  private readonly build: BuildManifest | undefined;
  private spool: CaptureSpool | undefined;
  private sessionId: string | undefined;
  private closed = false;
  private failed = false;
  private count = 0;
  private readonly pendingStarts = new Set<string>();
  private completedPairs = 0;
  private ended = false;

  constructor(options: DirectCliPassiveOptions) {
    this.dataDirectory = dirname(options.databasePath);
    this.scheduleDrain = options.scheduleDrain ?? startCaptureDrain;
    this.repositoryId = options.repositoryId;
    try {
      if (resolveRepository(options.workingDirectory)?.id !== options.repositoryId) throw new TypeError('Repository scope mismatch.');
      this.build = runningBuild();
      assertWriterCompatible([join(this.dataDirectory, 'capture-spool.sqlite')], this.build);
      this.spool = new CaptureSpool(join(this.dataDirectory, 'capture-spool.sqlite'));
    } catch { this.failed = true; }
  }

  get status(): 'captured' | 'capturing' | 'degraded' {
    return this.failed || this.ended && (this.count < 4 || this.completedPairs === 0 || this.pendingStarts.size !== 0) ? 'degraded'
      : this.ended ? 'captured' : 'capturing';
  }
  get admitted(): number { return this.count; }

  threadStarted(id: string, observedAt: string): void {
    if (this.closed || this.failed || this.sessionId !== undefined || !validId(id)) { this.failed = true; return; }
    this.sessionId = id;
    this.admit({ kind: 'session-start', session: { id: id as SessionId, source: 'codex',
      repositoryId: this.repositoryId, startedAt: observedAt } }, `cli-json-item:${id}`, observedAt);
  }

  event(event: NormalizedCaptureEvent): void {
    if (this.closed || this.failed || !this.sessionId || event.sessionId !== this.sessionId || event.source !== 'codex'
      || !/^cli-[0-9a-f]{64}-(start|result)$/.test(event.sourceEventId)
      || (event.phase === 'pre-action' && !event.sourceEventId.endsWith('-start'))
      || (event.phase === 'post-result' && (!event.sourceEventId.endsWith('-result')
        || event.relatedEventId !== event.sourceEventId.replace(/-result$/, '-start')))) {
      this.failed = true; return;
    }
    if (event.phase === 'pre-action' && this.pendingStarts.has(event.sourceEventId)) { this.failed = true; return; }
    if (event.phase === 'post-result' && !this.pendingStarts.has(event.relatedEventId ?? '')) {
      this.failed = true; return;
    }
    const before = this.count;
    this.admit({ kind: 'technical', event }, `cli-json-item:${event.sourceEventId}`, event.occurredAt);
    if (this.count > before) {
      if (event.phase === 'pre-action') this.pendingStarts.add(event.sourceEventId);
      else if (event.phase === 'post-result') {
        this.pendingStarts.delete(event.relatedEventId!);
        this.completedPairs++;
      }
    }
  }

  sessionEnded(id: string, observedAt: string): void {
    if (this.closed || this.failed || id !== this.sessionId) { this.failed = true; return; }
    this.admit({ kind: 'session-end', source: 'codex', sessionId: id as SessionId,
      endedAt: observedAt }, `cli-json-item:${id}:end`, observedAt);
    this.ended = true;
  }

  close(): void {
    this.closed = true;
    try { this.spool?.close(); } catch { this.failed = true; }
    this.spool = undefined;
  }

  private admit(record: PassiveCaptureRecord, correlationInput: string, receivedAt: string): void {
    if (!this.spool) { this.failed = true; return; }
    try {
      const admittedRecord = this.build === undefined ? record : { ...record, buildProvenance: {
        buildId: this.build.buildId, writer: this.build.capabilities.writer,
        captureSchema: this.build.capabilities.captureSchema, resultSchema: this.build.capabilities.resultSchema
      } };
      const result = this.spool.admitWithReceipt(admittedRecord, {
        source: 'codex', receivedAt, correlationInput, repositoryId: this.repositoryId
      });
      if (result.status === 'admitted') {
        this.count++;
        try { this.scheduleDrain(this.dataDirectory); } catch { /* Durable admission is independent of the wake-up. */ }
      }
    } catch { this.failed = true; }
  }
}

/** Attach before stdout is consumed. Storage failures leave the Codex child running. */
export function attachVerifiedCodexPassiveCapture(child: ChildProcess,
  options: DirectCliPassiveOptions): Promise<DirectCliPassiveResult> {
  if (!isVerifiedCodexChild(child)) throw new TypeError('Codex CLI child is not verified.');
  const admission = new DirectCliPassiveAdmission(options);
  let observed: Promise<TrustedCodexCliJsonStream>;
  try {
    observed = observeVerifiedCodexCliJsonChild(child, {
      onThreadStarted: (id, at) => admission.threadStarted(id, at),
      onEvent: event => admission.event(event)
    });
  } catch (error) { admission.close(); throw error; }
  return observed.then(stream => {
    admission.sessionEnded(stream.sessionId, (options.now ?? (() => new Date().toISOString()))());
    admission.close();
    const result: DirectCliPassiveResult = Object.freeze({ source: 'cli-json-item' as const, stream,
      status: admission.status === 'captured' ? 'captured' as const : 'degraded' as const,
      admitted: admission.admitted });
    directResults.set(result, child);
    return result;
  }, error => { admission.close(); throw error; });
}

function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/.test(value); }

/** Synthetic storage fixture. It never creates a direct-child provenance witness. */
export function createSyntheticDirectCliPassiveAdmission(options: DirectCliPassiveOptions) {
  const admission = new DirectCliPassiveAdmission(options);
  return Object.freeze({ source: 'synthetic-fixture' as const,
    threadStarted: (id: string, at: string) => admission.threadStarted(id, at),
    event: (event: NormalizedCaptureEvent) => admission.event(event),
    sessionEnded: (id: string, at: string) => admission.sessionEnded(id, at),
    close: () => admission.close(),
    get status() { return admission.status; },
    get admitted() { return admission.admitted; }
  });
}
