import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const maxInstructionBytes = 128 * 1024;
const instructionPaths = ['AGENTS.md', 'CLAUDE.md', '.ael/instructions.md'] as const;

export interface ProjectToolConvention {
  readonly tool: 'pnpm' | 'uv';
  readonly replaces: 'npm' | 'pip';
  readonly source: string;
  readonly digest: string;
}

export function readProjectToolConventions(repositoryRoot: string): readonly ProjectToolConvention[] {
  const conventions: ProjectToolConvention[] = [];
  for (const relativePath of instructionPaths) {
    const path = join(repositoryRoot, relativePath);
    if (!existsSync(path)) continue;
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxInstructionBytes) continue;
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    const digest = createHash('sha256').update(text).digest('hex');
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const directive = recognizedDirective(line);
      if (directive === undefined) continue;
      conventions.push(Object.freeze({ ...directive, source: `${relativePath}:${index + 1}`, digest }));
    }
  }
  return Object.freeze(conventions.sort(compareConvention));
}

function recognizedDirective(line: string): Pick<ProjectToolConvention, 'tool' | 'replaces'> | undefined {
  const normalized = line.trim().replace(/[.!]$/, '').toLowerCase();
  if (normalized === 'use pnpm instead of npm') return { tool: 'pnpm', replaces: 'npm' };
  if (normalized === 'use uv instead of pip') return { tool: 'uv', replaces: 'pip' };
  return undefined;
}

function compareConvention(left: ProjectToolConvention, right: ProjectToolConvention): number {
  return left.source.localeCompare(right.source) || left.tool.localeCompare(right.tool);
}
