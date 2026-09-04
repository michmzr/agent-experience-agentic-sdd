import { type ReadStream } from 'node:fs';

import { readBoundedLines } from './bounded-lines.js';

const artifactReadError = 'Session artifact could not be read.';

export interface BoundedJsonlOptions {
  readonly path: string;
  readonly onLine: (line: string) => void | Promise<void>;
  readonly streamFactory?: (path: string) => ReadStream;
}

export async function readBoundedJsonl(options: BoundedJsonlOptions): Promise<void> {
  await readBoundedLines({ ...options, errorMessage: artifactReadError, skipEmptyLines: true });
}
