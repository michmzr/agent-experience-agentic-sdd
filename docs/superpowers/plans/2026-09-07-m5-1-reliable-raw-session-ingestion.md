# M5.1 reliable raw session ingestion implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ael review session` ingest current raw Codex JSONL artifacts with bounded memory, explicit coverage and one safe warning for every unknown record.

**Architecture:** Keep the shared 4 MiB buffered-line path for existing sources. When an observed Codex record crosses that boundary, transfer it to a source-specific streaming JSON projector that validates the complete record and retains only allowlisted fields. Propagate aggregate coverage with the normalized session and emit unknown-record diagnostics immediately through an asynchronous sink.

**Tech Stack:** TypeScript, Node.js 22.17+, `node:fs`, `node:stream`, `node:test`, pnpm.

---

## File structure

- Create `src/review/ingestion.ts`: immutable ingestion coverage, diagnostic and sink contracts plus validation helpers.
- Create `src/review/adapters/codex-records.ts`: shared Codex disposition and checked coverage-counter helpers.
- Create `src/review/adapters/codex-streaming-projector.ts`: incremental JSON tokenizer and Codex field projector for oversized observed records.
- Modify `src/review/contracts.ts`: attach coverage to normalized sessions and normalization inputs.
- Modify `src/review/adapters/bounded-lines.ts`: add an opt-in overflow-record sink without changing default line rejection.
- Modify `src/review/adapters/bounded-jsonl.ts`: expose the opt-in overflow-record contract.
- Modify `src/review/adapters/codex.ts`: classify envelopes, skip token usage, emit per-occurrence diagnostics and route oversized observed records.
- Modify `src/review/sanitizer.ts`: validate, copy and freeze aggregate ingestion coverage.
- Modify `src/review/review-service.ts`: pass the diagnostic sink to Codex ingestion and return coverage.
- Modify `src/cli.ts`: stream one safe warning per unknown record to stderr in the executable path and preserve JSON stdout.
- Create `test/review-ingestion-coverage.test.ts`: coverage validation and sanitizer-boundary tests.
- Create `test/codex-streaming-projector.test.ts`: tokenizer, projection, resource and privacy tests.
- Modify `test/bounded-jsonl.test.ts`: overflow handoff and default rejection tests.
- Modify `test/codex-adapter.test.ts`: known technical and unknown-record behavior.
- Modify `test/review-cli.test.ts`: CLI warning-channel and JSON compatibility tests.
- Create `test/milestone-5-1-acceptance.test.ts`: generated large-record and end-to-end acceptance suite.
- Create `docs/verification/2026-09-07-milestone-5-1-raw-session-ingestion.md`: measured acceptance evidence without transcript content.
- Modify `docs/product/roadmap.md`: correct M5 status and add M5.1 completion only after verification.
- Modify `docs/superpowers/specs/2026-09-07-m5-1-reliable-raw-session-ingestion-design.md`: change status to Complete only after every acceptance check passes.

### Task 1: Define ingestion coverage and diagnostics

**Files:**

- Create: `src/review/ingestion.ts`
- Modify: `src/review/contracts.ts`
- Modify: `src/review/sanitizer.ts`
- Create: `test/review-ingestion-coverage.test.ts`

- [ ] **Step 1: Write failing contract tests**

Create `test/review-ingestion-coverage.test.ts` with a valid coverage object and assertions that normalization and sanitization preserve it exactly:

```ts
const coverage = {
  totalRecords: 4,
  normalizedRecords: 2,
  skippedTechnicalRecords: 1,
  unsupportedRecords: 1,
  truncatedTextFields: 0,
  omittedStructuredOutputs: 1,
  usedStreamingProjection: true
} as const;

const normalized = normalizeSession({
  source: 'codex',
  artifact: { source: 'codex', id: 'coverage', location: '/fixture/coverage.jsonl', format: 'observed-jsonl' },
  records: [{ kind: 'message', occurredAt: '2026-09-07T10:00:00.000Z', text: 'safe' }],
  ingestionCoverage: coverage
});

assert.deepEqual(normalized.ingestionCoverage, coverage);
assert.deepEqual(sanitizeForReview(normalized).session.ingestionCoverage, coverage);
```

Add table-driven rejection for negative values, unsafe integers, non-boolean streaming state and a partition where `totalRecords !== normalizedRecords + skippedTechnicalRecords + unsupportedRecords`. Assert generic errors contain none of the injected marker values.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm build && node --test dist/test/review-ingestion-coverage.test.js
```

Expected: compilation fails because `ingestionCoverage` and the ingestion contracts do not exist.

- [ ] **Step 3: Add the immutable public contracts**

Create `src/review/ingestion.ts` with these public types:

```ts
export interface SessionIngestionCoverage {
  readonly totalRecords: number;
  readonly normalizedRecords: number;
  readonly skippedTechnicalRecords: number;
  readonly unsupportedRecords: number;
  readonly truncatedTextFields: number;
  readonly omittedStructuredOutputs: number;
  readonly usedStreamingProjection: boolean;
}

export interface SessionIngestionDiagnostic {
  readonly code: 'UNSUPPORTED_CODEX_RECORD';
  readonly level: 'envelope' | 'response-item';
  readonly recordType: string;
  readonly sourceOrdinal: number;
}

export type SessionIngestionDiagnosticSink = (
  diagnostic: SessionIngestionDiagnostic
) => void | Promise<void>;
```

Export `validateIngestionCoverage`, `freezeIngestionCoverage` and `formatSafeRecordType`. `formatSafeRecordType` returns its input only when it matches `/^[A-Za-z0-9_.:/-]{1,128}$/`; otherwise it returns `unprintable`. Coverage validation must require non-negative safe integers and enforce the partition invariant.

Add optional `ingestionCoverage` to `NormalizeSessionInput` and required `ingestionCoverage` to `NormalizedSession`. When callers omit input coverage, derive complete coverage from `records.length` with every omission counter at zero and `usedStreamingProjection: false`.

Update `sanitizeForReview`, `validateNormalizedSession`, `assertNoSensitiveContent` and `freezeArtifact` so coverage is validated, copied, scanned only as typed numeric data and frozen.

- [ ] **Step 4: Run the focused and existing contract tests**

Run:

```bash
pnpm build && node --test dist/test/review-ingestion-coverage.test.js dist/test/review-contracts.test.js dist/test/session-text-evidence.test.js
```

Expected: all tests pass with zero failures and zero skipped tests.

- [ ] **Step 5: Commit the contract increment**

```bash
git add src/review/ingestion.ts src/review/contracts.ts src/review/sanitizer.ts test/review-ingestion-coverage.test.ts
git commit -m "feat: expose raw session ingestion coverage"
```

### Task 2: Classify buffered Codex records and log every unknown occurrence

**Files:**

- Create: `src/review/adapters/codex-records.ts`
- Modify: `src/review/adapters/codex.ts`
- Modify: `test/codex-adapter.test.ts`

- [ ] **Step 1: Replace fail-closed unknown-record expectations with diagnostic tests**

Add one fixture containing a supported message, two unknown envelopes of the same safe type, one unsafe display type and one unknown response-item subtype. Inject a sink and assert exact source-order diagnostics:

```ts
assert.deepEqual(diagnostics, [
  { code: 'UNSUPPORTED_CODEX_RECORD', level: 'envelope', recordType: 'future_record', sourceOrdinal: 1 },
  { code: 'UNSUPPORTED_CODEX_RECORD', level: 'envelope', recordType: 'future_record', sourceOrdinal: 2 },
  { code: 'UNSUPPORTED_CODEX_RECORD', level: 'envelope', recordType: 'unprintable', sourceOrdinal: 3 },
  { code: 'UNSUPPORTED_CODEX_RECORD', level: 'response-item', recordType: 'future_item', sourceOrdinal: 4 }
]);
```

Assert all four are omitted, the supported message remains, `unsupportedRecords` is 4 and no private marker from any payload occurs in the normalized session or diagnostics.

Add 43 `token_usage_record` envelopes around one supported message. Assert they produce no diagnostics, `skippedTechnicalRecords` is 43, `normalizedRecords` is 1 and none of the usage payload is retained.

Keep the synthetic `{ kind, occurredAt }` unknown-kind test fail-closed. Add malformed known envelope tests for missing timestamp, missing payload and unsafe tool name.

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```bash
pnpm build && node --test dist/test/codex-adapter.test.js
```

Expected: existing unknown-envelope assertions fail because the adapter still rejects them, and the option type is absent.

- [ ] **Step 3: Add classification and per-record sink delivery**

Add this option contract:

```ts
export interface CodexSessionAdapterOptions {
  readonly diagnosticSink?: SessionIngestionDiagnosticSink;
}

export class CodexSessionAdapter {
  public constructor(
    private readonly artifactRoot: string,
    private readonly options: CodexSessionAdapterOptions = {}
  ) {}
}
```

Create `src/review/adapters/codex-records.ts` and define the shared discriminated result there:

```ts
type CodexRecordDisposition =
  | { readonly state: 'normalized'; readonly record: LocalSessionRecord; readonly truncatedTextFields: number; readonly omittedStructuredOutputs: number }
  | { readonly state: 'technical-skip' }
  | { readonly state: 'unsupported'; readonly diagnostic: SessionIngestionDiagnostic };
```

Export `CodexRecordDisposition`, a mutable private counter factory, checked increment functions and a finalizer that returns validated `SessionIngestionCoverage`. Both buffered and streaming paths must use these helpers so their accounting cannot diverge.

Track `sourceOrdinal` before parsing each non-empty line. Change observed parsing to return `CodexRecordDisposition`.

Classify `token_usage_record` as `technical-skip`. Classify well-formed unknown observed envelopes and response-item subtypes as `unsupported`, call the injected sink exactly once with `await`, and continue. Preserve hard failures for synthetic unknown kinds and malformed supported records.

Assign `sourceOrdinal` to every normalized record before adding it to the accumulator. Build coverage counters with checked safe-integer increments and pass the final coverage to `normalizeSession`.

- [ ] **Step 4: Verify buffered classification**

Run:

```bash
pnpm build && node --test dist/test/codex-adapter.test.js dist/test/review-ingestion-coverage.test.js
```

Expected: every test passes. The diagnostic array contains one entry for each occurrence, not one per type.

- [ ] **Step 5: Commit the classification increment**

```bash
git add src/review/adapters/codex-records.ts src/review/adapters/codex.ts test/codex-adapter.test.ts
git commit -m "feat: classify evolving Codex session records"
```

### Task 3: Implement the oversized Codex record projector

**Files:**

- Create: `src/review/adapters/codex-streaming-projector.ts`
- Create: `test/codex-streaming-projector.test.ts`

- [ ] **Step 1: Write tokenizer and projection tests**

Test a projector through chunk sizes of 1, 2, 7 and 64 KiB. Feed the same observed record through every chunking strategy and assert the identical disposition. Include escaped quotes, backslashes, surrogate-pair escapes, CRLF framing and multi-byte UTF-8 split across chunks.

Use this public test shape:

```ts
const projector = createCodexStreamingProjector({
  sourceOrdinal: 7,
  diagnosticSink: (diagnostic) => diagnostics.push(diagnostic)
});
for (const chunk of chunks(record, chunkSize)) await projector.write(chunk);
const result = await projector.finish();
assert.deepEqual(result, expectedDisposition);
```

Add failure cases for truncated JSON, invalid escape, trailing data, invalid UTF-8, depth 65, an unsafe tool name and an oversized retained key. Put a unique secret marker in discarded output and assert it is absent from returned values and error messages.

Add positive projection cases for `event_msg`, response messages, function calls, string tool output, array tool output, `token_usage_record` and an unknown envelope. Array and object output must produce a tool event without `text` and set `omittedStructuredOutputs: 1`.

- [ ] **Step 2: Run the projector test and verify RED**

Run:

```bash
pnpm build && node --test dist/test/codex-streaming-projector.test.js
```

Expected: compilation fails because the projector module does not exist.

- [ ] **Step 3: Implement the incremental tokenizer boundary**

Export this interface:

```ts
export interface CodexStreamingProjector {
  write(chunk: Buffer): Promise<void>;
  finish(): Promise<CodexRecordDisposition>;
}

export function createCodexStreamingProjector(input: {
  readonly sourceOrdinal: number;
  readonly diagnosticSink?: SessionIngestionDiagnosticSink;
}): CodexStreamingProjector;
```

Implement a single-pass tokenizer with explicit states for whitespace, object key, colon, value, string, string escape, Unicode escape, number, literal and container close. Keep a stack of object or array frames with a maximum depth of 64. Decode UTF-8 through `TextDecoder('utf-8', { fatal: true })` with streaming enabled.

Track the current JSON path without retaining discarded scalar values. Materialize only `timestamp`, top-level `type`, `payload.type`, `payload.name`, supported message text and supported string tool input or output. Bound every retained key and type at 128 characters. Bound each retained text field at `MAX_SESSION_EVENT_TEXT_LENGTH`, keep consuming the full string after truncation and increment `truncatedTextFields` once per truncated field.

For array or object `payload.output`, consume and validate the complete value without retaining descendants, create the tool event without text and increment `omittedStructuredOutputs`. For unknown records, await the sink before `finish` resolves. Return only the disposition contract from Task 2.

- [ ] **Step 4: Verify tokenizer behavior and privacy**

Run:

```bash
pnpm build && node --test dist/test/codex-streaming-projector.test.js
```

Expected: all chunking, syntax, depth, UTF-8, classification and marker-exclusion tests pass.

- [ ] **Step 5: Commit the projector increment**

```bash
git add src/review/adapters/codex-streaming-projector.ts test/codex-streaming-projector.test.ts
git commit -m "feat: project oversized Codex records safely"
```

### Task 4: Route oversized JSONL records without changing other sources

**Files:**

- Modify: `src/review/adapters/bounded-lines.ts`
- Modify: `src/review/adapters/bounded-jsonl.ts`
- Modify: `src/review/adapters/codex.ts`
- Modify: `test/bounded-jsonl.test.ts`
- Modify: `test/review-resource-limits.test.ts`

- [ ] **Step 1: Write failing overflow-handoff tests**

Add an optional oversized-record factory to the bounded reader tests. Write a record one byte over 4 MiB and assert the factory receives the buffered prefix once, then receives later chunks in order, then `finish` once. Assert the regular `onLine` callback is not invoked for that record.

Keep an adjacent normal line and assert its `onLine` callback runs in source order after oversized finalization. Assert a missing factory retains the existing generic line-limit failure. Assert an injected overflow sink failure is converted to the generic artifact-read error without leaking its marker.

In `test/review-resource-limits.test.ts`, retain existing Cursor and Claude Code one-byte-over-line failures. Retain failure for an oversized synthetic Codex record. Add success for an oversized observed Codex tool-output record under 64 MiB.

- [ ] **Step 2: Run bounded-reader tests and verify RED**

Run:

```bash
pnpm build && node --test dist/test/bounded-jsonl.test.js dist/test/review-resource-limits.test.js
```

Expected: the oversized observed Codex case fails with the current generic resource-limit error.

- [ ] **Step 3: Add the opt-in overflow contract**

Add these interfaces to `bounded-lines.ts` and re-export the option through `bounded-jsonl.ts`:

```ts
export interface OverflowRecordSink {
  write(chunk: Buffer): void | Promise<void>;
  finish(): void | Promise<void>;
}

export interface BoundedLineReaderOptions {
  readonly overflowRecordFactory?: (input: {
    readonly prefix: Buffer;
    readonly sourceOrdinal: number;
  }) => OverflowRecordSink | Promise<OverflowRecordSink>;
}
```

Increment `sourceOrdinal` for every non-empty JSONL record. Until the record crosses 4 MiB, retain current buffering. On crossing, require the factory, transfer the complete buffered prefix once, clear the buffer and await later writes. At newline, await `finish` before handling the next record. Never send CR or LF framing bytes to the overflow sink.

In `CodexSessionAdapter.read`, provide the streaming factory for every oversized Codex record. The projector must validate the complete shape and reject oversized synthetic `{ kind, occurredAt }` records. Feed a successful observed disposition through the same accumulator and coverage helper from `codex-records.ts` as buffered parsing, and set `usedStreamingProjection: true`.

- [ ] **Step 4: Verify source isolation and limits**

Run:

```bash
pnpm build && node --test dist/test/bounded-jsonl.test.js dist/test/review-resource-limits.test.js dist/test/codex-adapter.test.js dist/test/claude-code-adapter.test.js dist/test/cursor-adapter.test.js
```

Expected: oversized observed Codex records succeed; synthetic Codex, Cursor and Claude Code retain their existing line-limit failures; every artifact above 64 MiB fails.

- [ ] **Step 5: Commit the routing increment**

```bash
git add src/review/adapters/bounded-lines.ts src/review/adapters/bounded-jsonl.ts src/review/adapters/codex.ts test/bounded-jsonl.test.ts test/review-resource-limits.test.ts
git commit -m "feat: route oversized Codex records to streaming projection"
```

### Task 5: Expose coverage and per-occurrence warnings through review and CLI

**Files:**

- Modify: `src/review/review-service.ts`
- Modify: `src/cli.ts`
- Modify: `test/review-cli.test.ts`
- Modify: `test/review-privacy-contract.test.ts`

- [ ] **Step 1: Write failing service and CLI tests**

Add `ingestionCoverage` to the expected JSON key order in `test/review-cli.test.ts`. For an artifact with two identical unknown envelopes and one supported message, inject a diagnostic writer and assert two separate stderr writes with ordinals 0 and 1. Assert both lines use `UNSUPPORTED_CODEX_RECORD` and neither contains the payload marker or artifact root.

Test JSON mode separately:

```ts
const warnings: string[] = [];
const result = await runCliAsync(argsWithJson, {
  ingestionDiagnosticWrite: async (line) => { warnings.push(line); }
});
assert.doesNotThrow(() => JSON.parse(result.stdout));
assert.equal(result.stderr, '');
assert.equal(warnings.length, 2);
```

Add a privacy test with an unsafe type and assert the warning contains `unprintable`, the correct ordinal and no original type or payload marker.

Add a diagnostic-writer failure test. The review must fail through the generic `REVIEW_ERROR` boundary and must not continue silently after losing a required per-occurrence warning.

- [ ] **Step 2: Run CLI tests and verify RED**

Run:

```bash
pnpm build && node --test dist/test/review-cli.test.js dist/test/review-privacy-contract.test.js
```

Expected: `ingestionCoverage` and `ingestionDiagnosticWrite` are absent.

- [ ] **Step 3: Wire the review boundary**

Add to `ManualReviewDependencies`:

```ts
readonly ingestionDiagnosticSink?: SessionIngestionDiagnosticSink;
```

Pass the dependency through `loadSession` to `CodexSessionAdapter`. Add `ingestionCoverage` to `ManualReviewResult` from the sanitized normalized session. Cursor and Claude Code return complete default coverage from Task 1.

Add to `RunCliAsyncOptions`:

```ts
readonly ingestionDiagnosticWrite?: (line: string) => void | Promise<void>;
```

Create a formatter that serializes only the diagnostic schema:

```ts
function formatIngestionDiagnostic(value: SessionIngestionDiagnostic): string {
  return `${JSON.stringify(value)}\n`;
}
```

When a writer is supplied, compose it with any injected review dependency sink and await both in deterministic order. The executable entrypoint passes an asynchronous writer backed by `process.stderr.write`; resolve the promise only from the write callback when backpressure returns false. Do not append successful ingestion warnings to `CliResult.stderr`, because the executable emits them during ingestion and duplicate output is forbidden.

Update non-JSON completion output to append coverage only when any skip, unsupported record, truncation or structured omission occurred. Do not print record types or paths in stdout.

- [ ] **Step 4: Verify channels and compatibility**

Run:

```bash
pnpm build && node --test dist/test/review-cli.test.js dist/test/review-privacy-contract.test.js dist/test/review-cli-terminal.test.js
```

Expected: JSON stdout parses, each unknown occurrence reaches the injected writer once, successful `CliResult.stderr` stays empty, and interactive behavior remains unchanged.

- [ ] **Step 5: Commit the review and CLI increment**

```bash
git add src/review/review-service.ts src/cli.ts test/review-cli.test.ts test/review-privacy-contract.test.ts
git commit -m "feat: report raw session ingestion diagnostics"
```

### Task 6: Prove M5.1 acceptance and record completion

**Files:**

- Create: `test/milestone-5-1-acceptance.test.ts`
- Create: `docs/verification/2026-09-07-milestone-5-1-raw-session-ingestion.md`
- Modify: `docs/product/roadmap.md`
- Modify: `docs/superpowers/specs/2026-09-07-m5-1-reliable-raw-session-ingestion-design.md`

- [ ] **Step 1: Write the generated acceptance test**

Generate large content inside the test instead of committing a multi-megabyte fixture:

```ts
const largeOutput = Array.from({ length: 13 }, (_, index) => ({
  index,
  output: 'private-marker-'.repeat(40_000)
}));
const oversized = JSON.stringify({
  timestamp: '2026-09-07T10:00:44.000Z',
  type: 'response_item',
  payload: { type: 'custom_tool_call_output', output: largeOutput }
});
assert.ok(Buffer.byteLength(oversized, 'utf8') >= 6_953_534);
```

Combine it with 43 `token_usage_record` envelopes, two separate unknown records and supported user and agent messages. Run the complete manual review and assert exit code 0, one normalized tool event without text, exact coverage counters, two warning writes with exact source ordinals and absence of the private marker from all outputs.

- [ ] **Step 2: Run focused M5.1 acceptance**

Run:

```bash
pnpm build && node --test dist/test/review-ingestion-coverage.test.js dist/test/codex-streaming-projector.test.js dist/test/milestone-5-1-acceptance.test.js
```

Expected: all focused tests pass with zero failures and zero skipped tests.

- [ ] **Step 3: Verify the unchanged private session locally**

Resolve the existing local artifact by session ID under the explicitly selected Codex sessions root. Run the built CLI against that original artifact with no copied or rewritten input. Capture only exit status, structural coverage counts, finding count, candidate count and proposal count. Do not redirect transcript output to a repository file and do not record the absolute source path.

Expected: exit code 0, `skippedTechnicalRecords` equals 43, `omittedStructuredOutputs` is at least 1 and no `REVIEW_ERROR` occurs.

- [ ] **Step 4: Run the full release gate**

Run:

```bash
pnpm check
git diff --check
```

Expected: zero failed and zero skipped tests; no whitespace errors.

- [ ] **Step 5: Record verification and status**

Create `docs/verification/2026-09-07-milestone-5-1-raw-session-ingestion.md` with the exact tested commit range, command outputs, M5.1-A1 through M5.1-A11 evidence and bounded structural counts from the private-session check. Include no transcript text, payload value or absolute path.

Update `docs/product/roadmap.md` so M5 is marked complete from its existing verification and M5.1 is listed separately. Change the M5.1 design status from Approved to Complete only after the verification document contains direct evidence for every criterion.

- [ ] **Step 6: Commit acceptance evidence**

```bash
git add test/milestone-5-1-acceptance.test.ts docs/verification/2026-09-07-milestone-5-1-raw-session-ingestion.md docs/product/roadmap.md docs/superpowers/specs/2026-09-07-m5-1-reliable-raw-session-ingestion-design.md
git commit -m "docs: record milestone 5.1 verification"
```
