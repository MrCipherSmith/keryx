# T48 spec — close the health command's exit-code denylist (T38-F-001)

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned
files: `src/commands/health.ts` and its focused tests
(`src/commands/health-incomplete.test.ts`, `src/commands/health-status.test.ts`,
a new `src/commands/health-gate-exit.test.ts`). Read-only: `src/health/*`
(`gate.ts`, `types.ts`, `service.ts`), `src/commands/security.ts`.

## The defect (T38-F-001, reported by the T38 worker rather than fixed —
different file, different vocabulary, out of that task's ownership)

`src/commands/health.ts:90-94` turns a health `GateStatus` into a process
exit code with the identical denylist shape T35 F-002 reported for
`src/commands/security.ts`'s `exitCodeFor`/`reportExitCode` (fixed in T38):

```ts
function runExitCode(status: string, strict: boolean): number {
  return status === "fail" || status === "incomplete" || (strict && status === "warn")
    ? 1
    : 0;
}
```

`status` is typed as bare `string`, not `GateStatus` — so nothing at the
call sites forces this function to be taught about a new gate value. Every
named case here happens to be correct today (confirmed below), but a status
this fold has not been told about — a future `GateStatus` member, or a
runtime value the type checker would never let a caller construct directly —
falls through to `0`, a false clean bill of health at the one place a
machine reads to decide whether quality was verified
(policies.md: "Strict CI принимает только PASS").

Two call sites feed it, both in `runRun` (`src/commands/health.ts:69,87`):
the `--json` branch and the human-readable branch of `keryx health run`.
`keryx health gate` is a **separate**, already-exhaustive fold
(`src/health/service.ts:132-149`, `HealthGateResult.exitCode` — out of this
task's ownership, `src/health/*` is read-only) and is not touched.

## What "the existing vocabulary" is

`GateStatus` (`src/health/types.ts:132`) is `"pass" | "warn" | "incomplete" |
"fail"` — four values, produced exclusively by `computeGate`
(`src/health/gate.ts`):

- `fail` — an established threshold violation (`failPriorities` findings, or
  a regression at/above `failOnRegressionDrop`). Blocks always.
- `incomplete` — a **required** source that is unavailable, failed to
  execute, or failed/never attempted to parse (`brokenRequired`,
  `gate.ts:50-63`). This is the "missing/skipped/unparsed/unfinished"
  outcome policies.md names explicitly and says must never be signed as
  passed. Blocks always, independent of `--strict` — the existing code
  already gets this right (`health-incomplete.test.ts`'s first two tests
  pin `incomplete` blocking even without `--strict`/`--strict-warn`), and
  this task must not weaken it.
- `warn` — a regression between `warnOnRegressionDrop` and
  `failOnRegressionDrop`, coverage below the soft floor, or an **optional**
  source that is configured but failed (`brokenOptional`, `gate.ts:69-77`).
  Blocks only under `--strict` — pre-existing behavior
  (`health-incomplete.test.ts`'s third test: `strictWarn: false` → exit 0,
  `strictWarn: true` → exit 1, exercised through `service.gate()`, the
  sibling fold this task does not own).
- `pass` — none of the above triggered. Never blocks.

A **skipped optional** source (`skippedOptional`, `gate.ts:64-67`) is
distinct from all four `GateStatus` values: it never escalates `status` at
all — it only appends an `OPTIONAL: ... skipped` reason string while
`status` can still be `pass`. So "an optional skip warns and is never
signed as passed" (policies.md) is already satisfied structurally: the
warning text is always present in `reasons`, and it never turns a `pass`
into anything that looks like a certified verification of the skipped
check. This task keeps that behavior — an optional skip is not turned into
a `GateStatus` of its own and is not made to block.

`GateStatus` is a closed, unrelated union to `SecurityGate`
(`"pass" | "fail" | "needs-approval" | "incomplete"`, `src/security/types.ts`).
This task does not import `SecurityGate`, `isPassGate`, `exitCodeFor` or
`reportExitCode` from `./security` — a new predicate is written over
`GateStatus` on its own terms, the way `runGate`
(`src/security/service.ts:301-330`) and `securityFlowGate`
(`src/security/guard.ts:360-419`) are two independent exhaustive switches
over the same `SecurityGate`, not a shared cross-module vocabulary.

## Fix shape

Exhaustive `switch` over `GateStatus`, default arm on the blocking side,
exported for direct regression testing of that default arm (a live
`HealthReport.gate.status` is always produced fresh by `computeGate`, which
only ever returns one of the four recognized values by the time `runRun`
sees one — so, exactly as `security-gate-exit.test.ts` had to do for
`SecurityGate`, the only way to exercise the default arm is a direct call
with a `"banana" as unknown as GateStatus` cast):

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
      // Exhaustive over `GateStatus`; a status this fold has not been taught
      // (a future member, or a runtime value the type checker would never
      // let a caller construct directly) must never inherit `pass` from a
      // fallthrough. Mirrors `isPassGate` (`src/commands/security.ts`),
      // `runGate` (`src/security/service.ts`) and `securityFlowGate`
      // (`src/security/guard.ts`) in shape only — health keeps its own
      // `GateStatus` vocabulary, not `SecurityGate`.
      return 1;
  }
}
```

Behavior for every value TypeScript's union already lets a caller construct
is byte-identical to today's denylist (confirmed by truth table below) —
this is a shape fix, not a behavior fix, for the four recognized values.
The only behavior change is the previously-unreachable-by-type fallthrough:
an unrecognized value now returns `1` in both `--strict` and non-strict
runs (not gated on `strict`, matching `fail`/`incomplete`'s own
strict-independent blocking, and the acceptance criterion "the default arm
blocks" is stated without a strict qualifier).

Truth table (old denylist vs. new switch), all four recognized values:

| `status` | `strict` | old | new | changed? |
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

Type change: `status: string` → `status: GateStatus`, importing `GateStatus`
from `../health/types` alongside the existing `ScopeSelector` import. Both
call sites (`runRun`'s `--json` and human-readable branches) already pass
`result.report.gate.status`, which is typed `GateStatus` — no call-site
change needed beyond the function now being exported.

## Regression tests (RED before, GREEN after)

New file `src/commands/health-gate-exit.test.ts`, mirroring
`src/commands/security-gate-exit.test.ts`'s structure for the equivalent
security fix:

1. Direct unit tests of `runExitCode` over all four recognized `GateStatus`
   values, at both `strict: true` and `strict: false` — the full truth
   table above, so a later edit cannot silently regress any of the eight
   already-correct cells while fixing the ninth/tenth.
2. An unrecognized-value test (`"banana" as unknown as GateStatus`) at both
   `strict: true` and `strict: false` — the only way to reach the default
   arm, since `computeGate` never produces anything else.

No existing test asserts the pre-fix fallthrough as intentional, so unlike
T38 (which had to correct two `security.check-input.test.ts` assertions
that encoded F-002's bug), no existing test needs correcting here.
`health-incomplete.test.ts` and `health-status.test.ts` are read for
confirmation that they exercise `runExitCode` only through already-correct
paths (`incomplete`/`pass`) and are left unmodified.

## Search for other command-layer folds over `GateStatus`

`bun src/cli.ts ctx rg -n "GateStatus|gate.status" src/commands` to confirm
`runExitCode`'s two call sites in `runRun` are the only place
`src/commands/health.ts` folds a `GateStatus` into an exit code; `runGate`
in this same file (`src/commands/health.ts:123-133`) delegates entirely to
`service.gate()`'s already-exhaustive `exitCode` (`src/health/service.ts`,
read-only) and does no folding of its own.

## Concerns to record

`src/health/service.ts`'s `gate()` method (`:132-149`, read-only —
`src/health/*` is out of this task's ownership) has the **same denylist
shape** as the pre-fix `runExitCode`:

```ts
const exitCode =
  status === "fail" ||
  status === "incomplete" ||
  (status === "warn" && input.strictWarn)
    ? 1
    : 0;
```

Not fixed here (different file, different owner per the dispatch). Flagged
as a candidate for its own task, the same way T38 flagged this one.
