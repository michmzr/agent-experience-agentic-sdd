import { adaptPassiveHook } from './hook-adapters/index.js';
import { MAX_HOOK_INPUT_BYTES, type PassiveHookSource } from './hook-adapters/contracts.js';
import { createPassiveCaptureService } from './passive-service.js';
import { ExperienceStore } from '../storage/experience-store.js';
import { resolveRepository } from '../repository/local-repository.js';

const HOOK_DATABASE_TIMEOUT_MS = 250;

export interface HookIngressOptions {
  readonly source: PassiveHookSource;
  readonly input: string;
  readonly databasePath: string;
  readonly now: () => string;
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

    const repository = resolveRepository(process.cwd());
    const record = adaptPassiveHook(options.source, payload, options.now(), repository?.id as never);
    if (record === undefined) return { status: 'ignored' };

    store = new ExperienceStore(options.databasePath, { timeoutMs: HOOK_DATABASE_TIMEOUT_MS });
    const service = createPassiveCaptureService({ store });
    const result = service.capture(record);
    if (repository !== undefined && result.status !== 'degraded') {
      store.registerRepository({ id: repository.id, root: repository.root, observedAt: options.now() });
    }
    return result.status === 'degraded'
      ? degraded('PERSISTENCE_FAILED')
      : result;
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

function isPassiveHookSource(value: unknown): value is PassiveHookSource {
  return value === 'codex' || value === 'cursor';
}

function inputErrorCode(error: unknown): 'INVALID_INPUT' | 'PRIVATE_INPUT' | 'PERSISTENCE_FAILED' {
  if (error instanceof Error && /private|credential/i.test(error.message)) return 'PRIVATE_INPUT';
  if (error instanceof Error && /sqlite|database|directory|file|path|permission|busy|locked|constraint/i.test(error.message)) {
    return 'PERSISTENCE_FAILED';
  }
  return 'INVALID_INPUT';
}

function degraded(code: 'INVALID_INPUT' | 'PRIVATE_INPUT' | 'PERSISTENCE_FAILED'): HookIngressResult {
  return { status: 'degraded', code };
}
