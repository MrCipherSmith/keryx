STATUS: DONE

# T56 — implementation: exhaustive health-gate fold at `flow complete()` (T39 F-001)

## Vocabulary enumeration (method, then result)

`GateStatus` (`src/health/types.ts:132`): a closed 4-member union, `"pass" |
"warn" | "incomplete" | "fail"`, read directly from the type declaration and
cross-checked against every value `computeGate` (`src/health/gate.ts`) can
`escalate()` to — the `RANK` table at the top of that file (`pass: 0, warn:
1, incomplete: 2, fail: 3`) lists all four and nothing else, confirming the
type and the producer agree.

What each value means (read from `computeGate` and `policies.md`'s "Health и
security gate" section):

| Value | `computeGate` condition | policy meaning |
|---|---|---|
| `pass` | no gate condition triggered | clean |
| `warn` | regression between warn/fail thresholds, an *optional* source `configured-but-failed`, or coverage below the soft floor | a signal, not a violation |
| `incomplete` | `brokenRequired.length > 0` — a **required** source unavailable, execution-failed/not-run, or parse-failed/not-run | "required check absent/skipped/unparsed/unfinished" — ranked between WARN and FAIL, never PASS |
| `fail` | a finding at a gate-priority, or regression at/above the fail threshold | an established threshold violation |

`GateOutcome.status` (`src/flow/types.ts:195-206` — the type this fold must
produce) is a **different, 3-valued** vocabulary: `"pass" | "fail" |
"skipped"`. There is no INCOMPLETE/WARN member. `unevaluableGate`'s own doc
comment, already in the file before this task (`service.ts:910-921`, T45/T47),
states the consequence directly: *"GateOutcome.status has no separate
INCOMPLETE value … INCOMPLETE has no lower bar than FAIL here because this
schema does not carry INCOMPLETE as its own value."* `"skipped"` is reserved
for a deliberate non-evaluation (module disabled, per-package opt-out — gates
2/3/6's existing `skipped` branches); it is not available for "the check ran
and returned a value this fold does not treat as clean," so every
`GateStatus` member that is not a clean pass must fold to `"fail"`, not to a
fourth status this type does not carry.

## The defect, reproduced before any edit

Pre-fix `src/flow/service.ts:640-644`:
```ts
health.status === "fail"
  ? { name: "health", status: "fail", detail: health.reasons.join("; ") || "health gate failed" }
  : { name: "health", status: "pass", detail: `health gate: ${health.status}` }
```
A two-way ternary keyed only on `"fail"` — a one-value denylist with the
permissive arm as the fallthrough. Re-ran the reviewer's own probe,
`T39-exit.ts`, against the real `complete()` pipeline (init → freeze → start
→ 4×taskDone → implemented → acConfirm → clean review package → complete)
before touching any code:

```
healthGate -> pass        recordedGateStatus "pass"  completionPassed true
healthGate -> warn        recordedGateStatus "pass"  completionPassed true   detail "health gate: warn"
healthGate -> incomplete  recordedGateStatus "pass"  completionPassed true   detail "health gate: incomplete"
healthGate -> fail        recordedGateStatus "fail"  completionPassed false
healthGate -> banana      recordedGateStatus "pass"  completionPassed true
```
(Direct console run at session start, before any edit — reproduced verbatim
above; not routed through `ctx run` for this specific pre-edit sanity check,
same precedent T45 recorded for its own pre-fix quick check.)

`deps.healthGate` is wired at both real call sites to
`createCodeHealthService().gate()` (`src/commands/flow.ts:117-119`,
`src/harness/tool/metaproject-adapter.ts:111-114`), whose `status` is the
full `GateStatus` union — `incomplete` is not exotic, it is exactly what
`computeGate` produces for a required source unavailable/failed/unparsed
(`gate.ts:58-63`), verbatim AC4/AFC-05's "skipped required check"/"incomplete
area" and verbatim `policies.md`'s FAIL > INCOMPLETE > PASS ordering. That
row is written into `flow.json` history and, on a pass, `buildIssueComment`
posts `${gate.name}: ${gate.status}` per gate to the tracker — so the false
pass for `incomplete` (and for `warn` and any unrecognized value) is durable
and, when a tracker is configured, published externally.

## Sibling shape (read before choosing this one)

Every other repaired fold in this phase is an **exhaustive switch over the
producer's own closed vocabulary, with the default arm on the blocking
side**, never a two-way `===`/ternary:

- `gateExitCode` (`src/health/service.ts:143-155`): switch over `GateStatus`,
  `pass -> 0`, `warn -> strictWarn?1:0`, `fail`/`incomplete -> 1`, `default ->
  1`.
- `runExitCode` (`src/commands/health.ts:120-131`): identical shape,
  `strict` instead of `strictWarn`.
- `isPassGate` (`src/commands/security.ts:590-601`): switch over
  `SecurityGate`, `pass -> true`, every recognized non-pass value and
  `default -> false`.
- `securityFlowGate`'s inner switch (`src/security/guard.ts:400-409`): same
  shape over the security module's gate status, `pass -> pass`, every
  recognized non-pass value and `default -> fail`.

This task's fix is the same shape over `GateStatus`, folding into
`GateOutcome`'s narrower 3-valued status instead of a boolean/exit code, and
reuses the file's own existing `unevaluableGate` helper for its default arm.

## The `warn` determination and its justification

**Decision: `warn -> GateOutcome.status: "pass"`, with `detail` preserving
the word "warn" (`"health gate: warn"`, not `"health gate: pass"`) so the row
is not textually identical to a genuine pass. `incomplete` and any
unrecognized value fold to `"fail"`.**

Reasoning:

1. **What would break if `warn` blocked.** Both health CLI surfaces (`keryx
   health run` → `runExitCode`, `keryx health gate` → `gateExitCode`) exit
   `0` for `warn` unless the caller opts in via `--strict`/`--strict-warn`.
   `flow complete()` has no strict-mode flag of its own — `deps.healthGate`'s
   only real wiring (`src/commands/flow.ts:117-119`) calls `.gate({ cwd })`
   with no `strictWarn`. Blocking on `warn` unconditionally here would
   silently adopt the strictest sibling behavior for every flow with no way
   to opt out the way the CLI's `--strict-warn` absence already opts callers
   out — exactly the dispatch's own warning that "a change that stops
   legitimate flows from completing would be worse than the defect." A flow
   whose health gate is `warn` today (a regression between thresholds, an
   *optional* source failure, or coverage below the soft floor — none of
   them a required-check gap) completes at every other surface today and
   must keep completing here.
2. **What the policy actually says.** `policies.md` states three tiers, not
   two — FAIL (established violation) > INCOMPLETE (required check gap) >
   PASS — and separately: "Optional skip shows a warning and is not signed
   as passed." That sentence is about an *optional source being skipped*,
   which `computeGate` already reports as a `warn`-adjacent `reasons` entry
   (`OPTIONAL: … source skipped`, `gate.ts:64-67`) without escalating
   `status` past `warn` on its own — it does not say every `warn` blocks
   completion. The dispatch's own framing is correct: "it does not
   necessarily make a warning block a completion."
3. **Distinguishability.** The acceptance criteria requires the recorded row
   to be distinguishable from a genuine pass when the gate did not pass
   cleanly. `warn` still carries that signal in `detail`
   (`` `health gate: ${health.status}` ``, unchanged from the pre-fix code,
   which already produced `"health gate: warn"`) even though `status` stays
   `"pass"` — pinned by the new "still completes… not identical to a genuine
   pass" regression test.
4. **Consistency with the sibling folds' own `warn` handling.**
   `gateExitCode`/`runExitCode` both treat `warn` as non-blocking by default,
   blocking only under an explicit strict opt-in this call site has no
   equivalent for — so "non-blocking" is the faithful mirror, not "silently
   promoted to the strictest sibling behavior."

`incomplete` gets no such argument the other way: it outranks `warn` in
`computeGate`'s own `RANK` table and in `policies.md`'s ordering, it is the
literal condition F-001 names, and no CLI surface in this codebase ever
returns exit `0` for it. It folds to `"fail"`.

An unrecognized value (a future `GateStatus` member, or a non-conforming
`healthGate` dependency — this call site's own type is the untyped `{
status: string; reasons: string[] }`, matching `FlowServiceDeps.healthGate`
as already declared, so no cast is even needed to reach the default arm)
reuses the shared `unevaluableGate("health")` constant instead of
interpolating the unrecognized string, for the same leak-safety reason T45
introduced that helper for the throw path.

## Conservatism argument

- The only behavior change reachable through the real wiring today is
  `incomplete -> pass` becoming `incomplete -> fail`. `pass`, `warn`, and
  `fail` are byte-identical in outcome to before.
- No flow whose health gate is `pass` or `warn` today stops completing —
  verified by the new `warn` regression test and by the full `src/flow/`
  suite staying green (191/191, see Verification).
- A flow whose health gate is `incomplete` today completed with a false
  passing row; after this fix it correctly fails, matching what `keryx
  health run`/`keryx health gate` already report for the identical status —
  the narrowly-scoped behavior change AC8 requires, nothing broader.
- The `banana`/unrecognized case cannot occur through the real
  `createCodeHealthService().gate()` wiring (its own `HealthGateResult`
  types `status` as `GateStatus`); it is a defensive default arm exactly
  like every sibling fold's default arm, exercised only by the regression
  test that constructs a non-conforming dependency directly, same technique
  `health-gate-exit.test.ts`/`security-gate-exit.test.ts` already use for
  their own default arms.

## Fix

Added one pure helper, `healthGateOutcome`, directly below `unevaluableGate`
in `src/flow/service.ts` (which it calls for its own default arm):

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

Gate 5's call site:
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
any other gate (1-4, 6 — including the security arm at `:656`, which T39
F-001 separately flagged as latent/type-admits-`skipped` but explicitly out
of this task's named regression; left untouched per the ownership
constraint). `health.reasons.join("; ")` for `fail`/`incomplete` is the same
construction the pre-fix `fail` arm already used unmodified — not a new leak
surface; `health.reasons` is the health module's own internal `computeGate`
output, not raw external/file content.

## Regression tests (RED before, GREEN after)

Four tests added to `src/flow/service.test.ts`, immediately after the
existing "healthGate that throws…" test (same file, same section, same
full-pipeline drive-to-complete pattern already used by every neighboring
gate test):

1. `"healthGate -> incomplete blocks completion, not relabeled pass"` —
   asserts `status === "fail"`, `detail` contains the reasons text, `passed
   === false`, flow stays `in-progress`.
2. `"healthGate -> unrecognized status blocks completion, not relabeled
   pass, and does not echo the value"` — `status === "fail"`, `detail`
   excludes both the unrecognized value (`"banana"`) and the planted reasons
   text, `passed === false`.
3. `"healthGate -> warn still completes, but the row is not identical to a
   genuine pass"` — `status === "pass"`, `detail === "health gate: warn"`
   (not `"health gate: pass"`), `passed === true`, flow reaches `"done"`.
   Pins the deliberate decision above so a future edit to `warn`'s handling
   is a visible, intentional test change.

**RED** (`bun test src/flow/service.test.ts -t "healthGate ->"`, run
directly per the T45/T47 precedent — test execution, not a code search, so
outside the `ctx rg`-only routing rule for the very first check; the
recorded, routed re-run below reproduces the same result post-fix):

```
error: expect(received).toBe(expected)
Expected: "fail"
Received: "pass"
  at service.test.ts:342  (healthGate -> incomplete blocks completion, not relabeled pass)
error: expect(received).toBe(expected)
Expected: "fail"
Received: "pass"
  at service.test.ts:377  (healthGate -> unrecognized status blocks completion, not relabeled pass, and does not echo the value)
 1 pass, 2 fail, 7 expect() calls
```
The one pre-fix pass was the `warn` test (already non-blocking before this
change, as expected — `warn` was never the named regression).

**GREEN** (`bun src/cli.ts ctx run -- bun test src/flow/service.test.ts -t
"healthGate ->"`): 3 pass / 0 fail / 16 expect(). Raw:
`.metaproject/data/gdctx/raw/2026-09-06T15-53-19-340Z_run.log`.

## Post-fix probe re-run (reviewer's own instrument)

`bun src/cli.ts ctx run -- bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T39-exit.ts`,
raw: `.metaproject/data/gdctx/raw/2026-09-06T15-53-28-458Z_run.log`. F1 rows,
before/after:

| healthGate | before (denylist) | after (exhaustive fold) |
|---|---|---|
| `pass` | `pass`, completes | `pass`, completes — unchanged |
| `warn` | `pass`, completes, detail `"health gate: warn"` | `pass`, completes, detail `"health gate: warn"` — unchanged, deliberate |
| `incomplete` | **`pass`, completes** | **`fail`, does not complete** — the fix |
| `fail` | `fail`, does not complete | `fail`, does not complete — unchanged |
| `banana` (unrecognized) | **`pass`, completes** | **`fail`, does not complete, constant detail** — the fix |

F2 (security gate) rows are byte-identical before/after — untouched, as
required by the ownership constraint (`securityGate` is a separate
dependency this task did not modify).

## Verification

| Check | Command | Result | Raw log |
|---|---|---|---|
| New regressions, RED (pre-fix) | `bun test src/flow/service.test.ts -t "healthGate ->"` (direct, quick pre-fix check) | 1 pass / 2 fail — both on the "fail" vs "pass" assertion, transcript above | not routed (quick local check, same precedent as T45) |
| New regressions, GREEN (post-fix) | `bun src/cli.ts ctx run -- bun test src/flow/service.test.ts -t "healthGate ->"` | 3 pass / 0 fail / 16 expect() | `.metaproject/data/gdctx/raw/2026-09-06T15-53-19-340Z_run.log` |
| Full `service.test.ts` | `bun test src/flow/service.test.ts` (direct, quick check before the recorded run) | 13 pass / 0 fail / 75 expect() | not routed (quick local check) |
| Full flow-focused suite (dispatch's required command) | `bun src/cli.ts ctx run -- bun test src/flow/` | 191 pass / 0 fail / 649 expect() across 20 files | `.metaproject/data/gdctx/raw/2026-09-06T15-52-05-762Z_run.log` |
| Typecheck | `bun src/cli.ts ctx run -- bun run typecheck` | exit 0, zero errors anywhere | `.metaproject/data/gdctx/raw/2026-09-06T15-52-19-531Z_run.log` |
| ESLint on every file changed | `bun src/cli.ts ctx run -- bunx eslint src/flow/service.ts src/flow/service.test.ts` | clean, no output | `.metaproject/data/gdctx/raw/2026-09-06T15-52-22-056Z_run.log` |
| Reviewer's own probe, post-fix | `bun src/cli.ts ctx run -- bun .metaproject/flows/233-.../artifacts/T39-exit.ts` | F1 table above; F2 unchanged | `.metaproject/data/gdctx/raw/2026-09-06T15-53-28-458Z_run.log` |

The full `src/flow/` count (191) is higher than T47's recorded 185 baseline;
this is a shared worktree with two other concurrent workers per the
dispatch's own note, and the delta is not attributable to any file this task
touched (only `src/flow/service.ts` and `src/flow/service.test.ts` were
edited here — confirmed by this task's own diff, not by a broader `git
status` scan, which is out of this task's ownership to interpret). What
matters for this task's acceptance is that the count stayed 0 fail both
before and after this task's own edits, which it did.

## Files changed

- `src/flow/service.ts` — Gate 5's inline ternary replaced with a call to a
  new `healthGateOutcome(health)` helper (placed directly below the existing
  `unevaluableGate`, which it calls for its own default arm); no change to
  `GateOutcome`, `FlowServiceDeps`, the pass/fail fold, `buildIssueComment`,
  or gates 1-4/6.
- `src/flow/service.test.ts` — four new tests added immediately after the
  existing "healthGate that throws…" test: `incomplete` blocks,
  unrecognized-value blocks and does not leak, `warn` still completes and
  stays distinguishable from a genuine pass (three new assertions plus the
  fold's own doc comment cover the fourth, `pass`, via the untouched
  existing happy-path test).

## Routing audit

graph_used: no (not-relevant — the dispatch named the exact file, the exact
function (`complete()`), the exact line (`:641`), and the exact finding
(F-001); no structural/dependency discovery question needed the graph).
wiki_used: no (not-relevant — the normative source is `policies.md`,
supplied directly in the dispatch and read in full, same as T45/T47).
ctx_used: yes — every project-code search via `bun src/cli.ts ctx rg`
(`gateExitCode`, `runExitCode`, `isPassGate`, `securityFlowGate`,
`unevaluableGate`, `GateOutcome`, `healthGate`), every verification command
via `bun src/cli.ts ctx run` (raw logs tabled above), file reads via the
`Read` tool per the dispatch's stated workaround for the raw-`sed`/`cat`
hook. raw_rg_used: no.
