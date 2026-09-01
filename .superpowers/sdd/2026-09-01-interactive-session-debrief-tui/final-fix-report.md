# Interactive debrief TUI final fix report

## RED

Added regression tests before implementation and ran the focused suite:

```text
tests 21
pass 18
fail 3
```

The failures demonstrated that terminal control characters remained in the presentation model and rendered frame, and that `toggle-evidence` changed overview state. The initial wide-glyph row assertion did not fail because the previous counter treated each grapheme as one column; the test was strengthened with `visibleWidth('測😀') === 4` before the width implementation.

## GREEN

- The presentation model removes C0, DEL, and C1 control characters from reviewer text, insight IDs, tool names, and evidence summaries.
- The renderer applies the same control-character removal before fitting and styling text.
- Display fitting measures grapheme terminal columns, treating CJK-wide glyphs and emoji as two columns.
- The reducer ignores `toggle-evidence` unless detail view is active.
- The terminal integration test now uses a five-second elapsed-time startup bound instead of 100 event-loop turns, which prevented full-suite contention from causing a false timeout.

Focused verification:

```text
tests 21
pass 21
fail 0
```

Full verification:

```text
rtk pnpm check
tests 508
pass 508
fail 0
```

`rtk git diff --check` completed without output.
