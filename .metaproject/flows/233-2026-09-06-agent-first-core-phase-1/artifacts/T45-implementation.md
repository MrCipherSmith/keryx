STATUS: DONE

# T45 — implementation: `flow/service.ts` no longer folds a throwing gate to `skipped`

## Gate enumeration (before choosing what to change)

`complete()` in `src/flow/service.ts` pushes exactly six `GateOutcome`
entries, read end to end (lines 554-670 in the pre-fix file) before touching
anything:

| # | name | Producer | Exception path | Deliberate-skip path |
|---|---|---|---|---|
| 1 | `acceptance-criteria` | inline `try`/`catch` around `assertAcIntact`+`readAcCriteria` | catch -> `status: "fail"` (already correct; detail interpolates `error.message`, out of this task's named regression — see "Scope decision" below) | none — this gate has no skip state |
| 2 | `pull-request` / `main-merge` | inline `if/else if/else` chain, no `try` at all for the tracker branch | n/a (no catch here) | `else` branch when `deps.tracker` is falsy or `tracker.detect()` is false -> `status: "skipped"`, constant detail `"tracker unavailable; verify PR checks manually"` — **not a throw**, a declared precondition |
| 3 | `tasks` | free-standing `taskGate(flow)` function, called directly (no `try`) | n/a — `evaluateTaskGate` is a pure function over `flow.tasks`, does not throw | `if (!flow.gates?.tasks)` -> `status: "skipped"`, constant detail naming per-package opt-in — **not a throw**, a declared precondition |
| 4 | `review` | inline `try`/`catch` around `reviewGate(...)` | catch -> `status: "fail"` (already correct; comment at the call site literally states "A gate that cannot run has not passed"; detail also interpolates `error.message`, same out-of-scope note) | none observed in this gate's own code path |
| 5 | `health` | inline `try`/`catch` around `deps.healthGate(cwd)` | **catch -> `status: "skipped"`, detail interpolated from `error.message` — THE BUG** | n/a — `deps.healthGate` has no declared skip return; every non-throw path is `pass`/`fail` |
| 6 | `security` | `if (deps.securityGate) { try/catch around deps.securityGate(cwd) }` | **catch -> `status: "skipped"`, detail interpolated from `error.message` — THE BUG** | `if (!deps.securityGate)` -> nothing pushed at all (module disabled, omitted, not skipped) — separate from the catch, untouched |

Enumeration method: read every `gates.push(...)` call site in `complete()`
top to bottom in the source file (no grep needed — the function is one
contiguous block, ~120 lines, and each push is preceded by a comment naming
the gate number, "Gate 1" through "Gate 6"). Cross-checked against
`GateOutcome.name`'s closed union in `src/flow/types.ts:193-203`
(`"acceptance-criteria" | "pull-request" | "main-merge" | "tasks" | "health"
| "security" | "review"` — 7 literals for 6 gates, because gate 2 emits
either `pull-request` or `main-merge` depending on `mergedCommit`), which
confirms nothing is pushed under a name absent from this table.

Confirmed against the fold itself, read at its call site:
`const passed = gates.every((gate) => gate.status !== "fail");` (line 672,
unchanged) — the only blocking value in this 3-valued status
(`"pass"|"fail"|"skipped"`) is `"fail"`. `"skipped"` and an omitted push are
both non-blocking, exactly as T30's and T35's independent reviews state and
as `T35-probe-flowfold.ts` C1 executed against the real `complete()` (cited
in `T35-review.md`, Claim A): `null` -> omitted -> `passed:true`; `pass` ->
`passed:true`; `skipped` -> `passed:true`; a throw -> (pre-fix) recorded
`skipped` -> `passed:true`; only `fail` -> `passed:false`.

## Scope decision (conservatism argument)

Two gates (1, `acceptance-criteria`, and 4, `review`) already push
`status: "fail"` from their catch arms — the blocking behavior this task
exists to establish is already correct there. Their detail strings also
interpolate `error.message`, which shares the leak-safety half of F-005's
finding text, but:

- F-005's own "Suggested fix" names only "the security and health catch
  arms," instructed to match **the review arm's existing `status: "fail"`**
  as the pattern — not the reverse.
- The task's own instruction is explicit: "The security arm was made
  unreachable by an earlier fix in its own module, but the health arm and
  any gate added later are still exposed" — naming health (and future
  gates) as the live surface, not gates 1 or 4.
- The acceptance criteria's "no flow that legitimately completes today
  stops completing" and the dispatch's "be conservative" instruction argue
  against touching two catch arms that are not implicated in the named
  regression (a throwing gate letting completion pass). Gates 1 and 4
  already block on throw; changing their detail string is a strictly
  separate, lower-risk cleanup with no regression to fix, and touching them
  enlarges the diff on a lifecycle module for no behavioral gain within this
  task's acceptance criteria.

**Narrower option taken:** fix only the two catch arms that (a) currently
use the non-blocking `"skipped"` status on an exception and (b) leak the
caught value — gates 5 (`health`) and 6 (`security`). This is the minimal
change that satisfies "a gate whose evaluation throws must not let
completion pass" without altering the behavior of any gate that already
gets that part right.

**Flagging, not fixing, the residual leak in gates 1 and 4:** their catch
arms still interpolate `error.message` into a `"fail"`-status detail. Status
is safe (blocking, as required); the detail's leak-safety is not fully
closed. Recorded here as a drift note for a follow-up task rather than
edited in this dispatch, per the ownership/conservatism constraints above.
This is a **concern**, not a defect this task was scoped to close — see
`skill_drift`/concerns note in the result file.

## Fix

Added one shared helper, `unevaluableGate(name: "health" | "security")`, in
`src/flow/service.ts` (placed directly above `taskGate`, the existing
free-standing gate-producing helper). It returns
`{ name, status: "fail", detail: \`${name} gate could not be evaluated;
treated as failed, not skipped\` }` — a string literal built only from the
gate's own name, never from the caught value.

Gate 5's catch arm: `catch (error) { gates.push({ name: "health", status:
"skipped", detail: \`health unavailable: ${error...}\` }) }` became
`catch { gates.push(unevaluableGate("health")); }`.

Gate 6's catch arm (inside the existing `if (deps.securityGate)` guard, so
"module disabled" still pushes nothing at all): the same transformation for
`"security"`.

No change to `GateOutcome`'s type (`"fail"` was already a valid `status`),
no change to gates 1-4, no change to the pass/fail fold, no change to any
`FlowServiceDeps` signature.

## Deliberate cases verified unchanged

- `deps.securityGate` absent -> gate omitted entirely (untouched `if`
  guard; not a catch arm). Test: `security-gate.test.ts` "no securityGate
  dep: no security gate runs (no regression)" and "securityGate returning
  null omits the gate entirely" — both still pass.
- Tracker unavailable -> `pull-request` gate `status: "skipped"`, unrelated
  code path, untouched. Covered by the full `security-gate.test.ts` +
  `service.test.ts` suite passing.
- `flow.gates?.tasks` false -> `tasks` gate `status: "skipped"`, unrelated
  free-standing function, untouched. Covered by `task-gate.test.ts` (part of
  the sibling-suite run below).
- Advisory security gate returning `{status:"pass", detail: "..."}` (no
  throw) -> unaffected, still `pass`. Test: "advisory securityGate adds an
  informational passing gate; flow still completes" — still passes.
- Enforced security gate returning `{status:"fail", ...}` (no throw, a real
  reported failure, not an exception) -> unaffected, still `fail` with its
  own detail (not replaced by the constant). Test: "enforced securityGate
  failure returns the flow to in-progress" — still passes, and its
  assertion on `detail` content was not changed, confirming the constant
  detail applies only to the throw path.

## Regression tests (RED before, GREEN after)

Two new tests, one per fixed catch arm, each planting a secret-looking path
in the thrown `Error` and asserting the gate blocks and the detail does not
contain it:

- `src/flow/security-gate.test.ts`: "securityGate that throws blocks
  completion, not skips it, and never echoes the thrown text"
- `src/flow/service.test.ts`: "healthGate that throws blocks completion,
  not skips it, and never echoes the thrown text"

**RED** (pre-fix, `bun test src/flow/security-gate.test.ts
src/flow/service.test.ts`): 2 failed / 11 passed. Both failures for the
expected reason:
```
Expected: "fail"
Received: "skipped"
```
at `service.test.ts:290` and `security-gate.test.ts:148` — i.e. the gate was
recorded `skipped` and would have let `result.passed` read `true`, exactly
the regression this task closes. (Run directly with `bun test`, not through
`ctx run`, as a quick pre-fix sanity check before editing source — this was
test execution, not a code search, so it is outside the `ctx rg`-only
routing rule; no raw gdctx log was produced for this specific invocation.
The console transcript is reproduced above verbatim.)

**GREEN** (post-fix, same command, routed through `ctx run`): 13 passed / 0
failed / 64 `expect()` calls. Raw log:
`.metaproject/data/gdctx/raw/2026-09-06T14-57-26-647Z_run.log`.

## Verification

| Check | Command | Result | Raw log |
|---|---|---|---|
| Fixed suites (security-gate + service, incl. the 2 new regressions) | `bun src/cli.ts ctx run -- bun test src/flow/security-gate.test.ts src/flow/service.test.ts` | 13 pass / 0 fail / 64 expect() | `.metaproject/data/gdctx/raw/2026-09-06T14-57-26-647Z_run.log` |
| Sibling gate suites (review, review e2e, tasks) | `bun src/cli.ts ctx run -- bun test src/flow/review-gate.test.ts src/flow/review-gate.e2e.test.ts src/flow/task-gate.test.ts` | 81 pass / 0 fail / 305 expect() | `.metaproject/data/gdctx/raw/2026-09-06T14-57-47-881Z_run.log` |
| Full flow-focused suite | `bun src/cli.ts ctx run -- bun test src/flow/` | 183 pass / 0 fail / 606 expect() | `.metaproject/data/gdctx/raw/2026-09-06T14-58-19-168Z_run.log` |
| Dispatch-required security suite (read-only confirmation; `guard.ts`/`guard.test.ts` are owned by a concurrent worker) | `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts` | 31 pass / **1 fail** — `guard.test.ts:119`, `bytesPreserved`/`redaction` fields undefined on `prepareOutputForPersistence`'s return; unrelated to this task (no `src/security/*` file was edited here — `git diff --stat` on `guard.ts`/`guard.test.ts` shows ~270/~480 lines already changed in the working tree before this task started, by the concurrent worker who owns that module) | `.metaproject/data/gdctx/raw/2026-09-06T14-58-24-172Z_run.log` |
| Typecheck | `bun src/cli.ts ctx run -- bun run typecheck` | Fails — but every reported error is in `src/security/guard.test.ts` and `src/security/persistence-sinks.test.ts` (`bytesPreserved`/`redaction` property errors); **zero errors reference `src/flow/*`** | `.metaproject/data/gdctx/raw/2026-09-06T14-58-53-075Z_run.log` |
| ESLint on every file this task changed | `bun src/cli.ts ctx run -- bunx eslint src/flow/service.ts src/flow/security-gate.test.ts src/flow/service.test.ts` | clean, no output | `.metaproject/data/gdctx/raw/2026-09-06T14-59-00-797Z_run.log` |

The `guard.test.ts` failure and the `typecheck` errors are both entirely
inside `src/security/*`, a module this task's constraints explicitly forbid
editing ("read-only... If the fix needs a change there, stop and reply
STATUS: BLOCKED"), and both predate this task's changes (confirmed via
`bun src/cli.ts ctx diff --stat` showing those two files already modified at
session start, matching the dispatch's own note that a concurrent worker
owns `src/security/guard.ts` and its tests). Not a blocker for this task:
none of the failures/errors touch `src/flow/*`, and the full `src/flow/`
suite is 183/183 green.

## Files changed

- `src/flow/service.ts` — replaced the health/security catch arms with
  calls to a new `unevaluableGate(name)` helper; added that helper.
- `src/flow/security-gate.test.ts` — added one regression test.
- `src/flow/service.test.ts` — added one regression test.

## Routing audit

graph_used: no (not-relevant — the dispatch named the exact file, the exact
function (`complete()`), and the exact finding (F-005); no discovery
question needed the graph). wiki_used: no (not-relevant — the normative
source is `policies.md`, supplied directly in the dispatch and read in
full). ctx_used: yes — every project-code search via `bun src/cli.ts ctx
rg`, every verification command via `bun src/cli.ts ctx run` (raw logs
tabled above), and every bounded file excerpt via `bun src/cli.ts ctx run --
sed -n ...` per the dispatch's stated workaround for the raw-`sed` hook.
raw_rg_used: no.
