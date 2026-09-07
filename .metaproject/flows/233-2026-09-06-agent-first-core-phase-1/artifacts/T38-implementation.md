# T38 implementation — close the CLI exit-code denylists (T35 F-002)

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned
files only: `src/commands/security.ts`, `src/commands/security.check-input.test.ts`,
new `src/commands/security-gate-exit.test.ts`. `src/security/*` was read only,
never edited. Spec written before coding: `T38-spec.md` (same directory).

All raw logs below are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## Reviewer's probe, before and after (dispatch-mandated)

`T35-probe-cli.ts` — the reviewer's own probe, run unchanged, exactly as the
dispatch instructed before any edit:

| Run | Result | Raw log |
|---|---|---|
| Before | exit 0, **1 case MISMATCHED** — `E4 stored needs-approval`: `cliExitCode: 0` while `strictCiShouldFail: true` (`"MISMATCH: strict CI PASSES on a needs-approval artifact"`) | `2026-09-06T14-56-52-628Z_run.log` |
| After | exit 0, **0 cases MISMATCHED** — `E4` now `cliExitCode: 1`; all 7 cases `OK` | `2026-09-06T15-03-23-128Z_run.log` |

`T35-probe-cli2.ts` (referenced by `T35-review.md`'s Evidence table, present in
the same artifacts directory; read for corroboration, not edited) — attacks
`exitCodeFor` (site 1) directly via `security scan`:

| Run | `ci` row | `enforced` row (unchanged, was already correct) | Raw log |
|---|---|---|---|
| Before | `scanExitCode: 0`, `reportExitCode: 0`, note: `"STRICT CI ACCEPTS needs-approval (policies.md:28 says only PASS)"` | `scanExitCode: 1`, `reportExitCode: 0` | `2026-09-06T14-56-57-935Z_run.log` |
| After | `scanExitCode: 1`, `reportExitCode: 1`, note: `""` | `scanExitCode: 1`, `reportExitCode: 0` (unchanged — see "Fold site 2" below) | `2026-09-06T15-03-29-900Z_run.log` |

## The two fold sites

### Fold site 1 — `exitCodeFor` (`src/commands/security.ts`, was `:798-806`)

Feeds `handleScan` (`security scan`) and `handleCheck` (`security check-input`
/ `check-output`, via `applyRuntimeDecision`). Was a denylist:

```ts
if (mode === "ci") {
  return decision.gate === "fail" || decision.gate === "incomplete" ? 1 : 0;
}
if (mode === "enforced") {
  return decision.gate === "fail" || decision.gate === "needs-approval" || decision.gate === "incomplete" ? 1 : 0;
}
return 0;
```

Now an allowlist over the one acceptable value, in both strict modes, via a
shared exhaustive predicate:

```ts
export function exitCodeFor(decision: SecurityDecision, _cwd: string, mode: string): number {
  if (mode === "ci" || mode === "enforced") {
    return isPassGate(decision.gate) ? 0 : 1;
  }
  return 0;
}
```

`ci` and `enforced` are now one rule, matching `guard.ts`'s `isBlockingMode`,
which already treats the two modes identically everywhere else in the
codebase. `advisory` is untouched (§11 invariant, tested as a control).

### Fold site 2 — `handleReport` (`src/commands/security.ts`, was `:559`)

Feeds `security report`. Was:

```ts
process.exitCode = mode === "ci" && (report.gate === "fail" || report.gate === "incomplete") ? 1 : 0;
```

Now:

```ts
export function reportExitCode(gate: string, mode: string): number {
  return mode === "ci" && !isPassGate(gate) ? 1 : 0;
}
```

Deliberately kept `ci`-only (not widened to `enforced`) — this is F-002's own
suggested fix, reproduced literally, not an independent judgement call. See
"Concerns" below for why, and for the residual asymmetry this leaves
(`T35-probe-cli2.ts`'s `enforced` row: `reportExitCode` stays `0` after this
fix, same as before).

### The shared predicate

```ts
function isPassGate(gate: string): boolean {
  switch (gate) {
    case "pass": return true;
    case "fail":
    case "needs-approval":
    case "incomplete": return false;
    default: return false;
  }
}
```

One vocabulary, not two: this mirrors `runGate`'s switch
(`src/security/service.ts:311-330`) and `securityFlowGate`'s
(`src/security/guard.ts:362-371`), which T33 already made exhaustive with the
default arm on the blocking side. `isPassGate` is the one boolean question the
CLI needs, over the same four-member union those switches already cover.

### Messages

Neither fold site needed a new message. Both already name the outcome without
leaking anything:

- Non-JSON `scan`/`check-*` output: `renderDecision` always prints
  `gate: ${gateLabel(decision.gate)}` — `gateLabel` renders exactly one of
  `PASS`/`FAIL`/`NEEDS-APPROVAL`/`INCOMPLETE`.
- `check-*` with `--runtime`: the refusal message interpolates only
  `decision.gate` (`` `...refused by the configured security policy (gate:
  ${decision.gate}).` ``) — never raw content, a path, or source bytes.
- `security report`: `gate: ${gateLabel(report.gate)}` printed unconditionally
  (JSON mode carries the `gate` field in the object).

Verified negative for leakage in the new regression tests (`err.not.toContain`
the injected payload) and unchanged in the existing check-input regressions
that already asserted this (`err.not.toContain(AWS_KEY)` etc.).

## Regression tests

### New file: `src/commands/security-gate-exit.test.ts`

Direct unit tests of `exitCodeFor`/`reportExitCode` (the only way to reach the
"unrecognized gate value" case — a live `SecurityDecision`/`SecurityReport`
has no on-disk JSON to attack the way `service.ts`'s `hasRecognizedGate` is
attacked in `guard.test.ts`; `computeGate` and `readLatestReport` both only
ever produce one of the four recognized values by the time either fold site
sees one, so the defensive default arm needs a direct call with a
`as unknown as SecurityGate` cast to exercise at all), plus CLI-level
regressions reproducing the reviewer's own probes through `securityCommand`
in-process (the pattern `security-recursive-scan.test.ts` already uses).

RED (before the fix — logic still the old denylist, but exported/extracted so
the tests could call it; see "Two-step implementation" below):

```
9 pass
7 fail
40 expect() calls
```
Raw: `2026-09-06T15-00-57-424Z_run.log`. All 7 failures were the predicted
inversions: `exitCodeFor`/`reportExitCode` over `needs-approval` in `ci`, over
an unrecognized value in `ci` and `enforced`, and the two CLI-level
`needs-approval`-in-`ci` reproductions. The 9 passing cases were the controls
(`pass`, `incomplete`, `advisory`, `enforced`'s three named arms) — already
correct, as `T38-spec.md` predicted.

GREEN (after the fix):

```
16 pass
0 fail
42 expect() calls
```
Raw: `2026-09-06T15-02-11-758Z_run.log`.

Per-case table (each row states whether it inverts):

| Case | Site | Before | After | Inverts? |
|---|---|---|---|---|
| `ci` + `needs-approval` | `exitCodeFor` (unit) | 0 | 1 | yes |
| `ci` + unrecognized (`"banana"`) | `exitCodeFor` (unit) | 0 | 1 | yes |
| `enforced` + unrecognized | `exitCodeFor` (unit) | 0 | 1 | yes |
| `ci` + `needs-approval` | `reportExitCode` (unit) | 0 | 1 | yes |
| `ci` + unrecognized | `reportExitCode` (unit) | 0 | 1 | yes |
| `ci` + `needs-approval`, live scan | `security scan` (CLI) | 0 | 1 | yes |
| `ci` + `needs-approval`, stored artifact | `security report` (CLI) | 0 | 1 | yes |
| `ci` + `pass` | both (unit + CLI) | 0 | 0 | no — pass control |
| `ci` + `incomplete` | both (unit + CLI) | 1 | 1 | no — already correct |
| `advisory` + any gate | both (unit + CLI) | 0 | 0 | no — §11 control |
| `enforced` + `pass`/`fail`/`needs-approval`/`incomplete` | `exitCodeFor` (unit) | (1/0 as before) | unchanged | no — already correct |
| `enforced` + any gate | `reportExitCode` (unit) | 0 | 0 | no — deliberately ci-only |

### Two-step implementation (why RED wasn't the very first commit)

`exitCodeFor` was module-private and `handleReport`'s fold was inline — the
tests could not call either without a name to import. Step 1 (no behavior
change) named `handleReport`'s fold `reportExitCode` and exported it plus
`exitCodeFor`, both still carrying the OLD denylist logic. Step 2 was the
actual fix. This kept the causal RED clean: the 7 failures in the RED run were
provably behavioral (the exhaustive-mapping bug), not "function does not
exist yet." Recorded here because it is a deviation from "write the test file
against code that does not exist" in the literal sense, though not from the
red-green-refactor cycle itself — no fix logic shipped before its test failed
against it.

### Existing tests that encoded the bug, corrected (not weakened)

`src/commands/security.check-input.test.ts` had two assertions that directly
described F-002's defect as intentional behavior. Both exercise
`src/commands/security.ts` (the file this task owns) end to end, so both had
to change as part of this fix:

1. `"an operator who lowers the injection floor DOES get a refusal"`
   (`:140-153`) asserted `writeConfig("ci", ...); expect(exit).toBe(0)` for a
   `needs-approval` decision with no `--runtime`, under a comment block titled
   "NOT ci, and that is the documented split rather than a gap." That
   documented split was F-002's defect. Now asserts `exit === 1` and the
   comment says why.
2. `"ci + needs-approval emits NOTHING"` (`:483-493`) drove the same case
   through `--runtime cursor` and asserted `{ exit: 0, out: "" }`. Post-fix,
   `ci` refuses, so `decideHookOutcome` returns `{kind:"refuse"}` and cursor —
   a stdout-JSON runtime — receives `{"permission":"deny", "agent_message":
   "..."}` instead of silence. The process exit code stays `0`: that is
   cursor's own documented convention (`refusalAction` in
   `src/ctx/runtimes.ts:325-334` — refusal is the stdout document for
   cursor/antigravity, not the process exit code), unrelated to this fix. The
   test now asserts the deny document and keeps the `NEEDS-APPROVAL` message
   and leak-safety assertions.

RED for these two (fix applied, tests not yet corrected):

```
30 pass
2 fail
96 expect() calls
```
Raw: `2026-09-06T15-02-28-984Z_run.log`. Both failures are exactly the two
assertions above inverting.

GREEN (tests corrected):

```
32 pass
0 fail
99 expect() calls
```
Raw: `2026-09-06T15-03-17-650Z_run.log`.

## Verification

| Check | Result | Raw log |
|---|---|---|
| `bun src/cli.ts ctx run -- bun test src/commands/security-recursive-scan.test.ts` (dispatch's required command) | **6 pass / 0 fail**, 46 expect() — unmodified by this task, confirms the T34 recursion/coverage repair is untouched | `2026-09-06T15-04-14-746Z_run.log` |
| `bun test src/commands/security-gate-exit.test.ts src/commands/security.check-input.test.ts src/commands/security-recursive-scan.test.ts src/commands/security-hooks-init.test.ts` (every command-layer security test file, including every file this task touched) | **62 pass / 0 fail**, 224 expect() | `2026-09-06T15-03-51-179Z_run.log` |
| `bun run typecheck` (`tsc --noEmit`) | **1 pre-existing error, unchanged before/after** — `src/security/detect/exfil.test.ts:339`, in a file a concurrent worker has modified (`git status` shows it `M`); zero errors in any file this task touched, both before (`2026-09-06T14-59-31-833Z_run.log`) and after this fix | before: `2026-09-06T14-59-31-833Z_run.log`; after: `2026-09-06T15-04-04-506Z_run.log` |
| `bunx eslint src/commands/security.ts src/commands/security.check-input.test.ts src/commands/security-gate-exit.test.ts` (every file this task changed) | clean, no output, exit 0 | `2026-09-06T15-04-10-421Z_run.log` |

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC8 / dispatch: no required failed or incomplete check is relabeled PASS at any surface, including the process exit code; strict modes accept only a pass. | met | `T35-probe-cli.ts` after: 0/7 mismatched (was 1/7). `T35-probe-cli2.ts` after: `ci` scan and report exit codes both 1 over a `needs-approval` artifact (were both 0). Unit tests pin `pass` as the only value either fold site accepts in `ci`/`enforced`. |
| Policy fold (policies.md): strict CI accepts only PASS; messages are constant and leak-safe. | met | `isPassGate` is exhaustive with the default arm on the blocking side. Every message at both sites interpolates only the `gate` enum value (`gateLabel`/`decision.gate`); regression tests assert neither the injected payload nor an AWS-shaped key appears in `err`/`out`. |
| The command layer and the service layer agree: a gate value that blocks in the service does not exit zero at the command, and an unrecognized value is treated as non-pass rather than falling through. | met | `isPassGate` mirrors `runGate`'s switch (`service.ts`) and `securityFlowGate`'s (`guard.ts`) — same four-member exhaustiveness, same default-arm-refuses discipline. `ci`/`enforced` now agree at the CLI the way `isBlockingMode` already made them agree at the write seam. |
| Advisory mode's existing permissiveness is unchanged. | met | `exitCodeFor`/`reportExitCode` both return 0 unconditionally for any mode that is not `ci`/`enforced`(`ci` for `reportExitCode`); pinned as a control in both the new test file and unchanged assertions in `security.check-input.test.ts`. |
| The distinction between a violation (`fail`), an approval requirement (`needs-approval`) and unavailable evidence (`incomplete`) stays visible in the output. | met | `gateLabel` still renders three distinct strings; `isPassGate` only changes the exit-code question ("does this block"), never the label printed alongside it. |
| Do not weaken the recursion behavior an earlier task (T34) fixed. | met | `src/security/path-scan.ts` was not touched; `security-recursive-scan.test.ts` (unmodified) still 6/6 green, including its non-recursive-directory-stays-incomplete case, which the new "incomplete-gate control" test in `security-gate-exit.test.ts` also exercises end to end through `security scan --no-recursive`. |

## Alignment with the existing vocabulary, and the search for other surfaces

`isPassGate` is the CLI's one predicate over `SecurityGate`, matching
`runGate` (`src/security/service.ts`) and `securityFlowGate`
(`src/security/guard.ts`) in shape (exhaustive switch, default arm refuses).
No new gate vocabulary was introduced.

Searched for other command surfaces reading a gate value the same
(denylist) way:

- `bun src/cli.ts ctx rg -n ".gate\s*===|decision.gate|report.gate|.gate !=="
  src/commands` (raw `2026-09-06T14-53-27-791Z_rg.log`) — found the two fold
  sites this task fixed, plus `src/commands/health.ts:69-94`
  (`runExitCode`) and `src/commands/workspace.ts:157,168,169`.
- `bun src/cli.ts ctx rg` for `gate === "pass"|gate !== "pass"|...` across
  `src`, excluding `src/security/**`, `src/commands/security.ts`,
  `src/flow/**` (already fixed by T33) and `src/commands/health.ts` (raw
  `2026-09-06T14-53-46-287Z_rg.log`) — found `src/sac/index.ts:383,399,429`,
  `src/sac/proposal-lifecycle.ts:713`, `src/lib/serve-turn.ts:789`, and
  `src/commands/workspace.ts:157,168,169`.

Findings:

- `src/commands/workspace.ts:157,168,169` — `security.gate === "needs-approval"`
  gates an acknowledgement flow, not a pass/fail exit-code fold. Not the same
  shape; not a defect.
- `src/sac/index.ts`, `src/sac/proposal-lifecycle.ts`, `src/lib/serve-turn.ts`
  — every one is already an **allowlist** (`gate !== "pass"` /
  `gate === "pass"`), the correct shape. Not a defect of this class.
- `src/commands/health.ts:90-94` (`runExitCode`) — **the same denylist shape**
  (`status === "fail" || status === "incomplete" || (strict && status ===
  "warn") ? 1 : 0`), over the unrelated `health` gate vocabulary
  (`fail`/`incomplete`/`warn`/`pass`, not `SecurityGate`). An unrecognized
  future `health` status would fall through to `0` the same way `exitCodeFor`
  did. This is a real instance of the same class of bug, but in a file this
  task does not own (`src/commands/security.ts` only, per the dispatch's
  ownership constraint) and over a different, unrelated gate type. Flagged as
  a candidate for a separate task rather than fixed here (see Concerns).

## Concerns

1. **`handleReport`/`reportExitCode` stays `ci`-only, not also `enforced`.**
   This directly reproduces T35 F-002's own suggested fix
   (`process.exitCode = mode === "ci" && report.gate !== "pass" ? 1 : 0`), not
   an independent judgement call. `security report` aggregates the *last
   stored scan*, a distinct surface from the write-seam guard
   `isBlockingMode` governs, so I did not widen its scope unilaterally. This
   leaves a residual, pre-existing asymmetry visible in
   `T35-probe-cli2.ts`'s `enforced` row: `scanExitCode: 1` (site 1, correct)
   next to `reportExitCode: 0` (site 2, deliberately unchanged) for the same
   stored `needs-approval` gate. If the phase wants `security report` to also
   refuse in `enforced`, that is a small, well-scoped follow-up
   (`reportExitCode`'s one condition), not a defect this task left open by
   oversight.
2. **`src/commands/health.ts`'s `runExitCode` has the identical denylist
   shape**, over the `health` gate rather than `SecurityGate`. Out of this
   task's ownership (`src/commands/security.ts` only); reported rather than
   fixed. Flagged as a spawned background task rather than left as a
   dangling note.

## Changed files

- `src/commands/security.ts` — `exitCodeFor` (site 1) rewritten as an
  allowlist over `pass`, shared with a new `reportExitCode` (site 2, extracted
  from `handleReport`'s inline fold) via a new private `isPassGate` predicate.
  Both `exitCodeFor` and `reportExitCode` exported for direct regression
  testing. Doc comment above `exitCodeFor` updated to describe the fix instead
  of the pre-fix asymmetry as intentional.
- `src/commands/security.check-input.test.ts` — two assertions that encoded
  F-002's defect corrected to the fixed behavior (see "Existing tests that
  encoded the bug, corrected" above); one leak-safety assertion added to the
  corrected test. No test deleted or weakened.
- `src/commands/security-gate-exit.test.ts` — new file, 16 tests: direct unit
  coverage of `isPassGate`'s exhaustiveness (including the unrecognized-value
  default arm) through `exitCodeFor`/`reportExitCode`, plus CLI-level
  regressions reproducing the reviewer's `T35-probe-cli.ts` (case E4) and
  `T35-probe-cli2.ts` (the `ci` row) scenarios through `securityCommand`
  in-process.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set, line
numbers and the finding to reproduce; no discovery or blast-radius question
arose); wiki_used: no (not-relevant — the normative sources are policies.md
and the frozen acceptance-criteria.md, both supplied as context_refs and read
directly); ctx_used: yes (every code search via `bun src/cli.ts ctx rg`, every
command and probe run via `bun src/cli.ts ctx run`, all raw logs cited above);
raw_rg_used: no — every raw-log read used a bounded `sed -n`/`grep -c` with
the documented `# keryx:raw` escape and a stated reason (ctx compaction
truncated the rg match list to 4 of 21 hits at one point, and elided
per-case test failure detail at another); no search over project code
bypassed ctx.`
