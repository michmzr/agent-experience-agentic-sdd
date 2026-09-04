# Milestone 3.3 large session artifacts verification

Date: 2026-09-04

Branch: `codex/milestone-3-3-reliability`

Final commit command: `git commit -m "test: verify large session artifact review"`

Final commit result: passed.

## Fixture contract

The verification test creates deterministic local Codex JSONL, Claude Code JSONL and Cursor Markdown artifacts. Each fixture is 8,357,151 UTF-8 bytes, which is 7.97 MiB rounded to the nearest byte. Each source fixture contains 1,025 supported events. The earliest event contains `secret=evicted-credential-marker`; the newest contains `secret=retained-credential-marker`.

The test reads every fixture through its production adapter, passes the normalized session to `sanitizeForReview`, and checks that the retained session and sanitized artifact contain 1,024 events. It checks that normalized retained text is no larger than 262,144 UTF-8 bytes, that the evicted marker is absent after normalization, and that the retained marker is absent after sanitization.

## Executed checks

| Command | Result |
| --- | --- |
| `pnpm build && node --test dist/test/milestone-3-3-large-artifacts.test.js` | 1 passed, 0 failed. |
| `pnpm test` | 544 passed, 0 failed, 0 skipped. |

## Metrics from the final suite run

The test emits one JSON record per source. `rssDelta` is the difference in `process.resourceUsage().maxRSS` recorded around the adapter and sanitization run.

```json
{"source":"codex","artifactBytes":8357151,"retainedEventCount":1024,"retainedTextBytes":11202,"durationMs":67.71712499999998,"rssDelta":197936}
{"source":"claude-code","artifactBytes":8357151,"retainedEventCount":1024,"retainedTextBytes":11202,"durationMs":106.10975000000002,"rssDelta":26352}
{"source":"cursor","artifactBytes":8357151,"retainedEventCount":1024,"retainedTextBytes":11202,"durationMs":50.14191699999998,"rssDelta":6000}
```
