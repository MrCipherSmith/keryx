# T47 — spec: close the leak-safety half T45 flagged and left open

## Starting point

T45 (`T45-implementation.md`) fixed the *blocking* half of F-005 for gates 5
(`health`) and 6 (`security`): a throwing evaluator now records `status:
"fail"` via a new shared helper, `unevaluableGate(name)`, instead of
`"skipped"`. It deliberately left gates 1 (`acceptance-criteria`) and 4
(`review`) untouched, because their catch arms already used `status: "fail"`
— the blocking behavior was already correct there — and flagged, not fixed,
that their `detail` strings still interpolate the caught error's message:

> "their catch arms still interpolate `error.message` into a `"fail"`-status
> detail. Status is safe (blocking, as required); the detail's leak-safety is
> not fully closed."

This task closes that remainder: fix the *leak-safety* half for gates 1 and
4, without touching their (already-correct) blocking behavior.

## Enumeration (verified fresh, not trusted from the table)

Every `gates.push(...)` / gate-detail-producing site in `complete()` and its
helpers, read end to end in the current file (`src/flow/service.ts`, `complete()`
at lines 542-694; helpers `taskGate` at 956, `verifyCommitOnMain` at 1040,
`unevaluableGate` at 939, `buildIssueComment` at 1026):

| # | name | Detail source | Attacker/fs-influenced? |
|---|---|---|---|
| 1 | `acceptance-criteria` (pass) | `` `${criteria.length} confirmed` `` | No — a count. |
| 1 | `acceptance-criteria` (fail, missing) | `` `unconfirmed: ${missing.join(", ")}` `` | No — `missing` is drawn from `readAcCriteria`'s regex capture `(AC\d+)`, uppercased; the value space is closed to `AC` + digits, not raw file content. |
| 1 | `acceptance-criteria` (catch) | `error instanceof Error ? error.message : String(error)` — **no prefix at all, the whole detail is the caught value** | **Yes.** `assertAcIntact`'s own throw is a constant, safe string (no interpolation in `store.ts`), but the same catch also covers `readAcCriteria`'s `readFile` and `acChecksum`'s `readFile`, whose Node `fs` errors embed the resolved path (confirmed empirically: `ENOENT` includes `open '<path>'`; see Fix section). **Fix target.** |
| 2 | `pull-request`/`main-merge` | tracker/`deps.mainMergeGate` results, or constants (`"no PR recorded"`, `"tracker unavailable; verify PR checks manually"`), or `verifyCommitOnMain`'s detail (commit id pre-validated by `/^[0-9a-f]{7,64}$/i` before interpolation) | No — no catch arm here at all (T45's enumeration confirmed this), and the one interpolated value (the commit id) is regex-constrained to hex. |
| 3 | `tasks` (`taskGate`) | task ids (`verdict.open/failed/blocked/unknownDisposition`, `.join(", ")`) | No — these are `flow.tasks[].id` values from `flow.json`, not arbitrary external text, and `taskGate` is a pure function over already-parsed state; it does not throw (T45's enumeration; unchanged). |
| 4 | `review` (delegated pass/fail/skipped) | `verdict.detail` from `runReviewGate`, itself built from structured, string-templated cases inside `review-gate.ts` (out of this file, out of this task's ownership) | Not evaluated here — inside `review-gate.ts`, not `service.ts`; noted as a possible follow-up below, not fixed (ownership boundary). |
| 4 | `review` (catch) | `` `review gate could not be evaluated: ${error instanceof Error ? error.message : String(error)}` `` | **Yes**, same shape as gates 5/6 before T45: a constant prefix plus the raw caught value. `reviewGate` itself never deliberately throws (no `throw` in `review-gate.ts`; every error path returns a structured verdict) — so this catch exists for genuinely *unexpected* failures, which is exactly the class that can carry a path or file content. **Fix target.** |
| 5 | `health` (catch) | `unevaluableGate("health")` | Already fixed (T45). Unchanged here. |
| 6 | `security` (catch) | `unevaluableGate("security")` | Already fixed (T45). Unchanged here. |
| — | `buildIssueComment` | `` `${gate.name}: ${gate.status}` `` per gate (name/status only) | No — never includes `gate.detail`. Confirms the two fixed leaks were reachable via `flow.json` history (the `completion-failed` transition reason joins `gate.detail`, see below) even though the issue-comment path was already safe. |
| — | failed-gates transition reason (line ~688) | `` failed.map((gate) => `${gate.name}: ${gate.detail}`).join(" | ") `` | Inherits whatever gate 1/4 currently leak — another reason the two fix targets above matter: a leaked detail reaches durable `flow.json` history a second time here, independent of `buildIssueComment`. |

Cross-checked against `GateOutcome.name`'s closed union in
`src/flow/types.ts:193-203` — same 7 literals for 6 gates T45 already
confirmed (`pull-request`/`main-merge` split), nothing pushed under a name
absent from this table.

**Confirmed there are exactly two remaining leak sites**, both named in the
dispatch: gate 1's catch arm and gate 4's catch arm. No other detail-building
site in `service.ts` interpolates unconstrained external text.

## Fix

Reuse `unevaluableGate`, widened to the two additional gate names, rather
than inventing a second constant-detail shape:

```ts
function unevaluableGate(
  name: "acceptance-criteria" | "review" | "health" | "security",
): GateOutcome {
  return {
    name,
    status: "fail",
    detail: `${name} gate could not be evaluated; treated as failed, not skipped`,
  };
}
```

Gate 1's catch becomes `gates.push(unevaluableGate("acceptance-criteria"))`.
Gate 4's catch becomes `gates.push(unevaluableGate("review"))`. Both keep
`status: "fail"` — the value they already had — so `gates.every((gate) =>
gate.status !== "fail")` is unchanged for these two arms; only the `detail`
string changes shape, from "prefix + raw error" (gate 4) or "raw error alone"
(gate 1) to the same category constant gates 5/6 already use.

No change to `GateOutcome`'s type, no change to the non-catch branches of
gates 1/2/3/4, no change to the pass/fail fold, no change to any
`FlowServiceDeps` signature.

## Diagnostic-value check (required before shipping a narrower detail)

Gate 1's catch currently *can* surface one genuinely useful, already-safe
message: `assertAcIntact`'s checksum-mismatch error (`store.ts`) is a
hardcoded constant naming the exact remedy (`flow ac update` / `flow ac
reseal`) — interpolating it back out is not itself unsafe, because nothing
variable is in it. Losing that specific text in favor of the generic
constant is a real (small) diagnostic reduction. It is not fixed by
special-casing the message in `service.ts` (string-matching a message owned
by `store.ts` is exactly the fragile, error-message-coupling anti-pattern
this task is closing) and not fixed by editing `store.ts` (out of this
task's file ownership: "`src/flow/service.ts` and the focused test files
under `src/flow/`. Nothing else."). Mitigation, not a workaround: `flow
check` (`service.ts` `check()`, ~line 828) independently re-derives the same
checksum mismatch as its own `kind: "checksum"` issue, with the identical
safe, constant, remedy-naming message — already exercised by the "freeze
locks AC; tampering blocks transitions and is caught by check" test in
`service.test.ts`. An operator who hits gate 1's generic "could not be
evaluated" detail during `complete()` has a dedicated, still-detailed
diagnostic one command away (`keryx flow check`), so no information is
silently dropped with no path to recover it — see `T47-implementation.md`
for the fuller note and a proposed typed-error follow-up.

Gate 4 has no equivalent existing risk: `reviewGate` never deliberately
throws (confirmed: no `throw` in `review-gate.ts`), so its catch arm was
already reserved for the unexpected/unstructured case — exactly like gates
5/6 before T45. There is no "safe constant message" being displaced here;
applying the same treatment is a direct, lower-risk match to precedent.

## Regression tests (RED before, GREEN after)

Two new tests in `src/flow/service.test.ts`, mirroring T45's
`"healthGate that throws blocks completion, not skips it, and never echoes
the thrown text"` pattern:

1. **Gate 1.** No injectable dependency exists for `readAcCriteria`/
   `assertAcIntact` (they are direct imports from `./store`, called from
   many other service methods too — freeze, start, implemented, acConfirm —
   so mocking the whole module would break the setup steps that must
   legitimately succeed before `complete()` runs). Instead, drive a flow to
   the point `complete()` is callable using the real filesystem, with a flow
   title containing a fake-secret-looking token that survives `slugify` into
   the flow directory name, then **delete the on-disk
   `acceptance-criteria.md` file** immediately before calling `complete()`.
   `assertAcIntact` → `acChecksum` → `readFile` then throws a real Node
   `ENOENT` whose message embeds the full path (`open '<path with the fake
   secret in the directory name>'`; verified empirically: an `ENOENT` from
   `node:fs/promises#readFile` includes the resolved path, unlike `EISDIR`,
   which on this platform does not). Assert `status === "fail"`, `detail`
   contains neither the secret token nor the path nor `"ENOENT"`,
   `result.passed === false`, `result.flow.status === "in-progress"`.
2. **Gate 4.** `reviewGate` has exactly one call site in `service.ts` (Gate
   4's `try`) and is not used by any other method, so mocking `./review-gate`
   for the duration of one test is precise and cannot disturb the setup
   steps (freeze/start/taskDone/implemented/acConfirm never call it). Use the
   same snapshot/break/restore discipline already established in
   `src/security/guard.test.ts` (`realConfigExports` /
   `breakConfigLoad`/`restoreConfigLoad`): snapshot the real module once at
   file scope, `mock.module("./review-gate", () => ({ ...real, reviewGate:
   async () => { throw new Error(...) } }))` for the test, restore in
   `finally`. Thrown message carries a planted path + fake secret. Assert the
   same four properties as (1).

Both assert the **status literal stays `"fail"`** (it already was — this is
a non-regression check, not the primary assertion) and that `detail` is
scrubbed — that is this task's actual regression: before the fix, `detail`
for both gates contains the planted secret/path; after, it does not, while
`status`/`passed`/`flow.status` are unchanged (proving blocking behavior was
never at risk).

## Verification plan

- `bun src/cli.ts ctx run -- bun test src/flow/service.test.ts` (existing +
  2 new)
- `bun src/cli.ts ctx run -- bun test src/flow/security-gate.test.ts
  src/flow/review-gate.test.ts src/flow/review-gate.e2e.test.ts
  src/flow/task-gate.test.ts` — sibling gate suites, unaffected by a
  detail-string-only change, run to catch any cross-gate assumption anyway
- `bun src/cli.ts ctx run -- bun test src/flow/` — full flow-focused suite
- `bun src/cli.ts ctx run -- bun run typecheck` — report only `src/flow/*`
  findings; `src/security/*` errors belong to a concurrent worker
- `bunx eslint` on every file changed
- Routing audit at the end, per dispatch instructions
