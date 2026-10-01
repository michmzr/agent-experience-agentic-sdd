import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const qualifiedCodexCli = Object.freeze({
  version: 'codex-cli 0.157.1',
  sha256: '27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d',
  model: 'gpt-6-sol'
});

export interface VerifiedCodexExecOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly args: readonly string[];
}

const verifiedChildren = new WeakSet<ChildProcess>();

export function hasQualifiedCodexExecArguments(args: readonly string[]): boolean {
  return args.length === 13
    && args[0] === '-a' && args[1] === 'never' && args[2] === 'exec'
    && args[3] === '--json' && args[4] === '--ephemeral' && args[5] === '--ignore-user-config'
    && args[6] === '-m' && args[7] === qualifiedCodexCli.model
    && args[8] === '-C' && typeof args[9] === 'string' && isAbsolute(args[9])
    && args[10] === '-s' && args[11] === 'workspace-write'
    && typeof args[12] === 'string' && args[12].trim().length > 0 && !args[12].startsWith('-');
}

/** The approved binary identity is source-qualified, not supplied by a run manifest. */
export async function spawnVerifiedCodexExec(options: VerifiedCodexExecOptions): Promise<ChildProcess> {
  if (!isAbsolute(options.binaryPath) || !isAbsolute(options.cwd)
    || !hasQualifiedCodexExecArguments(options.args)
    || options.args[9] !== options.cwd
    || options.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || Buffer.byteLength(options.args.join('\0'), 'utf8') > 64 * 1024) {
    throw new TypeError('Codex executable and exec arguments are invalid.');
  }
  const executable = realpathSync(options.binaryPath);
  if (!statSync(executable).isFile()) throw new TypeError('Codex executable is not a regular file.');
  if (await sha256File(executable) !== qualifiedCodexCli.sha256) throw new Error('Codex binary digest mismatch.');
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 4_096, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  if (version !== qualifiedCodexCli.version) throw new Error('Codex binary version mismatch.');
  if (await sha256File(executable) !== qualifiedCodexCli.sha256) throw new Error('Codex binary changed during verification.');
  const child = spawn(executable, [...options.args], {
    cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  verifiedChildren.add(child);
  return child;
}

export function isVerifiedCodexChild(child: ChildProcess): boolean { return verifiedChildren.has(child); }

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
