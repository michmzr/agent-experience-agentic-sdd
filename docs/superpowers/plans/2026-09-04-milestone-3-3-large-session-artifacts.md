# Milestone 3.3 large session artifacts implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Review Codex, Claude Code and Cursor artifacts up to 64 MiB while retaining the latest bounded evidence and preserving the sanitizer boundary.

**Architecture:** A shared accumulator retains the latest source records, stable source ordinals and newest complete text within a 256 KiB budget. Incremental JSONL and Markdown readers validate source input then feed that accumulator. Normalization accepts complete-artifact time boundaries.

**Tech stack:** Node.js 22.17+, TypeScript, node:fs, node:stream, node:test, pnpm.

---

## File structure

- Create: src/review/bounded-session.ts. Latest-event and newest-text accumulator.
- Create: src/review/adapters/bounded-jsonl.ts. Byte-bounded JSONL line reader.
- Modify: src/review/contracts.ts. 64 MiB cap, line cap, source ordinals and complete-session bounds.
- Modify: src/review/adapters/codex.ts and src/review/adapters/claude-code.ts. Incremental JSONL processing.
- Modify: src/review/adapters/cursor.ts and src/review/review-service.ts. Asynchronous streamed Markdown.
- Create: test/bounded-session.test.ts, test/bounded-jsonl.test.ts and test/milestone-3-3-large-artifacts.test.ts.
- Modify: test/review-contracts.test.ts, test/review-resource-limits.test.ts, test/codex-adapter.test.ts, test/cursor-adapter.test.ts and test/session-text-evidence.test.ts.
- Create: docs/verification/2026-09-04-milestone-3-3-large-session-artifacts.md.

### Task 1: Define bounded evidence contracts

**Files:**

- Create: src/review/bounded-session.ts
- Modify: src/review/contracts.ts
- Create: test/bounded-session.test.ts
- Modify: test/review-contracts.test.ts

- [ ] **Step 1: Write failing tests**

Add accumulator tests with five records and a three-event limit. Assert retained source ordinals are 2, 3 and 4, while the returned start and end timestamps are from inputs 0 and 4. Use multi-byte text over a small injected byte budget and assert that the oldest retained complete text is removed while event metadata remains. Assert that one text value larger than the entire budget retains no text but retains the event. Assert empty finalization fails.

Add this normalization test:

    const session = normalizeSession({
      source: 'codex',
      artifact: { source: 'codex', id: 'tail', location: '/fixture/tail.jsonl', format: 'observed-jsonl' },
      startedAt: '2026-09-04T10:00:00.000Z',
      endedAt: '2026-09-04T10:03:00.000Z',
      records: [
        { kind: 'metadata', occurredAt: '2026-09-04T10:01:00.000Z', sourceOrdinal: 41 },
        { kind: 'tool', occurredAt: '2026-09-04T10:02:00.000Z', tool: 'git', sourceOrdinal: 42 }
      ]
    });
    assert.deepEqual(session.events.map((event) => event.id), ['tail:41', 'tail:42']);

Assert rejection for one missing boundary, end before start, an event outside the supplied interval and an invalid ordinal.

- [ ] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/bounded-session.test.js dist/test/review-contracts.test.js

Expected: the bounded-session module and new contract fields do not exist.

- [ ] **Step 3: Implement contracts and accumulator**

Set shared limits:

    export const MAX_SESSION_ARTIFACT_BYTES = 64 * 1024 * 1024;
    export const MAX_SESSION_ARTIFACT_LINE_BYTES = 4 * 1024 * 1024;

Add optional sourceOrdinal to LocalSessionRecord. Add optional startedAt and endedAt to NormalizeSessionInput. When both are supplied, validate canonical timestamps, chronology and retained-event containment. Construct normalized event IDs from sourceOrdinal when present and from the current array index otherwise.

Create this public accumulator contract:

    export interface BoundedSessionWindow {
      readonly records: readonly LocalSessionRecord[];
      readonly startedAt: string;
      readonly endedAt: string;
    }

    export interface BoundedSessionAccumulator {
      add(record: LocalSessionRecord): void;
      finish(): BoundedSessionWindow;
    }

    export function createBoundedSessionAccumulator(
      limits?: { readonly maxEvents?: number; readonly maxTextBytes?: number }
    ): BoundedSessionAccumulator;

Assign a monotonically increasing ordinal when missing. Track first and last accepted timestamps. Retain at most MAX_NORMALIZED_SESSION_EVENTS. Measure text with Buffer.byteLength(text, 'utf8'). Omit an individually over-budget text. When the aggregate exceeds MAX_SESSION_REVIEW_TEXT_LENGTH, remove complete text from oldest retained text-bearing records until the budget is satisfied.

- [ ] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/bounded-session.test.js dist/test/review-contracts.test.js

Expected: all contract and accumulator tests pass.

- [ ] **Step 5: Commit**

    git add src/review/bounded-session.ts src/review/contracts.ts test/bounded-session.test.ts test/review-contracts.test.ts
    git commit -m "feat: bound retained session evidence"

### Task 2: Stream bounded JSONL

**Files:**

- Create: src/review/adapters/bounded-jsonl.ts
- Create: test/bounded-jsonl.test.ts

- [ ] **Step 1: Write failing line-reader tests**

Use temporary files. Assert LF and CRLF lines reach an asynchronous callback in source order while blank lines are ignored. Make the callback reject one marked line and assert no marker appears in the error. Test file sizes equal to and one byte greater than MAX_SESSION_ARTIFACT_BYTES. Test non-empty lines equal to and one byte greater than MAX_SESSION_ARTIFACT_LINE_BYTES. Inject a failing ReadStream factory and assert the stream is destroyed and the error includes no source input.

- [ ] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/bounded-jsonl.test.js

Expected: the bounded JSONL module cannot be resolved.

- [ ] **Step 3: Implement the reader**

Create:

    export interface BoundedJsonlOptions {
      readonly path: string;
      readonly onLine: (line: string) => void | Promise<void>;
      readonly streamFactory?: (path: string) => ReadStream;
    }

    export async function readBoundedJsonl(options: BoundedJsonlOptions): Promise<void>;

Use createReadStream with a 64 KiB high-water mark. Count Buffer chunk bytes and reject above MAX_SESSION_ARTIFACT_BYTES. Maintain only the incomplete line, split at byte 0x0A, strip one preceding 0x0D, ignore empty lines and reject a non-empty line above MAX_SESSION_ARTIFACT_LINE_BYTES. Decode complete lines as UTF-8 and await onLine serially. Destroy the stream in finally. File and stream errors must become the generic message Session artifact could not be read.

- [ ] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/bounded-jsonl.test.js

Expected: byte, line and cleanup tests pass.

- [ ] **Step 5: Commit**

    git add src/review/adapters/bounded-jsonl.ts test/bounded-jsonl.test.ts
    git commit -m "feat: stream bounded JSONL session artifacts"

### Task 3: Migrate Codex and Claude Code JSONL

**Files:**

- Modify: src/review/adapters/codex.ts
- Modify: src/review/adapters/claude-code.ts
- Modify: test/codex-adapter.test.ts
- Modify: test/review-resource-limits.test.ts
- Modify: test/session-text-evidence.test.ts

- [ ] **Step 1: Write failing adapter tests**

Add 1,026 valid Codex records. Assert IDs range from :2 through :1025, startedAt is from line 0 and endedAt from line 1025. Put a marked invalid line before 1,025 valid ones and assert rejection without the marker. Add equivalent Claude Code coverage.

Replace one-megabyte all-source rejection assertions with valid 64 MiB files and one-byte-over resource-limit files. Add old and newest credential markers. Assert evicted text does not cross the adapter boundary; assert retained text is sanitized before review output.

- [ ] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/codex-adapter.test.js dist/test/review-resource-limits.test.js dist/test/session-text-evidence.test.js

Expected: adapters still reject valid artifacts above one MiB or more than 1,024 source records.

- [ ] **Step 3: Implement streaming adapters**

Preserve current regular-file, symlink, root-containment, extension and Claude sidecar checks. Replace complete-file reads and source line-count rejections with readBoundedJsonl. Pass every source-validated record to the accumulator. Finalize and normalize:

    const window = accumulator.finish();
    return normalizeSession({
      source: 'codex',
      artifact,
      records: window.records,
      startedAt: window.startedAt,
      endedAt: window.endedAt
    });

Keep existing Codex synthetic and observed parsing and Claude message, metadata and tool allowlists unchanged.

- [ ] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/codex-adapter.test.js dist/test/review-resource-limits.test.js dist/test/session-text-evidence.test.js

Expected: both JSONL sources retain the latest evidence, accept valid 64 MiB artifacts and retain privacy behavior.

- [ ] **Step 5: Commit**

    git add src/review/adapters/codex.ts src/review/adapters/claude-code.ts test/codex-adapter.test.ts test/review-resource-limits.test.ts test/session-text-evidence.test.ts
    git commit -m "feat: stream Codex and Claude review artifacts"

### Task 4: Stream Cursor Markdown

**Files:**

- Modify: src/review/adapters/cursor.ts
- Modify: src/review/review-service.ts
- Modify: test/cursor-adapter.test.ts
- Modify: every test importing readCursorMarkdownExport

- [ ] **Step 1: Write failing Cursor tests**

Convert direct calls to await readCursorMarkdownExport. Add 1,026 alternating User and Assistant headings and assert IDs :2 through :1025. Add a four-megabyte Markdown-line boundary, an over-budget message whose event remains without text, a valid 64 MiB fixture made from ignored pre-heading lines, and a one-byte-over size rejection without a marker or root path.

- [ ] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/cursor-adapter.test.js dist/test/session-text-evidence.test.js

Expected: TypeScript errors because the existing reader is synchronous.

- [ ] **Step 3: Implement asynchronous Markdown parsing**

Change the reader to return Promise<NormalizedSession>. Keep resolveCursorExport unchanged. Verify the initial file size, count streamed bytes and apply the four-megabyte line limit. Match User and Assistant headings. Finalize a message at the next heading and at end of file. Buffer a message only while its UTF-8 bytes stay within MAX_SESSION_REVIEW_TEXT_LENGTH. Once it exceeds that value, discard the complete buffer and submit the message without text. Submit every supported message to the shared accumulator.

Await the reader in review-service:

    return await readCursorMarkdownExport(
      { source: 'cursor', id: basename(input.session, '.md'), location, format: 'markdown-export' },
      input.root,
      new Date(0).toISOString()
    );

- [ ] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/cursor-adapter.test.js dist/test/session-text-evidence.test.js

Expected: Cursor streams the latest headings and preserves root and symlink protections.

- [ ] **Step 5: Commit**

    git add src/review/adapters/cursor.ts src/review/review-service.ts test/cursor-adapter.test.ts test/session-text-evidence.test.ts
    git add test
    git commit -m "feat: stream bounded Cursor review exports"

### Task 5: Verify cross-source acceptance

**Files:**

- Create: test/milestone-3-3-large-artifacts.test.ts
- Create: docs/verification/2026-09-04-milestone-3-3-large-session-artifacts.md
- Modify: docs/product/roadmap.md

- [ ] **Step 1: Write the failing acceptance test**

Generate deterministic valid 7.97 MiB fixtures for every source. Each must exceed 1,024 supported records and include evicted and retained credential markers. Run the source adapter and sanitizeForReview. Assert exactly 1,024 sanitized events, no more than 256 KiB retained text, no evicted marker in the normalized session and no retained marker in sanitizer output.

Measure performance.now duration and process.resourceUsage().maxRSS before and after each run. Print JSON containing source, artifact bytes, retained event count, retained text bytes, duration milliseconds and RSS delta. Do not assert duration or memory thresholds.

- [ ] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/milestone-3-3-large-artifacts.test.js

Expected: an adapter still fails the previous artifact-size or complete-file behavior until Tasks 1 through 4 are complete.

- [ ] **Step 3: Document completed verification**

Make only corrections required by the acceptance test. Write the verification document with branch, commit, commands, pass counts, fixture sizes and emitted metrics. Update the roadmap to mark only the large-artifact increment complete while Cursor diagnostics and stale-session reconciliation remain deferred.

- [ ] **Step 4: Verify release gate**

Run:

    pnpm build && node --test dist/test/milestone-3-3-large-artifacts.test.js
    pnpm test

Expected: acceptance passes and the full suite has zero failures and zero skipped tests.

- [ ] **Step 5: Commit**

    git add test/milestone-3-3-large-artifacts.test.ts docs/verification/2026-09-04-milestone-3-3-large-session-artifacts.md docs/product/roadmap.md
    git commit -m "test: verify large session artifact review"

## Plan self-review

The tasks cover contracts, source-independent retention, streaming JSONL, all three adapters, privacy boundaries, measurements and release verification. The names sourceOrdinal, startedAt, endedAt, BoundedSessionWindow and readBoundedJsonl remain consistent. No task contains a deferred implementation marker.

