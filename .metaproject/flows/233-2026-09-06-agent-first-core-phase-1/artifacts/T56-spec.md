# T56 — spec: exhaustive health-gate fold at `flow complete()` (F-001)

## Defect (from T39-review.md F-001, verified by re-running `T39-exit.ts` before any edit)

`src/flow/service.ts:640-644`, Gate 5 ("code health") inside `complete()`:

```ts
const health = await deps.healthGate(cwd);
gates.push(
  health.status === "fail"
    ? { name: "health", status: "fail", detail: health.reasons.join("; ") || "health gate failed" }
    : { name: "health", status: "pass", detail: `health gate: ${health.status}` },
);
```

This is a one-value denylist (`fail` blocks, everything else — `pass`, `warn`,
`incomplete`, and any unrecognized string — passes). `deps.healthGate` is
wired at both real call sites to `createCodeHealthService().gate()`
(`src/commands/flow.ts:117-119`, `src/harness/tool/metaproject-adapter.ts:111-114`),
whose `status` is the full `GateStatus` union
(`"pass" | "warn" | "incomplete" | "fail"`, `src/health/types.ts:132`).
`incomplete` is produced by `computeGate` (`src/health/gate.ts:58-63`)
whenever a *required* health source is unavailable, failed to execute, or
failed to parse — verbatim `policies.md`'s "Health и security gate" ordering
(FAIL > INCOMPLETE for a missing/skipped/unparsed/unfinished required check
> PASS) and verbatim AC4/AFC-05's "skipped required check"/"incomplete
area". No corruption or unrecognized value is needed to reach it.

Reproduced pre-fix by re-running the reviewer's own probe,
`T39-exit.ts`, section "F1 flow complete, healthGate -> …", against the
**real** `complete()` pipeline (init → freeze → start → 4×taskDone →
implemented → acConfirm → clean review package → complete):

```
healthGate -> pass        recordedGateStatus "pass"  completionPassed true
healthGate -> warn        recordedGateStatus "pass"  completionPassed true   detail "health gate: warn"
healthGate -> incomplete  recordedGateStatus "pass"  completionPassed true   detail "health gate: incomplete"
healthGate -> fail        recordedGateStatus "fail"  completionPassed false
healthGate -> banana      recordedGateStatus "pass"  completionPassed true
```
Raw log: `.metaproject/data/gdctx/raw/2026-09-06T15-47-16-*_run.log` (see
Evidence in T56-implementation.md for the exact filename recorded by this
session's run).

That row is written into `flow.json` history (`transition()`) and, on a
pass, `buildIssueComment` posts `${gate.name}: ${gate.status}` per gate to
the issue tracker — so the false "pass" for `incomplete`/unrecognized is
durable and, when a tracker is configured, published externally.

## Vocabulary enumeration (method, then result)

`GateStatus` (`src/health/types.ts:132`): `"pass" | "warn" | "incomplete" |
"fail"` — a closed 4-member union, exhaustively read (not sampled) directly
from the type declaration, cross-checked against every value `computeGate`
(`src/health/gate.ts`) can `escalate()` to (`pass` default, `warn`,
`incomplete`, `fail` — the `RANK` table at the top of that file lists all
four and nothing else).

What each value means, read from `computeGate` and from `policies.md`
("Health и security gate"):

| Value | `computeGate` condition | policies.md meaning |
|---|---|---|
| `pass` | no gate condition triggered | clean; strict CI accepts only this one |
| `warn` | a regression between the warn/fail thresholds, an optional source `configured-but-failed`, or coverage below the soft floor | a signal, not a violation; "optional skip shows a warning and is not signed as passed" — but a *warning* is not the same schema position as a *skip*, see the `warn` decision below |
| `incomplete` | `brokenRequired.length > 0` — a **required** source unavailable, execution-failed, execution-not-run, parse-failed, or parse-not-run | "required check absent/skipped/unparsed/unfinished" — INCOMPLETE, ranked strictly between WARN and FAIL, never PASS |
| `fail` | a finding at a gate-priority, or regression at/above the fail threshold | an established threshold violation |

`GateOutcome.status` (`src/flow/types.ts:195-206`, the type this fold must
produce) is a **different, 3-valued** vocabulary: `"pass" | "fail" |
"skipped"`. There is no `INCOMPLETE`/`WARN` member here — a fact this same
file already states in `unevaluableGate`'s own doc comment (`service.ts:910-921`,
added by T45/T47 for the throw path): *"`GateOutcome.status` has no separate
INCOMPLETE value … INCOMPLETE has no lower bar than FAIL here because this
schema does not carry INCOMPLETE as its own value."* `"skipped"` is reserved
for a **deliberate** non-evaluation (module disabled, per-package opt-out —
see gates 2/3/6's `skipped` branches); it is not available for "the check
ran and returned a value this fold does not treat as clean," so every
`GateStatus` member that is not a clean pass must fold to `GateOutcome`'s
`"fail"`, not to a fourth status this type does not have.

## Sibling shape (read before choosing this one)

Every other fold in this phase's repairs (T33/T38/T45/T47/T48/T50) is an
**exhaustive switch over the producer's own closed vocabulary, with the
default arm on the blocking side** — never a two-way `===`/ternary:

- `gateExitCode` (`src/health/service.ts:143-155`) — switch over
  `GateStatus`, `pass -> 0`, `warn -> strictWarn?1:0`, `fail`/`incomplete
  -> 1`, `default -> 1`.
- `runExitCode` (`src/commands/health.ts:120-131`) — identical shape, `strict`
  instead of `strictWarn`.
- `isPassGate` (`src/commands/security.ts:590-601`) — switch over
  `SecurityGate`, `pass -> true`, every recognized non-pass value and
  `default -> false`.
- `securityFlowGate`'s inner switch (`src/security/guard.ts:400-409`) — same
  shape over `SecurityGateStatus`, `pass -> pass`, every recognized
  non-pass value and `default -> fail`.

This task's fix is the same shape, over `GateStatus`, folding into
`GateOutcome`'s narrower 3-valued status instead of a boolean/exit code.

## The `warn` decision

**Ruling: `warn -> GateOutcome.status: "pass"`, with the detail preserving
the word "warn" so the row is not identical to a clean pass. `incomplete`
and any unrecognized value fold to `"fail"`.**

Reasoning, weighing the two things the dispatch asked to be weighed against
each other:

1. **What would break if `warn` blocked.** Both health CLI surfaces
   (`keryx health run` → `runExitCode`, `keryx health gate` → `gateExitCode`)
   exit `0` for `warn` **unless** the caller opts in via `--strict` /
   `--strict-warn`. `flow complete()` has no strict-mode flag of its own to
   opt into — `deps.healthGate`'s only real wiring
   (`src/commands/flow.ts:117-119`) calls `.gate({ cwd })` with no
   `strictWarn`. If this fold blocked on `warn` unconditionally, it would
   silently adopt the *strict* behavior for every flow, with no way for an
   operator to opt out the way `--strict-warn`'s absence already opts them
   out at the two CLI surfaces. That is exactly the dispatch's own warning:
   "a change that stops legitimate flows from completing would be worse
   than the defect." A flow whose health gate currently sits at `warn`
   (regression between thresholds, an *optional* source failed, or coverage
   below the soft floor — none of them a required-check gap) completes
   today at every other surface and must keep completing here.
2. **What the policy actually says about `warn`.** `policies.md` distinguishes
   three tiers, not two: FAIL (established violation) > INCOMPLETE (required
   check gap) > PASS, and separately states "Optional skip shows a warning
   and is not signed as passed" — but that sentence is about an **optional
   source being skipped**, which `computeGate` already reports as a `warn`-
   adjacent `reasons` entry (`OPTIONAL: … source skipped`, `gate.ts:64-67`)
   *without* escalating `status` past `warn` on its own (an optional skip
   alone does not reach `escalate()`). The dispatch's own reading is
   correct: "it does not necessarily make a warning block a completion."
   Nothing in `policies.md`'s fold table places `warn` on the blocking side;
   only `FAIL` and (for required checks) `INCOMPLETE` are.
3. **Distinguishability, so `warn -> pass` does not silently reintroduce a
   variant of the same defect.** The acceptance criteria requires the
   recorded row to be "distinguishable from a genuine pass by a reader of
   `flow.json`" for a gate that did not cleanly pass. This applies most
   directly to `incomplete` (which must not read as `pass` at all — status
   itself changes), but `warn` still gets a textual signal: the detail stays
   `` `health gate: ${health.status}` `` (unchanged from the current code,
   which already writes `"health gate: warn"` today), so `status: "pass"` +
   `detail: "health gate: warn"` is visibly different from `status: "pass"` +
   `detail: "health gate: pass"`. A reader (human or the `buildIssueComment`
   consumer, which prints `` `${gate.name}: ${gate.status}` `` — not the
   detail — so the tracker comment itself only ever says "health: pass" for
   either) gets the distinction from `flow.json`'s own gate row, same as
   today.
4. **Consistency with the sibling folds' own `warn` handling.** `gateExitCode`
   and `runExitCode` both treat `warn` as non-blocking by default and
   blocking only under an explicit strict opt-in — this fold has no such
   opt-in surface to wire, so the closest faithful mirror is "non-blocking,"
   not "silently promoted to the strictest sibling behavior."

`incomplete` gets no such argument in the other direction: it is ranked
strictly above `warn` in `computeGate`'s own `RANK` table and in
`policies.md`'s ordering, it is the literal condition the dispatch and
F-001 name, and no CLI surface in this codebase ever returns exit `0` for
it (`gateExitCode`/`runExitCode` both fold `incomplete -> 1` unconditionally,
independent of any strict flag). It folds to `GateOutcome.status: "fail"`.

An unrecognized value (a future `GateStatus` member, or a value a
non-conforming `healthGate` dependency returns — the type at this call site
is the untyped `{ status: string; reasons: string[] }`, not the health
module's own closed union, exactly as `FlowServiceDeps.healthGate` already
declares it, so nothing here even needs a cast to reach the default arm)
folds to the same shared `unevaluableGate("health")` constant the throw
path already uses, rather than interpolating the unrecognized string: the
value came from a dependency this function does not control, so treating it
like "could not be evaluated" is both accurate (this fold literally cannot
place it) and leak-safe (no interpolation of an unvetted string into a
detail that reaches `flow.json` history and `buildIssueComment`).

## Fix

Add one pure helper, `healthGateOutcome`, next to `unevaluableGate` (which
it calls for its default arm, keeping one leak-safe "could not be evaluated"
constant in the file rather than two). Exhaustive switch over
`health.status`, default arm blocking:

```ts
function healthGateOutcome(health: { status: string; reasons: string[] }): GateOutcome {
  switch (health.status) {
    case "pass":
    case "warn":
      return { name: "health", status: "pass", detail: `health gate: ${health.status}` };
    case "fail":
      return { name: "health", status: "fail", detail: health.reasons.join("; ") || "health gate failed" };
    case "incomplete":
      return {
        name: "health",
        status: "fail",
        detail: health.reasons.join("; ") || "health gate incomplete",
      };
    default:
      return unevaluableGate("health");
  }
}
```

Call site (Gate 5) becomes:

```ts
try {
  const health = await deps.healthGate(cwd);
  gates.push(healthGateOutcome(health));
} catch {
  gates.push(unevaluableGate("health"));
}
```

No change to `GateOutcome`, `FlowServiceDeps`, the pass/fail fold
(`gates.every((gate) => gate.status !== "fail")`), `buildIssueComment`, or
any other gate (1-4, 6). `reasons.join("; ")` for `fail`/`incomplete` is the
same construction the current `fail` arm already uses unmodified (not a new
leak surface — `health.reasons` is the health module's own internal
`computeGate` output, not raw external/file content, same as today).

## Conservatism argument (summary)

- The only behavior change for a value that reaches production today through
  the real wiring is `incomplete -> pass` becoming `incomplete -> fail`. `warn`,
  `pass`, and `fail` are byte-identical in outcome to before (the `banana`/
  unrecognized case cannot occur through the real `createCodeHealthService().gate()`
  wiring, whose own `HealthGateResult.status` is `GateStatus`; it is a
  defensive arm for a non-conforming dependency, exactly like the sibling
  folds' `default` arms).
- No flow whose health gate is `pass` or `warn` today stops completing.
- A flow whose health gate is `incomplete` today completes with a **false**
  passing row; after this fix it correctly fails, matching what
  `keryx health run`/`keryx health gate` already report for the identical
  status. This is the intended, narrowly-scoped behavior change AC8 requires.

## Regressions to add (RED before, GREEN after)

In `src/flow/service.test.ts`, immediately after the existing "healthGate
that throws…" test:

1. `healthGate -> incomplete` blocks completion (status `"fail"`, `passed:
   false`, flow stays `in-progress`), and the recorded row is NOT `"pass"`.
2. `healthGate -> <unrecognized string>` blocks completion the same way,
   using the shared `unevaluableGate` constant detail (leak-safe, does not
   echo the unrecognized value).
3. `healthGate -> warn` still completes (`passed: true`, gate `status:
   "pass"`), pinning the deliberate decision above so a future change to
   `warn`'s handling is a visible, intentional test edit, not a silent
   regression — and the detail still reads `"health gate: warn"`, not
   `"health gate: pass"`, so the row stays distinguishable from a genuine
   pass even while `status` is `"pass"`.

## Verification plan

- `bun test src/flow/service.test.ts` before the fix (RED: new tests 1-2
  fail, `recordedGateStatus`/`status` reads `"pass"` instead of `"fail"`).
- Apply fix.
- `bun test src/flow/service.test.ts` after (GREEN).
- `bun src/cli.ts ctx run -- bun test src/flow/` (full focused suite, per
  the dispatch's test-selection restriction).
- `bun run typecheck`, filtered to files this task touches.
- `bunx eslint` on every file changed.
- Re-run `T39-exit.ts` post-fix and diff the F1 rows against the pre-fix
  capture above.
