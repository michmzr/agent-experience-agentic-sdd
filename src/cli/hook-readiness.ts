import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { ExperienceStore } from '../storage/experience-store.js';
import { loadProjectSettings } from '../config/project-settings.js';

export type HookReadinessSource = 'codex' | 'cursor';
export type HookReadinessResult =
  | { readonly status: 'ready'; readonly sources: readonly { readonly source: HookReadinessSource; readonly status: 'ready' }[] }
  | { readonly status: 'not-ready'; readonly code: string; readonly sources: readonly { readonly source: HookReadinessSource; readonly status: 'ready' }[] };

export interface HookReadinessOptions {
  readonly worktreePath: string;
  readonly temporaryRoot?: string;
}

const sources: readonly HookReadinessSource[] = ['codex', 'cursor'];

export async function verifyHookReadiness(options: HookReadinessOptions): Promise<HookReadinessResult> {
  const root = resolveWorktree(options.worktreePath);
  if (root === undefined) return notReady('WORKTREE_INVALID');
  for (const [path, code] of [
    ['.codex/hooks.json', 'CODEX_CONFIG_MISSING'], ['.cursor/hooks.json', 'CURSOR_CONFIG_MISSING'],
    ['.agents/hooks/ael-passive-capture.sh', 'WRAPPER_MISSING'], ['dist/src/cli.js', 'BUILD_MISSING']
  ] as const) if (!existsSync(join(root, path))) return notReady(code);

  const dataDir = mkdtempSync(join(options.temporaryRoot ?? '/tmp', 'ael-hook-readiness-'));
  try {
    const ready: Array<{ source: HookReadinessSource; status: 'ready' }> = [];
    for (const source of sources) {
      if (!await verifySource(root, dataDir, source)) return notReady(`${source.toUpperCase()}_DELIVERY_TIMEOUT`, ready);
      ready.push({ source, status: 'ready' });
    }
    return { status: 'ready', sources: ready };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function resolveWorktree(path: string): string | undefined {
  try {
    const root = realpathSync(path);
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
    return result.status === 0 && realpathSync(result.stdout.trim()) === root ? root : undefined;
  } catch { return undefined; }
}

async function verifySource(root: string, dataDir: string, source: HookReadinessSource): Promise<boolean> {
  const sessionId = `readiness-${source}`;
  const toolId = `${sessionId}-tool`;
  const eventNames = source === 'codex'
    ? ['SessionStart', 'PreToolUse', 'PostToolUse', 'SessionEnd'] as const
    : ['sessionStart', 'preToolUse', 'postToolUse', 'sessionEnd'] as const;
  for (const eventName of eventNames) {
    const payload = source === 'codex'
      ? { session_id: sessionId, cwd: root, hook_event_name: eventName, ...(eventName === 'SessionStart' ? { source: 'startup' } : {}), ...(eventName === 'PreToolUse' || eventName === 'PostToolUse' ? { tool_name: 'Bash', tool_use_id: toolId, tool_input: { command: 'git status --short' } } : {}) }
      : { conversation_id: sessionId, cwd: root, hook_event_name: eventName, ...(eventName === 'preToolUse' || eventName === 'postToolUse' ? { tool_name: 'Shell', tool_use_id: toolId, tool_input: { command: 'git status --short' } } : {}) };
    const result = spawnSync('/bin/sh', ['.agents/hooks/ael-passive-capture.sh', source], { cwd: root, env: { ...process.env, AEL_DATA_DIR: dataDir }, input: JSON.stringify(payload), encoding: 'utf8' });
    if (result.status !== 0 || result.stdout !== '' || result.stderr !== '') return false;
  }
  const deadline = Date.now() + loadProjectSettings(root).captureDeliveryDeadlineMs;
  while (Date.now() <= deadline) {
    if (hasCompleteDelivery(dataDir, source)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function hasCompleteDelivery(dataDir: string, source: HookReadinessSource): boolean {
  let store: ExperienceStore | undefined;
  try {
    store = new ExperienceStore(join(dataDir, 'experience.sqlite'));
    const events = store.listCapturedEventsPage().entries.filter((event) => event.source === source);
    const sessionId = events[0]?.sessionId;
    return sessionId !== undefined && events.length === 2 && events.every((event) => event.sessionId === sessionId)
      && store.loadSession(sessionId)?.endedAt !== undefined;
  } catch { return false; }
  finally { try { store?.close(); } catch { /* the next poll retries */ } }
}

function notReady(code: string, sources: readonly { readonly source: HookReadinessSource; readonly status: 'ready' }[] = []): HookReadinessResult {
  return { status: 'not-ready', code, sources };
}
