export interface ParsedArguments {
  readonly positionals: string[];
  readonly options: Map<string, string | true>;
}

const booleanOptions = new Set(['json', 'interactive', 'allow-expensive-checks', 'refresh', 'yes']);

export function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--') continue;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (!name) throw new SyntaxError('Option name is required.');
    if (options.has(name)) throw new SyntaxError(`Option may be supplied once: --${name}.`);
    if (booleanOptions.has(name)) {
      options.set(name, true);
      continue;
    }
    const optionValue = args[index + 1];
    if (!optionValue || optionValue.startsWith('--')) throw new SyntaxError(`Option requires a value: --${name}.`);
    options.set(name, optionValue);
    index += 1;
  }
  return { positionals, options };
}
