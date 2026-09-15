import { rmSync } from 'node:fs';

interface TemporaryDirectoryRemovalDependencies {
  readonly remove?: (path: string, options: { readonly recursive: true; readonly force: true }) => void;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

const MAX_REMOVAL_RETRIES = 20;
const REMOVAL_RETRY_DELAY_MS = 10;

export async function removeTemporaryDirectory(
  path: string,
  dependencies: TemporaryDirectoryRemovalDependencies = {}
): Promise<void> {
  const remove = dependencies.remove ?? rmSync;
  const delay = dependencies.delay ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      remove(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isTransientRemovalError(error) || attempt >= MAX_REMOVAL_RETRIES) throw error;
      await delay(REMOVAL_RETRY_DELAY_MS);
    }
  }
}

function isTransientRemovalError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOTEMPTY' || error.code === 'EBUSY');
}
