import { createHash, createHmac } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { configuredInstructionLocations } from '../config/project-settings.js';

const maxInstructionBytes = 128 * 1024;
export type InstructionState = 'yes' | 'no' | 'unknown';
export interface InstructionContext { readonly location: string; readonly scope: 'repository'; readonly found: boolean; readonly delivered: InstructionState; readonly explicitlyRead: InstructionState; readonly digest: string; readonly evidenceId: string; }
export interface ProjectToolConvention { readonly tool: 'pnpm' | 'uv'; readonly replaces: 'npm' | 'pip'; readonly source: string; readonly digest: string; }
export interface ProjectInstructionContext { readonly instructions: readonly InstructionContext[]; readonly conventions: readonly ProjectToolConvention[]; }

export function readProjectInstructionContext(repositoryRoot: string, settings: { readonly instructionLocations?: readonly string[] } = {}): ProjectInstructionContext {
  const instructions: InstructionContext[] = []; const conventions: ProjectToolConvention[] = [];
  for (const location of configuredInstructionLocations(settings)) {
    const path = join(repositoryRoot, location); let text: string | undefined;
    if (existsSync(path)) try { const stat = lstatSync(path); if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxInstructionBytes) text = readFileSync(path, 'utf8'); } catch { /* unavailable evidence remains unknown */ }
    const digest = contextDigest(repositoryRoot, location, text ?? '');
    instructions.push(Object.freeze({ location, scope: 'repository', found: text !== undefined, delivered: 'unknown', explicitlyRead: 'unknown', digest, evidenceId: `instruction-context:${location}` }));
    if (text === undefined) continue;
    for (const [index, line] of text.split(/\r?\n/).entries()) { const directive = recognizedDirective(line); if (directive) conventions.push(Object.freeze({ ...directive, source: `${location}:${index + 1}`, digest })); }
  }
  return Object.freeze({ instructions: Object.freeze(instructions.sort((a, b) => a.location.localeCompare(b.location))), conventions: Object.freeze(conventions.sort(compareConvention)) });
}

export function readProjectToolConventions(repositoryRoot: string): readonly ProjectToolConvention[] { return readProjectInstructionContext(repositoryRoot).conventions; }

function recognizedDirective(line: string): Pick<ProjectToolConvention, 'tool' | 'replaces'> | undefined {
  const normalized = line.trim().replace(/[`*_]/g, '').replace(/[.!:]$/, '').toLowerCase();
  if (/\b(?:use|prefer|run|invoke)\s+pnpm\b.*\b(?:instead of|rather than|not)\s+npm\b/.test(normalized)) return { tool: 'pnpm', replaces: 'npm' };
  if (/\b(?:use|prefer|run|invoke)\s+uv\b.*\b(?:instead of|rather than|not)\s+pip\b/.test(normalized)) return { tool: 'uv', replaces: 'pip' };
  return undefined;
}
function contextDigest(repositoryRoot: string, location: string, text: string): string {
  const localKey = createHash('sha256').update(`ael:instruction-context-key:v1\0${repositoryRoot}`).digest();
  return createHmac('sha256', localKey).update(`${location}\0${text}`).digest('hex');
}
function compareConvention(left: ProjectToolConvention, right: ProjectToolConvention): number { return left.source.localeCompare(right.source) || left.tool.localeCompare(right.tool); }
