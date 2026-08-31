import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type HookSource = 'codex' | 'cursor';
export interface HookSelectionPrompt { choose(): Promise<readonly HookSource[]>; }
export type HookInstallationStatus =
  | { readonly status: 'ready'; readonly sources: readonly { readonly source: HookSource; readonly status: 'ready' }[] }
  | { readonly status: 'not-ready'; readonly sources: readonly { readonly source: HookSource; readonly status: 'unavailable'; readonly code: string }[] };

const sources: readonly HookSource[] = ['codex', 'cursor'];

export function parseHookSelection(value: string): readonly HookSource[] {
  const selected = value.split(',').map((source) => source.trim()).filter(Boolean);
  if (!selected.length) throw new SyntaxError('At least one hook must be selected.');
  if (selected.some((source) => source !== 'codex' && source !== 'cursor')) throw new SyntaxError('Hooks must be codex or cursor.');
  return sources.filter((source) => selected.includes(source));
}

export function installHooks(input: { repositoryRoot: string; sources: readonly HookSource[]; cliEntrypoint: string }): void {
  const selected = checkedSources(input.sources);
  const updates = selected.map((source) => ({ source, path: configurationPath(input.repositoryRoot, source) }));
  for (const update of updates) readConfiguration(update.path);
  const wrapperPath = join(input.repositoryRoot, '.agents', 'hooks', 'ael-passive-capture.sh');
  mkdirSync(dirname(wrapperPath), { recursive: true });
  writeAtomic(wrapperPath, wrapper(input.cliEntrypoint), 0o755);
  for (const update of updates) {
    mkdirSync(dirname(update.path), { recursive: true });
    const current = readConfiguration(update.path);
    writeAtomic(update.path, JSON.stringify(merge(current, update.source, input.repositoryRoot), null, 2) + '\n', 0o644);
  }
}

export function verifyInstalledHooks(input: { repositoryRoot: string; sources: readonly HookSource[]; cliEntrypoint: string }): HookInstallationStatus {
  const selected = checkedSources(input.sources);
  const wrapperPath = join(input.repositoryRoot, '.agents', 'hooks', 'ael-passive-capture.sh');
  const unavailable = selected.flatMap((source) => {
    const path = configurationPath(input.repositoryRoot, source);
    const config = readConfiguration(path);
    const valid = existsSync(input.cliEntrypoint) && existsSync(wrapperPath) && (statSync(wrapperPath).mode & 0o111) !== 0 && includesAelHook(config, source);
    return valid ? [] : [{ source, status: 'unavailable' as const, code: 'HOOK_UNAVAILABLE' }];
  });
  return unavailable.length ? { status: 'not-ready', sources: unavailable } : { status: 'ready', sources: selected.map((source) => ({ source, status: 'ready' as const })) };
}

function checkedSources(value: readonly HookSource[]): readonly HookSource[] {
  if (!value.length) throw new SyntaxError('At least one hook must be selected.');
  return sources.filter((source) => value.includes(source));
}
function configurationPath(root: string, source: HookSource): string { return join(root, source === 'codex' ? '.codex/hooks.json' : '.cursor/hooks.json'); }
function readConfiguration(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new SyntaxError(`Hook configuration is not valid JSON: ${path}.`); }
}
function merge(current: Record<string, unknown>, source: HookSource, root: string): Record<string, unknown> {
  const hooks = typeof current.hooks === 'object' && current.hooks !== null && !Array.isArray(current.hooks) ? current.hooks as Record<string, unknown> : {};
  const command = source === 'codex' ? `"${join(root, '.agents/hooks/ael-passive-capture.sh')}" codex` : '.agents/hooks/ael-passive-capture.sh cursor';
  const names = source === 'codex' ? ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse'] : ['sessionStart', 'sessionEnd', 'preToolUse', 'postToolUse'];
  return { ...current, ...(source === 'cursor' ? { version: 1 } : {}), hooks: { ...hooks, ...Object.fromEntries(names.map((name) => [name, source === 'codex' ? [{ hooks: [{ type: 'command', command }] }] : [{ command }]])) } };
}
function includesAelHook(config: Record<string, unknown>, source: HookSource): boolean { return JSON.stringify(config).includes(source === 'codex' ? 'ael-passive-capture.sh" codex' : 'ael-passive-capture.sh cursor'); }
function writeAtomic(path: string, content: string, mode: number): void { const temporary = `${path}.ael-tmp`; writeFileSync(temporary, content, { mode }); chmodSync(temporary, mode); renameSync(temporary, path); }
function wrapper(cliEntrypoint: string): string { return `#!/bin/sh\nrepository_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0\nnode "${cliEntrypoint}" capture hook --source "$1" || { printf '%s\\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2; exit 0; }\n`; }
