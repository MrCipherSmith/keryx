# T65 spec — align the command exit-code folds with the corrected `gateway` meaning

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Written
before any code change.

Owned files: `src/commands/security.ts`, `src/commands/security-gate-exit.test.ts`,
`src/commands/security.check-input.test.ts`. Read-only: `src/security/guard.ts`,
`src/security/self-protect.ts`, `src/security/types.ts`,
`docs/requirements/keryx-agent-first-core/policies.md`,
`.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/acceptance-criteria.md`.
Nothing else is touched (per T61's disclosed residual and this dispatch's
ownership boundary).

## Background

T61 (`T61-spec.md`/`T61-implementation.md`) resolved a disagreement between
two notions of the `gateway` `SecurityMode`: `isBlockingMode`
(`src/security/guard.ts`) classified it non-blocking (grouped with
`advisory`), while `MODE_RANK` (`src/security/self-protect.ts`) ranked it
strictest of the four recognized modes. T61 concluded `MODE_RANK` reflects
the intended meaning — anchored by must-keep-passing regressions
(`gateway → ci` detected as a downgrade), no design document describing
`gateway` as more permissive than `enforced`/`ci`, and this module's
fail-closed discipline everywhere else (an unrecognized mode forces the
strictest posture, never the most permissive). `isBlockingMode` was
corrected: `gateway` now joins `enforced`/`ci` on the blocking side. T57's
review (`T57-review.md`, Judgement call #4) independently reached the same
conclusion when it refuted the "a broken-config window merely warns" argument
for the identical reason — `gateway` blocking, `isBlockingMode` at the time
saying otherwise.

Both T61-implementation.md and T55-implementation.md disclosed, rather than
fixed (out of their respective ownership), that `src/commands/security.ts`'s
two exit-code folds — `exitCodeFor` (site 1: `security scan`,
`security check-input`/`check-output`) and `reportExitCode` (site 2:
`security report`) — still classify `gateway` with `advisory` for the
process exit code: both check `mode === "ci" || mode === "enforced"`, so a
`gateway` workspace exits 0 for a `fail`/`needs-approval`/`incomplete`
decision exactly like `advisory` does, even though `guardOutput` and
`securityFlowGate` (the write-seam and flow-completion surfaces, both in
`guard.ts`) now refuse under `gateway` via the corrected `isBlockingMode`.
This is the exact shape this phase has repaired at eight prior sites: a
value that blocks inside the module exits zero at its command.

## Verification of the disagreement, at the real command entry points

Confirmed with a probe driven through `securityCommand(...)` itself (not by
calling `exitCodeFor`/`reportExitCode` directly with a literal `"gateway"`
string) — per T61-spec's own warning that an earlier repair in this file
(T55, the `report.mode` vs `modeOf(cwd)` defect) was invisible to a probe
that called the pure function directly, and the worker who caught it had to
write a second probe through the command. `T65-verify-gateway.ts` (same
directory) configures a real `.metaproject/security.config.json` with
`mode: "gateway"` and drives `security scan`, `security report` and
`security check-input` end to end.

Before any change (raw:
`.metaproject/data/gdctx/raw/2026-09-06T16-58-04-000Z_T65-verify-gateway-before.log`):
every `gateway` case — `fail`, `needs-approval`, `incomplete` at all three
surfaces — exits **0**, identically to the `advisory` controls at the bottom
of the same run. This is the bug: `gateway` currently behaves like
`advisory` at every command surface, while `guardOutput`/`securityFlowGate`
already refuse under it.

## Enumeration: every site in `src/commands/security.ts` that branches on mode

Method: `bun src/cli.ts ctx rg -n '"ci"|"enforced"|"advisory"|"gateway"|mode
===|=== mode|isBlockingMode|isPassGate|reportExitCode|exitCodeFor'
src/commands/security.ts` — 21 raw hits (gdctx's own summary view truncated
the displayed match list to 4 of 21; the full 21 were read from the raw log,
`.metaproject/data/gdctx/raw/2026-09-06T16-55-31-373Z_rg.log`, per this same
dispatch's warning about compaction dropping rows). Every hit was read in
context via `Read` on the full file (already read in full for this task).

| Line | Site | Branches on mode? | Classification today | Action |
|---|---|---|---|---|
| `:670` (`reportExitCode`) | `if (mode === "ci" \|\| mode === "enforced")` | yes | `gateway` falls to the `return 0` default, same as `advisory` | **fix — add `gateway`** |
| `:951` (`exitCodeFor`) | `if (mode === "ci" \|\| mode === "enforced")` | yes | `gateway` falls to the `return 0` default, same as `advisory` | **fix — add `gateway`** |
| `:786` (`handleHooks`, install note) | `if ((await modeOf(cwd)) === "advisory")` | yes, but only tests for `"advisory"` specifically, not an exhaustive blocking/non-blocking classification | prints an operator note when the mode is `advisory` ("will report and allow"); silent for every other mode, `gateway` included | **not part of this defect class — see below** |
| `:250`, `:596` | call `exitCodeFor(..., await modeOf(cwd))` | indirectly, via the fold above | inherits whatever `exitCodeFor` decides | fixed automatically once `exitCodeFor` is fixed |
| `:650` | calls `reportExitCode(report.gate, await modeOf(cwd))` | indirectly | inherits whatever `reportExitCode` decides | fixed automatically once `reportExitCode` is fixed |
| `:1059` (`applyRuntimeDecision`, via `decideHookOutcome`) | `code !== 0` (the fold's OUTPUT, not a mode literal) | no independent mode branch | already correct once `code` (from `exitCodeFor`) is correct | no change |

No other site in this file compares a `SecurityMode` value or a mode
literal. Confirmed with the same `ctx rg` pass (21/21 hits accounted for
above) plus a second pass for the bare word `gateway` alone (`bun src/cli.ts
ctx rg -n gateway src/commands/security.ts` — **zero hits**, raw
`.metaproject/data/gdctx/raw/2026-09-06T16-56-22-475Z_rg.log`), confirming
`gateway` is not named anywhere in this file today, including in a comment
that might describe an already-considered exception.

`:786`'s advisory-only note is judged out of scope: it is not an exhaustive
classification of blocking vs. non-blocking modes the way `exitCodeFor`/
`reportExitCode`'s mode checks are — it is a single, named-mode operator
hint ("if you are in `advisory`, the hook reports and does not refuse") that
says nothing at all about `gateway`, `ci`, or `enforced`, and saying nothing
about `gateway` is not the same defect as actively grouping it with
`advisory`. Widening it to also warn under `gateway` would be a UX
enhancement (arguably a Phase-4 concern, since `gateway`'s own behavior is
still being built out — see `guard.ts`'s own `"(Phase 4)"` comment), not a
correctness fix this task's acceptance criteria require, and touching it
risks a change of behavior for a mode this dispatch was explicitly told not
to touch (advisory's permissiveness/behavior "must not change"). Left alone,
named here rather than silently skipped.

## The fix

Add `gateway` alongside `ci`/`enforced` in both mode checks, mirroring
`isBlockingMode`'s own three-way blocking grouping exactly:

```ts
// reportExitCode, exitCodeFor — both, identically:
if (mode === "ci" || mode === "enforced" || mode === "gateway") {
  return isPassGate(...) ? 0 : 1;
}
return 0;
```

`isPassGate` itself (the gate-vocabulary switch) is untouched — this defect
is entirely about which *modes* reach the strict branch, not about the gate
values once there. No new gate vocabulary, no new mode vocabulary.

### Truth table — exactly what moves

| `mode` | `gate` | before | after | changed? |
|---|---|---|---|---|
| `ci` / `enforced` | any | (unchanged from T38/T55) | (unchanged) | no |
| `gateway` | `pass` | 0 | 0 | no |
| `gateway` | `fail` | 0 | **1** | **yes — this task** |
| `gateway` | `needs-approval` | 0 | **1** | **yes — this task** |
| `gateway` | `incomplete` | 0 | **1** | **yes — this task** |
| `gateway` | unrecognized | 0 | **1** | **yes — this task** |
| `advisory` | any | 0 | 0 | no — untouched, per the dispatch's explicit constraint |

If aligning the fold moved any `advisory` cell, this task would stop and
report rather than ship it (per the dispatch's constraint). It does not:
`advisory` is not named in either `if` condition, before or after.

## Regressions (`src/commands/security-gate-exit.test.ts`)

Mirrors the existing `ci`/`enforced`/`advisory` blocks exactly, for
`gateway`:

- Unit: `exitCodeFor` under `gateway` — `pass` → 0; `fail`/`needs-approval`/
  `incomplete`/unrecognized (`"banana"` cast) → 1.
- Unit: `reportExitCode` under `gateway` — same five cases.
- CLI-level, `security scan`: a `needs-approval` finding refuses under
  `gateway` (mirrors the existing `ci` case); the pass control stays 0; the
  existing incomplete-coverage control is extended to also assert under
  `gateway`.
- CLI-level, `security report`: a stored `needs-approval` report refuses
  under `gateway`; the pass control stays 0.
- Advisory-untouched control: re-affirm (no new test needed — every existing
  advisory assertion in this file already pins `0` for every gate, and none
  of them is touched by this change) that `advisory` still exits 0 for every
  gate, including a stored `fail`.

## Regressions (`src/commands/security.check-input.test.ts`)

Read in full (already read for this task, and by T55 before it — confirmed
no reference to `reportExitCode`/`exitCodeFor`/mode-literal logic that
encodes the pre-fix `gateway` behavior as intentional, so nothing existing
needs correcting). Two new cases added to the existing
`describe("what refuses is the operator's declared policy", ...)` block,
extending the pattern the `ci`/`enforced` cases already use:

- `gateway` + a lowered injection floor refuses, exactly like `ci`/
  `enforced` (extends the existing "an operator who lowers the injection
  floor DOES get a refusal" test rather than duplicating its structure in a
  new test).
- The existing secret-class control test
  ("the secret class refuses without any of that — the control") gains a
  `gateway` row alongside its existing `enforced`/`advisory` rows.

## Non-regression

Every existing assertion in both test files for `ci`, `enforced`, and
`advisory` is expected to keep passing unmodified — this task does not
change either mode-check's `ci`/`enforced` arm or the `advisory` fallthrough,
only adds `gateway` to the strict arm. `T38`'s and `T55`'s own regressions
(`exitCodeFor`/`reportExitCode` unit tests, the CLI-level `ci`/`advisory`
scan and report tests, the mismatched-mode tests) are read-only for this
task and must still pass byte-for-byte.

## Verification plan

1. RED at the real command entry point (already captured, before any
   change): `T65-verify-gateway.ts`, raw
   `2026-09-06T16-58-04-000Z_T65-verify-gateway-before.log` — every
   `gateway` case exits 0.
2. Apply the fix (`reportExitCode`, `exitCodeFor`).
3. GREEN at the same probe: re-run `T65-verify-gateway.ts`, expect every
   `gateway` fail/needs-approval/incomplete case to exit 1, pass control
   stays 0, and the two `advisory` controls at the bottom are byte-identical
   to the before run.
4. New regression tests, RED then GREEN, via `bun test
   src/commands/security-gate-exit.test.ts
   src/commands/security.check-input.test.ts`.
5. `bun src/cli.ts ctx run -- bun test src/commands/ src/security/`
   (dispatch-required, full owned+adjacent surface).
6. `bun run typecheck`.
7. `bunx eslint` on every changed file.
8. All raw logs under `.metaproject/data/gdctx/raw/`.

## Constraints honoured

No git state change, no network, no model calls, no `bun test` without file
arguments, no dependency/lockfile change, no `flow.json`/
`acceptance-criteria.md` edit, fixtures under `mkdtemp` only, no scan of a
real credential store. Stays out of `src/security/guard.ts` and
`src/security/self-protect.ts` (the T61 correction must not be re-touched),
`src/security/detect/exfil.ts`, `src/health/*`, and `src/flow/service.ts`
(concurrent workers). No existing test deleted or weakened; no committed
expectation in either owned test file encodes the disagreement being fixed
here (confirmed by reading both files in full), so none needs correcting in
writing — this task adds coverage, it does not flip an existing assertion.
