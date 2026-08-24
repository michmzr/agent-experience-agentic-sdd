import { createInterface } from 'node:readline/promises';

import type { ReviewSelectionPrompt, RepositorySessionDescriptor } from './selection.js';

export interface TerminalHost {
  write(value: string): void;
  readLine(prompt: string): Promise<string>;
}

export class TerminalReviewSelectionPrompt implements ReviewSelectionPrompt {
  constructor(private readonly terminal: TerminalHost) {}

  async choose(sessions: readonly RepositorySessionDescriptor[]): Promise<string | undefined> {
    this.terminal.write(`Available sessions:\n${sessions.map((session, index) => `${index + 1}. ${session.id}`).join('\n')}\n`);
    const answer = await this.terminal.readLine('Select a session number: ');
    const selected = Number.parseInt(answer, 10);
    return Number.isSafeInteger(selected) && selected >= 1 && selected <= sessions.length ? sessions[selected - 1]?.id : undefined;
  }

  async confirm(session: RepositorySessionDescriptor): Promise<boolean> {
    const answer = await this.terminal.readLine(`Run review for ${session.id}? [y/N] `);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  }
}

export function createProcessTerminalHost(): TerminalHost {
  return {
    write(value) { process.stdout.write(value); },
    async readLine(prompt) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await terminal.question(prompt);
      } finally {
        terminal.close();
      }
    }
  };
}
