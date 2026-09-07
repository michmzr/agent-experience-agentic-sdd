export interface SessionIngestionCoverage {
  readonly totalRecords: number;
  readonly normalizedRecords: number;
  readonly skippedTechnicalRecords: number;
  readonly unsupportedRecords: number;
  readonly truncatedTextFields: number;
  readonly omittedStructuredOutputs: number;
  readonly usedStreamingProjection: boolean;
}

export interface SessionIngestionDiagnostic {
  readonly code: 'UNSUPPORTED_CODEX_RECORD';
  readonly level: 'envelope' | 'response-item';
  readonly recordType: string;
  readonly sourceOrdinal: number;
}

export type SessionIngestionDiagnosticSink = (diagnostic: SessionIngestionDiagnostic) => void | Promise<void>;

const coverageKeys = [
  'totalRecords',
  'normalizedRecords',
  'skippedTechnicalRecords',
  'unsupportedRecords',
  'truncatedTextFields',
  'omittedStructuredOutputs',
  'usedStreamingProjection'
] as const;

const safeRecordType = /^[A-Za-z0-9_.:/-]{1,128}$/;

export function validateIngestionCoverage(value: unknown): SessionIngestionCoverage {
  if (!isRecord(value) || !hasOnlyCoverageKeys(value)) throw new Error('Session ingestion coverage is invalid.');
  const coverage = value as Record<string, unknown>;
  const counters = [
    coverage.totalRecords,
    coverage.normalizedRecords,
    coverage.skippedTechnicalRecords,
    coverage.unsupportedRecords,
    coverage.truncatedTextFields,
    coverage.omittedStructuredOutputs
  ];
  if (counters.some((counter) => typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) || typeof coverage.usedStreamingProjection !== 'boolean') {
    throw new Error('Session ingestion coverage is invalid.');
  }
  const normalizedRecords = coverage.normalizedRecords as number;
  const skippedTechnicalRecords = coverage.skippedTechnicalRecords as number;
  const unsupportedRecords = coverage.unsupportedRecords as number;
  const totalRecords = coverage.totalRecords as number;
  const partition = normalizedRecords + skippedTechnicalRecords + unsupportedRecords;
  if (!Number.isSafeInteger(partition) || totalRecords !== partition) throw new Error('Session ingestion coverage is invalid.');
  return coverage as unknown as SessionIngestionCoverage;
}

export function freezeIngestionCoverage(value: unknown): SessionIngestionCoverage {
  const coverage = validateIngestionCoverage(value);
  return Object.freeze({
    totalRecords: coverage.totalRecords,
    normalizedRecords: coverage.normalizedRecords,
    skippedTechnicalRecords: coverage.skippedTechnicalRecords,
    unsupportedRecords: coverage.unsupportedRecords,
    truncatedTextFields: coverage.truncatedTextFields,
    omittedStructuredOutputs: coverage.omittedStructuredOutputs,
    usedStreamingProjection: coverage.usedStreamingProjection
  });
}

export function formatSafeRecordType(value: unknown): string {
  return typeof value === 'string' && safeRecordType.test(value) ? value : 'unprintable';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyCoverageKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === coverageKeys.length && keys.every((key) => coverageKeys.includes(key as typeof coverageKeys[number]));
}
