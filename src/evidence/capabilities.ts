import type { AgentSource } from '../domain/types.js';

export interface SourceEvidenceCapability {
  readonly correlation: 'explicit-reference';
  readonly processExit: 'available' | 'partial' | 'unqualified';
  readonly taskVerification: 'structured-only' | 'unsupported';
  readonly humanWaiting: 'structured-only';
  readonly tokenUsage: 'source-provided' | 'unavailable';
}

export const sourceEvidenceCapabilities: Readonly<Record<AgentSource, SourceEvidenceCapability>> = Object.freeze({
  codex: Object.freeze({
    correlation: 'explicit-reference', processExit: 'unqualified', taskVerification: 'unsupported',
    humanWaiting: 'structured-only', tokenUsage: 'source-provided'
  }),
  'claude-code': Object.freeze({
    correlation: 'explicit-reference', processExit: 'partial', taskVerification: 'unsupported',
    humanWaiting: 'structured-only', tokenUsage: 'source-provided'
  }),
  cursor: Object.freeze({
    correlation: 'explicit-reference', processExit: 'partial', taskVerification: 'unsupported',
    humanWaiting: 'structured-only', tokenUsage: 'unavailable'
  })
});

export const localAnnotationEvidenceCapability = Object.freeze({
  producer: 'local-annotation' as const,
  taskVerification: 'user-declared' as const,
  nativeSourceTelemetry: false as const
});
