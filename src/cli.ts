import { fileURLToPath } from 'node:url';

import { DomainError, errorMessage, ExperienceService } from './application/experience-service.js';
import type { KnowledgeState } from './domain/types.js';
import type { KnowledgeScope } from './storage/experience-store.js';

export interface CliResult { exitCode: number; stdout: string; stderr: string; }

interface ParsedArguments { readonly positionals: string[]; readonly options: Map<string, string | true>; }

const scopes = new Set<KnowledgeScope>(['global', 'repository']);
const states = new Set<KnowledgeState>(['candidate', 'observed', 'confirmed', 'verified', 'disputed', 'superseded', 'rejected', 'expired']);

export function runCli(args: string[]): CliResult {
  try {
    const parsed = parseArguments(args);
    const json = parsed.options.has('json');
    const service = new ExperienceService({ dataDir: optionalString(parsed.options, 'data-dir') });
    return success(execute(service, parsed), json);
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    const diagnostic = toDiagnostic(error, syntax ? 'INVALID_SYNTAX' : 'STORAGE_ERROR');
    return args.includes('--json')
      ? { exitCode: syntax ? 2 : 1, stdout: `${JSON.stringify({ error: diagnostic })}\n`, stderr: '' }
      : { exitCode: syntax ? 2 : 1, stdout: '', stderr: `${diagnostic.code}: ${diagnostic.message}\n` };
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

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = []; const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const name = value.slice(2); if (!name) throw new SyntaxError('Option name is required.');
    if (options.has(name)) throw new SyntaxError(`Option may be supplied once: --${name}.`);
    if (name === 'json') { options.set(name, true); continue; }
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
function optionalScope(options: Map<string, string | true>): KnowledgeScope | undefined {
  const scope = optionalString(options, 'scope'); if (scope === undefined) return undefined; if (!scopes.has(scope as KnowledgeScope)) throw new SyntaxError('Scope must be global or repository.'); return scope as KnowledgeScope;
}
function optionalState(options: Map<string, string | true>): KnowledgeState | undefined {
  const state = optionalString(options, 'state'); if (state === undefined) return undefined; if (!states.has(state as KnowledgeState)) throw new SyntaxError('Knowledge state is unsupported.'); return state as KnowledgeState;
}
function filterOptions(options: Map<string, string | true>) {
  return { scope: optionalScope(options), repositoryId: optionalString(options, 'repository-id'), state: optionalState(options), tag: optionalString(options, 'tag') };
}
function success(value: unknown, json: boolean): CliResult { return json ? { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' } : { exitCode: 0, stdout: `${humanOutput(value)}\n`, stderr: '' }; }
function humanOutput(value: unknown): string { return Array.isArray(value) ? value.map((item) => JSON.stringify(item)).join('\n') : JSON.stringify(value); }
function toDiagnostic(error: unknown, fallbackCode: string): { code: string; message: string } { return error instanceof DomainError ? { code: error.code, message: error.message } : { code: fallbackCode, message: errorMessage(error) }; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runCli(process.argv.slice(2)); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.exitCode;
}
