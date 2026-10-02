# Review Report — flow 353, round 3 (fix round)

## Verdict: APPROVE_WITH_SUGGESTIONS

## Summary

Round 3 verifies the fix commit `861be8c2` for round 2's two retained findings (L3
blocker, T3 minor) on PR #773. L3 is fully closed: `keryx integrate cursor,claude`
no longer refuses as "Unknown command" and writes both client configs, confirmed
by direct execution on the new head and not reopening the original typo-guard
purpose (a real bad editor name is still caught downstream in
`commands/integrate.ts`). T3 is only partially closed: the new positive test
claims to cover comma-joined, path- and pattern-shaped first positionals, but
the guard it tests only ever inspects `args[1]`, and 3 of its 4 cases put a
plain bare word there — they pass regardless of whether the L3-class bug is
present. Two reviewers (`review-logic`, `review-testing-practices`) found this
independently; `review-verifier` confirmed it by execution in both directions
(mutation-in, mutation-out) and recorded it as one merged finding, `T4`. One
additional `info`-level naming nitpick (`T5`) was also confirmed. No
blocker/major findings remain.

## Review Scope

- Branch: `feat/p0-w5-first-hour`
- Parent ref: `origin/main`
- Merge-base: `f2ee4c8896dde3402c57a8c8544f75544289d0b2`
- Head: `861be8c20e366df1c1a6eea22728ab2e0d2a886e`
- Fix round: true (round 3, answering round 2's package
  `2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42`)
- Fix-delta reviewed by Wave A/B (scope of reviewer dispatch): commit
  `861be8c2` only — `src/lib/group-subcommands.ts`, `src/cli.test.ts` (2 files)
- Scope A record (pre-filter, whole PR diff, for stage-count continuity with
  rounds 1-2): `origin/main..861be8c2`, 39 files seen/retained, 0 dropped,
  1934 changed lines retained
- Scope B (blast radius): not computed this round — no scope-B reviewer
  (`review-regression`) was dispatched; the delta removes one map row and adds
  one test, no regression-check surface
- Reviewers dispatched: `review-logic`, `review-testing-practices` (Wave B, via
  `general-purpose` fallback — no native agent type named `review-logic` /
  `review-testing-practices` in this runtime), `review-verifier` (Wave C, same
  fallback)
- Skipped reviewers: `review-regression` (no scope-B surface; explicitly out of
  scope for this small FIX round), all other domain/convention/legacy
  reviewers (not applicable to a 2-file CLI-routing-table + test change)
- Context mode: light
- Model strategy: current-session (subagent dispatch on this session's model;
  no per-tier override applied)
- Verification mode: filter

## Prior findings from round 2 — disposition this round

- **L3** (blocker, `review-logic`) — **closed**. Checked against the code, not
  the commit message: `src/lib/group-subcommands.ts` no longer carries an
  `"integrate"` row, so the central "unknown subcommand" guard in `src/cli.ts`
  never fires for `integrate` (`knownSubcommandsFor("integrate")` returns
  `undefined`). Confirmed by execution: `bun run src/cli.ts integrate
  cursor,claude --dry-run` at `861be8c2` exits 0 and writes both
  `.cursor/mcp.json` and `.mcp.json` dry-run previews — identical to `main`'s
  pre-regression behaviour. The original guard's purpose is not reopened: a
  genuinely bad editor name (`keryx integrate bogus`) is still caught
  downstream in `commands/integrate.ts` → `resolveMcpRuntimes`, a different but
  equally real one-line error path.
- **T3** (minor, `review-testing-practices`) — **partial**. The fix does add
  one new test, and it does close the specific comma-joined-list gap T3 named
  (case 1, `integrate cursor,claude`, is a genuine, mutation-verified regression
  guard for exactly the class L3 was). But the test's title and comment also
  claim coverage of "path" and "pattern"-shaped first positionals, and that
  half of the claim is false: see new finding **T4**, which subsumes the
  remaining gap T3 pointed at.

## Regressions the fixes introduced

None found. The fix is a subtractive change (one map row removed) plus one
additive test; no new production code path was introduced.

## Stats

- blocker: 0
- major: 0
- minor: 1
- info: 1

## Blockers (must fix before merge)

None.

## Major Issues

None.

## Minor & Info

### [T4] The new test's "path or pattern first positional" coverage claim holds for only 1 of its 4 cases

- **Severity**: minor
- **File**: `src/cli.test.ts` (the new test added by commit `861be8c2`,
  `"a comma-joined, path or pattern first positional is never refused as
  unknown"`)
- **Problem**: The guard in `src/cli.ts` (`knownSubcommandsFor` +
  `!known.includes(sub)`) inspects only `args[1]`, never `args[2]` or beyond.
  Of the test's 4 cases — `integrate cursor,claude --dry-run`, `gdgraph
  affected src/cli.ts`, `ctx rg knownSubcommandsFor src/cli.ts`, `rules sync
  --help` — only case 1 puts a non-bare-word value at `args[1]` (and it passes
  only because `integrate` was removed from the map entirely, not because the
  guard tolerates a differently-shaped `args[1]`). In cases 2-4, `args[1]` is a
  plain bare word already present in that group's known list (`"affected"`,
  `"rg"`, `"sync"`); the path/pattern strings the test's name refers to
  (`src/cli.ts`, `knownSubcommandsFor`) sit at `args[2]`/`args[3]`, positions
  the guard never reads.
- **Why it matters**: independently found by both `review-logic` (as `L4`) and
  `review-testing-practices` (as `T4`), and confirmed by `review-verifier`
  through execution in both directions. Mutation-in: reverting only the
  `integrate` row removal and running cases 2-4 alone still passes 1/1 — they
  add no coverage for the L3-class bug. Mutation-out (cross-check): the same
  revert with all 4 original cases intact fails on case 1 with the exact
  stale `"Unknown command: cursor,claude..."` message, confirming case 1 (and
  only case 1) is the real regression guard. A future maintainer trusting this
  test's name would believe path/pattern-shaped first positionals are proven
  safe across the guard when they are not; if a future group is added to
  `GROUP_SUBCOMMANDS` with a genuinely path/pattern-shaped `args[1]` — the
  exact class of mistake `integrate` made — this test would not catch a
  regression there, despite reading as if it would.
- **Fix**: Either rename/rescope the test to state precisely what it covers
  (the comma-joined-list class, via `integrate`'s removal from the map), or
  make cases 2-4 genuinely exercise a non-bare-word `args[1]` for a mapped
  group if one exists — and if none currently does, say that gap explicitly
  instead of simulating it with unrelated bare-word subcommands.

### [T5] `runBunExpectingFailure` doesn't require or assert a non-zero exit despite its name

- **Severity**: info
- **File**: `src/cli.test.ts`
- **Problem**: The helper `runBunExpectingFailure`, used by the new test for
  all 4 cases (including two — `--dry-run` and `--help` — that plausibly exit
  0), simply resolves with whatever exit code occurred; it never rejects or
  asserts on a non-zero code. Its own JSDoc already discloses this ("this
  resolves with stdout/stderr/code regardless of what the code was"), so no
  test currently misuses it.
- **Why it matters**: low — purely a naming-vs-behaviour mismatch with no
  observed effect on determinism or signal. Confirmed by reading the JSDoc and
  body, and by independently running the two exit-0 cases directly (both
  return code 0 as expected).
- **Fix**: Optional — rename to something exit-code-agnostic (e.g.
  `runBunCapturingResult`) if this helper is reused outside guard-rejection
  tests, where the current name would be actively misleading.

## Positive Notes

- L3 is fully and correctly fixed, verified by execution at the new head, with
  no reopening of the original guard's real purpose.
- `bun test src/cli.test.ts` passes 68/68 (0 fail, 310 expect() calls) at
  `861be8c2`.
- `review-verifier` independently reproduced both reviewers' mutation-test
  proofs for T4 in throwaway scratch copies, and confirmed the worktree
  `~/keryx-w5` was left untouched throughout.

```json keryx:findings
[
  {
    "id": "T4",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/cli.test.ts",
    "quote": "test(\"a comma-joined, path or pattern first positional is never refused as unknown\", async () => {",
    "problem": "The test's own name and preceding comment claim to cover 'first positionals that are not one bare subcommand word ... a comma-joined editor list, a file path, a search pattern' -- but the guard under test (src/cli.ts, knownSubcommandsFor + `!known.includes(sub)`) only ever inspects args[1], the single token immediately after the group name. Of the 4 cases, only case 1 (`integrate cursor,claude`) puts a genuinely non-bare-word value there (and it passes only because `integrate` was removed from GROUP_SUBCOMMANDS entirely, so the guard never fires for it, not because the guard tolerates a differently-shaped args[1]). In cases 2-4, args[1] is `\"affected\"`, `\"rg\"`, and `\"sync\"` respectively -- each a plain bare word already present in that group's known-subcommand list in src/lib/group-subcommands.ts (gdgraph, ctx, rules). The 'path' (src/cli.ts) and 'pattern' (knownSubcommandsFor) strings the test's comment refers to sit at args[2]/args[3], positions the guard never reads.",
    "impact": "A future reader (or a later review round) will treat this test as proof that path- and pattern-shaped first positionals are safe across the guard, when only the comma-joined/list-vocabulary shape (the actual L3 regression) is protected. If a group is later added to GROUP_SUBCOMMANDS whose real first positional is a path or a free-text pattern -- the same class of mistake `integrate` made -- this test will not catch it, but its title reads as if it would. Independently found by review-logic (as L4) and review-testing-practices (as T4); review-verifier confirmed by execution in both directions: reverting only the `integrate` row removal and keeping only cases 2-4 still passes 1/1 (no coverage for the bug), while the same revert with all 4 cases fails on case 1 with the exact stale 'Unknown command: cursor,claude...' message (case 1 is the only real regression guard).",
    "suggested_fix": "Either (a) rename/rescope the test to state what it actually protects (the comma-joined-list class via integrate's removal from the map), or (b) make cases 2-4 genuinely path/pattern-shaped at args[1] if a currently-mapped group exists with that real shape (none was found on inspection), or (c) drop cases 2-4 and note the path/pattern-shaped-args[1] gap explicitly instead of simulating it with unrelated bare-word subcommands.",
    "evidence": "src/cli.ts (knownSubcommandsFor / the guard) inspects only args[1], never args[2+]. src/lib/group-subcommands.ts confirms gdgraph includes \"affected\", ctx includes \"rg\", rules includes \"sync\" as ordinary pre-existing bare-word entries. Mutation-in (review-testing-practices, independently reproduced by review-verifier in a separate scratch copy): reverted only the integrate row in src/lib/group-subcommands.ts, kept only cases 2-4 in the new test (dropped case 1), ran `bun test src/cli.test.ts -t \"comma-joined\"` -> 1 pass, 0 fail, 3 expect() calls -- the bug was live and cases 2-4 alone did not detect it. Mutation-out cross-check (review-verifier): same revert, all 4 original cases intact -> test FAILS on case 1 with `Received: \"Unknown command: cursor,claude. Run \\`keryx integrate --help\\` for the list.\\n\"`, confirming case 1 is the only case exercising the L3 regression class. Original worktree ~/keryx-w5 was never modified (git status --porcelain clean before and after, verified independently by both reviewers and the verifier).",
    "confidence": "high"
  },
  {
    "id": "T5",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/cli.test.ts",
    "quote": "function runBunExpectingFailure(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {",
    "problem": "The name `runBunExpectingFailure` reads as if it asserts or requires a non-zero exit, but it does not -- it simply resolves with whatever exit code occurred (0 or otherwise), unlike `runBun` which rejects on non-zero. The new T3/T4 test uses it for two cases that plausibly exit 0 (`integrate ... --dry-run`, `rules sync --help`), which is correct usage, but relies on the reader noticing the JSDoc above it rather than the name.",
    "impact": "Low -- the JSDoc immediately above the function already documents this precisely, and no test currently misuses it. Purely a naming-vs-behavior mismatch with no observed effect on determinism or signal. Confirmed by review-verifier: independently ran the two plausible-exit-0 cases directly (`integrate cursor,claude --dry-run` -> exit 0, `rules sync --help` -> exit 0).",
    "suggested_fix": "Optional: rename to something exit-code-agnostic (e.g. `runBunCapturingResult`) if this helper gets reused outside guard-rejection tests, where the current name would be actively misleading.",
    "evidence": "src/cli.test.ts: runBunExpectingFailure's JSDoc reads verbatim 'this resolves with stdout/stderr/code regardless of what the code was', and its body (`child.on(\"close\", (code) => resolve({ stdout, stderr, code }))`) never rejects or asserts on a non-zero code.",
    "confidence": "high"
  }
]
```
