import { fileURLToPath } from 'node:url';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[]): CliResult {
  const command = args[0];

  return {
    exitCode: 2,
    stdout: '',
    stderr: `Unknown command: ${command ?? ''}\n`
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
