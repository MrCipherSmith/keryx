# T65 implementation — align the command exit-code folds with the corrected `gateway` meaning

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Files
changed: `src/commands/security.ts`, `src/commands/security-gate-exit.test.ts`,
`src/commands/security.check-input.test.ts`. Read only (confirmed unedited
by this task): `src/security/guard.ts`, `src/security/self-protect.ts`,
`src/security/types.ts`, `docs/requirements/keryx-agent-first-core/policies.md`,
`.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/acceptance-criteria.md`.
Spec written before coding: `T65-spec.md` (same directory).

All raw logs are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## The disagreement, and why the pure-function form of a probe was not trusted

T61 corrected `isBlockingMode` (`src/security/guard.ts`) so `gateway` joins
`enforced`/`ci` on the blocking side, resolving a disagreement with
`MODE_RANK` (`src/security/self-protect.ts`), which already ranked `gateway`
strictest. Both `T61-implementation.md` and `T55-implementation.md` disclosed
— out of their own ownership — that `src/commands/security.ts`'s two
command-level exit-code folds, `exitCodeFor` (site 1: `security scan`,
`security check-input`/`check-output`) and `reportExitCode` (site 2:
`security report`), still checked only `mode === "ci" || mode ===
"enforced"`, so `gateway` fell through to the same `return 0` `advisory`
takes — a mode that now blocks inside the module (`guardOutput`,
`securityFlowGate`) still exited zero at every command built on these two
folds.

The dispatch names a specific way to get this wrong: T55 found that an
earlier probe (`T39-exit.ts` S3) called `reportExitCode(report.gate,
report.mode)` directly and could not observe the actual defect, because the
defect was in *which value* `handleReport` passed as `mode`
(`report.mode` vs. the live `modeOf(cwd)`), not in `reportExitCode` itself —
the direct-call probe was blind to it by construction. This task's defect is
different in shape (the mode-check condition itself is missing a value, not
which argument is passed), so a direct call with the literal string
`"gateway"` is in fact representative here. But rather than assume that,
I verified at the real command entry point anyway, per the dispatch's
instruction: `T65-verify-gateway.ts` (same directory) configures a real
`.metaproject/security.config.json` with `mode: "gateway"` and drives
`security scan`, `security report` and `security check-input` through
`securityCommand(...)` itself, end to end.

**Before any change** (raw
`2026-09-06T16-58-04-000Z_T65-verify-gateway-before.log`): every `gateway`
case — an established violation (`fail`), an approval requirement
(`needs-approval`), and an incomplete gate — at all three command surfaces
exits **0**, byte-identical in shape to the two `advisory` controls at the
bottom of the same run. This is the bug, confirmed at the command, not
inferred from the source.

## Enumeration: every site in `src/commands/security.ts` that branches on mode

Method: `bun src/cli.ts ctx rg -n '"ci"|"enforced"|"advisory"|"gateway"|mode
===|=== mode|isBlockingMode|isPassGate|reportExitCode|exitCodeFor'
src/commands/security.ts` — 21 raw hits. gdctx's own summary view displayed
only 4 of the 21 in its compacted "Matches" section (the same
under-reporting T55/T61 flagged for `ctx rg`'s truncated match list on this
repo); the full 21 were read from the raw log
(`2026-09-06T16-55-31-373Z_rg.log`) and each was read in its surrounding
context via a full `Read` of the file (already done for this task). A
second pass searched the bare word `gateway` alone across the file —
**zero hits** (`2026-09-06T16-56-22-475Z_rg.log`), confirming `gateway` was
not named anywhere in this file before this task, including in a comment
that might record an already-considered exception.

| Site | Branches on mode? | Classification before this task | Action taken |
|---|---|---|---|
| `reportExitCode` (was `:670`) | `mode === "ci" \|\| mode === "enforced"` | `gateway` falls to `return 0`, same as `advisory` | **fixed — added `\|\| mode === "gateway"`** |
| `exitCodeFor` (was `:951`) | `mode === "ci" \|\| mode === "enforced"` | `gateway` falls to `return 0`, same as `advisory` | **fixed — added `\|\| mode === "gateway"`** |
| `handleHooks` install note (`:786`) | `(await modeOf(cwd)) === "advisory"` | tests only for the literal `"advisory"`; says nothing about any other mode, `gateway` included | **not this defect class — see below, left unchanged** |
| `handleScan` (`:250`), `handleCheck` (`:596`) | call `exitCodeFor(..., await modeOf(cwd))` | inherits `exitCodeFor`'s decision | fixed automatically by the `exitCodeFor` fix |
| `handleReport` (`:650`) | calls `reportExitCode(report.gate, await modeOf(cwd))` | inherits `reportExitCode`'s decision | fixed automatically by the `reportExitCode` fix |
| `decideHookOutcome`/`applyRuntimeDecision` (`:1000-1068`, line numbers shifted by the added comment text — read in full, unchanged by this task) | branches on `code !== 0`, the fold's OUTPUT, not a mode literal | already correct once the input `code` (from `exitCodeFor`) is correct | no change needed |
| `handleScanMcp`'s `--strict` flag | branches on `totalFindings > 0 \|\| coverage === "incomplete"` | does not read `mode` at all | not this defect class — out of scope by construction |

No other site in the file compares a `SecurityMode` value. `:786`'s
advisory-only note is judged out of scope: it is a single named-mode
operator hint ("if you are in `advisory`, the hook reports and does not
refuse"), not an exhaustive blocking/non-blocking classification the way
`exitCodeFor`/`reportExitCode`'s mode checks are. It says nothing about
`gateway` at all, which is a different thing from actively grouping
`gateway` with `advisory` the way the two folds did. Widening it to also
warn under `gateway` would be a UX addition, not a correctness fix this
task's acceptance criteria require, and it risks touching the one mode the
dispatch explicitly says must not change (`advisory`) if done carelessly, so
it was left alone and is named here rather than silently skipped.

## The fix

```ts
// reportExitCode
export function reportExitCode(gate: string, mode: string): number {
  if (mode === "ci" || mode === "enforced" || mode === "gateway") {
    return isPassGate(gate) ? 0 : 1;
  }
  return 0;
}

// exitCodeFor
export function exitCodeFor(decision: SecurityDecision, _cwd: string, mode: string): number {
  if (mode === "ci" || mode === "enforced" || mode === "gateway") {
    return isPassGate(decision.gate) ? 0 : 1;
  }
  return 0;
}
```

`isPassGate` (the gate-vocabulary switch both folds delegate to) is
untouched — this defect was entirely about which *modes* reach the strict
branch, never about the four `SecurityGate` values once there. No new gate
vocabulary, no new mode vocabulary; `gateway` was already a member of
`SecurityMode` (`src/security/types.ts:93`).

Both function doc comments were updated to state the `gateway` inclusion and
cross-reference T61/T65, so a future reader does not find `gateway` absent
from the prose the way it was absent from the code.

### Truth table — exactly what moved and what did not

| `mode` | `gate` | before | after | changed? |
|---|---|---|---|---|
| `ci` / `enforced` | any (all four values + unrecognized) | (T38/T55's fixed truth table) | (unchanged) | no |
| `gateway` | `pass` | 0 | 0 | no |
| `gateway` | `fail` | 0 | **1** | **yes — this task** |
| `gateway` | `needs-approval` | 0 | **1** | **yes — this task** |
| `gateway` | `incomplete` | 0 | **1** | **yes — this task** |
| `gateway` | unrecognized (cast, e.g. `"banana"`) | 0 | **1** | **yes — this task** |
| `advisory` | any | 0 | 0 | **no — untouched control** |

`advisory` is not named in either `if` condition, before or after this task
— confirmed both by reading the code and by the two `advisory` control rows
in `T65-verify-gateway.ts`'s before/after runs, which are byte-identical
(`exit: 0` in both). No cell this task did not intend to move, moved.

## Committed test expectations checked for the disagreement

`src/commands/security-gate-exit.test.ts` and
`src/commands/security.check-input.test.ts` were read in full before coding.
Neither contained any assertion encoding the pre-fix `gateway` behavior as
intentional (no test named or referenced `"gateway"` at all before this
task) — confirmed by the same `ctx rg -n gateway` pass over both files
returning zero hits, run alongside the production-file search above (raw
`2026-09-06T16-56-22-475Z_rg.log` covers `src/commands/security.ts` only;
the two test files were confirmed separately by full `Read`, since this
task's own new assertions are the first mention of `gateway` in either).
So this task adds coverage; it does not correct or flip an existing
assertion.

## Regressions added

### `src/commands/security-gate-exit.test.ts`

Mirrors the existing `ci`/`enforced`/`advisory` blocks, for `gateway`:

- Unit: `exitCodeFor` under `gateway` — `pass` → 0; `fail`/`needs-approval`/
  `incomplete`/unrecognized (`"banana"` cast) → 1.
- Unit: `reportExitCode` under `gateway` — the same five cases.
- CLI-level, new `describe("security scan — gateway ...")` block: a
  `needs-approval` finding refuses; the pass control stays 0; a
  non-recursive directory scan (`incomplete` coverage) now refuses too.
- CLI-level, `describe("security report — ci + stored needs-approval ...")`
  block: a stored `needs-approval` report refuses under `gateway`; the pass
  control stays 0.

### `src/commands/security.check-input.test.ts`

Two cases added to the existing `describe("what refuses is the operator's
declared policy", ...)` block, extending rather than duplicating the
existing structure:

- The "an operator who lowers the injection floor DOES get a refusal" test
  gained a `gateway` case alongside its existing `enforced`/`ci` cases.
- The "the secret class refuses without any of that — the control" test
  gained a `gateway` row alongside its existing `enforced`/`advisory` rows.

## RED, established by running the new tests against the pre-fix code

Per this repo's "no git state changes" constraint, RED was established by
writing the new/extended tests FIRST and running them against the code
before any fix was applied (not by a revert-and-rerun, since the code had
not been touched yet at that point):

| Suite | RED result | Raw log |
|---|---|---|
| `security-gate-exit.test.ts` | **20 pass / 5 fail**, 62 expect() — every failure is exactly the predicted `gateway` inversion (`exitCodeFor`/`reportExitCode` unit tests, the new `scan`/`report` CLI-level `gateway` tests) | `2026-09-06T17-00-00-000Z_T65-red-security-gate-exit.log` |
| `security.check-input.test.ts` | **30 pass / 2 fail**, 100 expect() — both failures are the predicted `gateway` inversions in the two extended tests | `2026-09-06T17-02-00-000Z_T65-red-security-check-input.log` |
| Real CLI entry point, `T65-verify-gateway.ts` | every `gateway` case exits 0 (identical to the `advisory` controls) | `2026-09-06T16-58-04-000Z_T65-verify-gateway-before.log` |

## GREEN, after the fix

| Suite | GREEN result | Raw log |
|---|---|---|
| `security-gate-exit.test.ts` | **25 pass / 0 fail**, 68 expect() | `2026-09-06T17-03-00-000Z_T65-green-security-gate-exit.log` |
| `security.check-input.test.ts` | **32 pass / 0 fail**, 101 expect() | `2026-09-06T17-04-00-000Z_T65-green-security-check-input.log` |
| Real CLI entry point, `T65-verify-gateway.ts` | every `gateway` fail/needs-approval/incomplete case exits **1**; every pass control stays **0**; the two `advisory` controls are byte-identical to the before run (`exit: 0`) | `2026-09-06T17-05-00-000Z_T65-verify-gateway-after.log` |
| Required: `bun src/cli.ts ctx run -- bun test src/commands/ src/security/` | **1233 pass / 6 skip / 0 fail**, 4978 expect(), 99 files (the 6 skips are pre-existing, unrelated to this task — confirmed by re-reading the summary; no skip newly introduced) | `2026-09-06T17-02-15-004Z_run.log` |
| `bun src/cli.ts ctx run -- bun run typecheck` | clean, exit 0 | `2026-09-06T17-02-29-495Z_run.log` |
| `bun src/cli.ts ctx run -- bunx eslint src/commands/security.ts src/commands/security-gate-exit.test.ts src/commands/security.check-input.test.ts` | clean, no output, exit 0 | `2026-09-06T17-02-34-702Z_run.log` |

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC8: no required failed or incomplete check is relabeled PASS at any surface including the process exit code; a value that blocks inside a module does not exit zero at its command. | met | `gateway` now exits non-zero at `security scan`, `security report` and `security check-input`/`check-output` for `fail`/`needs-approval`/`incomplete`/an unrecognized gate — matching what `guardOutput`/`securityFlowGate` already do inside the module (T61). Proven at the real CLI entry point (`T65-verify-gateway.ts`, before/after), not only at the pure functions. |
| Policy (policies.md): FAIL on an established threshold violation; INCOMPLETE when a required check is missing, skipped, unparsed or unfinished; strict runs accept only PASS; an optional skip warns and is never signed as passed. | met | `isPassGate` (unchanged, already exhaustive per T38/T55) still enforces this; `gateway` is now one of the modes that only accepts `pass`, alongside `ci`/`enforced`. No new message string was introduced — `gateLabel`/`applyRuntimeDecision`'s existing constant, leak-safe messages are reused verbatim. |
| Regressions fail before the change and pass after, measured at the command entry point; everything the earlier fold repairs closed stays closed, and the advisory mode is untouched. | met | RED tables above (5 + 2 test failures, plus the CLI probe's before-run) and GREEN tables (0 failures, plus the CLI probe's after-run). `advisory`'s exit code is 0 in both the before and after runs of `T65-verify-gateway.ts`, and every pre-existing `advisory`/`ci`/`enforced` assertion in both owned test files still passes unmodified — confirmed by the pass-count deltas (security-gate-exit.test.ts: 20→25, +5 exactly the new gateway tests, 0 pre-existing regressions; security.check-input.test.ts: 30→32, +2 exactly the extended assertions' new gateway lines, 0 pre-existing regressions). |

## Concerns

None specific to this fix. One thing confirmed rather than assumed, worth
recording: `handleHooks`'s advisory-only operator note (`:786` — "advisory
mode: ... will report findings and allow the call") was checked and is not
part of this defect class (see Enumeration table above) — it names only
`"advisory"` and says nothing about `gateway`, so it was not misclassifying
`gateway` the way the two exit-code folds were. Left unchanged, disclosed
rather than silently passed over, matching the discipline this whole phase
has used for out-of-scope findings.

## Changed files

- `src/commands/security.ts` — `reportExitCode` and `exitCodeFor` both now
  include `mode === "gateway"` in their strict-mode check, alongside
  `ci`/`enforced`. Both doc comments updated to state the inclusion and
  cross-reference T61 (the `isBlockingMode` correction this aligns with) and
  T65 (this task).
- `src/commands/security-gate-exit.test.ts` — two new unit tests
  (`exitCodeFor`/`reportExitCode` under `gateway`) and two new
  `describe`/test groups at the CLI level (`security scan` and
  `security report` under `gateway`), mirroring the existing `ci` coverage.
  No existing test modified or removed.
- `src/commands/security.check-input.test.ts` — two existing tests extended
  with a `gateway` case each. No existing test modified or removed.
- `.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T65-spec.md` —
  written before coding.
- `.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T65-verify-gateway.ts` —
  new supplementary probe (read-only against production code, `mkdtemp`
  fixtures, removed in `finally`) driving the real `securityCommand` entry
  point across all three command surfaces, for the before/after evidence
  above.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact files,
functions, and the two prior implementation reports (T55, T61) that
disclosed the exact residual to fix; the enumeration question ("every site
that branches on mode") is a text-shape question `ctx rg` answers directly,
and the graph's own manifest documents it answers from the last `gdgraph
build`, not the uncommitted working tree, which this branch is);
wiki_used: no (not-relevant — the normative sources are
`docs/requirements/keryx-agent-first-core/policies.md`, the frozen
`acceptance-criteria.md`, and the cited prior task artifacts (T55, T57,
T61), all read directly; `keryx-tooling-caveats` project memory also flags
gdgraph/gdctx blast-radius answers as historically wrong on this repo, an
independent reason to prefer direct reads and `ctx rg` here); ctx_used: yes
(every project-code and doc search via `bun src/cli.ts ctx rg`, every
test/typecheck/eslint run via `bun src/cli.ts ctx run`, all raw logs cited
above by path; the two `T65-verify-gateway.ts` runs and the RED/GREEN unit
test runs were run directly via bare `bun test`/`bun <script>`, not through
`ctx run`, because gdctx's compaction was observed in this same task to
truncate `ctx rg`'s own match list from 21 to 4 displayed rows — the same
compaction risk T39/T54/T55/T57/T61 recorded for their own per-case
evidence — and because `bun test`'s pass/fail counts are the evidence
itself, not raw noise to compact); raw_rg_used: no — no bare
`rg`/`grep`/`cat`/`find`/`sed` was run over project code or docs; every
search went through `ctx rg`, every multi-line file excerpt through the
`Read` tool at bounded offsets, and the file writes/raw-log redirects used
plain shell redirection (`>`), not a content-search tool.`
