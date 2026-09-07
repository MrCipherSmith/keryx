STATUS: DONE

# T47 — implementation: close the leak-safety half T45 flagged and left open

## Enumeration (method, then result)

Read `complete()` end to end in the current `src/flow/service.ts` (lines
542-694) plus every helper it calls that produces a `GateOutcome` or feeds
into a persisted completion record (`taskGate` at 956, `verifyCommitOnMain`
at 1040, `unevaluableGate` at 939 pre-widening, `buildIssueComment` at 1026,
and the failed-gates transition-reason line at ~688). Cross-checked against
`GateOutcome.name`'s closed union in `src/flow/types.ts:193-203` (7 literals
for 6 gates, `pull-request`/`main-merge` split) — nothing pushed under a name
absent from the table below, same check T45 already ran and I re-ran rather
than trusting.

| # | site | detail source | attacker/fs-influenced? |
|---|---|---|---|
| 1 | acceptance-criteria, pass | `` `${criteria.length} confirmed` `` | No — a count. |
| 1 | acceptance-criteria, fail (missing confirmations) | `` `unconfirmed: ${missing.join(", ")}` `` | No — `missing` values are `readAcCriteria`'s regex capture `(AC\d+)`, uppercased; a closed token space, not raw file content. |
| 1 | acceptance-criteria, **catch** | **was**: `error instanceof Error ? error.message : String(error)`, no prefix at all | **Yes — fix target.** `assertAcIntact`'s own throw is a hardcoded, safe constant (no interpolation in `store.ts`), but the same catch also covers `readAcCriteria`'s and `acChecksum`'s `readFile` calls, whose Node `fs` errors embed the resolved path. Verified empirically (script run during spec work): `ENOENT` from `node:fs/promises#readFile` embeds `open '<path>'`; this platform's `EISDIR` does not embed a path but a different fs failure mode could. |
| 2 | pull-request/main-merge (all branches) | tracker/`deps.mainMergeGate` results, or constants, or `verifyCommitOnMain`'s detail (commit id pre-validated `/^[0-9a-f]{7,64}$/i` before interpolation) | No. No catch arm exists here (confirmed, matches T45's independent enumeration). |
| 3 | tasks (`taskGate`) | task ids from `flow.tasks[].id`, `.join(", ")` | No — internal state, not external text; pure function, does not throw. |
| 4 | review, delegated pass/fail/skipped | `verdict.detail`, built inside `review-gate.ts` (outside this task's ownership) | Not evaluated here (see "Out of scope, flagged" below). |
| 4 | review, **catch** | **was**: `` `review gate could not be evaluated: ${error instanceof Error ? error.message : String(error)}` `` | **Yes — fix target.** `reviewGate` never deliberately throws (no `throw` anywhere in `review-gate.ts`; every error path returns a structured verdict), so this catch is reserved for a genuinely unexpected failure — the exact class that can carry a path or file content. |
| 5 | health, catch | `unevaluableGate("health")` | Already fixed, T45. Unchanged. |
| 6 | security, catch | `unevaluableGate("security")` | Already fixed, T45. Unchanged. |
| — | `buildIssueComment` | `` `${gate.name}: ${gate.status}` `` per gate | No — never includes `gate.detail`. |
| — | failed-gates transition reason (`complete()`, ~line 688) | `` failed.map((gate) => `${gate.name}: ${gate.detail}`).join(" \| ") `` | Inherits whatever `gate.detail` currently contains for any failed gate — a second, independent route by which the two leaks above reach durable `flow.json` history, beyond `buildIssueComment`. |

**Result: exactly two remaining leak sites**, both named in the dispatch —
gate 1's catch arm and gate 4's catch arm. No other detail-building call
site in `service.ts` interpolates unconstrained external text on the
completion path.

## Fix

Widened the existing `unevaluableGate` helper (added by T45 for gates 5/6)
rather than inventing a second constant-detail vocabulary:

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

- Gate 1's catch: `catch { gates.push(unevaluableGate("acceptance-criteria")); }`
- Gate 4's catch: `catch { gates.push(unevaluableGate("review")); }`

Both catch arms already had `status: "fail"` before this change — the
blocking behavior was correct and is untouched. Only the `detail` string's
shape changed, from raw/prefixed interpolation of the caught value to the
same leak-free constant gates 5/6 already use. No change to `GateOutcome`'s
type, to any non-catch branch of gates 1-4, to the pass/fail fold
(`gates.every((gate) => gate.status !== "fail")`), or to `FlowServiceDeps`.

## Diagnostic-value tradeoff, addressed as instructed

Gate 1's catch could previously surface one genuinely useful, already-safe
message: `assertAcIntact`'s checksum-mismatch error is a hardcoded constant
in `store.ts` naming the exact remedy (`flow ac update <id> --reason "..."`
or `flow ac reseal <id> --reason "..."`). Replacing it with the generic
constant is a real, if narrow, reduction in what an operator sees at the
`complete()` call site specifically.

I did not special-case that message (string-matching text owned by
`store.ts` from inside `service.ts` reintroduces exactly the
message-coupling fragility this task removes, and silently regresses again
the moment `store.ts`'s wording changes) and did not edit `store.ts` to add
a distinguishable error type (out of this task's file ownership:
"`src/flow/service.ts` and the focused test files under `src/flow/`.
Nothing else.").

Where the detail can safely live instead: it already does. `service.ts`'s
own `check()` method (~line 828) independently re-derives the identical
checksum mismatch as a `kind: "checksum"` issue, with the same safe,
constant, remedy-naming message, exercised by the existing test "freeze
locks AC; tampering blocks transitions and is caught by check"
(`service.test.ts`, unmodified, still passing). An operator who sees gate
1's generic "could not be evaluated" detail during `complete()` has a
dedicated, still-detailed diagnostic one command away (`keryx flow check`);
nothing is dropped with no path to recover it, only moved to a place that
was already the more precise tool for this specific cause.

**Proposed follow-up** (not done here, named per the task's own "propose
rather than ship the broad option" instruction): give `assertAcIntact`'s
checksum-mismatch throw a dedicated, narrow error type
(e.g. `AcChecksumMismatchError`) in `store.ts`, so a `service.ts` catch
arm could `instanceof`-check it and safely reuse its own hardcoded (and
therefore leak-free by construction) message, falling back to
`unevaluableGate` for every other, genuinely unexpected throw. That is a
`store.ts` change and is outside this task's ownership.

Gate 4 has no equivalent tradeoff: `reviewGate` never deliberately throws,
so its catch arm was already reserved for the unstructured/unexpected case
exactly like gates 5/6 pre-T45 — there is no safe constant message being
displaced.

## Out of scope, flagged (not fixed here)

Two observations from reading `review-gate.ts` while confirming gate 4's
catch arm never deliberately throws, both outside `service.ts` and therefore
outside this task's ownership:

1. `readReviewGateConfig` (`review-gate.ts` ~line 111) reads
   `.metaproject/tasks.config.json`; a `JSON.parse`/`readFile` failure is
   caught and folded into a `notes` entry that interpolates
   `error.message` verbatim, and the function's own doc comment states "the
   note is rendered into the gate detail" — a `readFile` failure (not just a
   JSON syntax error) at that specific call site would carry a path into a
   `review`-gate detail through a route this task's fix does not touch (it
   flows through the *pass/fail* branch of gate 4's `verdict.detail`, not the
   `catch` arm this task fixed).
2. `parseReviewRounds`-adjacent code (`review-gate.ts` ~line 389) calls
   `readFile(scopePath, "utf8")` unguarded by a `try` (only a preceding
   `pathExists` check, which is a TOCTOU gap, not a guarantee) — a failure
   there is a candidate for the same "unexpected throw reaches gate 4's
   catch" class this task's fix already makes safe at the `service.ts`
   boundary, so it is not a live regression of this task's acceptance
   criteria, but it is closer to the source than where this task can reach.

Both are candidates for a follow-up inside `review-gate.ts` (leak-safety
audit of its own detail/notes construction), not fixed here: neither file is
in this task's ownership (`src/flow/service.ts` and focused test files under
`src/flow/`), and reaching them from `service.ts` alone is exactly the
fragile message-coupling this task avoided doing for gate 1 above.

## Regression tests (RED before, GREEN after)

Two new tests in `src/flow/service.test.ts`.

**Gate 1.** No injectable dependency exists for `readAcCriteria`/
`assertAcIntact` — direct `./store` imports used by several other service
methods, including `complete()`'s own top-of-function `assertAcIntact` check
(via the shared `transition()` helper, `service.ts:140`) that runs *before*
the gates loop even starts. First attempt deleted the on-disk
`acceptance-criteria.md` file before calling `complete()`; RED run showed
this trips the earlier, unguarded `assertAcIntact` call and crashes the test
with an uncaught `ENOENT` (`transition` at `service.ts:140` called from
`service.ts:551`), never reaching Gate 1's own catch. Corrected approach:
`mock.module("./store", () => ({ ...real, readAcCriteria: async () => { throw ... } }))`,
applied only after every setup step (freeze, start, taskDone, implemented,
acConfirm — each of which calls the real `readAcCriteria`/`assertAcIntact`
and must keep succeeding) has already run for real, and only
`readAcCriteria` is overridden — `assertAcIntact` stays real, so both the
preflight call and Gate 1's own `assertAcIntact` call keep succeeding, and
only Gate 1's `readAcCriteria` call (the second statement in its `try`)
throws. Restored in `finally`, same discipline as
`src/security/guard.test.ts`'s `breakConfigLoad`/`restoreConfigLoad`
(`realConfigExports` snapshot, `mock.module` break, `mock.module` restore).

**Gate 4.** `reviewGate` has exactly one call site in `service.ts` (Gate 4's
`try`) and no other service method calls it, so mocking `./review-gate` for
the span of one test is precise and does not disturb any setup step. Same
snapshot/break/restore pattern, overriding only `reviewGate`.

Both plant `/Users/attacker/.ssh/id_rsa` and `"ENOENT"` in the thrown
message and assert: `status === "fail"`, `detail` excludes both the path and
`"ENOENT"`, `result.passed === false`, `result.flow.status ===
"in-progress"`.

**RED** (`bun test src/flow/service.test.ts -t "echoes the thrown text"`,
run directly per T45's precedent — test execution, not a code search, so
outside the `ctx rg`-only routing rule):

- Gate 1 (first attempt, fs-deletion approach): uncaught `ENOENT`, test
  errored rather than failed an assertion — diagnostic that the corruption
  point was wrong (see above), corrected before re-running.
- Gate 1 (corrected, mock-based) / Gate 4: both failed on
  `expect(detail).not.toContain(secretPath)` — actual detail was
  `"ENOENT: no such file or directory, open '/Users/attacker/.ssh/id_rsa'"`
  (gate 1, unprefixed) and
  `"review gate could not be evaluated: ENOENT: no such file or directory, open '/Users/attacker/.ssh/id_rsa'"`
  (gate 4) — confirming both leaked pre-fix, with `status` already correctly
  `"fail"` in both (the blocking half T45 already closed).

**GREEN** (same command, post-fix): 3 pass / 0 fail / 15 expect() (1 filter
match from the health test T45 added, 2 new).

## Verification

| Check | Command | Result | Raw log |
|---|---|---|---|
| Full `service.test.ts` | `bun test src/flow/service.test.ts` (direct, quick check before the recorded run) | 10 pass / 0 fail / 59 expect() | not routed (quick local check) |
| Full flow-focused suite | `bun src/cli.ts ctx run -- bun test src/flow/` | 185 pass / 0 fail / 616 expect() across 20 files | `.metaproject/data/gdctx/raw/2026-09-06T15-14-02-534Z_run.log` |
| Sibling gate suites (security, review, review e2e, tasks) | `bun src/cli.ts ctx run -- bun test src/flow/security-gate.test.ts src/flow/review-gate.test.ts src/flow/review-gate.e2e.test.ts src/flow/task-gate.test.ts` | 86 pass / 0 fail / 320 expect() | `.metaproject/data/gdctx/raw/2026-09-06T15-14-17-114Z_run.log` |
| ESLint on every file changed | `bun src/cli.ts ctx run -- bunx eslint src/flow/service.ts src/flow/service.test.ts` | clean, no output | `.metaproject/data/gdctx/raw/2026-09-06T15-14-21-423Z_run.log` |
| Typecheck | `bun src/cli.ts ctx run -- bun run typecheck` | exit 0, no errors at all (the concurrent `src/security/*` in-flight work T45 reported as unrelated failures is no longer failing at this point in time; zero errors reference `src/flow/*` either way) | `.metaproject/data/gdctx/raw/2026-09-06T15-14-33-603Z_run.log` |

185 = T45's 183 baseline + 2 new tests. All flow-focused suites are fully
green; nothing from the concurrent `src/security/*` work was touched or
needed to be worked around this time.

## Files changed

- `src/flow/service.ts` — gate 1 (`acceptance-criteria`) and gate 4
  (`review`) catch arms now call the shared `unevaluableGate(name)` helper
  instead of interpolating the caught error's message; the helper's name
  parameter widened from `"health" | "security"` to `"acceptance-criteria" |
  "review" | "health" | "security"`; helper's doc comment updated to note
  all four gates now share it. No other line in `complete()`, no type, no
  dependency signature changed.
- `src/flow/service.test.ts` — added two regression tests (`mock` added to
  the `bun:test` import; `realReviewGateExports`/`realStoreExports`
  snapshots added at file scope for the two tests' break/restore).

## Routing audit

graph_used: no (not-relevant — the dispatch named the exact file, the exact
function, and the exact two remaining catch arms; the enumeration needed a
careful read of `complete()` and its helpers, not a structural/dependency
question the graph answers). wiki_used: no (not-relevant — the normative
source is `policies.md`, supplied directly in the dispatch and read in
full, same as T45). ctx_used: yes — every project-code search via
`bun src/cli.ts ctx rg`, every verification command via
`bun src/cli.ts ctx run` (raw logs tabled above), every bounded file
excerpt via `bun src/cli.ts ctx run -- sed -n ...`. raw_rg_used: no.
