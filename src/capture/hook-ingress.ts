import { adaptCursorPassiveHook, adaptPassiveHook } from './hook-adapters/index.js';
import { MAX_HOOK_INPUT_BYTES, type PassiveHookSource } from './hook-adapters/contracts.js';
import { TechnicalSignatureRejection } from './hook-adapters/technical-signature.js';
import { type DiagnosticScope, resolveDiagnosticScope } from './diagnostic-scope.js';
import type { CursorCaptureDiagnosticCategory } from './hook-diagnostics.js';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RepositoryId, SessionId } from '../domain/types.js';
import type { PassiveCaptureRecord } from './passive-service.js';
import { CaptureDiagnosticStore } from '../storage/capture-diagnostic-store.js';
import { resolveRepository } from '../repository/local-repository.js';
import { dirname, join } from 'node:path';
import { CaptureSpool, CaptureSpoolCapacityError } from './spool.js';


export interface HookIngressOptions {
  readonly source: PassiveHookSource;
  readonly input: string;
  readonly databasePath: string;
  readonly now: () => string;
  readonly workingDirectory?: string;
  readonly repositoryId?: RepositoryId;
  readonly diagnosticStoreFactory?: (databasePath: string) => CaptureDiagnosticStore;
  readonly scheduleDrain?: (dataDirectory: string) => void;
}

export type HookIngressResult =
  | { readonly status: 'captured' | 'duplicate' | 'ignored' }
  | { readonly status: 'degraded'; readonly code: 'INVALID_INPUT' | 'PRIVATE_INPUT' | 'PERSISTENCE_FAILED' };

export function ingestPassiveHook(options: HookIngressOptions): HookIngressResult {
  let scope: DiagnosticScope | undefined;
  let spool: CaptureSpool | undefined;
  try {
    if (!isPassiveHookSource(options.source)) return degraded('INVALID_INPUT');
    if (typeof options.input !== 'string' || Buffer.byteLength(options.input, 'utf8') > MAX_HOOK_INPUT_BYTES) {
      return degraded('INVALID_INPUT');
    }

    spool = new CaptureSpool(join(dirname(options.databasePath), 'capture-spool.sqlite'));
    let payload: unknown;
    try {
      payload = JSON.parse(options.input) as unknown;
    } catch {
      spool.recordReceipt({ source: options.source, receivedAt: options.now(), disposition: 'malformed-envelope', correlationInput: options.input });
      return degraded('INVALID_INPUT');
    }

    const workingDirectory = options.workingDirectory ?? process.cwd();
    scope = options.source === 'cursor'
      ? resolveDiagnosticScope(workingDirectory, { dataDirectory: dirname(options.databasePath) })
      : undefined;
    const repository = resolveRepository(workingDirectory);
    const repositoryId = options.repositoryId ?? repository?.id as RepositoryId | undefined;
    const record = options.source === 'cursor'
      ? cursorRecord(options, payload, repositoryId, scope!)
      : adaptPassiveHook(options.source, payload, options.now(), repositoryId);
    if (record === undefined) {
      spool.recordReceipt({ source: options.source, receivedAt: options.now(), disposition: 'unsupported-tool', correlationInput: options.input });
      return { status: 'ignored' };
    }

    const result = spool.admit(record, options.now());
    spool.recordReceipt({
      source: options.source,
      receivedAt: options.now(),
      disposition: result.status === 'admitted' ? 'accepted' : 'duplicate',
      correlationInput: options.input
    });
    if (result.status === 'admitted') {
      try { (options.scheduleDrain ?? startDrain)(dirname(options.databasePath)); }
      catch { /* Durable admission does not depend on best-effort worker startup. */ }
    }
    return { status: result.status === 'admitted' ? 'captured' : 'duplicate' };
  } catch (error) {
    const code = inputErrorCode(error);
    try {
      spool?.recordReceipt({
        source: options.source,
        receivedAt: options.now(),
        disposition: code === 'PRIVATE_INPUT' ? 'privacy-redaction' : code === 'PERSISTENCE_FAILED' ? 'admission-failure' : 'unsafe-normalization',
        correlationInput: options.input
      });
    } catch {
      try { spool?.markReceiptAccountingUnavailable(); } catch { /* Accounting storage may itself be unavailable. */ }
    }
    if (code === 'PERSISTENCE_FAILED' && scope !== undefined) incrementDiagnostic(options, scope, 'persistence-failure');
    return degraded(code);
  } finally {
    try {
      spool?.close();
    } catch {
      // Hook delivery is fail-open, including cleanup failures.
    }
  }
}

function cursorRecord(
  options: HookIngressOptions,
  payload: unknown,
  repositoryId: RepositoryId | undefined,
  scope: DiagnosticScope
) {
  const adaptation = adaptCursorPassiveHook(payload, options.now(), repositoryId);
  if (adaptation.state === 'accepted') return anonymizeCursorSession(adaptation.record);
  if (adaptation.state === 'ignored') return undefined;
  incrementDiagnostic(options, scope, adaptation.category);
  if (adaptation.category === 'unsupported-tool') return undefined;
  throw new HookIngressDiagnosticError(adaptation.ingressCode ?? 'INVALID_INPUT');
}

function anonymizeCursorSession(record: PassiveCaptureRecord): PassiveCaptureRecord {
  switch (record.kind) {
    case 'session-start':
      return Object.freeze({ kind: 'session-start', session: Object.freeze({ ...record.session, id: anonymousCursorSessionId(record.session.id) }) });
    case 'session-end':
      return Object.freeze({ ...record, sessionId: anonymousCursorSessionId(record.sessionId) });
    case 'technical':
      return Object.freeze({
        ...record,
        event: Object.freeze({ ...record.event, sessionId: anonymousCursorSessionId(record.event.sessionId) })
      });
  }
}

function anonymousCursorSessionId(sessionId: SessionId): SessionId {
  return createHash('sha256').update('ael:cursor-passive-session:v1\0').update(sessionId).digest('hex') as SessionId;
}

function incrementDiagnostic(
  options: HookIngressOptions,
  scope: DiagnosticScope,
  category: CursorCaptureDiagnosticCategory
): void {
  let store: CaptureDiagnosticStore | undefined;
  try {
    store = options.diagnosticStoreFactory?.(join(dirname(options.databasePath), 'capture-diagnostics.sqlite'))
      ?? new CaptureDiagnosticStore(join(dirname(options.databasePath), 'capture-diagnostics.sqlite'));
    store.increment({ source: 'cursor', scope }, category);
  } catch {
    // Diagnostic persistence is strictly best effort for passive hooks.
  } finally {
    try {
      store?.close();
    } catch {
      // Cleanup failures cannot change passive hook behavior.
    }
  }
}

function isPassiveHookSource(value: unknown): value is PassiveHookSource {
  return value === 'codex' || value === 'cursor';
}

function inputErrorCode(error: unknown): 'INVALID_INPUT' | 'PRIVATE_INPUT' | 'PERSISTENCE_FAILED' {
  if (error instanceof CaptureSpoolCapacityError) return 'PERSISTENCE_FAILED';
  if (error instanceof HookIngressDiagnosticError) return error.code;
  if (error instanceof TechnicalSignatureRejection) return error.code === 'PRIVATE_INPUT' ? 'PRIVATE_INPUT' : 'INVALID_INPUT';
  if (error instanceof Error && /private|credential/i.test(error.message)) return 'PRIVATE_INPUT';
  if (error instanceof Error && /sqlite|database|directory|file|path|permission|busy|locked|constraint/i.test(error.message)) {
    return 'PERSISTENCE_FAILED';
  }
  return 'INVALID_INPUT';
}

class HookIngressDiagnosticError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'PRIVATE_INPUT') {
    super(code);
  }
}

function degraded(code: 'INVALID_INPUT' | 'PRIVATE_INPUT' | 'PERSISTENCE_FAILED'): HookIngressResult {
  return { status: 'degraded', code };
}

function startDrain(dataDirectory: string): void {
  try {
    const entrypoint = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    spawn(process.execPath, [entrypoint, 'capture', 'drain', '--data-dir', dataDirectory], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Admission is durable even if the best-effort worker launch fails.
  }
}
