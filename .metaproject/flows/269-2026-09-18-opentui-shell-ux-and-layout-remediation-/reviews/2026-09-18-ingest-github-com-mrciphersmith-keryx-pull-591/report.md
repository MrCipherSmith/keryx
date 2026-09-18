# Review round 1 — flow 269 / PR #591 (`466183e4`)

Target: `pr` · https://github.com/MrCipherSmith/keryx/pull/591 · head `466183e4cc473341358a97f3c11069aaf72c2a27`
Scope: diff `origin/main...466183e4`: 26 files, +1872/−57. Source under review: `src/tui/tui-shell.ts`, `src/tui/modal-host.ts`, `src/tui/review-inspector.ts`, `src/tui/shell-chrome.ts`, `src/tui/transcript-blocks.ts`, `src/commands/agent-commands.ts` plus their tests. Requirements docs, flow state and gdgraph artifacts were read but not reviewed line by line.
Reviewers: one manual review pass in the orchestrating session (Claude Opus 5), not a dispatched reviewer panel. Findings carry `reviewer: session-review` for that reason. No scope-B reviewer (`review-regression`) ran, so there is no blast-radius record.
Model: `claude-opus-5`, current session; no `keryx review tier` computation was made for this round.
Checks run: `bun test` on the six touched test files (154 pass), `bun test src/tui` (725 pass), `tsc --noEmit` (2 errors, reproduced in CI job `typecheck-and-tests`), `eslint .` (clean).

## Verdict

REQUEST_CHANGES. The `typecheck-and-tests` job was red at this head while the flow already read `implemented`: two type errors (F-001, F-002). One acceptance criterion was met only in part (F-004), and the two picker rewrites doubled the picker code instead of reusing it (F-003).

## Findings

### F-001 `blocker` — the new picker test imports a type `tui-shell` does not export
`src/tui/model-session-picker-modal.test.ts:2` imports `type SessionSummary` from `./tui-shell`, which only imports it. `tsc` fails with TS2459.

### F-002 `blocker` — `contentRows: undefined` violates `exactOptionalPropertyTypes`
`src/tui/review-inspector.ts:497` passes `contentRows: isCompactEmpty ? 3 : undefined` to `openModal`, whose `contentRows?: number` does not accept `undefined`. TS2379.

### F-003 `major` — the modal-hosted pickers are a second copy of the overlay pickers
`pickModelInTui` and `pickSessionInTui` each gained a ~150-line `ModalChrome` branch that repeats the filter state, `apply`, key handling and placeholder rows of the overlay branch, which stays for `chat-shell.ts` and the existing tests.

### F-004 `major` — AC7 is implemented for one modal only
Only the empty `/review` passes `contentRows`; the pickers and every other modal still size to 95% of the terminal, and the 85% cap applies only when `contentRows` is given.

### F-005 `minor` — the `/model` modal repeats its key hints, and says "close" where Esc goes back
The filter line `type to filter · ↑/↓ Enter · Esc to close` repeats the footer — the duplication AC4 removed from `/sessions`. Inside `selectProviderModelInTui` Esc at the model step returns to the provider step.

### F-006 `minor` — a bare Enter on an empty composer jumps the transcript to the bottom
The AC5 scroll in `textarea.onSubmit` runs before the empty-line check, so an operator reading history is yanked to the end by Enter on an empty composer.

### F-007 `minor` — `/help` wrapping leaves trailing whitespace and unexplained widths
`renderCommandHelp` emits indent-only lines for empty description lines; `helpText` uses bare `- 4` / `- 34`.

### F-008 `info` — modal-host documentation and casts
`BACKDROP_ALPHA`'s comment ("how much of the transcript stays visible") contradicts `1.0`; the AC1 test is still named "translucent"; `resolveModalAvailableWidth` repeats `as { width?: number }` casts on typed `Box` values; the host's once-per-renderer mount point is undocumented.

```json keryx:findings
[
  {
    "id": "F-001",
    "severity": "blocker",
    "file": "src/tui/model-session-picker-modal.test.ts",
    "line": 2,
    "problem": "The new picker test imports type SessionSummary from ./tui-shell, which does not export it, so tsc fails (TS2459).",
    "impact": "CI job typecheck-and-tests is red at the PR head, so the PR cannot merge and the flow's AC10 claim (all checks green) is false.",
    "suggested_fix": "Import SessionSummary from its home module src/session/store.ts and build complete fixtures.",
    "evidence": "bunx tsc --noEmit at 466183e4: src/tui/model-session-picker-modal.test.ts(2,49): error TS2459: Module './tui-shell' declares 'SessionSummary' locally, but it is not exported. Same error in CI run 35352026993, job typecheck-and-tests. tsc on origin/main is clean.",
    "confidence": "high",
    "reviewer": "session-review",
    "blocking_merge": true,
    "class_scope": {
      "sites": ["src/tui/model-session-picker-modal.test.ts:2"],
      "enumeration_method": "Every tsc error at 466183e4 was listed: exactly two, this one and F-002."
    }
  },
  {
    "id": "F-002",
    "severity": "blocker",
    "file": "src/tui/review-inspector.ts",
    "line": 497,
    "problem": "presentReview passes contentRows: undefined to openModal, which exactOptionalPropertyTypes rejects (TS2379).",
    "impact": "Second of the two type errors that keep typecheck-and-tests red at the PR head.",
    "suggested_fix": "Pass contentRows through a conditional spread only when the review is empty.",
    "evidence": "bunx tsc --noEmit at 466183e4: src/tui/review-inspector.ts(497,42): error TS2379 ... Types of property 'contentRows' are incompatible. Type 'number | undefined' is not assignable to type 'number'.",
    "confidence": "high",
    "reviewer": "session-review",
    "blocking_merge": true,
    "class_scope": {
      "sites": ["src/tui/review-inspector.ts:497"],
      "enumeration_method": "Every tsc error at 466183e4 was listed: exactly two, this one and F-001; contentRows has no other caller at that head."
    }
  },
  {
    "id": "F-003",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "line": 2269,
    "problem": "pickModelInTui and pickSessionInTui each gained a ModalChrome branch that duplicates the overlay branch's filter state, apply(), key handling and placeholder rows.",
    "impact": "Two parallel copies per picker (four filter lists in total) must be fixed in lockstep; the modal copies already diverged in key handling (manual up/down, a second Enter path beside ITEM_SELECTED).",
    "suggested_fix": "Extract one type-to-filter list body that mounts into either the overlay box or a ModalHost tab body.",
    "evidence": "git diff origin/main...466183e4 -- src/tui/tui-shell.ts: +319 lines, of which the ModalChrome branches of pickModelInTui (2278-2414) and pickSessionInTui (2515-2663) restate the overlay code below each of them; the overlay branches remain reachable from chat-shell.ts:623-653 and tui-shell.ts:2947.",
    "confidence": "high",
    "reviewer": "session-review",
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts:2269 (pickModelInTui)", "src/tui/tui-shell.ts:2507 (pickSessionInTui)"],
      "enumeration_method": "grep for SelectRenderable pickers that gained an isModalChrome branch in the diff: exactly these two functions; selectProviderModelInTui only forwards chrome to pickModelInTui."
    }
  },
  {
    "id": "F-004",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "line": 2307,
    "problem": "AC7 (modals compute adaptive height from content rows, capped at 85%) is met only by the empty /review modal; the /model and /sessions modals pass no contentRows and still take 95% of the terminal.",
    "impact": "A frozen acceptance criterion is confirmed while two of the three modals this flow touched do not satisfy it.",
    "suggested_fix": "Pass contentRows from both pickers (filter line plus list rows), or narrow AC7 through keryx flow ac update.",
    "evidence": "At 466183e4 the only caller passing contentRows to openModal is review-inspector.ts:505; the openModal calls at tui-shell.ts:2307 and :2558 pass none, so resolveModalPanelSize takes its 95% branch.",
    "confidence": "high",
    "reviewer": "session-review",
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts:2308 (model picker openModal)", "src/tui/tui-shell.ts:2558 (session picker openModal)", "src/tui/review-inspector.ts:505"],
      "enumeration_method": "grep -n 'contentRows' src at 466183e4 plus every openModal( call site in files this PR changed."
    }
  },
  {
    "id": "F-005",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "line": 2307,
    "problem": "The /model modal's filter line repeats the footer's key hints, and its footer says esc close although Esc at the model step of the provider wizard goes back to the provider step.",
    "impact": "The duplication AC4 removed from /sessions remains in /model, and the /connect and /provider flows describe Esc wrongly.",
    "suggested_fix": "Keep only the filter prompt on the filter line and let the wizard pass an Esc label of back.",
    "evidence": "At 466183e4 the filter line reads 'type to filter · ↑/↓ Enter · Esc to close' while the footer reads '↑/↓ select · Enter confirm · esc close'; selectProviderModelInTui continues to the provider step when pickModelInTui resolves undefined.",
    "confidence": "high",
    "reviewer": "session-review"
  },
  {
    "id": "F-006",
    "severity": "minor",
    "file": "src/tui/shell-chrome.ts",
    "line": 1059,
    "problem": "The AC5 jump-to-bottom runs on every composer submit, including a bare Enter on an empty composer that sends nothing.",
    "impact": "An operator scrolled up reading history loses their place by pressing Enter on an empty composer.",
    "suggested_fix": "Scroll only when the submitted line is non-empty, in the one place both submit paths share.",
    "evidence": "textarea.onSubmit at 466183e4 sets scroll.scrollTop = scroll.scrollHeight and stickyScroll = true before emitSubmit(line), with no check on line.",
    "confidence": "high",
    "reviewer": "session-review"
  },
  {
    "id": "F-007",
    "severity": "minor",
    "file": "src/commands/agent-commands.ts",
    "line": 465,
    "problem": "renderCommandHelp emits indent-only lines for empty description lines, and helpText sizes the wrap with bare - 4 and - 34.",
    "impact": "Trailing whitespace in /help output, and a wrap width whose derivation is not written down.",
    "suggested_fix": "trimEnd each rendered row, factor out the word wrap, and name the width constants.",
    "evidence": "At 466183e4, an empty rawLine with words.length === 0 pushes `${indent}` (width + 4 spaces); tui-shell.ts:3966 uses chrome.main.width - 4 and r.width - 34.",
    "confidence": "medium",
    "reviewer": "session-review"
  },
  {
    "id": "F-008",
    "severity": "info",
    "file": "src/tui/modal-host.ts",
    "line": 84,
    "problem": "BACKDROP_ALPHA's comment contradicts its value 1.0, the AC1 test is still named translucent, resolveModalAvailableWidth casts typed Box values, and the once-per-renderer mount point is undocumented.",
    "impact": "Misleading documentation for the next change to modal-host.",
    "suggested_fix": "Reword the comment, rename the test, drop the casts and document the mount point.",
    "evidence": "modal-host.ts:78-84 and :141-159 at 466183e4; modal-host.test.ts AC1 title contains 'translucent backdrop'.",
    "confidence": "high",
    "reviewer": "session-review"
  }
]
```
