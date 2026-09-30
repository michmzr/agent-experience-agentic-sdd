import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCandidateEvidenceResolver } from '../knowledge/evidence-resolver.js';
import { resolveRepository } from '../repository/local-repository.js';

type Observation = { readonly scenarioId: string; readonly revision: 1; readonly kind: 'pipeline'; readonly status: 'observed'; readonly evidence: Record<string, string | number | boolean> };

const entrypoint = resolve(dirname(fileURLToPath(import.meta.url)), '../cli.js');
const secret = `sk-${'v'.repeat(24)}`;

export function runPipeline(deadline: number): { observations: Observation[];
  aclReview: { status: 'observed'; reviewedCandidates: number; retrievedAdvice: number } } {
  const root = mkdtempSync(join(tmpdir(), 'ael-avb-b1-'));
  try {
    const project = join(root, 'project'); const dataDir = join(root, 'data');
    mkdirSync(project); mkdirSync(dataDir);
    const git = spawnSync('git', ['init', '-q', project], { encoding: 'utf8', timeout: remaining(deadline) });
    if (git.status !== 0) throw new Error('Benchmark repository setup failed.');
    const repositoryId = resolveRepository(project)?.id;
    if (!repositoryId) throw new Error('Benchmark repository identity unavailable.');
    writeFileSync(join(project, 'AGENTS.md'), 'Use pnpm rather than npm.\n');
    const tracked = spawnSync('git', ['add', 'AGENTS.md'], { cwd: project, encoding: 'utf8', timeout: remaining(deadline) });
    const committed = spawnSync('git', ['-c', 'user.name=AEL Benchmark', '-c', 'user.email=ael@example.invalid',
      'commit', '-q', '-m', 'Pin benchmark instruction'], { cwd: project, encoding: 'utf8', timeout: remaining(deadline) });
    if (tracked.status !== 0 || committed.status !== 0) throw new Error('Benchmark instruction setup failed.');
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
    hook({ session_id: 'avb-confirmation-session', hook_event_name: 'SessionStart', source: 'startup' });
    hook({ session_id: 'avb-confirmation-session', hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_use_id: 'avb-confirmation', tool_input: { command: 'pnpm install' } });
    const privateHook = command(['capture', 'hook', '--source', 'codex'], { session_id: 'avb-session', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_use_id: 'private-operation', tool_input: { command: `curl --token=${secret}` } });
    const privacyRejected = privateHook.status === 0 && privateHook.stderr.includes('AEL_CAPTURE_PRIVATE_INPUT') && !privateHook.stderr.includes(secret);
    if (!privacyRejected) throw new Error('Benchmark private hook was not rejected safely.');
    let drain = invoke(['capture', 'drain']) as { pending: number; committed: number; quarantined: number; claimed: number };
    while (drain.claimed !== 0 && remaining(deadline) > 1000) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      drain = invoke(['capture', 'status']) as typeof drain;
    }
    if (drain.pending !== 0 || drain.claimed !== 0 || drain.quarantined !== 0 || drain.committed < 6) throw new Error(`Benchmark drain did not commit all admissions: ${drain.pending},${drain.committed},${drain.quarantined},${drain.claimed}.`);
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
    invoke(['candidates', 'backfill', 'apply', '--repository-id', repositoryId]);
    const candidates = invoke(['candidates', 'list', '--repository-id', repositoryId]) as Array<{
      id: string; kind: string; statement: string; state: string }>;
    const candidate = candidates.find(row => row.kind === 'convention'
      && row.statement === 'Use pnpm instead of npm in this repository.');
    if (!candidate) throw new Error('Benchmark analyzed convention candidate is unavailable.');
    const witnessDatabase = new DatabaseSync(join(dataDir, 'experience.sqlite'), { readOnly: true, timeout: 2_000 });
    let observedId: string; let confirmedId: string;
    try {
      const readEvent = (session: string, sourceEvent: string): string => {
        const row = witnessDatabase.prepare('SELECT event_id FROM logical_evidence WHERE session_id = ? AND source_event_id = ?')
          .get(session, sourceEvent) as { event_id: string } | undefined;
        if (!row) throw new Error('Benchmark captured observation witness is unavailable.');
        return row.event_id;
      };
      observedId = readEvent('avb-session', 'avb-operation:pre');
      confirmedId = readEvent('avb-confirmation-session', 'avb-confirmation:pre');
    } finally { witnessDatabase.close(); }
    const resolver = new SqliteCandidateEvidenceResolver(join(dataDir, 'experience.sqlite'), 'avb-session');
    let instruction: { id: string; contextRevision: string };
    try {
      const matches = resolver.listInstructionContextEvidence(repositoryId).filter(entry =>
        entry.tool === 'pnpm' && entry.replaces === 'npm' && entry.applicability.scope === 'repository');
      if (matches.length !== 1) throw new Error('Benchmark instruction witness is ambiguous.');
      instruction = matches[0]!;
    } finally { resolver.close(); }
    const reviewPath = join(root, 'review.json');
    const review = (sessionId: string, target: string, evidenceId: string): { state: string } => {
      writeFileSync(reviewPath, JSON.stringify({ candidateId: candidate.id, sessionId, target,
        actorId: 'benchmark-reviewer', evidenceId, reviewedAt: new Date().toISOString() }));
      return invoke(['candidates', 'review', '--repository-id', repositoryId, '--input', reviewPath]) as { state: string };
    };
    if (review('avb-session', 'observed', observedId).state !== 'observed'
      || review('avb-confirmation-session', 'confirmed', confirmedId).state !== 'confirmed'
      || review('avb-session', 'verified', instruction.id).state !== 'verified') {
      throw new Error('Benchmark public candidate review did not reach verified.');
    }
    const verifiedCandidates = invoke(['candidates', 'list', '--repository-id', repositoryId, '--state', 'verified']) as Array<{ id: string }>;
    if (!verifiedCandidates.some(row => row.id === candidate.id)) throw new Error('Benchmark verified candidate is unavailable after restart.');
    invoke(['advice', 'configure', '--repository-id', repositoryId, '--enabled', 'true']);
    const advicePath = join(root, 'advice-context.json');
    writeFileSync(advicePath, JSON.stringify({ repositoryId, sessionId: 'avb-advice-session',
      operationSignature: 'operation:v1:benchmark', contextRevision: instruction.contextRevision,
      conditions: [], retrievalRef: 'benchmark-cli-retrieval' }));
    const advice = invoke(['advice', 'retrieve', '--input', advicePath]) as { status: string; entries: Array<{ candidateId: string }> };
    if (advice.status !== 'ready' || !advice.entries.some(entry => entry.candidateId === candidate.id)) {
      throw new Error('Benchmark public advice retrieval did not return verified candidate.');
    }
    return readOnlySnapshot(join(dataDir, 'experience.sqlite'), join(dataDir, 'capture-spool.sqlite'), (database, spool) => {
      const sessions = database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?').get('avb-session') as { count: number };
      const results = database.prepare("SELECT (SELECT COUNT(*) FROM capture_run_events WHERE source_event_id = ? AND capture_outcome = 'unknown') + (SELECT COUNT(*) FROM capture_events WHERE source_event_id = ? AND capture_outcome = 'unknown') AS count").get('avb-operation:post', 'avb-operation:post') as { count: number };
      const requests = database.prepare('SELECT COUNT(*) AS count FROM logical_evidence WHERE source_event_id = ?').get('avb-operation:pre') as { count: number };
      const resumed = database.prepare("SELECT COUNT(*) AS count FROM capture_runs WHERE origin = 'resume'").get() as { count: number };
      const scoped = database.prepare('SELECT payload_json FROM capture_instruction_contexts LIMIT 1').get() as { payload_json: string } | undefined;
      const verified = database.prepare("SELECT COUNT(*) AS count FROM imported_typed_evidence WHERE evidence_id = ? AND resolution = 'resolved' AND origin = 'user-declared'").get('avb-verification') as { count: number };
      const receiptCount = spool.prepare('SELECT COUNT(*) AS count FROM capture_receipts').get() as { count: number };
      const privateReceipts = spool.prepare("SELECT COUNT(*) AS count FROM capture_receipts WHERE disposition = 'privacy-redaction'").get() as { count: number };
      if (sessions.count !== 1 || resumed.count !== 1 || requests.count !== 1 || results.count !== 1 || verified.count !== 1 || receiptCount.count < 8 || privateReceipts.count !== 1 || !scoped?.payload_json.includes('pnpm')) throw new Error(`Benchmark persisted relation failed: ${[sessions.count, resumed.count, requests.count, results.count, verified.count, receiptCount.count, privateReceipts.count, Number(scoped?.payload_json.includes('pnpm'))].join(',')}.`);
      if (readFileSync(join(dataDir, 'experience.sqlite')).includes(Buffer.from(secret)) || readFileSync(join(dataDir, 'capture-spool.sqlite')).includes(Buffer.from(secret))) throw new Error('Benchmark private input persisted.');
      const observations: Observation[] = [
        { scenarioId: 'resume', revision: 1, kind: 'pipeline', status: 'observed', evidence: { retainedSessions: sessions.count, resumedRuns: resumed.count } },
        { scenarioId: 'unknown-result', revision: 1, kind: 'pipeline', status: 'observed', evidence: { retainedUnknownResults: results.count } },
        { scenarioId: 'recovery', revision: 1, kind: 'pipeline', status: 'observed', evidence: { retainedReceipts: receiptCount.count, rejectedPrivateReceipts: privateReceipts.count, healthyRowsSelected: recovery.selected, committed: drain.committed } },
        { scenarioId: 'scoped-convention', revision: 1, kind: 'pipeline', status: 'observed', evidence: { retainedScopedContext: true, analyzed: typeof analysis === 'object', reportAvailable: typeof report === 'object', reviewedCandidate: true, retrievedAdvice: true } },
        { scenarioId: 'typed-verification', revision: 1, kind: 'pipeline', status: 'observed', evidence: { resolvedUserAnnotations: verified.count, crossScopeRejected, forgedAuthorityRejected, importAccepted: typeof imported === 'object' } }
      ];
      return { observations, aclReview: { status: 'observed' as const, reviewedCandidates: 1, retrievedAdvice: advice.entries.length } };
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function readOnlySnapshot<T>(databasePath: string, spoolPath: string,
  read: (database: DatabaseSync, spool: DatabaseSync) => T): T {
  for (let attempt = 0; attempt < 3; attempt++) {
    let database: DatabaseSync | undefined; let spool: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true, timeout: 2_000 });
      spool = new DatabaseSync(spoolPath, { readOnly: true, timeout: 2_000 });
      return read(database, spool);
    } catch (error) {
      const sqlite = error as { code?: string; errcode?: number; message?: string };
      const locked = sqlite.errcode === 5 || sqlite.errcode === 6 || sqlite.code === 'SQLITE_BUSY'
        || sqlite.code === 'SQLITE_LOCKED' || sqlite.message === 'database is locked'
        || sqlite.message === 'database schema is locked';
      if (!locked || attempt === 2) throw error;
    } finally { spool?.close(); database?.close(); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
  }
  throw new Error('Benchmark snapshot retry limit reached.');
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error('Benchmark run budget exhausted.');
  return value;
}
