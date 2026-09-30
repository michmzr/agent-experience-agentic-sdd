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
  readonly instructionScopes?: readonly { readonly location: string; readonly qualifier: string; readonly path: string }[];
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
  const keys = Object.keys(record);
  if (keys.some(key => !['version', 'captureDeliveryDeadlineMs', 'automaticOperationalLearning', 'instructionLocations', 'instructionScopes'].includes(key))
    || !keys.includes('version') || !keys.includes('captureDeliveryDeadlineMs') || record.version !== 1) {
    throw new TypeError('Project settings are invalid.');
  }
  const deadline = record.captureDeliveryDeadlineMs;
  if (!Number.isSafeInteger(deadline) || (deadline as number) < MIN_CAPTURE_DELIVERY_DEADLINE_MS || (deadline as number) > MAX_CAPTURE_DELIVERY_DEADLINE_MS) {
    throw new TypeError('Capture delivery deadline must be between 100 and 60000 milliseconds.');
  }
  if (record.automaticOperationalLearning !== undefined && typeof record.automaticOperationalLearning !== 'boolean') throw new TypeError('Automatic operational learning must be boolean.');
  const instructionLocations = parseInstructionLocations(record.instructionLocations);
  const instructionScopes = parseInstructionScopes(record.instructionScopes, projectRoot, instructionLocations ?? defaultInstructionLocations);
  return Object.freeze({ version: 1, captureDeliveryDeadlineMs: deadline as number, ...(record.automaticOperationalLearning === undefined ? {} : { automaticOperationalLearning: record.automaticOperationalLearning }), ...(instructionLocations === undefined ? {} : { instructionLocations }), ...(instructionScopes === undefined ? {} : { instructionScopes }) });
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

function parseInstructionScopes(value: unknown, root: string, locations: readonly string[]): ProjectSettings['instructionScopes'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) throw new TypeError('Instruction scopes exceed the limit of 16.');
  const scopes = value.map((entry): NonNullable<ProjectSettings['instructionScopes']>[number] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'location,path,qualifier') throw new TypeError('Instruction scope is invalid.');
    const { location, path, qualifier } = entry as Record<string, unknown>;
    if (typeof location !== 'string' || !locations.includes(location)
      || (qualifier !== 'mobile app' && qualifier !== 'backend')
      || typeof path !== 'string' || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)) throw new TypeError('Instruction scope path or qualifier is invalid.');
    let current = root;
    for (const segment of path.split('/')) {
      current = join(current, segment);
      try { if (lstatSync(current).isSymbolicLink()) throw new TypeError('Instruction scope crosses a symlink.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return Object.freeze({ location, qualifier, path });
  });
  for (const [index, a] of scopes.entries()) for (const b of scopes.slice(index + 1)) {
    if (a.location === b.location && (a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`)))
      throw new TypeError('Ambiguous overlapping instruction scopes.');
  }
  return Object.freeze(scopes);
}
