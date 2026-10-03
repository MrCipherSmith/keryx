**No blockers, merge-ready.** Reviewed `cbbbe29f36fac4a3305ce1b5548bfa8ce3063079` against `origin/main` (round 5, PR #773). Verifier-only round: no domain reviewers dispatched. This round checks the delta since round 4 (`70538bea..cbbbe29f`, one file: `src/tui/help-modal.test.ts`).

### The delta

Flow 353 appended `doctor` and `/doctor` to the "Start here" help group (`src/standard/help-groups.ts`). CI had failed the opentui native jobs on `src/tui/help-modal.test.ts`'s "↓ never runs past the last command in a tab" expectation, which still asserted the pre-flow-353 terminal entry `slash:/help`. The fix commit moves that expectation to `slash:/doctor` and rewrites the preceding comment to say the group now has 7 entries instead of 5.

### Verified clean

- `bun test src/tui/help-modal.test.ts` at `cbbbe29f` (worktree `~/keryx-w5`) — 5 pass, 14 skip, 0 fail, 28 expect() calls (19 tests, 197ms).
- `src/standard/help-groups.ts:100-127` — the "Start here" group's literal entry order is `init`, `status`, `shell`, `help`, `/help`, `doctor`, `/doctor`, ending exactly there before the "Connect a model provider" group begins at line 129. `/doctor` is the last entry, so the new expectation is the truthful one, not a test bent to pass.
- `bun test src/standard/commands-by-task.test.ts src/standard/help-groups.test.ts src/commands/help-grouped.test.ts src/commands/help.test.ts` — 43 pass, 0 fail, 2370 expect() calls. No other test in the repository pins the "Start here" order or entry count: `help-groups.test.ts` only asserts `shell`'s group membership, and `commands-by-task.test.ts` is the docs-agreement test, which already agrees — `docs/docs/commands-by-task.md`'s "Start here" table already lists `keryx doctor` and `/doctor` (added in an earlier round of this same flow).

### Coverage checked (step 2 of the round's instructions)

Searched (`keryx ctx rg`) `"Start here"`, `HELP_GROUPS`, and `slash:/help` across `src/**/*.test.ts` and `docs/docs/commands-by-task.md` + its generator test. No other test asserts an order or count over the "Start here" group; no finding to file.

### Regressions the fixes introduced

None found. The delta is a pure test-file rewrite (3 insertions, 2 deletions, `src/tui/help-modal.test.ts` only), so there is no production code to regress.

### One candidate concern raised and refuted this round

The test-truthfulness risk named above is filed as F1 below (reviewer: `review-testing-practices`) and refuted by `review-verifier` via execution and site-check — see the `keryx:verifications` this round attaches.

### How this review was run

- **Run by:** MrCipherSmith with `review-orchestrator`
- **Scope:** `origin/main..cbbbe29f36fac4a3305ce1b5548bfa8ce3063079`, round 5, PR #773
- **Orchestrator:** `review-orchestrator`
- **Verifier:** `review-verifier` — F1 `refuted` by execution + site-check at this head
- **Not run:** domain reviewers — verifier-only round per instruction; no new code beyond the one test file
- **Verification:** `filter`; confirmed 0, refuted 1, unverifiable 0, unverified 0; retained 0

```json keryx:findings
[
  {
    "id": "F1",
    "global_id": "2026-09-27-ingest-cbbbe29f36fac4a3305ce1b5548bfa8ce3063079#F1",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/tui/help-modal.test.ts",
    "line": null,
    "quote": "expect(handle?.selectedEntry()).toBe(\"slash:/doctor\");",
    "problem": "The delta moves this test's terminal-entry expectation from slash:/help to slash:/doctor because flow 353 appended doctor and /doctor to the \"Start here\" help group; the candidate risk is that the expectation was bent to make CI pass rather than reflecting a truthful new group order.",
    "impact": "If the expectation had been adjusted without the underlying group order actually changing, the test would silently stop catching a real \"down arrow overruns the last command\" regression.",
    "suggested_fix": "None needed once the order is confirmed as claimed.",
    "evidence": "src/standard/help-groups.ts declares the \"Start here\" group ending with /doctor as its last entry; the comment change in the test names the new 7-entry order explicitly.",
    "confidence": "medium",
    "location_class": "in-diff"
  }
]
```
