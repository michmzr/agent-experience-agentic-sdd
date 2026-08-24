#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

import { DomainError, errorMessage, ExperienceService } from './application/experience-service.js';
import type { KnowledgeState } from './domain/types.js';
import type { KnowledgeScope } from './storage/experience-store.js';
import { discoverReviewSessions, runManualReview, type ManualReviewDependencies } from './review/review-service.js';
import { createProcessTerminalHost, TerminalReviewSelectionPrompt, type TerminalHost } from './review/terminal-prompt.js';

export interface CliResult { exitCode: number; stdout: string; stderr: string; }
export interface RunCliAsyncOptions {
  readonly terminal?: TerminalHost;
  readonly reviewDependencies?: ManualReviewDependencies;
}

interface ParsedArguments { readonly positionals: string[]; readonly options: Map<string, string | true>; }

const scopes = new Set(['global', 'repo'] as const);
const states = new Set<KnowledgeState>(['candidate', 'observed', 'confirmed', 'verified', 'disputed', 'superseded', 'rejected', 'expired']);
const reviewSources = new Set(['codex', 'claude-code', 'cursor'] as const);

export function runCli(args: string[]): CliResult {
  if (args.length === 1 && args[0] === '--help') return { exitCode: 0, stdout: `${usage()}\n`, stderr: '' };
  try {
    const parsed = parseArguments(args);
    const json = parsed.options.has('json');
    const service = new ExperienceService({ dataDir: optionalString(parsed.options, 'data-dir') });
    return success(execute(service, parsed), json, parsed.positionals);
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    const diagnostic = toDiagnostic(error, syntax ? 'INVALID_SYNTAX' : 'STORAGE_ERROR');
    return args.includes('--json')
      ? { exitCode: syntax ? 2 : 1, stdout: `${JSON.stringify({ error: diagnostic })}\n`, stderr: '' }
      : { exitCode: syntax ? 2 : 1, stdout: '', stderr: `${diagnostic.code}: ${diagnostic.message}\n` };
  }
}

export async function runCliAsync(args: string[], options: RunCliAsyncOptions = {}): Promise<CliResult> {
  if (args[0] !== 'review') return runCli(args);
  try {
    const parsed = parseArguments(args); const json = parsed.options.has('json');
    const request = parseReviewRequest(parsed);
    const reviewDependencies = request.kind === 'review' && request.interactive
      ? { ...options.reviewDependencies, prompt: options.reviewDependencies?.prompt ?? new TerminalReviewSelectionPrompt(options.terminal ?? createProcessTerminalHost()) }
      : options.reviewDependencies;
    const value = request.kind === 'discover'
      ? (await discoverReviewSessions(request)).map(({ source, id }) => ({ source, id }))
      : await runManualReview(request, reviewDependencies);
    return success(value, json, parsed.positionals);
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    const diagnostic = syntax ? toDiagnostic(error, 'INVALID_SYNTAX') : { code: 'REVIEW_ERROR', message: 'Review failed.' };
    return args.includes('--json') ? { exitCode: syntax ? 2 : 1, stdout: `${JSON.stringify({ error: diagnostic })}\n`, stderr: '' } : { exitCode: syntax ? 2 : 1, stdout: '', stderr: `${diagnostic.code}: ${diagnostic.message}\n` };
  }
}

function execute(service: ExperienceService, parsed: ParsedArguments): unknown {
  const [command, subcommand, ...rest] = parsed.positionals;
  if (command === 'init' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope']); optionalScope(parsed.options); return service.init();
  }
  if (command === 'experience' && subcommand === 'add' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'input']); return service.add(requiredString(parsed.options, 'input'));
  }
  if (command === 'validate' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope']); optionalScope(parsed.options); return service.validate();
  }
  if (command === 'inspect' && typeof subcommand === 'string' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json']); const entry = service.inspect(subcommand);
    if (!entry) throw new DomainError('NOT_FOUND', `Knowledge entry not found: ${subcommand}.`); return entry;
  }
  if (command === 'lessons' && subcommand === 'list' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope', 'repository-id', 'state', 'tag']);
    return service.list(filterOptions(parsed.options));
  }
  if (command === 'retrieve' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope', 'repository-id', 'path', 'tool', 'tag', 'state']);
    const tag = optionalString(parsed.options, 'tag');
    return service.retrieve({ ...filterOptions(parsed.options), path: optionalString(parsed.options, 'path'), tool: optionalString(parsed.options, 'tool'), ...(tag ? { tags: [tag] } : {}) });
  }
  if (command === 'export' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope', 'repository-id', 'state', 'tag', 'format']);
    const format = optionalString(parsed.options, 'format'); if (format && format !== 'json') throw new SyntaxError('Export format must be json.');
    return service.export(filterOptions(parsed.options));
  }
  throw new SyntaxError(`Unknown command: ${[command, subcommand, ...rest].filter(Boolean).join(' ')}`);
}

function parseReviewRequest(parsed: ParsedArguments) {
  const [command, subcommand, ...rest] = parsed.positionals;
  if (command !== 'review' || !['session', 'sessions'].includes(subcommand ?? '') || rest.length !== 0) throw new SyntaxError(`Unknown command: ${parsed.positionals.join(' ')}`);
  assertNoUnknownOptions(
    parsed.options,
    subcommand === 'sessions'
      ? ['json', 'source', 'root', 'project']
      : ['json', 'source', 'session', 'root', 'project', 'repository', 'profile', 'interactive', 'allow-expensive-checks']
  );
  const source = requiredReviewSource(parsed.options); const root = requiredString(parsed.options, 'root'); const project = optionalString(parsed.options, 'project');
  if (subcommand === 'sessions') return { kind: 'discover' as const, source, root, project };
  const session = optionalString(parsed.options, 'session');
  const repository = optionalString(parsed.options, 'repository');
  const interactive = parsed.options.has('interactive');
  if (session === 'latest' && (!interactive || !repository)) throw new SyntaxError('Interactive repository scope is required for session selection.');
  return { kind: 'review' as const, source, session, root, project, repository, interactive, profile: optionalReviewProfile(parsed.options), allowExpensiveChecks: parsed.options.has('allow-expensive-checks') };
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = []; const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--') continue;
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const name = value.slice(2); if (!name) throw new SyntaxError('Option name is required.');
    if (options.has(name)) throw new SyntaxError(`Option may be supplied once: --${name}.`);
    if (name === 'json' || name === 'interactive' || name === 'allow-expensive-checks') { options.set(name, true); continue; }
    const optionValue = args[index + 1]; if (!optionValue || optionValue.startsWith('--')) throw new SyntaxError(`Option requires a value: --${name}.`);
    options.set(name, optionValue); index += 1;
  }
  return { positionals, options };
}

function assertNoUnknownOptions(options: Map<string, string | true>, allowed: readonly string[]): void {
  for (const name of options.keys()) if (!allowed.includes(name)) throw new SyntaxError(`Unsupported option: --${name}.`);
}
function optionalString(options: Map<string, string | true>, name: string): string | undefined {
  const value = options.get(name); if (value === undefined) return undefined; if (value === true) throw new SyntaxError(`Option requires a value: --${name}.`); return value;
}
function requiredString(options: Map<string, string | true>, name: string): string {
  const value = optionalString(options, name); if (value === undefined) throw new SyntaxError(`Option is required: --${name}.`); return value;
}
function requiredReviewSource(options: Map<string, string | true>): typeof reviewSources extends Set<infer Value> ? Value : never {
  const source = requiredString(options, 'source');
  if (!reviewSources.has(source as typeof reviewSources extends Set<infer Value> ? Value : never)) {
    throw new SyntaxError('Source must be codex, claude-code, or cursor.');
  }
  return source as typeof reviewSources extends Set<infer Value> ? Value : never;
}
function optionalReviewProfile(options: Map<string, string | true>): { id: string; version: string } | undefined {
  const value = optionalString(options, 'profile');
  if (value === undefined) return undefined;
  const [id, version, ...extra] = value.split('@');
  if (!id || !version || extra.length !== 0) throw new SyntaxError('Profile must be specified as id@version.');
  return { id, version };
}
function optionalScope(options: Map<string, string | true>): KnowledgeScope | undefined {
  const scope = optionalString(options, 'scope'); if (scope === undefined) return undefined; if (!scopes.has(scope as typeof scopes extends Set<infer Value> ? Value : never)) throw new SyntaxError('Scope must be global or repo.'); return scope === 'repo' ? 'repository' : 'global';
}
function optionalState(options: Map<string, string | true>): KnowledgeState | undefined {
  const state = optionalString(options, 'state'); if (state === undefined) return undefined; if (!states.has(state as KnowledgeState)) throw new SyntaxError('Knowledge state is unsupported.'); return state as KnowledgeState;
}
function filterOptions(options: Map<string, string | true>) {
  return { scope: optionalScope(options), repositoryId: optionalString(options, 'repository-id'), state: optionalState(options), tag: optionalString(options, 'tag') };
}
function success(value: unknown, json: boolean, positionals: readonly string[]): CliResult { return json ? { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' } : { exitCode: 0, stdout: `${humanOutput(value, positionals)}\n`, stderr: '' }; }
function humanOutput(value: unknown, positionals: readonly string[]): string {
  const [command, subcommand] = positionals;
  if (command === 'init') return `Initialized local experience store at ${(value as { databasePath: string }).databasePath}.`;
  if (command === 'experience' && subcommand === 'add') return `Imported ${countLabel((value as { imported: number }).imported, 'knowledge entry')}.`;
  if (command === 'validate') return 'Validation passed.';
  if (command === 'inspect') return formatKnowledge(value as KnowledgeRecord, true);
  if (command === 'lessons' || command === 'retrieve') return formatKnowledgeList(value as KnowledgeRecord[]);
  if (command === 'export') {
    const knowledge = (value as { knowledge: KnowledgeRecord[] }).knowledge;
    return `Exported ${countLabel(knowledge.length, 'knowledge entry')}.${knowledge.length ? `\n${formatKnowledgeList(knowledge)}` : ''}`;
  }
  if (command === 'review' && subcommand === 'session') {
    const review = value as { findings: readonly unknown[]; candidates: readonly unknown[]; proposals: readonly unknown[]; skippedReviewerIds: readonly string[] };
    return `Review completed: ${review.findings.length} finding groups, ${review.candidates.length} candidates, ${review.proposals.length} proposals.${review.skippedReviewerIds.length ? ` Skipped reviewers: ${review.skippedReviewerIds.join(', ')}.` : ''}`;
  }
  if (command === 'review' && subcommand === 'sessions') return (value as readonly { id: string }[]).map(({ id }) => id).join('\n') || 'No sessions found.';
  return JSON.stringify(value);
}
interface KnowledgeRecord { readonly id: string; readonly state: string; readonly statement: string; readonly evidenceIds: readonly string[]; readonly authoritative?: boolean; }
function formatKnowledgeList(entries: readonly KnowledgeRecord[]): string { return entries.length ? entries.map((entry) => formatKnowledge(entry, false)).join('\n') : 'No knowledge entries found.'; }
function formatKnowledge(entry: KnowledgeRecord, includeEvidence: boolean): string { return `${entry.id} [${entry.state}]${entry.authoritative ? ' [authoritative]' : ''}\n${entry.statement}${includeEvidence ? `\nEvidence: ${entry.evidenceIds.join(', ')}` : ''}`; }
function countLabel(count: number, singular: string): string { return `${count} ${count === 1 ? singular : `${singular}s`}`; }
function usage(): string { return 'Usage: ael <init|experience add|validate|inspect|lessons list|retrieve|export|review session> [options]'; }
function toDiagnostic(error: unknown, fallbackCode: string): { code: string; message: string } { return error instanceof DomainError ? { code: error.code, message: error.message } : { code: fallbackCode, message: errorMessage(error) }; }

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const result = await runCliAsync(process.argv.slice(2)); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.exitCode;
}
