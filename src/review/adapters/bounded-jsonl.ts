import { createReadStream, type ReadStream } from 'node:fs';

import { MAX_SESSION_ARTIFACT_BYTES, MAX_SESSION_ARTIFACT_LINE_BYTES } from '../contracts.js';

const artifactReadError = 'Session artifact could not be read.';

export interface BoundedJsonlOptions {
  readonly path: string;
  readonly onLine: (line: string) => void | Promise<void>;
  readonly streamFactory?: (path: string) => ReadStream;
}

export async function readBoundedJsonl(options: BoundedJsonlOptions): Promise<void> {
  let stream: ReadStream | undefined;
  try {
    stream = options.streamFactory?.(options.path) ?? createReadStream(options.path);
    let totalBytes = 0;
    let unfinished = Buffer.alloc(0);

    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > MAX_SESSION_ARTIFACT_BYTES) throw new Error(artifactReadError);

      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline === -1) {
          const fragment = bytes.subarray(offset);
          if (unfinished.length + fragment.length > MAX_SESSION_ARTIFACT_LINE_BYTES + 1) throw new Error(artifactReadError);
          unfinished = Buffer.concat([unfinished, fragment]);
          break;
        }

        const fragment = bytes.subarray(offset, newline);
        const length = unfinished.length + fragment.length;
        const endsWithCarriageReturn = (fragment.length > 0 ? fragment[fragment.length - 1] : unfinished[unfinished.length - 1]) === 0x0d;
        const contentLength = length - (endsWithCarriageReturn ? 1 : 0);
        if (contentLength > MAX_SESSION_ARTIFACT_LINE_BYTES) throw new Error(artifactReadError);
        if (contentLength > 0) {
          const complete = Buffer.concat([unfinished, fragment]);
          await options.onLine(complete.subarray(0, contentLength).toString('utf8'));
        }
        unfinished = Buffer.alloc(0);
        offset = newline + 1;
      }
    }

    if (unfinished.length > MAX_SESSION_ARTIFACT_LINE_BYTES) throw new Error(artifactReadError);
    if (unfinished.length > 0) await options.onLine(unfinished.toString('utf8'));
  } catch {
    throw new Error(artifactReadError);
  } finally {
    stream?.destroy();
  }
}
