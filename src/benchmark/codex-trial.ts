import { createHash } from 'node:crypto';
import { CodexCliJsonCapture } from '../capture/adapters/codex-cli-json.js';

interface CommandFact { readonly id: string; readonly kind: 'package-manager-check' | 'package-manager-discovery' | 'advice-selection' | 'other'; readonly outcome: 'succeeded' | 'failed' | 'unknown' }
interface PendingCommand { readonly id: string; readonly text: string }

/** Projects one direct child Codex JSON stream. This does not qualify advice exposure or task success. */
export class CodexTrialProjection {
  private readonly capture: CodexCliJsonCapture;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly commands: CommandFact[] = [];
  private readonly redundant: string[] = [];
  private readonly verifiedSourceReads: string[] = [];
  private threadSeen = false;
  private turnComplete = false;
  private failed = false;
  private totalTokens: number | null = null;
  private lastDiscoveryDigest: string | undefined;
  private eventCount = 0;
  private finished = false;

  constructor(hostVersion: string, private readonly scenarioId: string,
    private readonly selectionInvocation?: string, private readonly expectedSourceBytes?: string) {
    this.capture = new CodexCliJsonCapture(hostVersion);
    if (scenarioId !== 'package-manager-fact') throw new TypeError('Actual benchmark scenario is not qualified.');
  }

  accept(value: unknown, observedAt: string): void {
    if (this.finished || ++this.eventCount > 2048) throw new TypeError('Codex trial stream is closed or exceeds event bound.');
    const event = record(value);
    const normalized = this.capture.accept(event, observedAt);
    if (event.type === 'thread.started') {
      if (this.threadSeen) throw new TypeError('Codex trial thread start is repeated.');
      this.threadSeen = true;
      return;
    }
    if (!this.threadSeen) throw new TypeError('Codex trial thread start is missing.');
    if (event.type === 'turn.failed' || event.type === 'error') {
      this.failed = true;
      return;
    }
    if (event.type === 'turn.completed') {
      if (this.turnComplete || this.failed) throw new TypeError('Codex trial terminal turn is invalid.');
      const usage = record(event.usage);
      const input = safeCount(usage.input_tokens);
      const cached = safeCount(usage.cached_input_tokens);
      const output = safeCount(usage.output_tokens);
      if (cached > input || (usage.reasoning_output_tokens !== undefined
        && safeCount(usage.reasoning_output_tokens) > output)) throw new TypeError('Codex trial token usage is invalid.');
      this.totalTokens = sum(input, output);
      this.turnComplete = true;
      return;
    }
    if (event.type !== 'item.started' && event.type !== 'item.completed') return;
    const item = record(event.item);
    if (item.type !== 'command_execution') {
      if (item.type === 'file_change') this.lastDiscoveryDigest = undefined;
      return;
    }
    if (this.turnComplete || typeof item.id !== 'string' || typeof item.command !== 'string') {
      throw new TypeError('Codex trial command item is invalid.');
    }
    if (event.type === 'item.started') {
      if (!normalized || normalized.phase !== 'pre-action' || this.pending.size > 0 || this.pending.has(item.id)) {
        throw new TypeError('Codex trial command start is invalid.');
      }
      if (!isDiscovery(item.command)) this.lastDiscoveryDigest = undefined;
      this.pending.set(item.id, { id: normalized.sourceEventId, text: item.command });
      return;
    }
    const started = this.pending.get(item.id);
    if (!started || !normalized || normalized.phase !== 'post-result' || started.text !== item.command
      || normalized.relatedEventId !== started.id) throw new TypeError('Codex trial command result is not linked.');
    if (normalized.outcome === undefined) throw new TypeError('Codex trial command outcome is unavailable.');
    this.pending.delete(item.id);
    this.commands.push(Object.freeze({ id: started.id, kind: isPackageManagerCheck(started.text) ? 'package-manager-check'
      : isDiscovery(started.text) ? 'package-manager-discovery'
        : this.selectionInvocation && isExactCommand(started.text, this.selectionInvocation) ? 'advice-selection' : 'other',
      outcome: normalized.outcome }));
    if (this.expectedSourceBytes !== undefined && isDiscovery(started.text)
      && normalized.outcome === 'succeeded' && item.aggregated_output === this.expectedSourceBytes
      && Buffer.byteLength(this.expectedSourceBytes, 'utf8') <= 4096) this.verifiedSourceReads.push(started.id);
    if (this.scenarioId === 'package-manager-fact' && isDiscovery(started.text)
      && normalized.outcome === 'succeeded' && typeof item.aggregated_output === 'string'
      && Buffer.byteLength(item.aggregated_output, 'utf8') <= 4096
      && isManifestOutput(item.aggregated_output)) {
      const current = createHash('sha256').update(item.aggregated_output).digest('hex');
      if (this.lastDiscoveryDigest === current) this.redundant.push(started.id);
      this.lastDiscoveryDigest = current;
    } else this.lastDiscoveryDigest = undefined;
  }

  finish(): { readonly status: 'unsupported' | 'observed'; readonly tokens: number | null;
    readonly operations: readonly CommandFact[]; readonly redundantOperationIds: readonly string[];
    readonly verifiedSourceReadOperationIds: readonly string[] } {
    if (this.finished) throw new TypeError('Codex trial stream is closed.');
    this.finished = true;
    const status = this.threadSeen && this.turnComplete && !this.failed && this.pending.size === 0
      ? 'observed' as const : 'unsupported' as const;
    return Object.freeze({ status, tokens: status === 'observed' ? this.totalTokens : null,
      operations: Object.freeze([...this.commands]), redundantOperationIds: Object.freeze([...this.redundant]),
      verifiedSourceReadOperationIds: Object.freeze([...this.verifiedSourceReads]) });
  }
}

function isDiscovery(text: string): boolean {
  return text === 'cat packages/app/package.json'
    || text === "/bin/zsh -lc 'cat packages/app/package.json'";
}

function isPackageManagerCheck(text: string): boolean {
  return text === 'pnpm --version' || text === "/bin/zsh -lc 'pnpm --version'";
}

function isExactCommand(command: string, expected: string): boolean {
  return command === expected || (!expected.includes("'") && command === `/bin/zsh -lc '${expected}'`);
}

function isManifestOutput(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as { packageManager?: unknown }).packageManager === 'string';
  } catch { return false; }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Codex trial event is invalid.');
  return value as Readonly<Record<string, unknown>>;
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('Codex trial token usage is invalid.');
  return value as number;
}

function sum(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new TypeError('Codex trial token usage exceeds integer bound.');
  return value;
}
