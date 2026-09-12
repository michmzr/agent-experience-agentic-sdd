import type { AgentSource, Session, SessionId } from '../domain/types.js';
import type { IncrementalAppendResult, IncrementalCaptureAppend, LifecycleSignal, NormalizedCaptureEvent } from './contracts.js';

/** The only records accepted by runtime-independent passive capture. */
export type PassiveCaptureRecord =
  | { readonly kind: 'session-start'; readonly session: Session; readonly lifecycle?: LifecycleSignal }
  | { readonly kind: 'session-end'; readonly source: AgentSource; readonly sessionId: SessionId; readonly endedAt: string; readonly lifecycle?: LifecycleSignal }
  | { readonly kind: 'technical'; readonly event: NormalizedCaptureEvent; readonly session?: Session };

export interface PassiveCaptureStore {
  appendIncremental(input: IncrementalCaptureAppend): IncrementalAppendResult;
  endSession(source: AgentSource, id: SessionId, endedAt: string): IncrementalAppendResult;
  recordLifecycleSignal?(signal: LifecycleSignal): IncrementalAppendResult;
  appendLifecycleTechnical?(event: NormalizedCaptureEvent): IncrementalAppendResult;
}

export interface PassiveCaptureServiceOptions {
  readonly store: PassiveCaptureStore;
}

export interface PassiveCaptureDiagnostic {
  readonly code: 'PASSIVE_CAPTURE_FAILED';
  readonly eventClass: PassiveCaptureRecord['kind'];
}

export type PassiveCaptureResult =
  | { readonly status: 'captured' | 'duplicate' }
  | { readonly status: 'degraded'; readonly diagnostic: PassiveCaptureDiagnostic };

export interface PassiveCaptureService {
  capture(record: PassiveCaptureRecord): PassiveCaptureResult;
}

export function createPassiveCaptureService(options: PassiveCaptureServiceOptions): PassiveCaptureService {
  return Object.freeze({
    capture(record: PassiveCaptureRecord): PassiveCaptureResult {
      try {
        const result = persistPassiveCapture(options.store, record);
        return Object.freeze({ status: result.inserted ? 'captured' : 'duplicate' });
      } catch {
        return degraded(record.kind);
      }
    }
  });
}

export function persistPassiveCapture(store: PassiveCaptureStore, record: PassiveCaptureRecord): IncrementalAppendResult {
  switch (record.kind) {
    case 'session-start': {
      if (record.lifecycle === undefined || store.recordLifecycleSignal === undefined) return store.appendIncremental({ session: record.session });
      const session = record.lifecycle.kind === 'start' && /:startup(?::|$)/.test(record.lifecycle.sourceEventId)
        ? store.appendIncremental({ session: record.session })
        : { inserted: false };
      const lifecycle = store.recordLifecycleSignal(record.lifecycle);
      return Object.freeze({ inserted: session.inserted || lifecycle.inserted });
    }
    case 'session-end': {
      if (record.lifecycle === undefined || store.recordLifecycleSignal === undefined) return store.endSession(record.source, record.sessionId, record.endedAt);
      const lifecycle = store.recordLifecycleSignal(record.lifecycle);
      const session = store.endSession(record.source, record.sessionId, record.endedAt);
      return Object.freeze({ inserted: lifecycle.inserted || session.inserted });
    }
    case 'technical': {
      try {
        return store.appendIncremental({
          ...(record.session === undefined ? {} : { session: record.session }),
          event: record.event
        });
      } catch (error) {
        if (error instanceof TypeError && /after its session end/i.test(error.message) && store.appendLifecycleTechnical !== undefined) {
          return store.appendLifecycleTechnical(record.event);
        }
        throw error;
      }
    }
  }
}

function degraded(eventClass: PassiveCaptureRecord['kind']): PassiveCaptureResult {
  return Object.freeze({
    status: 'degraded',
    diagnostic: Object.freeze({ code: 'PASSIVE_CAPTURE_FAILED', eventClass })
  });
}
