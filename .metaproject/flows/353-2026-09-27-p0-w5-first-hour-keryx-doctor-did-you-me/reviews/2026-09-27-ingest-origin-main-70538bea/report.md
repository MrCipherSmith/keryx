**No blockers, merge-ready.** Reviewed `70538bea` against `origin/main` (round 4, PR #773). Verifier-only fix round: no domain reviewers dispatched. This round checks the fix commit `70538bea` (delta `861be8c2..70538bea`, one file: `src/cli.test.ts`) against the two findings round 3 retained.

### Prior findings

- **T4** (minor, `review-testing-practices`) — **closed**. Round 3's test claimed to cover comma-joined/path/pattern first positionals but only its case 1 (`integrate cursor,claude`) actually exercised the guard; cases 2-4 sat behind bare subcommand words already known to their groups and proved nothing. The fix commit deletes cases 2-4 and the original test, replacing it with one test — `"a group whose first positional is a comma-joined list is not in the map and is never refused"` — that (a) asserts `integrate` is absent from `GROUP_SUBCOMMANDS` and (b) runs `integrate cursor,claude --dry-run` and asserts it is not refused as unknown. Re-verified by execution and by mutation: `bun test src/cli.test.ts` is 68 pass / 0 fail at head, and re-adding `["integrate", [...]]` to `src/lib/group-subcommands.ts` makes the new test fail on its first assertion (`expect(...).not.toContain("integrate")`), reverted immediately after.
- **T5** (info, `review-testing-practices`) — **closed**. `runBunExpectingFailure` read as if it asserted a non-zero exit; it did not. The fix commit renames the helper to `runBunCapture` and rewrites its JSDoc to state plainly that it "never rejects on the exit code: it resolves with stdout/stderr/code whatever the code was, so a test can assert exit 1 (flow 353 AC3) or exit 0 as the case under test." Verified by site-check: the misleading name no longer exists in `src/cli.test.ts`; all seven call sites in the file now call `runBunCapture`.

Both findings are carried into this round's `keryx:findings` block below (verbatim `global_id`, per `reviewer-finding.schema.json`) so the verifier's `refuted` verdicts can be applied by `keryx review ingest --verification-mode filter`.

### Regressions the fixes introduced

None found. The fix commit is a pure test-file rewrite (22 insertions, 26 deletions, `src/cli.test.ts` only) with no production code touched; the mutation check confirms the new test still exercises the exact guard it claims to.

### Verified clean

- `bun test src/cli.test.ts` at `70538bea` — 68 pass, 0 fail, 309 expect() calls.
- Mutation-in: re-adding `["integrate", ["cursor","claude","opencode","vscode","generic","all"]]` to `src/lib/group-subcommands.ts` and re-running the new test alone (`bun test src/cli.test.ts -t "comma-joined list is not in the map"`) fails on `expect([...groupsWithKnownSubcommands()]).not.toContain("integrate")`. Reverted; `git -C /home/altsay/keryx-w5 status --porcelain` shows only the pre-existing untracked `.metaproject/data/governance/` directory, unchanged from before the check.

### How this review was run

- **Run by:** MrCipherSmith with `review-orchestrator`
- **Scope:** `origin/main..70538bea`, round 4, PR #773
- **Orchestrator:** `review-orchestrator`
- **Verifier:** `review-verifier` — T4, T5 both `refuted` by execution/site-check at this head
- **Not run:** domain reviewers — verifier-only fix round per instruction; no new code beyond the one test file
- **Verification:** `filter`; confirmed 0, refuted 2, unverifiable 0, unverified 0; retained 0

```json keryx:findings
[
  {
    "id": "T4",
    "global_id": "2026-09-27-ingest-861be8c20e366df1c1a6eea22728ab2e0d2a886e#T4",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/cli.test.ts",
    "line": null,
    "quote": "test(\"a comma-joined, path or pattern first positional is never refused as unknown\", async () => {",
    "problem": "The test's own name and preceding comment claim to cover comma-joined, path and pattern first positionals, but the guard under test only ever inspects args[1]; cases 2-4 put a plain bare word already known to that group's subcommand list at args[1], so only case 1 (integrate's comma-joined list) exercised the guard at all.",
    "impact": "A future reader or later review round would treat this test as proof that path- and pattern-shaped first positionals are safe across the guard, when only the comma-joined-list shape was actually protected.",
    "suggested_fix": "Rescope the test to state what it actually protects (integrate's removal from the map / its comma-joined form), or drop the cases that prove nothing.",
    "evidence": "Round 3 mutation check: reverting only the integrate row removal and keeping only cases 2-4 still passed (no coverage for the bug); the same revert with all 4 cases failed only on case 1.",
    "confidence": "high",
    "location_class": "in-diff"
  },
  {
    "id": "T5",
    "global_id": "2026-09-27-ingest-861be8c20e366df1c1a6eea22728ab2e0d2a886e#T5",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/cli.test.ts",
    "line": null,
    "quote": "function runBunExpectingFailure(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {",
    "problem": "The name runBunExpectingFailure reads as if it asserts or requires a non-zero exit, but it resolves with whatever exit code occurred, unlike runBun which rejects on non-zero.",
    "impact": "Low: the JSDoc already documented the real behavior and no test misused it, but the name is misleading on its own.",
    "suggested_fix": "Rename to something exit-code-agnostic.",
    "evidence": "src/cli.test.ts's JSDoc for the helper stated verbatim that it resolves regardless of the exit code, and its body never rejects or asserts on a non-zero code.",
    "confidence": "high",
    "location_class": "in-diff"
  }
]
```
