import type { DecisionOutcome, OperationClass, RuntimeProfile } from './contracts.js';
import { CircuitBreaker, type CircuitBreakerConfig, type CircuitState } from './circuit-breaker.js';
import { createRuleIndex, type RuleIndex } from './rule-index.js';
import type { RuntimeSnapshotV1 } from './snapshot.js';

export type RuntimeFallbackSource = 'memory' | 'snapshot' | 'last-known-good' | 'degraded-policy';
export type RuntimeHealth = 'healthy' | 'fallback' | 'degraded';

export interface RuntimeStatus {
  readonly health: RuntimeHealth;
  readonly profileId: string;
  readonly hardBlocking: boolean;
  readonly retrievalMode: 'deterministic' | 'degraded';
  readonly fallbackSource: RuntimeFallbackSource;
  readonly circuitState: CircuitState;
}

export interface RuntimeResolution {
  readonly source: RuntimeFallbackSource;
  readonly status: RuntimeStatus;
  readonly index?: RuleIndex;
  readonly outcome?: DecisionOutcome;
}

export interface ResilientRuntimeOptions {
  readonly profile: RuntimeProfile;
  readonly currentIndex?: RuleIndex;
  readonly loadCurrent: () => RuntimeSnapshotV1;
  readonly loadLastKnownGood: () => RuntimeSnapshotV1;
  readonly circuit?: Omit<CircuitBreakerConfig, 'clock'>;
  readonly clock?: () => number;
  readonly onDiagnostic?: (message: string) => void;
}

export class ResilientRuntime {
  readonly #profile: RuntimeProfile;
  readonly #loadCurrent: () => RuntimeSnapshotV1;
  readonly #loadLastKnownGood: () => RuntimeSnapshotV1;
  readonly #breaker: CircuitBreaker;
  readonly #onDiagnostic: (message: string) => void;
  #current?: RuleIndex;
  #degradedDiagnosticEmitted = false;

  constructor(options: ResilientRuntimeOptions) {
    this.#profile = options.profile;
    this.#current = options.currentIndex;
    this.#loadCurrent = options.loadCurrent;
    this.#loadLastKnownGood = options.loadLastKnownGood;
    this.#breaker = new CircuitBreaker({ failureThreshold: options.circuit?.failureThreshold ?? 3, resetAfterMs: options.circuit?.resetAfterMs ?? 30_000, clock: options.clock });
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  resolve(operationClass: OperationClass): RuntimeResolution {
    if (this.#current !== undefined) return this.#withIndex('memory', 'healthy', this.#current);
    if (this.#breaker.canAttempt()) {
      try {
        const index = createRuleIndex(this.#loadCurrent());
        this.#breaker.recordSuccess(); this.#degradedDiagnosticEmitted = false; this.#current = index;
        return this.#withIndex('snapshot', 'healthy', index);
      } catch {
        try {
          const index = createRuleIndex(this.#loadLastKnownGood());
          this.#breaker.recordSuccess(); this.#degradedDiagnosticEmitted = false; this.#current = index;
          return this.#withIndex('last-known-good', 'fallback', index);
        } catch { this.#breaker.recordFailure(); }
      }
    }
    if (!this.#degradedDiagnosticEmitted) {
      this.#onDiagnostic('Runtime knowledge is unavailable; applying the configured degraded policy.');
      this.#degradedDiagnosticEmitted = true;
    }
    const outcome = operationClass === 'normal' ? 'ALLOW' : this.#profile.degradedOutcomes[operationClass];
    return Object.freeze({ source: 'degraded-policy', outcome, status: this.#status('degraded-policy', 'degraded') });
  }

  clearCurrent(): void { this.#current = undefined; }
  get circuitState(): CircuitState { return this.#breaker.state; }

  #withIndex(source: Exclude<RuntimeFallbackSource, 'degraded-policy'>, health: RuntimeHealth, index: RuleIndex): RuntimeResolution {
    return Object.freeze({ source, index, status: this.#status(source, health) });
  }
  #status(source: RuntimeFallbackSource, health: RuntimeHealth): RuntimeStatus {
    return Object.freeze({ health, profileId: this.#profile.id, hardBlocking: this.#profile.hardBlocking, retrievalMode: source === 'degraded-policy' ? 'degraded' : 'deterministic', fallbackSource: source, circuitState: this.#breaker.state });
  }
}
