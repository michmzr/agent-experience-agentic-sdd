import { createInterface } from 'node:readline';

import { resolveCliContext, type CliContext } from './context.js';

export interface CliContextPrompt {
  readonly interactive: boolean;
  readContextPath(message: string): Promise<string | undefined>;
}

export type ContextPreparation =
  | { readonly status: 'ready'; readonly args: readonly string[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'invalid' };

type ContextRequirement = 'repository-id' | 'repository-root' | 'workspace-root' | 'repository-root-and-id';

export async function prepareContextArguments(
  args: readonly string[],
  options: { readonly workingDirectory: string; readonly prompt?: CliContextPrompt }
): Promise<ContextPreparation> {
  const requirement = contextRequirement(args);
  if (requirement === undefined || args.includes('--json') || options.prompt?.interactive !== true) {
    return { status: 'ready', args };
  }

  const candidate = optionValue(args, 'repository') ?? options.workingDirectory;
  try {
    if (resolveCliContext(candidate) !== undefined) return { status: 'ready', args };
  } catch {
    return { status: 'ready', args };
  }

  const selectedPath = await options.prompt.readContextPath('Repository or workspace path: ');
  if (selectedPath === undefined) return { status: 'cancelled' };
  let context: CliContext | undefined;
  try { context = resolveCliContext(selectedPath); } catch { return { status: 'invalid' }; }
  if (context === undefined) return { status: 'invalid' };
  return { status: 'ready', args: [...args, ...contextArguments(requirement, context, args)] };
}

export function createProcessContextPrompt(): CliContextPrompt {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async readContextPath(message) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      return await new Promise<string | undefined>((resolve) => {
        let settled = false;
        const finish = (value: string | undefined): void => {
          if (settled) return;
          settled = true;
          terminal.close();
          resolve(value);
        };
        terminal.once('SIGINT', () => finish(undefined));
        terminal.question(message, (answer) => finish(answer.trim() || undefined));
      });
    }
  };
}

function contextRequirement(args: readonly string[]): ContextRequirement | undefined {
  const [command, subcommand, third] = args;
  if (command === 'unregister' && !hasOption(args, 'repository-id')) return 'repository-id';
  if ((command === 'list' && subcommand === 'records') || command === 'stats' || command === 'status') {
    return hasOption(args, 'repository-id') || hasOption(args, 'repository') ? undefined : 'repository-id';
  }
  if (command === 'analysis' && (subcommand === 'run' || subcommand === 'report') && !hasOption(args, 'repository-id')) {
    return 'repository-id';
  }
  if ((command === 'lessons' || command === 'retrieve' || command === 'export')
    && optionValue(args, 'scope') === 'repo' && !hasOption(args, 'repository-id')) return 'repository-id';
  if (command === 'runtime' && subcommand === 'config' && third === 'explain' && !hasOption(args, 'workspace')) {
    return 'workspace-root';
  }
  if (command === 'knowledge' && (subcommand === 'validate' || subcommand === 'promote') && !hasOption(args, 'repository')) {
    return 'repository-root';
  }
  if (command === 'knowledge' && subcommand === 'refresh-runtime') {
    const rootMissing = !hasOption(args, 'repository');
    const idMissing = !hasOption(args, 'repository-id');
    if (rootMissing && idMissing) return 'repository-root-and-id';
    if (rootMissing) return 'repository-root';
    if (idMissing) return 'repository-id';
  }
  return undefined;
}

function contextArguments(requirement: ContextRequirement, context: CliContext, args: readonly string[]): string[] {
  if (requirement === 'repository-id') return hasOption(args, 'repository-id') ? [] : ['--repository-id', context.id];
  if (requirement === 'workspace-root') return ['--workspace', context.root];
  if (requirement === 'repository-root') return ['--repository', context.root];
  return ['--repository', context.root, '--repository-id', context.id];
}

function hasOption(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}
