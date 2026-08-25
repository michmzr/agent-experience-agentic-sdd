export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly resetAfterMs: number;
  readonly clock?: () => number;
}

export class CircuitBreaker {
  readonly #failureThreshold: number;
  readonly #resetAfterMs: number;
  readonly #clock: () => number;
  #state: CircuitState = 'closed';
  #failures = 0;
  #openedAt = 0;

  constructor(config: CircuitBreakerConfig) {
    if (!Number.isInteger(config.failureThreshold) || config.failureThreshold < 1) throw new RangeError('Circuit failure threshold must be a positive integer.');
    if (!Number.isFinite(config.resetAfterMs) || config.resetAfterMs < 0) throw new RangeError('Circuit reset interval must be non-negative.');
    this.#failureThreshold = config.failureThreshold;
    this.#resetAfterMs = config.resetAfterMs;
    this.#clock = config.clock ?? Date.now;
  }

  get state(): CircuitState { return this.#state; }
  get consecutiveFailures(): number { return this.#failures; }

  canAttempt(): boolean {
    if (this.#state === 'closed') return true;
    if (this.#state === 'half-open') return false;
    if (this.#clock() - this.#openedAt < this.#resetAfterMs) return false;
    this.#state = 'half-open';
    return true;
  }

  recordSuccess(): void {
    this.#state = 'closed'; this.#failures = 0;
  }

  recordFailure(): void {
    this.#failures += 1;
    if (this.#state === 'half-open' || this.#failures >= this.#failureThreshold) {
      this.#state = 'open'; this.#openedAt = this.#clock();
    }
  }

  reset(): void { this.recordSuccess(); }
}
