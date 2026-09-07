# T48 implementation — close the health command's exit-code denylist (T38-F-001)

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned
files only: `src/commands/health.ts`, new `src/commands/health-gate-exit.test.ts`.
`src/health/*` and `src/commands/security.ts` were read only, never edited.
Spec written before coding: `T48-spec.md` (same directory).

All raw logs below are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## The value enumeration and how it was found

`GateStatus` (`src/health/types.ts:132`): `"pass" | "warn" | "incomplete" |
"fail"`. Found by reading the type directly, then tracing every producer:

- `computeGate` (`src/health/gate.ts:17-93`) is the **only** place a
  `GateStatus` is constructed. It starts `status: GateStatus = "pass"` and
  only ever escalates via `escalate(next, reason)`, which is called with a
  literal `"fail"` (a `failPriorities` finding, or regression at/above
  `failOnRegressionDrop`, `gate.ts:36-48`) or a literal `"warn"` (regression
  between the warn/fail thresholds, coverage below the soft floor, or an
  optional source that is `configured-but-failed`, `gate.ts:46-77`). `RANK`
  (`gate.ts:10-15`) makes `escalate` monotonic (`fail` always wins over
  `warn`), so the four-member union is closed and exhaustive by
  construction — no fifth value can come out of `computeGate` today.
- `incomplete` is set separately, once, when `brokenRequired.length > 0`
  (`gate.ts:58-63`) — a required source that is unavailable, failed to
  execute, or failed/never attempted to parse. This is exactly policies.md's
  "required check that is missing, skipped, unparsed or unfinished".
- A **skipped optional** source (`skippedOptional`, `gate.ts:64-67`) never
  touches `status` at all — it only appends an `OPTIONAL: ... skipped`
  reason string, so `status` can still be `pass` while that reason is
  present. Confirmed this is not a fifth `GateStatus` and does not need its
  own arm: `runExitCode` only ever sees the four-member `status`, and the
  warning text survives untouched regardless of the exit code — "an
  optional skip still warns and is never signed as passed" was already true
  structurally before this task and stays true after (nothing in this fix
  touches `reasons` or `skippedOptional`).
- Confirmed via `bun src/cli.ts ctx rg -n "GateStatus|gate.status"
  src/commands` that `runRun`'s two call sites (`:69`, `:87`, now `:69`/`:87`
  post-comment-insertion — the switch was added between them, so the export
  lives where the old private function did) are the **only** exit-code fold
  over a health `GateStatus` in `src/commands/health.ts`; `runGate`
  (`:123-133`, unrelated name collision with the CLI subcommand handler, not
  `security/service.ts`'s `runGate`) delegates entirely to
  `service.gate()`'s own `exitCode`, doing no folding of its own.
- Live smoke test (not part of the automated suite, run by hand to see a
  real `computeGate` output end to end): `keryx health run --source eslint
  --scope file:src/commands/health.ts --json`, filtering out the required
  `typescript` source, produced `gate.status: "incomplete"` with reasons
  `INCOMPLETE: required source unavailable: typescript: excluded by source
  filter` alongside three `OPTIONAL: ... skipped` lines — confirming in a
  live run that a required-source exclusion produces `incomplete` (not
  `fail`, not `pass`) and that optional skips coexist with it as warnings
  rather than escalating `status` themselves.

## The fix

`src/commands/health.ts` — the type import gained `GateStatus`:

```diff
-import type { ScopeSelector } from "../health/types";
+import type { GateStatus, ScopeSelector } from "../health/types";
```

`runExitCode` (was `:90-94`, module-private, `status: string`) is now
exported and typed over `GateStatus`, rewritten as an exhaustive `switch`
with the default arm on the blocking side:

```ts
export function runExitCode(status: GateStatus, strict: boolean): number {
  switch (status) {
    case "pass":
      return 0;
    case "warn":
      return strict ? 1 : 0;
    case "fail":
    case "incomplete":
      return 1;
    default:
      return 1;
  }
}
```

Both call sites in `runRun` (`--json` branch and the human-readable branch)
already passed `result.report.gate.status` (typed `GateStatus`) and
`result.report.strict` (typed `boolean`) — no call-site change needed.

This mirrors `isPassGate` (`src/commands/security.ts`), `runGate`
(`src/security/service.ts:301-330`) and `securityFlowGate`
(`src/security/guard.ts:360-419`) in *shape* only — exhaustive switch,
default arm refuses — over health's own `GateStatus`, not `SecurityGate`.
No cross-module import was added or needed.

### Truth table — every recognized value is byte-identical to before

| `status` | `strict` | old (denylist) | new (switch) | changed? |
|---|---|---|---|---|
| `pass` | false | 0 | 0 | no |
| `pass` | true | 0 | 0 | no |
| `warn` | false | 0 | 0 | no |
| `warn` | true | 1 | 1 | no |
| `incomplete` | false | 1 | 1 | no |
| `incomplete` | true | 1 | 1 | no |
| `fail` | false | 1 | 1 | no |
| `fail` | true | 1 | 1 | no |
| unrecognized | false | 0 | **1** | **yes — the fix** |
| unrecognized | true | 0 | **1** | **yes — the fix** |

Only the previously-unreachable-by-type fallthrough changes. The
unrecognized-value arm blocks in **both** strict and non-strict runs — not
gated on `strict` — matching how `fail`/`incomplete` already block
unconditionally, and matching the acceptance criterion "the default arm
blocks" (stated without a strict-only qualifier).

## Regression tests

### New file: `src/commands/health-gate-exit.test.ts`

Direct unit tests of `runExitCode` — the only way to reach the "unrecognized
gate value" case, since `computeGate` only ever produces one of the four
recognized `GateStatus` values by the time either call site in `runRun`
sees one (no on-disk JSON to attack the way `security/service.ts`'s
`hasRecognizedGate` is attacked in `guard.test.ts`; the fresh-computation
argument is *stronger* here than for `SecurityGate`, since `security
report`'s gate comes from a stored artifact an operator could hand-edit,
while health's gate is always freshly computed in the same process).

RED (before the fix — logic reverted in-place to the old string-based
denylist for exactly this run, keeping the export/type so the test could
still compile and call it; reverted back to the fix immediately after):

```
5 pass
1 fail
17 expect() calls
```
Raw: `2026-09-06T15-14-52-957Z_run.log`. The one failure was the predicted
inversion: `runExitCode("banana" as unknown as GateStatus, true)` returned
`0`, not `1` (the test's second assertion, `strict: false`, was never
reached — `expect` throws on the first failing assertion in the test body).
The 5 passing cases were the controls (`pass`, `fail`, `incomplete`, `warn`)
— already correct, as `T48-spec.md`'s truth table predicted.

GREEN (after re-applying the fix):

```
6 pass
0 fail
18 expect() calls
```
Raw: `2026-09-06T15-15-01-557Z_run.log`.

Per-case coverage (mirrors `T48-spec.md`'s truth table exactly, plus the
unrecognized-value cell the table has no row for):

| Case | Before | After | Inverts? |
|---|---|---|---|
| `pass`, strict true/false | 0 / 0 | 0 / 0 | no — pass control |
| `warn`, strict false | 0 | 0 | no — already correct |
| `warn`, strict true | 1 | 1 | no — already correct |
| `incomplete`, strict true/false | 1 / 1 | 1 / 1 | no — already correct, and independent of strict both before and after |
| `fail`, strict true/false | 1 / 1 | 1 / 1 | no — already correct |
| unrecognized (`"banana"`), strict true | 0 | 1 | **yes** |
| unrecognized (`"banana"`), strict false | 0 | 1 | **yes** |

### No existing test encoded the bug

Unlike T38 (which had to correct two `security.check-input.test.ts`
assertions that described F-002's defect as intentional), no existing test
in this repository calls `runExitCode` directly or asserts on an
unrecognized `GateStatus` value. `health-incomplete.test.ts` and
`health-status.test.ts` were read in full and exercise only already-correct
paths (`incomplete` unconditionally, `pass`/`warn` via the *separate*
`service.gate()` fold this task does not own) — both left unmodified, and
both still pass (see Verification).

## Verification

Health command-layer focused tests (all three files touching
`src/commands/health.ts`, including the new one):

```
10 pass
0 fail
28 expect() calls
```
Raw: `2026-09-06T15-15-05-664Z_run.log`.

Full `src/health/` module suite (18 files, unmodified by this task —
confirms the parser/gate repair this flow already landed, and every other
health source/scoring/report test, is untouched):

```
86 pass
0 fail
256 expect() calls
```
Raw: `2026-09-06T15-15-13-372Z_run.log`.

`bun run typecheck` (`tsc --noEmit`): clean, no output, exit 0. Raw:
`2026-09-06T15-15-25-201Z_run.log`.

`bunx eslint src/commands/health.ts src/commands/health-gate-exit.test.ts`:
clean, no output, exit 0. Raw: `2026-09-06T15-15-27-765Z_run.log`.

Live smoke test (`keryx health run --source eslint --scope
file:src/commands/health.ts --json`, real `computeGate` output, not a
fixture): `gate.status: "incomplete"` (required `typescript` source
excluded by the source filter), process exit `1` — confirms the fix's
`incomplete` arm end to end through the real command, not just the unit
table.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC4 / AFC-05: fixtures, a corrupted payload, a skipped required check and an incomplete area each produce the expected outcome; violations are not lost when another check is unavailable. | met | `incomplete` (required-source-unavailable, which subsumes "skipped required check" and "incomplete area") blocks unconditionally, both before and after this fix — pinned in the truth table and the full-suite run (`health-incomplete.test.ts`, unmodified, still green). This task's own scope is the exit-code fold, not the parser/coverage repair AFC-05 mainly targets (already landed earlier in this flow, per dispatch context); T48 keeps that behavior intact rather than reimplementing it, and closes the one remaining gap (the fold's fallthrough) that could have silently relabeled a future/unrecognized outcome as PASS. |
| No health gate value that blocks inside the module exits zero at the command; the default arm blocks; an optional skip still warns and is never signed as passed. | met | `runExitCode`'s `switch` is exhaustive with `default: return 1`. Verified for all four recognized values (truth table, byte-identical to before) plus the unrecognized-value cast (0→1, the fix). Optional-skip warnings are untouched — `skippedOptional` never sets `status` in `computeGate` (read-only, confirmed by tracing `gate.ts`), so the `OPTIONAL: ... skipped` reason string is unaffected by this exit-code-only change; verified structurally, and the live smoke test shows three `OPTIONAL:` reasons coexisting with a blocking `incomplete` status. |
| Regressions fail before the change and pass after; the health focused suites stay green and no currently passing invocation stops passing. | met | RED 5/1/17 → GREEN 6/0/18 (`health-gate-exit.test.ts`, both raw logs above). Combined health command-layer suite 10/0/28. Full `src/health/` suite 86/0/256, unmodified. `bun run typecheck` and `bunx eslint` both clean on every file this task touched. |

## Concerns

`src/health/service.ts`'s `gate()` method (`:132-149`) has the **identical
denylist shape** this task fixed, over the same `GateStatus`:

```ts
const exitCode =
  status === "fail" ||
  status === "incomplete" ||
  (status === "warn" && input.strictWarn)
    ? 1
    : 0;
```

It feeds `keryx health gate`'s `--strict-warn` exit code
(`src/commands/health.ts`'s `runGate` function, `:123-133` in the current
file, which is a thin delegator and does no folding of its own — it just
returns `service.gate()`'s already-computed `exitCode` verbatim). Not fixed
here: `src/health/*` is explicitly read-only per this task's ownership
(dispatch: "Read `src/health/*` ... but do not edit them. If the fix needs a
change there, stop and reply STATUS: BLOCKED naming the exact change" — this
task's own fix did not require touching it, so no block was needed, but the
sibling defect is real and out of scope). Flagged as a candidate for its own
task, the same way T38 flagged this one (T38-F-001) and this task closed it.

## Changed files

- `src/commands/health.ts` — `runExitCode` rewritten as an exhaustive
  `switch` over `GateStatus` with the default arm blocking; exported for
  direct regression testing; type import gained `GateStatus`. Doc comment
  above it explains the fix and cross-references the three sibling
  exhaustive folds by shape only (no shared vocabulary/import).
- `src/commands/health-gate-exit.test.ts` — new file, 6 tests / 18
  `expect()` calls: direct unit coverage of every recognized `GateStatus`
  value at both `strict` settings (the full truth table, pinned against
  regression) plus the unrecognized-value default arm.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file, function
and line range to fix, carried forward from T38's own finding T38-F-001; no
discovery or blast-radius question arose); wiki_used: no (not-relevant — the
normative source is policies.md, supplied directly by the dispatch and read
in full at the cited section, "Health и security gate"); ctx_used: yes
(every code search via `bun src/cli.ts ctx rg`, every test/typecheck/eslint
run via `bun src/cli.ts ctx run`, all raw logs cited above by path);
raw_rg_used: no — no bare `rg`/`grep` was run; every search went through
`keryx ctx rg`, and no raw-log read needed a `# keryx:raw` escape (all `ctx
run`/`ctx rg` summaries were small enough to read compacted).`
