import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { managedEventSupported } from '../cli/hook-installation.js';
import { resolveManagedTarget } from './inspection.js';
import { readBuildManifest, verifyBuild } from './build-manifest.js';

export function qualifyInstallation(root: string) {
  const target = resolveManagedTarget(root);
  const unavailable = { status: 'unqualified', evidence: 'controlled-fixture', startup: false, resume: false, end: false, correlatedResult: false };
  const wrapper = join(root, '.agents/hooks/ael-passive-capture.sh');
  if (!target.target || !existsSync(target.target) || (statSync(wrapper).mode & 0o111) === 0) return unavailable;
  const packageRoot = resolve(dirname(target.target), '../..');
  let buildId: string;
  try { const manifest = readBuildManifest(packageRoot); verifyBuild(packageRoot, manifest); buildId = manifest.buildId; } catch { return unavailable; }
  const configuration = join(root, '.codex/hooks.json');
  if (!existsSync(configuration)) return unavailable;
  const hooks = JSON.parse(readFileSync(configuration, 'utf8')).hooks;
  const commands = [`"${join(root, '.agents/hooks/ael-passive-capture.sh')}" codex`, '"$(git rev-parse --show-toplevel)/.agents/hooks/ael-passive-capture.sh" codex'];
  const supported = (event: string, value: string): boolean => commands.some(command => managedEventSupported(hooks?.[event], command, value));
  const directory = mkdtempSync(join(tmpdir(), 'ael-qualification-'));
  const data = join(directory, 'data');
  const session = `abi-${randomUUID()}`;
  try {
    mkdirSync(data);
    // Invoke the recognized installed executable through its configured direct contract.
    const deliveries = [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'abi-action', tool_input: { command: 'git status --short' } },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'abi-action', tool_input: { command: 'git status --short' }, exit_status: 0 },
      { hook_event_name: 'SessionEnd' },
      { hook_event_name: 'SessionStart', source: 'resume' }
    ];
    let deliveryFailed = false;
    for (const payload of deliveries) {
      const value = payload.hook_event_name === 'SessionStart' ? payload.source! : payload.hook_event_name === 'SessionEnd' ? 'end' : 'Bash';
      if (!supported(payload.hook_event_name, value)) continue;
      const result = spawnSync(wrapper, ['codex'], { cwd: root, env: { ...process.env, AEL_DATA_DIR: data, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` }, input: JSON.stringify({ ...payload, session_id: session, cwd: root }), encoding: 'utf8', timeout: 10000 });
      if (result.status !== 0 || result.stderr.includes('AEL_CAPTURE_UNAVAILABLE')) deliveryFailed = true;
    }
    const deadline = Date.now() + 10000;
    let facts = { startup: false, resume: false, end: false, correlatedResult: false };
    do {
      spawnSync(process.execPath, [target.target, 'capture', 'drain', '--data-dir', data, '--json'], { cwd: root, encoding: 'utf8', timeout: 10000 });
      if (existsSync(join(data, 'experience.sqlite'))) {
        const db = new DatabaseSync(join(data, 'experience.sqlite'), { readOnly: true });
        try {
          const signals = db.prepare('SELECT kind, start_origin FROM lifecycle_signals WHERE conversation_id = ?').all(session) as { kind: string; start_origin: string | null }[];
          const result = db.prepare("SELECT COUNT(*) AS count FROM capture_events p JOIN capture_events a ON p.related_event_id = a.source_event_id AND p.source = a.source JOIN events pe ON pe.id = p.event_id JOIN events ae ON ae.id = a.event_id AND ae.session_id = pe.session_id WHERE pe.session_id = ? AND p.phase = 'post-result' AND a.phase = 'pre-action' AND p.capture_outcome = 'succeeded' AND pe.exit_status = 0").get(session) as { count: number };
          facts = { startup: signals.some(s => s.start_origin === 'startup'), resume: signals.some(s => s.start_origin === 'resume'), end: signals.some(s => s.kind === 'end'), correlatedResult: result.count === 1 };
        } catch { /* The detached drain may not have published its first schema yet. */ }
        finally { db.close(); }
      }
      if (facts.startup && facts.resume && facts.end && facts.correlatedResult) break;
      if (!supported('SessionStart', 'resume')) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    } while (Date.now() < deadline);
    return { status: !deliveryFailed && facts.startup && facts.resume && facts.end && facts.correlatedResult ? 'qualified' : 'unqualified', evidence: 'controlled-fixture', buildId, ...facts };
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
