import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { TextDecoder } from 'node:util';

import type { NormalizedCaptureEvent } from '../contracts.js';
import { normalizeMappedCapture } from '../normalization.js';
import { isVerifiedCodexChild } from '../../host/codex-cli-launcher.js';

const hostId = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/;
const maxPending = 1024;
const maxStreamBytes = 8 * 1024 * 1024;
const maxLineBytes = 128 * 1024;
const maxStreamLines = 4096;

export interface TrustedCodexCliJsonStream {
  readonly sessionId: string;
  readonly events: readonly NormalizedCaptureEvent[];
  readonly childExitCode: 0;
}

const trustedStreams = new WeakSet<TrustedCodexCliJsonStream>();

/** Callbacks run synchronously in direct-child event order, before the next JSONL item. */
export interface VerifiedCodexCliJsonObserver {
  readonly onThreadStarted?: (threadId: string, observedAt: string) => void;
  readonly onEvent?: (event: NormalizedCaptureEvent) => void;
}

export function isTrustedCodexCliJsonStream(value: unknown): value is TrustedCodexCliJsonStream {
  return typeof value === 'object' && value !== null && trustedStreams.has(value as TrustedCodexCliJsonStream);
}

/** Consume only the stdout of a child launched by the pinned Codex launcher. */
export function observeVerifiedCodexCliJsonChild(child: ChildProcess,
  observer: VerifiedCodexCliJsonObserver = {}): Promise<TrustedCodexCliJsonStream> {
  if (!isVerifiedCodexChild(child) || !child.stdout || child.exitCode !== null || child.signalCode !== null) {
    throw new TypeError('Codex CLI child is not verified or was already completed.');
  }
  const capture = new CodexCliJsonCapture(codexCliJsonEvidenceCapability.observedVersion);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const events: NormalizedCaptureEvent[] = [];
  let pending = '';
  let bytes = 0;
  let lines = 0;
  let invalid = false;
  const consume = (line: string): void => {
    if (!line || invalid) return;
    if (++lines > maxStreamLines) { invalid = true; return; }
    try {
      const observedAt = new Date().toISOString();
      const previousThread = capture.sessionId;
      const event = capture.accept(JSON.parse(line), observedAt);
      if (!previousThread && capture.sessionId) observer.onThreadStarted?.(capture.sessionId, observedAt);
      if (event) { events.push(event); observer.onEvent?.(event); }
    } catch { invalid = true; }
  };
  child.stdout.on('data', (chunk: Buffer | string) => {
    if (invalid) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxStreamBytes) { invalid = true; return; }
    try { pending += decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, { stream: true }); }
    catch { invalid = true; return; }
    if (Buffer.byteLength(pending, 'utf8') > maxLineBytes) { invalid = true; return; }
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });
  return new Promise((resolve, reject) => {
    child.once('error', () => { invalid = true; reject(new TypeError('Verified Codex CLI child failed.')); });
    child.once('close', (code, signal) => {
      try {
        if (pending && !invalid) consume(pending + decoder.decode());
        if (invalid || code !== 0 || signal !== null || capture.sessionId === undefined) {
          reject(new TypeError('Verified Codex CLI stream is incomplete or invalid.'));
          return;
        }
        capture.assertComplete();
        const stream: TrustedCodexCliJsonStream = Object.freeze({ sessionId: capture.sessionId,
          events: Object.freeze(events), childExitCode: 0 });
        trustedStreams.add(stream);
        resolve(stream);
      } catch { reject(new TypeError('Verified Codex CLI stream is invalid.')); }
    });
  });
}

export function codexCliJsonSourceEventId(threadId: string, itemId: string, phase: 'start' | 'result'): string {
  const key = createHash('sha256').update('ael:codex-exec-json:v1\0').update(identifier(threadId))
    .update('\0').update(identifier(itemId)).digest('hex');
  return `cli-${key}-${phase}`;
}

/** Codex 0.157.1 `exec --json` command items, independent of project hooks. */
export const codexCliJsonEvidenceCapability = Object.freeze({
  source: 'codex-exec-json' as const,
  observedVersion: '0.157.1' as const,
  processExit: 'available' as const,
  asyncRelation: 'not-qualified' as const
});

export class CodexCliJsonCapture {
  private threadId: string | undefined;
  private readonly pending = new Set<string>();

  get sessionId(): string | undefined { return this.threadId; }

  assertComplete(): void {
    if (this.threadId === undefined || this.pending.size !== 0) {
      throw new TypeError('Codex CLI stream has pending commands or no thread.');
    }
  }

  constructor(hostVersion: string) {
    if (hostVersion !== codexCliJsonEvidenceCapability.observedVersion) {
      throw new TypeError('Codex CLI JSON host version is not qualified.');
    }
  }

  accept(value: unknown, observedAt: string): NormalizedCaptureEvent | undefined {
    const event = record(value);
    canonicalTime(observedAt);
    if (event.type === 'thread.started') {
      const id = identifier(event.thread_id);
      if (this.threadId !== undefined && this.threadId !== id) throw new TypeError('Codex CLI thread identity changed.');
      this.threadId = id;
      return undefined;
    }
    if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined;
    const item = record(event.item);
    if (item.type !== 'command_execution') return undefined;
    if (this.threadId === undefined) throw new TypeError('Codex CLI thread start is missing.');
    const id = identifier(item.id);
    const sourceEventId = codexCliJsonSourceEventId(this.threadId, id, event.type === 'item.started' ? 'start' : 'result');
    if (event.type === 'item.started') {
      if (item.status !== 'in_progress') throw new TypeError('Codex CLI command start status is invalid.');
      if (this.pending.has(id)) return undefined;
      if (this.pending.size >= maxPending) throw new RangeError('Codex CLI pending operation limit exceeded.');
      this.pending.add(id);
      return normalizeMappedCapture({ source: 'codex', sourceEventId, sessionId: this.threadId,
        phase: 'pre-action', occurredAt: observedAt, tool: 'shell', action: 'command', summary: 'Codex CLI command started.' });
    }
    if (!this.pending.has(id)) return undefined;
    const status = item.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'declined') {
      throw new TypeError('Codex CLI command terminal status is invalid.');
    }
    const exitStatus = item.exit_code;
    if (exitStatus !== null && exitStatus !== undefined && !Number.isSafeInteger(exitStatus)) {
      throw new TypeError('Codex CLI exit code is invalid.');
    }
    this.pending.delete(id);
    const outcome = typeof exitStatus !== 'number' ? 'unknown'
      : status === 'completed' && exitStatus === 0 ? 'succeeded'
        : status === 'failed' && exitStatus !== 0 ? 'failed' : 'unknown';
    return normalizeMappedCapture({ source: 'codex', sourceEventId, sessionId: this.threadId,
      phase: 'post-result', occurredAt: observedAt, tool: 'shell', action: 'command', summary: 'Codex CLI command completed.',
      outcome, ...(typeof exitStatus === 'number' ? { exitStatus } : {}),
      relatedEventId: codexCliJsonSourceEventId(this.threadId, id, 'start') });
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Codex CLI event must be an object.');
  return value as Readonly<Record<string, unknown>>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !hostId.test(value)) throw new TypeError('Codex CLI host identity is invalid.');
  return value;
}

function canonicalTime(value: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('Codex CLI observation timestamp is invalid.');
  }
}
