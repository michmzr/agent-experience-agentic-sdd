import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveRepository } from '../repository/local-repository.js';

type Observation = { readonly scenarioId: string; readonly revision: 1; readonly kind: 'pipeline'; readonly status: 'observed'; readonly evidence: Record<string, string | number | boolean> };

const entrypoint = resolve(dirname(fileURLToPath(import.meta.url)), '../cli.js');
const secret = `sk-${'v'.repeat(24)}`;

export function runPipeline(deadline: number): { observations: Observation[]; aclReview: { status: 'unsupported'; reason: string } } {
  const root = mkdtempSync(join(tmpdir(), 'ael-avb-b1-'));
  try {
    const project = join(root, 'project'); const dataDir = join(root, 'data');
    mkdirSync(project); mkdirSync(dataDir);
    const git = spawnSync('git', ['init', '-q', project], { encoding: 'utf8', timeout: remaining(deadline) });
    if (git.status !== 0) throw new Error('Benchmark repository setup failed.');
    const repositoryId = resolveRepository(project)?.id;
    if (!repositoryId) throw new Error('Benchmark repository identity unavailable.');
    writeFileSync(join(project, 'AGENTS.md'), 'Use pnpm rather than npm.\n');
    const command = (args: string[], input?: unknown) => {
      const child = spawnSync(process.execPath, [entrypoint, ...args, '--data-dir', dataDir, ...(args[0] === 'capture' && args[1] === 'hook' ? [] : ['--json'])], {
        cwd: project, encoding: 'utf8', timeout: remaining(deadline), maxBuffer: 256 * 1024,
        ...(input === undefined ? {} : { input: JSON.stringify(input) })
      });
      return child;
    };
    const invoke = (args: string[], input?: unknown): unknown => {
      const child = command(args, input);
      if (child.error || child.status !== 0 || child.stderr) {
        const diagnostic = child.stdout ? (JSON.parse(child.stdout) as { error?: { code?: string; message?: string } }).error : undefined;
        throw new Error(`Benchmark public command failed: ${args.slice(0, 2).join(' ')}${diagnostic ? ` (${diagnostic.code}: ${diagnostic.message})` : ''}.`);
      }
      return child.stdout ? JSON.parse(child.stdout) as unknown : undefined;
    };
    invoke(['init', '--scope', 'repo', '--hooks', 'codex']);
    const hook = (event: Record<string, unknown>): void => { invoke(['capture', 'hook', '--source', 'codex'], event); };
    hook({ session_id: 'avb-session', hook_event_name: 'SessionStart', source: 'startup' });
    hook({ session_id: 'avb-session', hook_event_name: 'SessionEnd' });
    hook({ session_id: 'avb-session', hook_event_name: 'SessionStart', source: 'resume' });
    hook({ session_id: 'avb-session', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'avb-operation', tool_input: { command: 'npm install' } });
    hook({ session_id: 'avb-session', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'avb-operation', tool_input: { command: 'npm install' }, tool_response: { output: secret } });
    const privateHook = command(['capture', 'hook', '--source', 'codex'], { session_id: 'avb-session', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_use_id: 'private-operation', tool_input: { command: `curl --token=${secret}` } });
    const privacyRejected = privateHook.status === 0 && privateHook.stderr.includes('AEL_CAPTURE_PRIVATE_INPUT') && !privateHook.stderr.includes(secret);
    if (!privacyRejected) throw new Error('Benchmark private hook was not rejected safely.');
    let drain = invoke(['capture', 'drain']) as { pending: number; committed: number; quarantined: number; claimed: number };
    while (drain.claimed !== 0 && remaining(deadline) > 1000) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      drain = invoke(['capture', 'status']) as typeof drain;
    }
    if (drain.pending !== 0 || drain.claimed !== 0 || drain.quarantined !== 0 || drain.committed < 4) throw new Error(`Benchmark drain did not commit all admissions: ${drain.pending},${drain.committed},${drain.quarantined},${drain.claimed}.`);
    const analysis = invoke(['analysis', 'run', '--repository-id', repositoryId]);
    const report = invoke(['analysis', 'report', '--repository-id', repositoryId, '--schema-version', '3']);
    const inputPath = join(root, 'annotation.json');
    writeFileSync(inputPath, JSON.stringify({ version: 1, producer: { kind: 'local-annotation', version: '1', namespace: 'controlled-test' },
      repositoryId, sessionId: 'avb-session', contextRevision: 'rev-1', records: [{ id: 'avb-verification', origin: 'user-declared',
        kind: 'task-verification', state: 'succeeded', decisionKey: 'decision-1', scopeKey: 'task-1', reasonClass: 'verification',
        operation: { source: 'codex', sourceEventId: 'avb-operation:pre' } }] }));
    const imported = invoke(['evidence', 'import', '--repository-id', repositoryId, '--input', inputPath]);
    const wrongScope = { version: 1, producer: { kind: 'local-annotation', version: '1', namespace: 'controlled-test' },
      repositoryId: 'foreign-repository', sessionId: 'avb-session', contextRevision: 'rev-1', records: [{ id: 'foreign-claim',
        origin: 'user-declared', kind: 'task-verification', state: 'succeeded', decisionKey: 'decision-1', scopeKey: 'task-1',
        reasonClass: 'verification', operation: { source: 'codex', sourceEventId: 'avb-operation:pre' } }] };
    writeFileSync(inputPath, JSON.stringify(wrongScope));
    const crossScopeRejected = command(['evidence', 'import', '--repository-id', repositoryId, '--input', inputPath]).status !== 0;
    if (!crossScopeRejected) throw new Error('Benchmark cross-scope annotation was accepted.');
    writeFileSync(inputPath, JSON.stringify({ ...wrongScope, repositoryId, records: [{ ...wrongScope.records[0], id: 'forged-authority', origin: 'source-observed' }] }));
    const forgedAuthorityRejected = command(['evidence', 'import', '--repository-id', repositoryId, '--input', inputPath]).status !== 0;
    if (!forgedAuthorityRejected) throw new Error('Benchmark forged verification authority was accepted.');
    const planPath = join(root, 'recovery-plan.json');
    const recovery = invoke(['capture', 'recovery', 'plan', '--repository-id', repositoryId, '--output', planPath]) as { selected: number };
    if (recovery.selected !== 0) throw new Error('Benchmark healthy capture selected for recovery.');
    const database = new DatabaseSync(join(dataDir, 'experience.sqlite'), { readOnly: true });
    const spool = new DatabaseSync(join(dataDir, 'capture-spool.sqlite'), { readOnly: true });
    try {
      const sessions = database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?').get('avb-session') as { count: number };
      const results = database.prepare("SELECT (SELECT COUNT(*) FROM capture_run_events WHERE source_event_id = ? AND capture_outcome = 'unknown') + (SELECT COUNT(*) FROM capture_events WHERE source_event_id = ? AND capture_outcome = 'unknown') AS count").get('avb-operation:post', 'avb-operation:post') as { count: number };
      const requests = database.prepare('SELECT COUNT(*) AS count FROM logical_evidence WHERE source_event_id = ?').get('avb-operation:pre') as { count: number };
      const resumed = database.prepare("SELECT COUNT(*) AS count FROM capture_runs WHERE origin = 'resume'").get() as { count: number };
      const scoped = database.prepare('SELECT payload_json FROM capture_instruction_contexts LIMIT 1').get() as { payload_json: string } | undefined;
      const verified = database.prepare("SELECT COUNT(*) AS count FROM imported_typed_evidence WHERE evidence_id = ? AND resolution = 'resolved' AND origin = 'user-declared'").get('avb-verification') as { count: number };
      const receiptCount = spool.prepare('SELECT COUNT(*) AS count FROM capture_receipts').get() as { count: number };
      const privateReceipts = spool.prepare("SELECT COUNT(*) AS count FROM capture_receipts WHERE disposition = 'privacy-redaction'").get() as { count: number };
      if (sessions.count !== 1 || resumed.count !== 1 || requests.count !== 1 || results.count !== 1 || verified.count !== 1 || receiptCount.count < 6 || privateReceipts.count !== 1 || !scoped?.payload_json.includes('pnpm')) throw new Error(`Benchmark persisted relation failed: ${[sessions.count, resumed.count, requests.count, results.count, verified.count, receiptCount.count, privateReceipts.count, Number(scoped?.payload_json.includes('pnpm'))].join(',')}.`);
      if (readFileSync(join(dataDir, 'experience.sqlite')).includes(Buffer.from(secret)) || readFileSync(join(dataDir, 'capture-spool.sqlite')).includes(Buffer.from(secret))) throw new Error('Benchmark private input persisted.');
      return { observations: [
        { scenarioId: 'resume', revision: 1, kind: 'pipeline', status: 'observed', evidence: { retainedSessions: sessions.count, resumedRuns: resumed.count } },
        { scenarioId: 'unknown-result', revision: 1, kind: 'pipeline', status: 'observed', evidence: { retainedUnknownResults: results.count } },
        { scenarioId: 'recovery', revision: 1, kind: 'pipeline', status: 'observed', evidence: { retainedReceipts: receiptCount.count, rejectedPrivateReceipts: privateReceipts.count, healthyRowsSelected: recovery.selected, committed: drain.committed } },
        { scenarioId: 'scoped-convention', revision: 1, kind: 'pipeline', status: 'observed', evidence: { retainedScopedContext: true, analyzed: typeof analysis === 'object', reportAvailable: typeof report === 'object' } },
        { scenarioId: 'typed-verification', revision: 1, kind: 'pipeline', status: 'observed', evidence: { resolvedUserAnnotations: verified.count, crossScopeRejected, forgedAuthorityRejected, importAccepted: typeof imported === 'object' } }
      ], aclReview: { status: 'unsupported', reason: 'No public ACL candidate review command is available.' } };
    } finally { database.close(); spool.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error('Benchmark run budget exhausted.');
  return value;
}
