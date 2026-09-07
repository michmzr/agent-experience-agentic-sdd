import { closeSync, createReadStream, type ReadStream } from 'node:fs';

import { MAX_SESSION_ARTIFACT_BYTES, MAX_SESSION_ARTIFACT_LINE_BYTES } from '../contracts.js';

export interface BoundedLineReaderOptions {
  readonly path: string;
  readonly errorMessage: string;
  readonly onLine: (line: string) => void | Promise<void>;
  readonly skipEmptyLines?: boolean;
  readonly fileDescriptor?: number;
  readonly streamFactory?: (path: string) => ReadStream;
  readonly overflowRecordFactory?: (input: {
    readonly prefix: Buffer;
    readonly sourceOrdinal: number;
  }) => OverflowRecordSink | Promise<OverflowRecordSink>;
}

export interface OverflowRecordSink {
  write(chunk: Buffer): void | Promise<void>;
  finish(): void | Promise<void>;
}

export async function readBoundedLines(options: BoundedLineReaderOptions): Promise<void> {
  let stream: ReadStream | undefined;
  try {
    stream = options.fileDescriptor === undefined
      ? options.streamFactory?.(options.path) ?? createReadStream(options.path)
      : createReadStream(options.path, { fd: options.fileDescriptor });
    let totalBytes = 0;
    let unfinished = Buffer.alloc(0);
    let overflow: OverflowRecordSink | undefined;
    let overflowTail = Buffer.alloc(0);
    let sourceOrdinal = 0;

    const beginOverflow = async (): Promise<void> => {
      if (overflow) return;
      if (!options.overflowRecordFactory) throw new Error(options.errorMessage);
      overflow = await options.overflowRecordFactory({ prefix: unfinished, sourceOrdinal });
      unfinished = Buffer.alloc(0);
    };
    const writeFragment = async (fragment: Buffer): Promise<void> => {
      if (overflow) {
        const combined = Buffer.concat([overflowTail, fragment]);
        overflowTail = combined.subarray(Math.max(0, combined.length - 1));
        const body = combined.subarray(0, combined.length - overflowTail.length);
        if (body.length > 0) await overflow.write(body);
        return;
      }
      if (unfinished.length + fragment.length > MAX_SESSION_ARTIFACT_LINE_BYTES) {
        await beginOverflow();
        if (fragment.length > 0) await overflow!.write(fragment);
        return;
      }
      unfinished = Buffer.concat([unfinished, fragment]);
    };
    const finishLine = async (fragment: Buffer): Promise<void> => {
      const lastByte = fragment.length > 0
        ? fragment[fragment.length - 1]
        : overflow ? overflowTail[overflowTail.length - 1] : unfinished[unfinished.length - 1];
      const endsWithCarriageReturn = lastByte === 0x0d;
      const finalFragment = endsWithCarriageReturn && fragment.length > 0 ? fragment.subarray(0, -1) : fragment;
      if (endsWithCarriageReturn && fragment.length === 0 && !overflow) unfinished = unfinished.subarray(0, -1);
      if (overflow) {
        const combined = Buffer.concat([overflowTail, finalFragment]);
        overflowTail = Buffer.alloc(0);
        const content = endsWithCarriageReturn && combined.length > 0
          ? combined.subarray(0, -1)
          : combined;
        if (content.length > 0) await overflow.write(content);
        await overflow.finish();
        overflow = undefined;
        sourceOrdinal += 1;
        return;
      }
      const contentLength = unfinished.length + finalFragment.length;
      if (contentLength > MAX_SESSION_ARTIFACT_LINE_BYTES) throw new Error(options.errorMessage);
      if (!options.skipEmptyLines || contentLength > 0) {
        const complete = Buffer.concat([unfinished, finalFragment]);
        await options.onLine(complete.toString('utf8'));
        sourceOrdinal += 1;
      }
      unfinished = Buffer.alloc(0);
    };

    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > MAX_SESSION_ARTIFACT_BYTES) throw new Error(options.errorMessage);

      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline === -1) {
          await writeFragment(bytes.subarray(offset));
          break;
        }
        await finishLine(bytes.subarray(offset, newline));
        offset = newline + 1;
      }
    }

    if (overflow) {
      if (overflowTail.length > 0) await overflow.write(overflowTail);
      await overflow.finish();
    }
    else if (unfinished.length > 0 || !options.skipEmptyLines) await options.onLine(unfinished.toString('utf8'));
  } catch {
    throw new Error(options.errorMessage);
  } finally {
    if (stream) stream.destroy();
    else if (options.fileDescriptor !== undefined) closeSync(options.fileDescriptor);
  }
}
