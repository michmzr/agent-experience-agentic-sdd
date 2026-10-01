import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

import { AdvisoryConfigurationStore } from './configuration.js';
import { AdvisoryUsageStore, type AdviceScope } from './usage.js';
import { hasQualifiedCodexExecArguments, isVerifiedCodexChild } from '../host/codex-cli-launcher.js';

export interface ObservedCodexAdviceExposure {
  readonly bundleId: string;
  readonly threadId: string;
  readonly retrievalItemId: string;
  readonly echoItemId: string;
  readonly responseSha256: string;
  readonly witnessRef: string;
}

export interface HostAdviceExposureWitness extends ObservedCodexAdviceExposure, AdviceScope {
  readonly retrievalRef: string;
  readonly origin: 'host-challenge';
}

export interface HostAdviceExposureScope extends AdviceScope {
  readonly bundleId: string;
  readonly operationSignature: string;
  readonly retrievalRef: string;
  readonly dataDir: string;
  readonly invocation: string;
}

export class DeferredCodexAdviceExposureObserver {
  private scope: HostAdviceExposureScope | null = null;
  private observer: CodexAdviceExposureObserver | null = null;
  private invalid = false;

  constructor(readonly onThreadStarted: (threadId: string) => HostAdviceExposureScope) {}

  consume(value: unknown): void {
    if (this.invalid || !value || typeof value !== 'object') return;
    const event = value as { type?: unknown; thread_id?: unknown };
    if (event.type === 'thread.started') {
      if (this.observer || typeof event.thread_id !== 'string' || !event.thread_id
        || event.thread_id.length > 160) { this.invalid = true; return; }
      try {
        const scope = this.onThreadStarted(event.thread_id);
        if (!scope || typeof scope !== 'object' || scope.sessionId !== event.thread_id
          || typeof scope.bundleId !== 'string' || typeof scope.invocation !== 'string') {
          this.invalid = true; return;
        }
        this.scope = scope;
        this.observer = new CodexAdviceExposureObserver(scope.invocation, scope.bundleId);
        this.observer.consume(value);
      } catch { this.invalid = true; }
      return;
    }
    if (!this.observer) { this.invalid = true; return; }
    this.observer.consume(value);
  }

  deliveryReady(): { readonly scope: HostAdviceExposureScope; readonly observed: ObservedCodexAdviceExposure } | null {
    const observed = !this.invalid && this.observer?.deliveryReady();
    return observed && this.scope ? { scope: this.scope, observed } : null;
  }

  result(): { readonly scope: HostAdviceExposureScope; readonly observed: ObservedCodexAdviceExposure } | null {
    const observed = !this.invalid && this.observer?.result();
    return observed && this.scope ? { scope: this.scope, observed } : null;
  }
}

const directChildWitnesses = new WeakMap<HostAdviceExposureWitness, ChildProcess>();

/** Only attach to the same direct Codex child that executes the subsequent task. */
export function attachCodexAdviceExposure(child: ChildProcess,
  scopeOrSetup: HostAdviceExposureScope | ((threadId: string) => HostAdviceExposureScope)): Promise<HostAdviceExposureWitness | null> {
  const args = child.spawnargs;
  if (!isVerifiedCodexChild(child) || !hasQualifiedCodexExecArguments(args.slice(1))
    || args.some(arg => /aap-challenge:[a-f0-9]{32}/.test(arg)) || !child.stdout) {
    return Promise.resolve(null);
  }
  const observer = new DeferredCodexAdviceExposureObserver(typeof scopeOrSetup === 'function'
    ? scopeOrSetup : () => scopeOrSetup);
  const decoder = new TextDecoder();
  let pending = '';
  let totalBytes = 0;
  let invalid = false;
  let delivered: HostAdviceExposureWitness | null = null;
  let deliveryAttempted = false;
  const consume = (line: string): void => {
    if (!line || invalid) return;
    try {
      observer.consume(JSON.parse(line));
      const ready = observer.deliveryReady();
      if (ready && !deliveryAttempted) {
        deliveryAttempted = true;
        delivered = recordDelivery(ready.scope, ready.observed, child);
      }
    }
    catch { invalid = true; }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (invalid) return;
    totalBytes += chunk.length;
    if (totalBytes > 8 * 1024 * 1024) { invalid = true; return; }
    pending += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pending, 'utf8') > 128 * 1024) { invalid = true; return; }
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });
  return new Promise(resolve => child.once('close', (code, signal) => {
    if (pending) consume(pending + decoder.decode());
    const completed = !invalid && code === 0 && signal === null ? observer.result() : null;
    resolve(completed && delivered && completed.observed.witnessRef === delivered.witnessRef ? delivered : null);
  }));
}

function recordDelivery(scope: HostAdviceExposureScope, observed: ObservedCodexAdviceExposure,
  child: ChildProcess): HostAdviceExposureWitness | null {
    try {
      if (scope.sessionId !== observed.threadId || scope.bundleId !== observed.bundleId) return null;
      const path = join(scope.dataDir, 'advice.sqlite');
      const usage = new AdvisoryUsageStore(path);
      const bundle = usage.bundle(scope.bundleId);
      if (!bundle || bundle.repositoryId !== scope.repositoryId || bundle.lessonId !== scope.lessonId
        || bundle.lessonRevision !== scope.lessonRevision || bundle.sessionId !== scope.sessionId
        || bundle.contextRevision !== scope.contextRevision || bundle.operationSignature !== scope.operationSignature
        || !usage.facts(scope.bundleId).some(fact => fact.kind === 'retrieved'
          && fact.origin === 'cli-retrieval' && fact.witnessRef === scope.retrievalRef)
        || !new AdvisoryConfigurationStore(path).status(scope.repositoryId).enabled) return null;
      const witness: HostAdviceExposureWitness = Object.freeze({ ...observed, repositoryId: scope.repositoryId,
        lessonId: scope.lessonId, lessonRevision: scope.lessonRevision, sessionId: scope.sessionId,
        contextRevision: scope.contextRevision, retrievalRef: scope.retrievalRef, origin: 'host-challenge' });
      directChildWitnesses.set(witness, child);
      usage.recordObservedHostDelivery(witness, child);
      return witness;
    } catch { return null; }
}

export function isHostAdviceExposureWitnessForChild(witness: HostAdviceExposureWitness, child: ChildProcess): boolean {
  return directChildWitnesses.get(witness) === child;
}

export class CodexAdviceExposureObserver {
  private threadId: string | null = null;
  private retrievalItemId: string | null = null;
  private echoItemId: string | null = null;
  private marker: string | null = null;
  private responseSha256: string | null = null;
  private echoCompleted = false;
  private turnCompleted = false;
  private invalid = false;

  constructor(readonly invocation: string, readonly bundleId: string) {}

  consume(value: unknown): void {
    if (this.invalid || !value || typeof value !== 'object') return;
    const event = value as { type?: unknown; thread_id?: unknown; item?: unknown };
    if (event.type === 'thread.started') {
      if (this.threadId || typeof event.thread_id !== 'string' || event.thread_id.length > 160) this.invalid = true;
      else this.threadId = event.thread_id;
      return;
    }
    if (event.type === 'turn.completed') {
      if (!this.echoCompleted) this.invalid = true;
      else this.turnCompleted = true;
      return;
    }
    if (event.type !== 'item.started' && event.type !== 'item.completed') return;
    if (!event.item || typeof event.item !== 'object') return;
    const item = event.item as { type?: unknown; id?: unknown; command?: unknown; exit_code?: unknown;
      aggregated_output?: unknown; status?: unknown };
    if (item.type !== 'command_execution' || typeof item.id !== 'string' || typeof item.command !== 'string') return;
    if (event.type === 'item.started') {
      if (isExactInvocation(item.command, this.invocation) && !this.retrievalItemId && this.threadId && !this.marker) {
        this.retrievalItemId = item.id;
      } else if (this.marker && this.retrievalItemId && item.id !== this.retrievalItemId
        && !isExactInvocation(item.command, this.invocation) && item.command.includes(this.marker) && !this.echoItemId) {
        this.echoItemId = item.id;
      }
      return;
    }
    if (item.id === this.retrievalItemId && isExactInvocation(item.command, this.invocation) && !this.marker) {
      if (item.status !== 'completed' || item.exit_code !== 0 || typeof item.aggregated_output !== 'string'
        || Buffer.byteLength(item.aggregated_output, 'utf8') > 4096) { this.invalid = true; return; }
      let response: { status?: unknown; entries?: unknown; deliveryChallenge?: unknown };
      try { response = JSON.parse(item.aggregated_output) as typeof response; }
      catch { this.invalid = true; return; }
      if (response.status !== 'ready' || !Array.isArray(response.entries)
        || !response.entries.some(entry => entry && typeof entry === 'object'
          && (entry as { bundleId?: unknown }).bundleId === this.bundleId)
        || typeof response.deliveryChallenge !== 'string'
        || !/^aap-challenge:[a-f0-9]{32}$/.test(response.deliveryChallenge)) { this.invalid = true; return; }
      this.marker = response.deliveryChallenge;
      this.responseSha256 = sha256(item.aggregated_output);
      return;
    }
    if (item.id === this.echoItemId) {
      if (item.status !== 'completed' || item.exit_code !== 0 || !this.marker
        || !item.command.includes(this.marker)) this.invalid = true;
      else this.echoCompleted = true;
    }
  }

  result(): ObservedCodexAdviceExposure | null {
    return this.turnCompleted ? this.deliveryReady() : null;
  }

  deliveryReady(): ObservedCodexAdviceExposure | null {
    if (this.invalid || !this.echoCompleted || !this.threadId || !this.retrievalItemId || !this.echoItemId
      || !this.responseSha256) return null;
    const witnessRef = `codex-exposure:v1:${sha256(JSON.stringify([
      this.threadId, this.retrievalItemId, this.echoItemId, this.responseSha256, this.bundleId
    ]))}`;
    return Object.freeze({ bundleId: this.bundleId, threadId: this.threadId,
      retrievalItemId: this.retrievalItemId, echoItemId: this.echoItemId,
      responseSha256: this.responseSha256, witnessRef });
  }
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function isExactInvocation(command: string, invocation: string): boolean {
  return command === invocation || (!invocation.includes("'") && command === `/bin/zsh -lc '${invocation}'`);
}
