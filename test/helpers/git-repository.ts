import { execFileSync } from 'node:child_process';

export function initializeGitRepository(repository: string): void {
  execFileSync('git', ['init', '--quiet', repository], { stdio: 'ignore' });
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'tests@example.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'AEL tests'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repository, 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
}
