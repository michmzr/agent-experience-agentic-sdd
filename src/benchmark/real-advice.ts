import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

import type { HostAdviceExposureScope } from '../advice/codex-exposure.js';
import { AdvisoryUsageStore } from '../advice/usage.js';
import { observeVerifiedCodexCliJsonChild } from '../capture/adapters/codex-cli-json.js';
import type { NormalizedCaptureEvent } from '../capture/contracts.js';
import { runCli } from '../cli.js';
import type { RepositoryId, SessionId } from '../domain/types.js';
import { qualifiedCodexCli, spawnVerifiedCodexExec } from '../host/codex-cli-launcher.js';
import { CandidateRepository } from '../knowledge/candidate-repository.js';
import { operationSignatureFromStoredJson } from '../knowledge/evidence-resolver.js';
import { recordPackageManagerFact } from '../knowledge/package-manager-fact.js';
import { resolveRepository } from '../repository/local-repository.js';
import { ExperienceStore } from '../storage/experience-store.js';
import { CodexTrialProjection } from './codex-trial.js';

export interface RealAdviceSeed {
  readonly repositoryId: RepositoryId;
  readonly candidateId: string;
  readonly contextRevision: string;
  readonly operationSignature: string;
}

const trustedSeeds = new WeakSet<RealAdviceSeed>();
interface SourceRun { readonly sessionId: SessionId; readonly events: readonly NormalizedCaptureEvent[];
  readonly sourceOperation: NormalizedCaptureEvent; readonly checkOperation: NormalizedCaptureEvent }

export const realAdviceSourcePrompt = 'Run exactly cat packages/app/package.json once, then run exactly pnpm --version once as a separate shell command. Do not change files.';

/** Two actual Codex A sessions supply observed and confirmed operations; the tracked file supplies verification. */
export async function prepareRealAdviceSeed(root: string, dataDir: string, binaryPath: string): Promise<RealAdviceSeed> {
  const repositoryId = resolveRepository(root)?.id as RepositoryId | undefined;
  if (!repositoryId) throw new TypeError('Advice repository is unavailable.');
  const first = await observeSourceRead(root, binaryPath);
  const second = await observeSourceRead(root, binaryPath);
  if (first.sessionId === second.sessionId) throw new TypeError('Source sessions must be independent.');
  const databasePath = join(dataDir, 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  try {
    store.registerRepository({ id: repositoryId, root, observedAt: new Date().toISOString() });
    for (const source of [first, second]) {
      store.appendIncremental({ session: { id: source.sessionId, source: 'codex', repositoryId,
        startedAt: source.sourceOperation.occurredAt } });
      for (const event of source.events) store.appendIncremental({ event });
    }
  } finally { store.close(); }
  const fact = recordPackageManagerFact(databasePath, repositoryId, first.sessionId,
    { scope: 'subproject', path: 'packages/app' });
  const candidates = new CandidateRepository(databasePath);
  const candidate = candidates.register({ repositoryId, kind: 'project-fact', source: 'manual-review',
    originId: first.sessionId, propositionKey: fact.factKey, applicability: fact.applicability,
    statement: 'packages/app uses pnpm@12.6.0.' });
  candidates.close();
  const reviewPath = join(dataDir, 'review.json');
  for (const [sessionId, target, evidenceId] of [
    [first.sessionId, 'observed', first.sourceOperation.id],
    [second.sessionId, 'confirmed', second.sourceOperation.id],
    [first.sessionId, 'verified', fact.evidenceId]
  ] as const) {
    writeFileSync(reviewPath, JSON.stringify({ candidateId: candidate.id, sessionId, target,
      actorId: 'avb-controlled-reviewer', evidenceId, reviewedAt: new Date().toISOString() }));
    const result = runCli(['candidates', 'review', '--repository-id', repositoryId, '--input', reviewPath,
      '--data-dir', dataDir, '--json'], { workingDirectory: root });
    if (result.exitCode !== 0) throw new TypeError('Public candidate review failed.');
  }
  const configured = runCli(['advice', 'configure', '--repository-id', repositoryId, '--enabled', 'true',
    '--data-dir', dataDir, '--json'], { workingDirectory: root });
  if (configured.exitCode !== 0) throw new TypeError('Public advice configuration failed.');
  const seed = Object.freeze({ repositoryId, candidateId: candidate.id, contextRevision: fact.contextRevision,
    operationSignature: operationSignatureFromStoredJson(JSON.stringify(first.checkOperation.signature)) });
  trustedSeeds.add(seed);
  return seed;
}

/** Runs public retrieval in one B slot after the closed seed databases were copied. */
export function prepareRealAdviceScope(root: string, dataDir: string, buildRoot: string,
  seed: RealAdviceSeed, sessionBId: string, retrievalRef: string): HostAdviceExposureScope {
  if (!trustedSeeds.has(seed) || seed.repositoryId !== resolveRepository(root)?.id
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/.test(sessionBId)
    || !/^avb-real-retrieval-[0-9]{1,2}$/.test(retrievalRef)
    || [root, dataDir, buildRoot].some(path => /['\s]/.test(path))) throw new TypeError('Advice seed or scope is unsupported.');
  // The direct passive ingress owns the B session and its host-observed start time.
  const contextPath = join(dataDir, 'retrieval.json');
  writeFileSync(`${contextPath}.tmp`, JSON.stringify({ repositoryId: seed.repositoryId, sessionId: sessionBId,
    subproject: 'packages/app', operationSignature: seed.operationSignature,
    contextRevision: seed.contextRevision, conditions: [], retrievalRef }), { flag: 'wx' });
  renameSync(`${contextPath}.tmp`, contextPath);
  const retrieved = runCli(['advice', 'retrieve', '--input', contextPath, '--data-dir', dataDir, '--json'],
    { workingDirectory: root });
  if (retrieved.exitCode !== 0) throw new TypeError('Public advice retrieval failed.');
  const parsed = JSON.parse(retrieved.stdout) as { status?: unknown;
    entries?: { bundleId?: unknown; candidateId?: unknown; revision?: unknown }[] };
  if (parsed.status !== 'ready' || !Array.isArray(parsed.entries) || parsed.entries.length !== 1
    || parsed.entries[0]?.candidateId !== seed.candidateId || typeof parsed.entries[0].bundleId !== 'string'
    || typeof parsed.entries[0].revision !== 'string') throw new TypeError('Public advice bundle is not ready.');
  const bundle = parsed.entries[0] as { bundleId: string; candidateId: string; revision: string };
  const usage = new AdvisoryUsageStore(join(dataDir, 'advice.sqlite'));
  if (!usage.facts(bundle.bundleId).some(item => item.kind === 'retrieved' && item.origin === 'cli-retrieval'
    && item.witnessRef === retrievalRef)) throw new TypeError('Public retrieval witness is unavailable.');
  const selection = { repositoryId: seed.repositoryId, lessonId: seed.candidateId,
    lessonRevision: bundle.revision, sessionId: sessionBId, contextRevision: seed.contextRevision,
    bundleId: bundle.bundleId, kind: 'selected', origin: 'agent-selection', witnessRef: `avb-selected-${retrievalRef}` };
  writeFileSync(join(dataDir, 'selection.json.tmp'), JSON.stringify(selection), { flag: 'wx' });
  renameSync(join(dataDir, 'selection.json.tmp'), join(dataDir, 'selection.json'));
  return Object.freeze({ repositoryId: seed.repositoryId, lessonId: seed.candidateId, lessonRevision: bundle.revision,
    sessionId: sessionBId, contextRevision: seed.contextRevision, bundleId: bundle.bundleId,
    operationSignature: seed.operationSignature, retrievalRef, dataDir,
    invocation: realAdviceInvocation(buildRoot, dataDir) });
}

export function realAdviceInvocation(buildRoot: string, dataDir: string): string {
  if ([buildRoot, dataDir].some(path => /['\s]/.test(path))) throw new TypeError('Advice invocation paths are unsupported.');
  return `node ${join(buildRoot, 'dist/src/advice/challenge-retrieve.js')} ${join(dataDir, 'retrieval.json')} ${dataDir}`;
}

export function realSelectionInvocation(buildRoot: string, dataDir: string): string {
  if ([buildRoot, dataDir].some(path => /['\s]/.test(path))) throw new TypeError('Selection invocation paths are unsupported.');
  return `node ${join(buildRoot, 'dist/src/benchmark/selection-after-delivery.js')} ${join(dataDir, 'selection.json')} ${dataDir}`;
}

export function waitForHostDelivery(read: () => boolean, now: () => number, pause: (milliseconds: number) => void,
  timeoutMilliseconds = 10_000): boolean {
  const deadline = now() + timeoutMilliseconds;
  do {
    if (read()) return true;
    if (now() >= deadline) return false;
    pause(Math.min(50, Math.max(1, deadline - now())));
  } while (true);
}

async function observeSourceRead(root: string, binaryPath: string): Promise<SourceRun> {
  const args = ['-a', 'never', 'exec', '--json', '--ephemeral', '--ignore-user-config', '-m', 'gpt-6-sol',
    '-C', root, '-s', 'workspace-write', realAdviceSourcePrompt];
  const child = await spawnVerifiedCodexExec({ binaryPath, cwd: root, args });
  const trusted = observeVerifiedCodexCliJsonChild(child).then(value => value, () => null);
  const expectedSource = readFileSync(join(root, 'packages/app/package.json'), 'utf8');
  const projection = new CodexTrialProjection(qualifiedCodexCli.version.slice('codex-cli '.length),
    'package-manager-fact', undefined, expectedSource);
  const decoder = new TextDecoder();
  let pending = '';
  let bytes = 0;
  let invalid = false;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (invalid) return;
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { invalid = true; child.kill(); return; }
    pending += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pending, 'utf8') > 128 * 1024) { invalid = true; child.kill(); return; }
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      try { projection.accept(JSON.parse(pending.slice(0, newline)) as unknown, new Date().toISOString()); }
      catch { invalid = true; child.kill(); return; }
      pending = pending.slice(newline + 1);
    }
  });
  child.stderr?.resume();
  const timer = setTimeout(() => child.kill(), 120_000);
  const closed = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => {
    child.once('error', () => resolve({ code: null, signal: null }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const stream = await trusted;
  if (pending && !invalid) {
    try { projection.accept(JSON.parse(pending + decoder.decode()) as unknown, new Date().toISOString()); }
    catch { invalid = true; }
  }
  const projected = invalid ? null : projection.finish();
  if (closed.code !== 0 || closed.signal !== null || !stream || projected?.status !== 'observed'
    || projected.operations.length !== 2 || projected.operations[0]?.kind !== 'package-manager-discovery'
    || projected.operations[1]?.kind !== 'package-manager-check'
    || projected.operations.some(operation => operation.outcome !== 'succeeded')
    || projected.verifiedSourceReadOperationIds.length !== 1
    || projected.verifiedSourceReadOperationIds[0] !== projected.operations[0].id
    || stream.events.length !== 4 || stream.events.some((event, index) => {
      const operation = projected.operations[Math.floor(index / 2)];
      return event.sessionId !== stream.sessionId || event.phase !== (index % 2 ? 'post-result' : 'pre-action')
        || (index % 2 ? event.relatedEventId !== operation?.id || event.outcome !== 'succeeded'
          : event.sourceEventId !== operation?.id);
    })) throw new TypeError('Session A source and check operations are not bound to trusted Codex evidence.');
  return Object.freeze({ sessionId: stream.sessionId as SessionId, events: stream.events,
    sourceOperation: stream.events[0]!, checkOperation: stream.events[2]! });
}
