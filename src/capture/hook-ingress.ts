import { adaptCursorPassiveHook, adaptPassiveHook } from './hook-adapters/index.js';
import { MAX_HOOK_INPUT_BYTES, type PassiveHookSource } from './hook-adapters/contracts.js';
import { type DiagnosticScope, resolveDiagnosticScope } from './diagnostic-scope.js';
import type { CursorCaptureDiagnosticCategory } from './hook-diagnostics.js';
import { createPassiveCaptureService } from './passive-service.js';
import { CaptureDiagnosticStore } from '../storage/capture-diagnostic-store.js';
import { ExperienceStore } from '../storage/experience-store.js';
import { resolveRepository } from '../repository/local-repository.js';
import { dirname, join } from 'node:path';

const HOOK_DATABASE_TIMEOUT_MS = 250;

export interface HookIngressOptions {
  readonly source: PassiveHookSource;
  readonly input: string;
  readonly databasePath: string;
  readonly now: () => string;
  readonly workingDirectory?: string;
  readonly diagnosticStoreFactory?: (databasePath: string) => CaptureDiagnosticStore;
}

export type HookIngressResult =
  | { readonly status: 'captured' | 'duplicate' | 'ignored' }
  | { readonly status: 'degraded'; readonly code: 'INVALID_INPUT' | 'PRIVATE_INPUT' | 'PERSISTENCE_FAILED' };

export function ingestPassiveHook(options: HookIngressOptions): HookIngressResult {
  let store: ExperienceStore | undefined;
  try {
    if (!isPassiveHookSource(options.source)) return degraded('INVALID_INPUT');
    if (typeof options.input !== 'string' || Buffer.byteLength(options.input, 'utf8') > MAX_HOOK_INPUT_BYTES) {
      return degraded('INVALID_INPUT');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(options.input) as unknown;
    } catch {
      return degraded('INVALID_INPUT');
    }

    const workingDirectory = options.workingDirectory ?? process.cwd();
    const scope = options.source === 'cursor' ? resolveDiagnosticScope(workingDirectory) : undefined;
    const repository = resolveRepository(workingDirectory);
    const record = options.source === 'cursor'
      ? cursorRecord(options, payload, repository?.id as never, scope!)
      : adaptPassiveHook(options.source, payload, options.now(), repository?.id as never);
    if (record === undefined) return { status: 'ignored' };

    store = new ExperienceStore(options.databasePath, { timeoutMs: HOOK_DATABASE_TIMEOUT_MS });
    const service = createPassiveCaptureService({ store });
    const result = service.capture(record);
    if (repository !== undefined && result.status !== 'degraded') {
      store.registerRepository({ id: repository.id, root: repository.root, observedAt: options.now() });
    }
    if (result.status === 'degraded') {
      if (scope !== undefined) incrementDiagnostic(options, scope, 'persistence-failure');
      return degraded('PERSISTENCE_FAILED');
    }
    return result;
  } catch (error) {
    return degraded(inputErrorCode(error));
  } finally {
    try {
      store?.close();
    } catch {
      // Hook delivery is fail-open, including cleanup failures.
    }
  }
}

function cursorRecord(
  options: HookIngressOptions,
  payload: unknown,
  repositoryId: never,
  scope: DiagnosticScope
) {
  const adaptation = adaptCursorPassiveHook(payload, options.now(), repositoryId);
  if (adaptation.state === 'accepted') return adaptation.record;
  if (adaptation.state === 'ignored') return undefined;
  incrementDiagnostic(options, scope, adaptation.category);
  if (adaptation.category === 'unsupported-tool') return undefined;
  throw new HookIngressDiagnosticError(adaptation.ingressCode ?? 'INVALID_INPUT');
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
  if (error instanceof HookIngressDiagnosticError) return error.code;
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
