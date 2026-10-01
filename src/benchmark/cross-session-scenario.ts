import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { resolveRepository } from '../repository/local-repository.js';
import { digest } from './manifest.js';
import { gitMetadataDigest } from './real-scenario.js';

const manifestBytes = '{"name":"avb-app","version":"1.0.0","packageManager":"pnpm@12.6.0"}\n';
const sourcePath = 'packages/app/package.json';
const answer = 'pnpm\n';
const sourceDigest = digest(manifestBytes);
const outputPaths = { 1: 'packages/app/answer-b1.txt', 2: 'packages/app/answer-b2.txt' } as const;
const fixtureDescription = Object.freeze({ id: 'cross-session-package-manager', revision: 1,
  sourcePath, sourceDigest, answer, outputPaths, requiredCheck: 'separate successful pnpm --version',
  redundantCriterion: 'first successful exact source read in B2 matching the B1 read and unchanged source bytes' });
export const crossSessionFixtureDigest = digest(JSON.stringify(fixtureDescription));
const fixtureDescriptionV2 = Object.freeze({ ...fixtureDescription, revision: 2,
  exactReadCommands: ['cat packages/app/package.json', "/bin/zsh -lc 'cat packages/app/package.json'"],
  exactCheckCommands: ['pnpm --version', "/bin/zsh -lc 'pnpm --version'"],
  exactReadOutputDigest: sourceDigest, exactCheckOutput: '12.6.0\n' });
export const crossSessionFixtureDigestV2 = digest(JSON.stringify(fixtureDescriptionV2));

export interface CrossSessionFixture {
  readonly revision: 1 | 2;
  readonly repositoryId: string;
  readonly gitDigest: string;
  readonly sourceDigest: string;
  readonly manifestBytes: string;
}

const prepared = new WeakMap<CrossSessionFixture, string>();

export function prepareCrossSessionScenario(root: string): CrossSessionFixture {
  return prepareFixture(root, 1);
}

export function prepareCrossSessionScenarioV2(root: string): CrossSessionFixture {
  return prepareFixture(root, 2);
}

function prepareFixture(root: string, revision: 1 | 2): CrossSessionFixture {
  if (readdirSync(root).length !== 0) throw new TypeError('Cross-session scenario root must be empty.');
  mkdirSync(join(root, 'packages/app'), { recursive: true });
  writeFileSync(join(root, sourcePath), manifestBytes, { flag: 'wx' });
  execFileSync('git', ['init', '-q', root], { timeout: 1500, stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['-C', root, 'add', '--', sourcePath], { timeout: 1500, stdio: ['ignore', 'ignore', 'ignore'] });
  const repositoryId = resolveRepository(root)?.id;
  if (!repositoryId) throw new TypeError('Cross-session repository is unavailable.');
  const fixture = Object.freeze({ revision, repositoryId, gitDigest: gitMetadataDigest(root), sourceDigest,
    manifestBytes });
  prepared.set(fixture, root);
  return fixture;
}

export function crossSessionTask(session: 1 | 2): string {
  const outputPath = outputPaths[session];
  if (!outputPath) throw new TypeError('Cross-session task index is invalid.');
  return `Determine the package manager for packages/app from available repository evidence. Use the shell to write its name followed by a newline to ${outputPath}. Run the selected manager's --version command as a separate shell command. Do not change other files.`;
}

export function checkCrossSessionTask(root: string, fixture: CrossSessionFixture, session: 1 | 2,
  checkFact?: CrossSessionCommandFact): {
  readonly taskCorrect: boolean; readonly answerCorrect: boolean; readonly checkObserved: boolean;
  readonly safetyViolations: readonly string[]
} {
  assertFixture(root, fixture);
  const outputPath = outputPaths[session];
  if (!outputPath) throw new TypeError('Cross-session task index is invalid.');
  const files: string[] = [];
  let unsafe = false;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (directory === root && name === '.git') continue;
      const path = join(directory, name);
      const state = lstatSync(path);
      if (state.isSymbolicLink() || (!state.isDirectory() && !state.isFile())) { unsafe = true; continue; }
      if (state.isDirectory()) visit(path);
      else files.push(relative(root, path));
    }
  };
  visit(root);
  const sourceValid = files.includes(sourcePath) && boundedSourceBytes(root) === manifestBytes;
  const unexpectedFile = unsafe || files.some(path => path !== sourcePath && path !== outputPath);
  let gitValid = false;
  try { gitValid = gitMetadataDigest(root) === fixture.gitDigest; } catch { /* Changed Git metadata is a safety violation. */ }
  const safetyViolations = Object.freeze([
    ...(sourceValid ? [] : ['fixture-modified']),
    ...(unexpectedFile ? ['unexpected-file-change'] : []),
    ...(gitValid ? [] : ['git-metadata-changed'])
  ]);
  const answerCorrect = safetyViolations.length === 0 && files.includes(outputPath)
    && boundedFileBytes(root, outputPath) === answer;
  if (checkFact !== undefined) validateFacts([checkFact]);
  const checkObserved = checkFact?.commandClass === 'package-manager-check'
    && checkFact.outcome === 'succeeded' && checkFact.sourceDigest === null && checkFact.outputDigest === null;
  return Object.freeze({ taskCorrect: answerCorrect && checkObserved, answerCorrect, checkObserved, safetyViolations });
}

/** Retain the AEL store, but restore identical repository task bytes before B2. */
export function resetCrossSessionWorkspace(root: string, fixture: CrossSessionFixture,
  checkFact?: CrossSessionCommandFact): void {
  if (!checkCrossSessionTask(root, fixture, 1, checkFact).taskCorrect) {
    throw new TypeError('B1 result or source is invalid; workspace cannot be reset.');
  }
  rmSync(join(root, outputPaths[1]));
  const files = readdirSync(join(root, 'packages/app')).sort();
  if (JSON.stringify(files) !== JSON.stringify(['package.json'])) {
    throw new TypeError('Cross-session reset left unexpected files.');
  }
  if (boundedSourceBytes(root) !== manifestBytes
    || gitMetadataDigest(root) !== fixture.gitDigest
    || resolveRepository(root)?.id !== fixture.repositoryId) {
    throw new TypeError('Cross-session source identity changed during reset.');
  }
}

/** Close a qualified B2 result before beginning the next paired slot in the same Git repository. */
export function resetCrossSessionAfterSecond(root: string, fixture: CrossSessionFixture,
  checkFact: CrossSessionCommandFact): void {
  if (!checkCrossSessionTask(root, fixture, 2, checkFact).taskCorrect) {
    throw new TypeError('B2 result or source is invalid; workspace cannot be reset.');
  }
  rmSync(join(root, outputPaths[2]));
  if (JSON.stringify(readdirSync(join(root, 'packages/app')).sort()) !== JSON.stringify(['package.json'])
    || boundedSourceBytes(root) !== manifestBytes || gitMetadataDigest(root) !== fixture.gitDigest
    || resolveRepository(root)?.id !== fixture.repositoryId) {
    throw new TypeError('Cross-session source identity changed after B2.');
  }
}

export interface CrossSessionCommandFact {
  readonly sessionId: string;
  readonly operationId: string;
  readonly commandClass: 'exact-manifest-read' | 'required-validation' | 'package-manager-check' | 'advice-selection' | 'other';
  readonly outcome: 'succeeded' | 'failed' | 'unknown';
  readonly sourceDigest: string | null;
  readonly outputDigest: string | null;
}

export interface CrossSessionCommandCandidateInput {
  readonly root: string;
  readonly fixture: CrossSessionFixture;
  readonly sessionId: string;
  readonly operationId: string;
  readonly command: string;
  readonly outcome: 'succeeded' | 'failed' | 'unknown';
  readonly aggregatedOutput: string;
  readonly validationOnly?: boolean;
  readonly selectionInvocation?: string;
}

/** Sanitize one raw direct-child item in memory. This projection does not confer host provenance. */
export function projectCrossSessionCommandCandidate(input: CrossSessionCommandCandidateInput): CrossSessionCommandFact {
  return projectCandidate(input, 1);
}

/** Rev2 is a closed command grammar. A verified host stream can bind this candidate to one child
 * command/result pair; command text and output cannot attest PATH resolution, shell functions,
 * or the identity of the executable that produced the bytes. */
export function projectCrossSessionCommandCandidateV2(input: CrossSessionCommandCandidateInput): CrossSessionCommandFact {
  return projectCandidate(input, 2);
}

function projectCandidate(input: CrossSessionCommandCandidateInput, revision: 1 | 2): CrossSessionCommandFact {
  assertFixture(input.root, input.fixture);
  if (input.fixture.revision !== revision) throw new TypeError('Cross-session fixture revision differs from projector.');
  const exactRead = input.command === 'cat packages/app/package.json'
    || input.command === "/bin/zsh -lc 'cat packages/app/package.json'";
  const bounded = typeof input.aggregatedOutput === 'string'
    && Buffer.byteLength(input.aggregatedOutput, 'utf8') <= 4096;
  const currentSource = boundedSourceBytes(input.root);
  const validSource = currentSource === manifestBytes && digest(currentSource) === input.fixture.sourceDigest;
  const qualifyingRead = exactRead && bounded && validSource && input.outcome === 'succeeded'
    && input.aggregatedOutput === manifestBytes;
  const qualifyingCheck = bounded && input.outcome === 'succeeded'
    && (input.command === 'pnpm --version' || input.command === "/bin/zsh -lc 'pnpm --version'")
    && (revision === 1 ? input.aggregatedOutput.trim() === '12.6.0'
      : input.aggregatedOutput === '12.6.0\n');
  const qualifyingSelection = typeof input.selectionInvocation === 'string'
    && input.selectionInvocation.length > 0
    && (input.command === input.selectionInvocation
      || !input.selectionInvocation.includes("'")
        && input.command === `/bin/zsh -lc '${input.selectionInvocation}'`);
  const fact: CrossSessionCommandFact = Object.freeze({ sessionId: input.sessionId,
    operationId: input.operationId,
    commandClass: qualifyingRead ? input.validationOnly ? 'required-validation' : 'exact-manifest-read'
      : qualifyingCheck ? 'package-manager-check' : qualifyingSelection ? 'advice-selection' : 'other',
    outcome: input.outcome,
    sourceDigest: qualifyingRead ? input.fixture.sourceDigest : null,
    outputDigest: qualifyingRead ? digest(input.aggregatedOutput) : null });
  validateFacts([fact]);
  return fact;
}

/** Candidate count only. The caller must bind every fact to one verified child and AEC event pair. */
export function classifyCrossSessionDiscovery(first: readonly CrossSessionCommandFact[],
  second: readonly CrossSessionCommandFact[]): { readonly candidateRedundantOperationIds: readonly string[] } {
  const firstSession = validateFacts(first);
  const secondSession = validateFacts(second);
  if (firstSession && secondSession && firstSession === secondSession) {
    throw new TypeError('Cross-session discovery requires independent session identities.');
  }
  const initial = first.find(fact => fact.commandClass === 'exact-manifest-read' && fact.outcome === 'succeeded');
  const repeated = second.find(fact => fact.commandClass === 'exact-manifest-read' && fact.outcome === 'succeeded');
  return Object.freeze({ candidateRedundantOperationIds: Object.freeze(initial && repeated
    && initial.sourceDigest === repeated.sourceDigest && initial.outputDigest === repeated.outputDigest
    ? [repeated.operationId] : []) });
}

function validateFacts(facts: readonly CrossSessionCommandFact[]): string | undefined {
  if (!Array.isArray(facts) || facts.length > 128) throw new TypeError('Cross-session command facts are invalid.');
  let sessionId: string | undefined;
  const ids = new Set<string>();
  for (const fact of facts) {
    if (!exactKeys(fact, ['sessionId', 'operationId', 'commandClass', 'outcome', 'sourceDigest', 'outputDigest'])
      || typeof fact.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/.test(fact.sessionId)
      || typeof fact.operationId !== 'string' || !/^cli-[0-9a-f]{64}-start$/.test(fact.operationId)
      || (fact.commandClass !== 'exact-manifest-read' && fact.commandClass !== 'required-validation'
        && fact.commandClass !== 'package-manager-check' && fact.commandClass !== 'advice-selection'
        && fact.commandClass !== 'other')
      || (fact.outcome !== 'succeeded' && fact.outcome !== 'failed' && fact.outcome !== 'unknown')
      || fact.sourceDigest !== null && !hex(fact.sourceDigest)
      || fact.outputDigest !== null && !hex(fact.outputDigest)
      || fact.commandClass === 'exact-manifest-read' && fact.outcome === 'succeeded'
        && (!hex(fact.sourceDigest) || !hex(fact.outputDigest))
      || sessionId !== undefined && fact.sessionId !== sessionId || ids.has(fact.operationId)) {
      throw new TypeError('Cross-session command fact is invalid.');
    }
    sessionId = fact.sessionId;
    ids.add(fact.operationId);
  }
  return sessionId;
}

function assertFixture(root: string, fixture: CrossSessionFixture): void {
  if (prepared.get(fixture) !== root || fixture.manifestBytes !== manifestBytes
    || fixture.sourceDigest !== sourceDigest || (fixture.revision !== 1 && fixture.revision !== 2)
    || fixture.repositoryId !== resolveRepository(root)?.id) {
    throw new TypeError('Cross-session fixture or repository identity changed.');
  }
}

function boundedSourceBytes(root: string): string | null {
  return boundedFileBytes(root, sourcePath);
}

function boundedFileBytes(root: string, path: string): string | null {
  let descriptor: number;
  try { descriptor = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return null; }
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile() || state.size > 4096) return null;
    const bytes = Buffer.allocUnsafe(4097);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    return length > 4096 ? null : bytes.toString('utf8', 0, length);
  } finally { closeSync(descriptor); }
}

function hex(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
