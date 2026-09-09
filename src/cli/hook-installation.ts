import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TerminalHost } from '../review/terminal-prompt.js';

export type HookSource = 'codex' | 'cursor';
export interface HookSelectionPrompt { choose(): Promise<readonly HookSource[]>; }
export type HookInstallationStatus =
  | { readonly status: 'ready'; readonly sources: readonly { readonly source: HookSource; readonly status: 'ready' }[] }
  | { readonly status: 'not-ready'; readonly sources: readonly { readonly source: HookSource; readonly status: 'unavailable'; readonly code: string }[] };

const sources: readonly HookSource[] = ['codex', 'cursor'];

export class TerminalHookSelectionPrompt implements HookSelectionPrompt {
  constructor(private readonly terminal: TerminalHost) {}

  async choose(): Promise<readonly HookSource[]> {
    this.terminal.write('Select hooks to install (comma-separated):\n1. Codex\n2. Cursor\n');
    const answer = await this.terminal.readLine('Select one or more numbers: ');
    return parseHookSelection(answer.split(',').map((value) => value.trim() === '1' ? 'codex' : value.trim() === '2' ? 'cursor' : value.trim()).join(','));
  }
}

export function parseHookSelection(value: string): readonly HookSource[] {
  const selected = value.split(',').map((source) => source.trim()).filter(Boolean);
  if (!selected.length) throw new SyntaxError('At least one hook must be selected.');
  if (selected.some((source) => source !== 'codex' && source !== 'cursor')) throw new SyntaxError('Hooks must be codex or cursor.');
  return sources.filter((source) => selected.includes(source));
}

export function installHooks(input: { repositoryRoot: string; sources: readonly HookSource[]; cliEntrypoint: string; repositoryId?: string }): void {
  const selected = checkedSources(input.sources);
  const updates = selected.map((source) => ({ source, path: configurationPath(input.repositoryRoot, source) }));
  for (const update of updates) readConfiguration(update.path);
  const wrapperPath = join(input.repositoryRoot, '.agents', 'hooks', 'ael-passive-capture.sh');
  mkdirSync(dirname(wrapperPath), { recursive: true });
  writeAtomic(wrapperPath, wrapper(input.cliEntrypoint, input.repositoryId), 0o755);
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
    const configuration = readConfigurationForVerification(path);
    const valid = configuration !== undefined && existsSync(input.cliEntrypoint) && executable(wrapperPath) && includesAelHook(configuration, source, wrapperPath);
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
function readConfigurationForVerification(path: string): Record<string, unknown> | undefined {
  try { return readConfiguration(path); } catch { return undefined; }
}
function merge(current: Record<string, unknown>, source: HookSource, root: string): Record<string, unknown> {
  const hooks = typeof current.hooks === 'object' && current.hooks !== null && !Array.isArray(current.hooks) ? current.hooks as Record<string, unknown> : {};
  const command = source === 'codex' ? `"${join(root, '.agents/hooks/ael-passive-capture.sh')}" codex` : '.agents/hooks/ael-passive-capture.sh cursor';
  const names = source === 'codex' ? ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse'] : ['sessionStart', 'sessionEnd', 'preToolUse', 'postToolUse'];
  const updated = Object.fromEntries(names.map((name) => {
    const groups = Array.isArray(hooks[name]) ? hooks[name] as unknown[] : [];
    const replacement = replaceAelCommand(groups, source, command);
    const installed = source === 'codex' ? { hooks: [{ type: 'command', command }] } : { command };
    return [name, replacement.replaced ? replacement.value : [...groups, installed]];
  }));
  return { ...current, ...(source === 'cursor' ? { version: 1 } : {}), hooks: { ...hooks, ...updated } };
}
function includesAelHook(config: Record<string, unknown>, source: HookSource, wrapperPath: string): boolean {
  const expected = source === 'codex' ? `"${wrapperPath}" codex` : '.agents/hooks/ael-passive-capture.sh cursor';
  const commands = strings(config);
  return commands.includes(expected) || (source === 'codex' && commands.includes('"$(git rev-parse --show-toplevel)/.agents/hooks/ael-passive-capture.sh" codex'));
}
function replaceAelCommand(value: unknown, source: HookSource, command: string): { value: unknown; replaced: boolean } {
  if (Array.isArray(value)) {
    let replaced = false;
    const items = value.map((item) => {
      const replacement = replaceAelCommand(item, source, command);
      replaced ||= replacement.replaced;
      return replacement.value;
    });
    return { value: items, replaced };
  }
  if (!value || typeof value !== 'object') return { value, replaced: false };
  const record = value as Record<string, unknown>;
  if (typeof record.command === 'string' && isAelCommand(record.command, source)) {
    return { value: { ...record, command }, replaced: true };
  }
  let replaced = false;
  const entries = Object.entries(record).map(([key, item]) => {
    const replacement = replaceAelCommand(item, source, command);
    replaced ||= replacement.replaced;
    return [key, replacement.value];
  });
  return { value: Object.fromEntries(entries), replaced };
}
function isAelCommand(command: string, source: HookSource): boolean {
  return command.includes('ael-passive-capture.sh') && command.trim().endsWith(` ${source}`);
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
function executable(path: string): boolean {
  try { return existsSync(path) && (statSync(path).mode & 0o111) !== 0; } catch { return false; }
}
function writeAtomic(path: string, content: string, mode: number): void { const temporary = `${path}.ael-tmp`; writeFileSync(temporary, content, { mode }); chmodSync(temporary, mode); renameSync(temporary, path); }
function wrapper(cliEntrypoint: string, repositoryId?: string): string {
  const repositoryArgument = repositoryId === undefined ? '' : ` --repository-id "${repositoryId}"`;
  return [
    '#!/bin/sh', '', 'source_name="$1"', `cli="${cliEntrypoint}"`, '',
    'if [ ! -f "$cli" ]; then', "  printf '%s\\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2", '  exit 0', 'fi', '',
    'node_is_compatible() {', `  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 17) ? 0 : 1)' >/dev/null 2>&1`, '}', '',
    'node_command=$(command -v node 2>/dev/null || true)', 'if [ -n "$node_command" ] && ! node_is_compatible "$node_command"; then', '  node_command=', 'fi', 'if [ -z "$node_command" ]; then', '  for candidate in \\',
    '    "${NVM_BIN:-}/node" \\', '    "${VOLTA_HOME:-}/bin/node" \\', '    "${HOME:-}/.knode/bin/node" \\', '    "${HOME:-}/.volta/bin/node" \\', '    "/opt/homebrew/bin/node" \\', '    "/usr/local/bin/node"',
    '  do', '    if [ -x "$candidate" ] && node_is_compatible "$candidate"; then', '      node_command="$candidate"', '      break', '    fi', '  done', 'fi',
    'if [ -z "$node_command" ]; then', "  printf '%s\\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2", '  exit 0', 'fi', '',
    `"$node_command" "$cli" capture hook --source "$source_name"${repositoryArgument} || {`, "  printf '%s\\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2", '  exit 0', '}', '', 'exit 0', ''
  ].join('\n');
}
