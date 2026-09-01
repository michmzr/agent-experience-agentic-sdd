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

## Unicode width correction

### RED

Replaced the prior renderer width assertion with independent known-width cases. Before the implementation change, `U+A960` measured as one column instead of two. The prior range heuristic also omitted `U+1B000`, `U+1F200`, and emoji modifiers, and widened all extended pictographs.

### GREEN

The renderer now uses sorted local Unicode terminal-wide intervals with binary search, plus emoji-presentation, emoji variation-selector, and keycap sequence rules. Exact test expectations cover:

- `測😀` = 4 columns
- `U+A960` = 2 columns
- `𛀀𛀀` = 4 columns
- `U+1F200` and `U+1F3FB` = 2 columns each
- `©a` = 2 columns, while plain `☀` and `♟` = 1 column each
- `©️`, `1️⃣`, and `👩‍💻` = 2 columns each

Focused renderer and state verification passed 14 tests with zero failures.

Full verification after the correction: `rtk pnpm check` passed 508 tests with zero failures. `rtk git diff --check` completed without output.

## Tangut width correction

### RED

Added independent exact-width regressions. `𗀀` initially measured as one column instead of two. The test also specifies that two Tangut characters cannot fit in a two-column viewport and that U+303F remains one column.

### GREEN

The local interval table now covers Tangut, Tangut Components, Tangut Supplement, U+16FE0 and U+16FF0 blocks, and the related Kana and enclosed-CJK intervals. The U+2E80 through U+A4CF interval is split around U+303F, preserving its Neutral East Asian Width. Focused renderer and state verification passed 14 tests with zero failures.

Full verification after the Tangut correction: `rtk pnpm check` passed 508 tests with zero failures. `rtk git diff --check` completed without output.
