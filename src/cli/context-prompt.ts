import { createInterface } from 'node:readline';

import { parseArguments, type ParsedArguments } from './arguments.js';
import { resolveCliContext, type CliContext } from './context.js';
import { safeTerminalValue } from './human-renderer.js';

export interface CliContextPrompt {
  readonly interactive: boolean;
  readContextPath(message: string): Promise<string | undefined>;
}

export type ContextPreparation =
  | { readonly status: 'ready'; readonly args: readonly string[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'invalid' };

type ContextRequirement = 'repository-id' | 'repository-root' | 'workspace-root' | 'repository-root-and-id';
interface RequiredContext { readonly kind: ContextRequirement; readonly parsed: ParsedArguments }

export async function prepareContextArguments(
  args: readonly string[],
  options: { readonly workingDirectory: string; readonly prompt?: CliContextPrompt }
): Promise<ContextPreparation> {
  const required = contextRequirement(args);
  if (required === undefined || required.parsed.options.has('json') || options.prompt?.interactive !== true) {
    return { status: 'ready', args };
  }

  const candidate = optionValue(required.parsed, 'repository') ?? options.workingDirectory;
  try {
    if (resolveCliContext(candidate) !== undefined) return { status: 'ready', args };
  } catch {
    return { status: 'ready', args };
  }

  const selectedPath = await options.prompt.readContextPath(`Repository or workspace path [${safeTerminalValue(options.workingDirectory)}]: `);
  if (selectedPath === undefined) return { status: 'cancelled' };
  let context: CliContext | undefined;
  try { context = resolveCliContext(selectedPath); } catch { return { status: 'invalid' }; }
  if (context === undefined) return { status: 'invalid' };
  return { status: 'ready', args: [...args, ...contextArguments(required.kind, context, required.parsed)] };
}

export function createProcessContextPrompt(streams: {
  readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly output: NodeJS.WritableStream & { readonly isTTY?: boolean };
} = { input: process.stdin, output: process.stdout }): CliContextPrompt {
  return {
    interactive: Boolean(streams.input.isTTY && streams.output.isTTY),
    async readContextPath(message) {
      const terminal = createInterface({ input: streams.input, output: streams.output });
      return await new Promise<string | undefined>((resolve) => {
        let settled = false;
        const finish = (value: string | undefined): void => {
          if (settled) return;
          settled = true;
          terminal.close();
          resolve(value);
        };
        terminal.once('SIGINT', () => finish(undefined));
        terminal.once('close', () => finish(undefined));
        terminal.question(message, (answer) => finish(answer.trim() || undefined));
      });
    }
  };
}

function contextRequirement(args: readonly string[]): RequiredContext | undefined {
  let parsed: ParsedArguments;
  try { parsed = parseArguments(args); } catch { return undefined; }
  const [command, subcommand, third] = parsed.positionals;
  if (command === 'unregister' && exactForm(parsed, 1, ['data-dir', 'json', 'repository-id']) && !hasOption(parsed, 'repository-id')) return { kind: 'repository-id', parsed };
  if ((command === 'list' && subcommand === 'records') || command === 'stats' || command === 'status') {
    const positionals = command === 'list' ? 2 : 1;
    const allowed = command === 'status' ? ['data-dir', 'json', 'repository-id', 'repository', 'schema-version'] : ['data-dir', 'json', 'repository-id', 'repository'];
    const valuesValid = command !== 'status' || validOptionalValue(parsed, 'schema-version', ['2']);
    return exactForm(parsed, positionals, allowed) && valuesValid && !hasOption(parsed, 'repository-id') && !hasOption(parsed, 'repository') ? { kind: 'repository-id', parsed } : undefined;
  }
  if (command === 'analysis' && (subcommand === 'run' || subcommand === 'report') && exactForm(parsed, 2, subcommand === 'run'
    ? ['data-dir', 'json', 'repository-id']
    : ['data-dir', 'json', 'repository-id', 'session', 'schema-version'])
    && (subcommand === 'run' || validOptionalValue(parsed, 'schema-version', ['2'])) && !hasOption(parsed, 'repository-id')) {
    return { kind: 'repository-id', parsed };
  }
  if ((command === 'lessons' || command === 'retrieve' || command === 'export')
    && exactForm(parsed, command === 'lessons' ? 2 : 1, knowledgeFilterOptions(command))
    && validOptionalValue(parsed, 'state', ['candidate', 'observed', 'confirmed', 'verified', 'disputed', 'superseded', 'rejected', 'expired'])
    && (command !== 'export' || validOptionalValue(parsed, 'format', ['json']))
    && optionValue(parsed, 'scope') === 'repo' && !hasOption(parsed, 'repository-id')) return { kind: 'repository-id', parsed };
  if (command === 'runtime' && subcommand === 'config' && third === 'explain'
    && exactForm(parsed, 3, ['data-dir', 'json', 'remote', 'workspace']) && !hasOption(parsed, 'workspace')) {
    return { kind: 'workspace-root', parsed };
  }
  if (command === 'knowledge' && (subcommand === 'validate' || subcommand === 'promote')
    && exactForm(parsed, 2, subcommand === 'validate' ? ['data-dir', 'json', 'repository', 'trusted-ref'] : ['data-dir', 'input', 'json', 'repository'])
    && (subcommand !== 'promote' || hasStringOption(parsed, 'input'))
    && !hasOption(parsed, 'repository')) {
    return { kind: 'repository-root', parsed };
  }
  if (command === 'knowledge' && subcommand === 'refresh-runtime'
    && exactForm(parsed, 2, ['data-dir', 'json', 'repository', 'repository-id', 'trusted-ref'])
    && hasStringOption(parsed, 'trusted-ref')) {
    const rootMissing = !hasOption(parsed, 'repository');
    const idMissing = !hasOption(parsed, 'repository-id');
    if (rootMissing && idMissing) return { kind: 'repository-root-and-id', parsed };
    if (rootMissing) return { kind: 'repository-root', parsed };
    if (idMissing) return { kind: 'repository-id', parsed };
  }
  return undefined;
}

function contextArguments(requirement: ContextRequirement, context: CliContext, parsed: ParsedArguments): string[] {
  if (requirement === 'repository-id') return hasOption(parsed, 'repository-id') ? [] : ['--repository-id', context.id];
  if (requirement === 'workspace-root') return ['--workspace', context.root];
  if (requirement === 'repository-root') return ['--repository', context.root];
  return ['--repository', context.root, '--repository-id', context.id];
}

function exactForm(parsed: ParsedArguments, positionals: number, allowedOptions: readonly string[]): boolean {
  return parsed.positionals.length === positionals && [...parsed.options.keys()].every((name) => allowedOptions.includes(name));
}

function hasOption(parsed: ParsedArguments, name: string): boolean {
  return parsed.options.has(name);
}

function optionValue(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function hasStringOption(parsed: ParsedArguments, name: string): boolean {
  return typeof parsed.options.get(name) === 'string';
}

function validOptionalValue(parsed: ParsedArguments, name: string, allowed: readonly string[]): boolean {
  const value = optionValue(parsed, name);
  return value === undefined || allowed.includes(value);
}

function knowledgeFilterOptions(command: string): readonly string[] {
  if (command === 'lessons') return ['data-dir', 'json', 'scope', 'repository-id', 'state', 'tag'];
  if (command === 'retrieve') return ['data-dir', 'json', 'scope', 'repository-id', 'path', 'tool', 'tag', 'state'];
  return ['data-dir', 'json', 'scope', 'repository-id', 'state', 'tag', 'format'];
}
