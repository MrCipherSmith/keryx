# T45 — spec: stop `flow/service.ts` from recording an unevaluable gate as `skipped`

## Defect (T35 F-005, confirmed by two independent reviews: T30, T35)

`src/flow/service.ts`'s `complete()` folds gate results with:

```ts
const passed = gates.every((gate) => gate.status !== "fail");
```

Only `"fail"` blocks. `"pass"`, `"skipped"`, and an omitted gate (nothing
pushed) are all non-blocking. Two of the six gate blocks catch an exception
from evaluating the gate and push `status: "skipped"` with the thrown
`error.message` interpolated into `detail`:

- Gate 5 (`health`), lines ~639-652 — `deps.healthGate(cwd)` throws ->
  `{ name: "health", status: "skipped", detail: \`health unavailable: ${error.message}\` }`.
- Gate 6 (`security`), lines ~657-670 — `deps.securityGate(cwd)` throws ->
  `{ name: "security", status: "skipped", detail: \`security unavailable: ${error.message}\` }`.

Both are wrong for the same reason the phase's policy states in
`docs/requirements/keryx-agent-first-core/policies.md` (§"Health и security
gate"): "если ... required check отсутствует/пропущен/не разобран/не
завершён — INCOMPLETE" — a check that could not run is not the same outcome
as one that was deliberately skipped, and it must never fold to something
`strict` accepts. In this schema (`GateOutcome.status: "pass"|"fail"|
"skipped"`) the blocking value is `"fail"`, so "incomplete" here means
`"fail"`, matching how Gate 1 (acceptance-criteria) and Gate 4 (review)
already treat their own catch arms.

Second defect at the same two sites: the detail interpolates
`error instanceof Error ? error.message : String(error)` verbatim into a
string that is written into `flow.json` (via `save` -> `history`) and into
`buildIssueComment`, which can be posted to an external issue tracker. A
thrown error from `deps.healthGate`/`deps.securityGate` can carry a
filesystem path or file content (e.g. a stack frame naming an unreadable
file, or a parse error quoting the file's own bytes). `policies.md`
(§"Redaction и security scan") states secrets/content must not survive into
an exception, error, receipt, or raw continuation — the general rule the
existing `POSTURE_UNAVAILABLE_REASON`-style constants in `src/security/
guard.ts` already follow one layer down. The two catch arms here do not
follow it: they build the detail from the caught value.

## What is deliberately NOT touched

Read every status producer in `complete()` before deciding scope
(enumeration in `T45-implementation.md`). Two shapes must survive unchanged:

1. **Omitted because the module is disabled** — `deps.securityGate`
   undefined: the `if (deps.securityGate)` guard means nothing is pushed for
   gate 6 at all. This is not a catch arm and is untouched.
2. **Genuinely skipped optional check** — no exception involved:
   - Gate 2 (`pull-request`) when `deps.tracker` is unset or `tracker.detect()`
     is false: `{ status: "skipped", detail: "tracker unavailable; verify PR
     checks manually" }`. A real "we could not check" case, not an
     exception — the caller told us up front there is no tracker.
   - `taskGate()` (Gate 3, in the free-standing `taskGate` function) when
     `flow.gates?.tasks` is false: `{ status: "skipped", detail: "task gate
     not enabled for this package ..." }`. Per-package opt-in, also not an
     exception path.

Neither of those is a `catch` reacting to a throw, so neither is in scope for
"a gate whose evaluation throws must not read as skipped."

Gate 1 (`acceptance-criteria`) and Gate 4 (`review`) already push
`status: "fail"` from their catch arms — the blocking status is already
correct there. Their detail *also* interpolates the raw error text
(`error instanceof Error ? error.message : String(error)`), which shares the
leak-safety defect on the detail. F-005's finding text scopes the required
fix ("suggested fix: make the security and health catch arms `status: "fail"`
... matching the review arm") to gates 5 and 6, rated `info` severity, and
explicitly used the review arm's `status: "fail"` as the pattern to match —
not flagged as a blocker requiring the other two arms to change. Given this
task's ownership is scoped to the regression named in the dispatch (a
throwing gate that lets completion pass), and "keep the deliberate cases
intact ... no flow that legitimately completes today stops completing" is
the conservatism instruction, I will:

- Fix gates 5 and 6 (the two that currently leak AND fail to block).
- Leave gates 1 and 4 exactly as they are: they already block (no behavior
  regression risk), and widening their detail is a strictly separate,
  lower-risk cleanup outside this dispatch's named defect. Note it as a
  drift observation in the implementation report rather than editing files
  outside what the regression requires — touching them adds risk (their
  detail strings are asserted verbatim nowhere in the current suite, but
  changing untouched-by-the-defect code inflates the diff on a lifecycle
  module the dispatch says to be conservative about).

## Fix

Add one small shared helper, used by both catch arms, so future gates (any
added later) reuse the same non-leaking, blocking behavior instead of a new
per-gate ad hoc catch:

```ts
/**
 * A gate whose evaluation threw has not passed and was never deliberately
 * skipped — INCOMPLETE folds to FAIL here, matching policies.md's "Health и
 * security gate" ordering (violation -> FAIL; missing/skipped/unparsed/
 * unfinished required check -> INCOMPLETE; strict accepts only PASS -- and
 * this schema has no separate INCOMPLETE value, so the only status that
 * blocks is "fail"). The detail is a constant naming the gate: the caught
 * value is never interpolated, because it can carry a path or file content
 * (policies.md, "Redaction и security scan").
 */
function unevaluableGate(name: "health" | "security"): GateOutcome {
  return {
    name,
    status: "fail",
    detail: `${name} gate could not be evaluated; treated as failed, not skipped`,
  };
}
```

Gate 5 catch arm becomes `gates.push(unevaluableGate("health"))`.
Gate 6 catch arm becomes `gates.push(unevaluableGate("security"))` (inside
the existing `if (deps.securityGate)` block, so "module disabled" stays
"omitted" and only "module present but threw" changes).

No change to `GateOutcome`'s type (`status` already includes `"fail"`) and no
change to any other gate.

## Regression tests (RED before, GREEN after)

New tests in `src/flow/security-gate.test.ts` (extends the existing
`driveToComplete` harness already used for security-gate throw/skip/pass
cases in that file) plus one in `src/flow/service.test.ts` for the health
arm (that file already has a `healthGate` override in `makeDeps`):

1. `security-gate.test.ts`: `securityGate` that throws -> gate pushed with
   `status: "fail"`, `result.passed === false`, `result.flow.status ===
   "in-progress"`, and the detail contains neither the thrown message nor a
   planted sentinel/path substring.
2. `service.test.ts`: `healthGate` that throws -> same shape (fail, blocked,
   sentinel-free detail).

Both assert the **status literal is `"fail"`, not `"skipped"`** — that is
the exact regression: before the fix, `gates.every(g => g.status !==
"fail")` reads `true` for a thrown gate because it is recorded `"skipped"`,
so `result.passed` is `true` and the flow completes. RED must show
`result.passed === true` today; GREEN must show `false`.

## Verification plan

- `bun test src/flow/security-gate.test.ts` (existing 4 + 1 new)
- `bun test src/flow/service.test.ts` (existing 6, unaffected)
- `bun test src/flow/review-gate.test.ts src/flow/review-gate.e2e.test.ts
  src/flow/task-gate.test.ts` — sibling gate-focused suites, to catch any
  cross-gate assumption the change might disturb
- `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts` (dispatch
  requirement; read-only confirmation the security module's own fix, F-001,
  is unaffected by this flow-layer change)
- `bun run typecheck`
- `bunx eslint src/flow/service.ts src/flow/security-gate.test.ts
  src/flow/service.test.ts`
