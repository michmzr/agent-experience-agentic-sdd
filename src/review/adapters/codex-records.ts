import {
  validateIngestionCoverage,
  type SessionIngestionCoverage,
  type SessionIngestionDiagnostic
} from '../ingestion.js';
import type { LocalSessionRecord } from '../contracts.js';

export type CodexRecordDisposition =
  | {
    readonly state: 'normalized';
    readonly record: LocalSessionRecord;
    readonly truncatedTextFields: number;
    readonly omittedStructuredOutputs: number;
  }
  | { readonly state: 'technical-skip' }
  | { readonly state: 'unsupported'; readonly diagnostic: SessionIngestionDiagnostic };

export interface CodexIngestionCoverageCounter {
  readonly kind: 'codex-ingestion-coverage-counter';
}

interface MutableCoverage {
  totalRecords: number;
  normalizedRecords: number;
  skippedTechnicalRecords: number;
  unsupportedRecords: number;
  truncatedTextFields: number;
  omittedStructuredOutputs: number;
}

const coverageByCounter = new WeakMap<CodexIngestionCoverageCounter, MutableCoverage>();

export function createCodexIngestionCoverageCounter(): CodexIngestionCoverageCounter {
  const counter = { kind: 'codex-ingestion-coverage-counter' } as const;
  coverageByCounter.set(counter, {
    totalRecords: 0,
    normalizedRecords: 0,
    skippedTechnicalRecords: 0,
    unsupportedRecords: 0,
    truncatedTextFields: 0,
    omittedStructuredOutputs: 0
  });
  return counter;
}

export function incrementCodexIngestionCoverage(
  counter: CodexIngestionCoverageCounter,
  disposition: CodexRecordDisposition
): void {
  const coverage = coverageByCounter.get(counter);
  if (coverage === undefined) throw new Error('Codex ingestion coverage counter is invalid.');
  coverage.totalRecords = checkedIncrement(coverage.totalRecords);
  if (disposition.state === 'technical-skip') {
    coverage.skippedTechnicalRecords = checkedIncrement(coverage.skippedTechnicalRecords);
    return;
  }
  if (disposition.state === 'unsupported') {
    coverage.unsupportedRecords = checkedIncrement(coverage.unsupportedRecords);
    return;
  }
  coverage.normalizedRecords = checkedIncrement(coverage.normalizedRecords);
  coverage.truncatedTextFields = checkedAdd(coverage.truncatedTextFields, disposition.truncatedTextFields);
  coverage.omittedStructuredOutputs = checkedAdd(coverage.omittedStructuredOutputs, disposition.omittedStructuredOutputs);
}

export function finalizeCodexIngestionCoverage(
  counter: CodexIngestionCoverageCounter,
  usedStreamingProjection: boolean
): SessionIngestionCoverage {
  const coverage = coverageByCounter.get(counter);
  if (coverage === undefined) throw new Error('Codex ingestion coverage counter is invalid.');
  return validateIngestionCoverage({ ...coverage, usedStreamingProjection });
}

function checkedIncrement(value: number): number {
  return checkedAdd(value, 1);
}

function checkedAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new Error('Codex ingestion coverage counter is invalid.');
  }
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error('Codex ingestion coverage counter overflow.');
  return result;
}
