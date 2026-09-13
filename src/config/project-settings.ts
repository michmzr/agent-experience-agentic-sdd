import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CAPTURE_DELIVERY_DEADLINE_MS = 2_000;
const MIN_CAPTURE_DELIVERY_DEADLINE_MS = 100;
const MAX_CAPTURE_DELIVERY_DEADLINE_MS = 60_000;
const defaultInstructionLocations = ['AGENTS.md', 'CLAUDE.md', '.agents/AGENTS.md', '.ael/instructions.md'] as const;

export interface ProjectSettings {
  readonly version: 1;
  readonly captureDeliveryDeadlineMs: number;
  readonly automaticOperationalLearning?: boolean;
  readonly instructionLocations?: readonly string[];
}

export function loadProjectSettings(projectRoot: string): ProjectSettings {
  const path = join(projectRoot, '.ael', 'settings.json');
  if (!existsSync(path)) return defaults();
  if (lstatSync(path).isSymbolicLink()) throw new TypeError('Project settings must be a regular file.');
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch { throw new TypeError('Project settings are invalid.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Project settings are invalid.');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (!['captureDeliveryDeadlineMs,version', 'automaticOperationalLearning,captureDeliveryDeadlineMs,version', 'captureDeliveryDeadlineMs,instructionLocations,version', 'automaticOperationalLearning,captureDeliveryDeadlineMs,instructionLocations,version'].includes(keys) || record.version !== 1) {
    throw new TypeError('Project settings are invalid.');
  }
  const deadline = record.captureDeliveryDeadlineMs;
  if (!Number.isSafeInteger(deadline) || (deadline as number) < MIN_CAPTURE_DELIVERY_DEADLINE_MS || (deadline as number) > MAX_CAPTURE_DELIVERY_DEADLINE_MS) {
    throw new TypeError('Capture delivery deadline must be between 100 and 60000 milliseconds.');
  }
  if (record.automaticOperationalLearning !== undefined && typeof record.automaticOperationalLearning !== 'boolean') throw new TypeError('Automatic operational learning must be boolean.');
  const instructionLocations = parseInstructionLocations(record.instructionLocations);
  return Object.freeze({ version: 1, captureDeliveryDeadlineMs: deadline as number, ...(record.automaticOperationalLearning === undefined ? {} : { automaticOperationalLearning: record.automaticOperationalLearning }), ...(instructionLocations === undefined ? {} : { instructionLocations }) });
}

function defaults(): ProjectSettings {
  return Object.freeze({ version: 1, captureDeliveryDeadlineMs: DEFAULT_CAPTURE_DELIVERY_DEADLINE_MS });
}

export function configuredInstructionLocations(settings?: Pick<ProjectSettings, 'instructionLocations'>): readonly string[] {
  return settings?.instructionLocations ?? defaultInstructionLocations;
}

function parseInstructionLocations(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError('Instruction locations are invalid.');
  const locations = value.map((location) => {
    if (typeof location !== 'string' || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(location)) throw new TypeError('Instruction locations are invalid.');
    return location;
  });
  if (new Set(locations).size !== locations.length) throw new TypeError('Instruction locations are invalid.');
  return Object.freeze(locations);
}
