import { CodexCliJsonCapture } from '../capture/adapters/codex-cli-json.js';
import type { NormalizedCaptureEvent } from '../capture/contracts.js';
import { projectCrossSessionCommandCandidate, projectCrossSessionCommandCandidateV2, type CrossSessionCommandFact,
  type CrossSessionFixture } from './cross-session-scenario.js';

interface Pending { readonly command: string; readonly operationId: string }
export interface CrossSessionCandidate {
  readonly status: 'observed' | 'unsupported'; readonly sessionId: string | null;
  readonly facts: readonly CrossSessionCommandFact[]; readonly tokens: number | null
}

/** In-memory command projection. Its output is a candidate until matched with a trusted direct-child stream. */
export class CrossSessionCommandObserver {
  private readonly capture = new CodexCliJsonCapture('0.157.1');
  private readonly pending = new Map<string, Pending>();
  private readonly facts: CrossSessionCommandFact[] = [];
  private complete = false;
  private failed = false;
  private finished = false;
  private count = 0;
  private tokens: number | null = null;

  constructor(private readonly root: string, private readonly fixture: CrossSessionFixture,
    private readonly selectionInvocation?: string) {}

  accept(value: unknown, observedAt: string): void {
    if (this.finished || ++this.count > 2048) throw new TypeError('Cross-session stream exceeds bound.');
    const event = asRecord(value);
    const normalized = this.capture.accept(event, observedAt);
    if (event.type === 'turn.failed' || event.type === 'error') { this.failed = true; return; }
    if (event.type === 'turn.completed') {
      if (this.complete || this.failed || !this.capture.sessionId) throw new TypeError('Cross-session turn is invalid.');
      if (event.usage !== undefined) {
        const usage = asRecord(event.usage);
        const input = count(usage.input_tokens);
        const cached = count(usage.cached_input_tokens);
        const output = count(usage.output_tokens);
        if (cached > input || usage.reasoning_output_tokens !== undefined
          && count(usage.reasoning_output_tokens) > output || !Number.isSafeInteger(input + output)) {
          throw new TypeError('Cross-session token usage is invalid.');
        }
        this.tokens = input + output;
      }
      this.complete = true;
      return;
    }
    if (event.type !== 'item.started' && event.type !== 'item.completed') return;
    const item = asRecord(event.item);
    if (item.type !== 'command_execution') return;
    if (this.complete || typeof item.id !== 'string' || typeof item.command !== 'string'
      || !this.capture.sessionId) throw new TypeError('Cross-session command is invalid.');
    if (event.type === 'item.started') {
      if (this.pending.size > 0 || !normalized || normalized.phase !== 'pre-action'
        || this.pending.has(item.id)) throw new TypeError('Cross-session start is invalid.');
      this.pending.set(item.id, { command: item.command, operationId: normalized.sourceEventId });
      return;
    }
    const started = this.pending.get(item.id);
    if (!started || started.command !== item.command || !normalized
      || normalized.phase !== 'post-result' || normalized.relatedEventId !== started.operationId
      || normalized.outcome === undefined || typeof item.aggregated_output !== 'string'
      || Buffer.byteLength(item.aggregated_output, 'utf8') > 4096) {
      throw new TypeError('Cross-session result is invalid.');
    }
    this.pending.delete(item.id);
    const project = this.fixture.revision === 2
      ? projectCrossSessionCommandCandidateV2 : projectCrossSessionCommandCandidate;
    this.facts.push(project({ root: this.root, fixture: this.fixture,
      sessionId: this.capture.sessionId, operationId: started.operationId, command: started.command,
      outcome: normalized.outcome, aggregatedOutput: item.aggregated_output,
      selectionInvocation: this.selectionInvocation }));
  }

  finish(): CrossSessionCandidate {
    if (this.finished) throw new TypeError('Cross-session projection is closed.');
    this.finished = true;
    const status = this.capture.sessionId && this.complete && !this.failed && this.pending.size === 0
      ? 'observed' as const : 'unsupported' as const;
    return Object.freeze({ status, sessionId: this.capture.sessionId ?? null,
      facts: Object.freeze([...this.facts]), tokens: status === 'observed' ? this.tokens : null });
  }
}

/** Structural comparison only; caller must separately prove direct-child stream provenance. */
export function matchCrossSessionCommandFacts(candidate: CrossSessionCandidate,
  stream: { readonly sessionId: string; readonly events: readonly NormalizedCaptureEvent[] }): readonly CrossSessionCommandFact[] {
  if (candidate.status !== 'observed' || candidate.sessionId !== stream.sessionId
    || stream.events.length !== candidate.facts.length * 2) return [];
  for (let index = 0; index < candidate.facts.length; index++) {
    const fact = candidate.facts[index]!;
    const start = stream.events[index * 2];
    const result = stream.events[index * 2 + 1];
    if (start?.phase !== 'pre-action' || result?.phase !== 'post-result'
      || start.sessionId !== stream.sessionId || result.sessionId !== stream.sessionId
      || start.sourceEventId !== fact.operationId || result.relatedEventId !== fact.operationId
      || result.outcome !== fact.outcome) return [];
  }
  return Object.freeze([...candidate.facts]);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Cross-session event is invalid.');
  }
  return value as Readonly<Record<string, unknown>>;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('Cross-session token count is invalid.');
  return value as number;
}
