import type { AgentSource } from '../domain/types.js';

export interface SourceEvidenceCapability {
  readonly correlation: 'explicit-reference';
  readonly processExit: 'available' | 'partial';
  readonly taskVerification: 'structured-only';
  readonly humanWaiting: 'structured-only';
  readonly tokenUsage: 'source-provided' | 'unavailable';
}

export const sourceEvidenceCapabilities: Readonly<Record<AgentSource, SourceEvidenceCapability>> = Object.freeze({
  codex: Object.freeze({
    correlation: 'explicit-reference', processExit: 'available', taskVerification: 'structured-only',
    humanWaiting: 'structured-only', tokenUsage: 'source-provided'
  }),
  'claude-code': Object.freeze({
    correlation: 'explicit-reference', processExit: 'partial', taskVerification: 'structured-only',
    humanWaiting: 'structured-only', tokenUsage: 'source-provided'
  }),
  cursor: Object.freeze({
    correlation: 'explicit-reference', processExit: 'partial', taskVerification: 'structured-only',
    humanWaiting: 'structured-only', tokenUsage: 'unavailable'
  })
});
