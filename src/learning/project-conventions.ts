import { createHash, createHmac } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { configuredInstructionLocations, loadProjectSettings, type ProjectSettings } from '../config/project-settings.js';

const maxInstructionBytes = 128 * 1024;
const contextCache = new Map<string, { readonly signatures: string; readonly context: ProjectInstructionContext }>();
const maxCachedContexts = 64;
export type InstructionState = 'yes' | 'no' | 'unknown';
export interface InstructionContext { readonly location: string; readonly scope: 'repository'; readonly found: boolean; readonly delivered: InstructionState; readonly explicitlyRead: InstructionState; readonly digest: string; readonly evidenceId: string; }
export interface ProjectToolConvention { readonly tool: 'pnpm' | 'uv'; readonly replaces: 'npm' | 'pip'; readonly source: string; readonly digest: string; }
export interface ScopedToolConvention extends ProjectToolConvention { readonly scopePath: string; readonly qualifier: string; }
export interface ProjectInstructionContext { readonly instructions: readonly InstructionContext[]; readonly conventions: readonly ProjectToolConvention[]; readonly scopedConventions: readonly ScopedToolConvention[]; readonly unresolvedScopes: readonly string[]; }
export const CONVENTION_PARSER_VERSION = 2;

export function readProjectInstructionContext(repositoryRoot: string, settings?: Pick<ProjectSettings, 'instructionLocations' | 'instructionScopes'>): ProjectInstructionContext {
  const configured = settings ?? loadProjectSettings(repositoryRoot);
  const locations = configuredInstructionLocations(configured);
  const signatures = locations.map(location => safeFileSignature(repositoryRoot, location));
  const cacheKey = JSON.stringify([repositoryRoot, locations, configured.instructionScopes ?? []]);
  const signatureKey = JSON.stringify(signatures);
  const cached = contextCache.get(cacheKey);
  if (cached?.signatures === signatureKey) return cached.context;
  const instructions: InstructionContext[] = []; const conventions: ProjectToolConvention[] = [];
  const scopedConventions: ScopedToolConvention[] = []; const unresolvedScopes: string[] = [];
  let cacheable = true;
  for (const [index, location] of locations.entries()) {
    const text = signatures[index] === undefined ? undefined : readBoundedRegularFile(repositoryRoot, location, signatures[index]!);
    if (signatures[index] !== undefined && text === undefined) cacheable = false;
    const digest = contextDigest(repositoryRoot, location, text ?? '');
    instructions.push(Object.freeze({ location, scope: 'repository', found: text !== undefined, delivered: 'unknown', explicitlyRead: 'unknown', digest, evidenceId: `instruction-context:${location}` }));
    if (text === undefined) continue;
    let fenced = false;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced || /^ {4,}\S/.test(line)) continue;
      const directive = recognizedDirective(line);
      if (!directive) continue;
      const source = `${location}:${index + 1}`;
      if (directive.qualifier === undefined) conventions.push(Object.freeze({ tool: directive.tool, replaces: directive.replaces, source, digest }));
      else {
        const mapping = configured.instructionScopes?.find(scope => scope.location === location && scope.qualifier === directive.qualifier);
        if (mapping) scopedConventions.push(Object.freeze({ tool: directive.tool, replaces: directive.replaces, source, digest, qualifier: directive.qualifier, scopePath: mapping.path }));
        else unresolvedScopes.push(source);
      }
    }
  }
  const context = Object.freeze({ instructions: Object.freeze(instructions.sort((a, b) => a.location.localeCompare(b.location))), conventions: Object.freeze(conventions.sort(compareConvention)),
    scopedConventions: Object.freeze(scopedConventions.sort(compareConvention)), unresolvedScopes: Object.freeze(unresolvedScopes.sort()) });
  contextCache.delete(cacheKey);
  if (cacheable) {
    contextCache.set(cacheKey, { signatures: signatureKey, context });
    if (contextCache.size > maxCachedContexts) contextCache.delete(contextCache.keys().next().value!);
  }
  return context;
}

function safeFileSignature(root: string, location: string): string | undefined {
  let current = root;
  try {
    for (const segment of location.split('/')) {
      current = join(current, segment);
      const stat = lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink()) return undefined;
      if (current !== join(root, location) && !stat.isDirectory()) return undefined;
      if (current === join(root, location)) {
        if (!stat.isFile() || stat.size > BigInt(maxInstructionBytes)) return undefined;
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      }
    }
  } catch { /* Missing or inaccessible instruction is unknown. */ }
  return undefined;
}

function readBoundedRegularFile(root: string, location: string, signature: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, location), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maxInstructionBytes)
      || [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') !== signature) return undefined;
    const bytes = Buffer.alloc(maxInstructionBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > maxInstructionBytes || safeFileSignature(root, location) !== signature) return undefined;
    return bytes.toString('utf8', 0, length);
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readProjectToolConventions(repositoryRoot: string): readonly ProjectToolConvention[] { return readProjectInstructionContext(repositoryRoot).conventions; }
export function readScopedToolConventions(repositoryRoot: string, relativePath: string): readonly ScopedToolConvention[] {
  if (relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) return [];
  let current = repositoryRoot;
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    try { if (lstatSync(current).isSymbolicLink()) return []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return []; }
  }
  return readProjectInstructionContext(repositoryRoot).scopedConventions.filter(convention => relativePath === convention.scopePath || relativePath.startsWith(`${convention.scopePath}/`));
}

function recognizedDirective(line: string): { tool: 'pnpm' | 'uv'; replaces: 'npm' | 'pip'; qualifier?: string } | undefined {
  if (/^\s*(?:>|["'`])/.test(line)) return undefined;
  let normalized = line.trim().replace(/^(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+)/, '').replace(/[`*_]/g, '').replace(/[.!:]$/, '').toLowerCase();
  if (/^(?:do not|don't|never|avoid|forbid)\b/.test(normalized)) return undefined;
  let qualifier: string | undefined;
  const scope = /^(?:for (mobile app|backend)\s*[,;:]\s*|(mobile app|backend):\s*)/.exec(normalized);
  if (scope) { qualifier = scope[1] ?? scope[2]; normalized = normalized.slice(scope[0].length); }
  const prefix = '(?:please\\s+)?(?:use|prefer|run|invoke)\\s+';
  const suffix = '(?:\\s+for\\s+package\\s+commands)?';
  if (new RegExp(`^(?:${prefix}pnpm\\s+(?:instead of|rather than|not|never)\\s+npm|pnpm\\s+only)${suffix}$`).test(normalized.replace(/[()]/g, ''))) return { tool: 'pnpm', replaces: 'npm', ...(qualifier ? { qualifier } : {}) };
  if (new RegExp(`^(?:${prefix}uv\\s+(?:instead of|rather than|not|never)\\s+pip|uv\\s+only)${suffix}$`).test(normalized.replace(/[()]/g, ''))) return { tool: 'uv', replaces: 'pip', ...(qualifier ? { qualifier } : {}) };
  return undefined;
}
function contextDigest(repositoryRoot: string, location: string, text: string): string {
  const localKey = createHash('sha256').update(`ael:instruction-context-key:v1\0${repositoryRoot}`).digest();
  return createHmac('sha256', localKey).update(`${location}\0${text}`).digest('hex');
}
function compareConvention(left: ProjectToolConvention, right: ProjectToolConvention): number {
  const [leftLocation, leftLine] = splitSource(left.source); const [rightLocation, rightLine] = splitSource(right.source);
  return leftLocation.localeCompare(rightLocation) || leftLine - rightLine || left.tool.localeCompare(right.tool);
}
function splitSource(source: string): [string, number] { const split = source.lastIndexOf(':'); return [source.slice(0, split), Number(source.slice(split + 1))]; }
