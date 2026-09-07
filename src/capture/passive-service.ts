import type { AgentSource, Session, SessionId } from '../domain/types.js';
import type { IncrementalAppendResult, IncrementalCaptureAppend, NormalizedCaptureEvent } from './contracts.js';

/** The only records accepted by runtime-independent passive capture. */
export type PassiveCaptureRecord =
  | { readonly kind: 'session-start'; readonly session: Session }
  | { readonly kind: 'session-end'; readonly source: AgentSource; readonly sessionId: SessionId; readonly endedAt: string }
  | { readonly kind: 'technical'; readonly event: NormalizedCaptureEvent; readonly session?: Session };

export interface PassiveCaptureStore {
  appendIncremental(input: IncrementalCaptureAppend): IncrementalAppendResult;
  endSession(source: AgentSource, id: SessionId, endedAt: string): IncrementalAppendResult;
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
    case 'session-start':
      return store.appendIncremental({ session: record.session });
    case 'session-end':
      return store.endSession(record.source, record.sessionId, record.endedAt);
    case 'technical':
      return store.appendIncremental({
        ...(record.session === undefined ? {} : { session: record.session }),
        event: record.event
      });
  }
}

function degraded(eventClass: PassiveCaptureRecord['kind']): PassiveCaptureResult {
  return Object.freeze({
    status: 'degraded',
    diagnostic: Object.freeze({ code: 'PASSIVE_CAPTURE_FAILED', eventClass })
  });
}
