# T50 spec — close `src/health/service.ts`'s `gate()` exit-code denylist (T48's flagged concern)

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned
files: `src/health/service.ts` and a new focused test under `src/health/`
(`src/health/service-gate-exit.test.ts`). Read-only, for the sibling style:
`src/health/types.ts`, `src/health/gate.ts`, `src/commands/health.ts`.
Out of scope, not touched: `src/commands/health.ts`, anything under
`src/security/` or `src/flow/`.

## Verifying the reported defect myself

`createCodeHealthService().gate()` (`src/health/service.ts:132-149`):

```ts
async gate(input: HealthGateInput): Promise<HealthGateResult> {
  const latest = await readLatest(input.cwd);
  if (!latest) {
    return { status: "fail", exitCode: 1, reasons: [...] };
  }
  const status = latest.gate.status;
  const exitCode =
    status === "fail" ||
    status === "incomplete" ||
    (status === "warn" && input.strictWarn)
      ? 1
      : 0;
  return { status, exitCode, reasons: latest.gate.reasons };
},
```

**What values can reach `status` here, and how.** `status` is
`latest.gate.status`, and `latest` comes from `readLatest()`
(`service.ts:29-51`):

```ts
const latest = JSON.parse(await readFile(file, "utf8")) as HealthReport & { record?: string };
```

This is an **unchecked type assertion** over a file on disk
(`.metaproject/data/health/artifacts/latest.json`, or the pointed-to
`record` file). `GateStatus` (`src/health/types.ts:132`) is
`"pass" | "warn" | "incomplete" | "fail"` at the type level, but nothing
validates the parsed JSON against that union at runtime. The file is
written by `runHealth`/`computeGate` today, but it is also exactly the
"corrupted payload" AC4/AFC-05 names: it can be a stale artifact from an
older or newer `keryx` schema version, hand-edited, or corrupted, and
`gate()` reads whatever string sits at `.gate.status` without validation.

Confirmed this is reachable in the existing test suite's own style, not
just hypothetically: `src/commands/health-incomplete.test.ts` already
writes synthetic `latest.json` fixtures by hand (`writeLatest`/
`incompleteReport`) and calls `createCodeHealthService().gate({ cwd })`
against them — the exact same seam. A fixture with `gate.status: "banana"`
(or any value outside the four-member union) reaches this method's
`status` variable unchanged and unvalidated.

**What happens today for each reachable value:**

| `status` | `strictWarn` | today's `exitCode` |
|---|---|---|
| `"pass"` | false / true | `0` / `0` |
| `"warn"` | false | `0` |
| `"warn"` | true | `1` |
| `"incomplete"` | false / true | `1` / `1` |
| `"fail"` | false / true | `1` / `1` |
| anything else (e.g. `"banana"`, a corrupted/older/newer-schema value) | false | **`0`** |
| anything else | true | **`0`** |

The last two rows are the defect: the fold is a denylist
(`fail`/`incomplete`/`warn-when-strict`) with an implicit `else -> 0`, so a
value nobody enumerated is treated as a pass's exit code — a false clean
bill of health at the exact place `keryx health gate` and every caller of
`CodeHealthService.gate()` (`src/mcp/tools.ts:641`, `src/commands/flow.ts:118`,
`src/harness/tool/metaproject-adapter.ts:112`, `src/commands/health.ts`'s
`runGate`) reads to decide whether quality was verified. This is real, not
merely type-theoretic, for the same reason the sibling fix in
`src/commands/health.ts`'s `runExitCode` was real: the value crosses a
JSON-parse boundary where the type checker's guarantee does not reach.

**Conclusion: the report is correct.** This is the sixth instance of the
same defect shape. Fixing it.

## What "the existing vocabulary" is (unchanged from T48, re-confirmed by
re-reading `src/health/gate.ts` directly rather than trusting the prior
report)

`GateStatus` = `"pass" | "warn" | "incomplete" | "fail"`, produced
exclusively by `computeGate` (`src/health/gate.ts`) when a report is
freshly generated:

- `fail` — an established threshold violation (`failPriorities` findings,
  or a regression at/above `failOnRegressionDrop`). Blocks always.
- `incomplete` — a required source that is unavailable, failed to execute,
  or failed/never attempted to parse (`brokenRequired`, `gate.ts:50-63`).
  Blocks always, independent of `strictWarn` — `gate()`'s existing
  `status === "incomplete"` arm already gets this right
  (`health-incomplete.test.ts`'s first test), and this task must not
  weaken it.
- `warn` — a regression between the warn/fail thresholds, coverage below
  the soft floor, or an optional source that is configured but failed.
  Blocks only when `strictWarn` is set — pre-existing behavior
  (`health-incomplete.test.ts`'s third test: `strictWarn` absent -> exit 0,
  `strictWarn: true` -> exit 1). Preserved exactly: policies.md's "strict
  CI accepts only PASS" is what makes `warn` conditional on strict in the
  first place, not a license to also let it (or anything else) leak
  through non-strict.
- `pass` — none of the above triggered. Never blocks.

A skipped **optional** source never becomes a `GateStatus` value of its own
— `computeGate`'s `skippedOptional` branch (`gate.ts:64-67`) only appends
an `OPTIONAL: ... skipped` reason string while `status` can stay `pass`.
`gate()` passes `latest.gate.reasons` through unchanged, so "an optional
skip warns and is never signed as passed" is unaffected by this task: the
warning text survives regardless of `exitCode`, and this fix touches only
the `exitCode` fold, not `status` or `reasons`.

`GateStatus` is a closed, unrelated union to `SecurityGate`. This task
does not import from `../security/*` — a new local predicate is written
over `GateStatus` on its own terms, the same as `runExitCode`
(`src/commands/health.ts`, read-only reference), `isPassGate`
(`src/commands/security.ts`), `runGate` (`src/security/service.ts`) and
`securityFlowGate` (`src/security/guard.ts`) are four independent
exhaustive folds, not a shared cross-module vocabulary.

## Fix shape

Add a local, exported-for-testing helper in `src/health/service.ts`:

```ts
export function gateExitCode(status: GateStatus, strictWarn: boolean): number {
  switch (status) {
    case "pass":
      return 0;
    case "warn":
      return strictWarn ? 1 : 0;
    case "fail":
    case "incomplete":
      return 1;
    default:
      return 1;
  }
}
```

and call it from `gate()`:

```ts
const status = latest.gate.status;
const exitCode = gateExitCode(status, Boolean(input.strictWarn));
return { status, exitCode, reasons: latest.gate.reasons };
```

`status` itself (the field returned to the caller, distinct from the
`exitCode` fold) stays a pass-through of `latest.gate.status` — unchanged,
since the ask is to fix the fold, not to sanitize or relabel whatever
string a corrupted artifact carries. `HealthGateResult.status` is typed
`GateStatus`, so this is the same pre-existing type-level trust the return
statement already had.

`GateStatus` needs adding to `service.ts`'s existing type-only import from
`./types` (currently missing it; every other consumer type is already
imported there).

Behavior for all four recognized values is byte-identical to today's
denylist (truth table above, mirrored exactly). The only change is the
previously-open fallthrough: an unrecognized value now returns `1` in both
`strictWarn: true` and `strictWarn: false` calls — not gated on
`strictWarn`, matching `fail`/`incomplete`'s existing strict-independent
blocking, and matching the acceptance criterion "the default arm blocks"
(stated without a strict-only qualifier).

## Regression tests (RED before, GREEN after)

New file `src/health/service-gate-exit.test.ts`, calling
`createCodeHealthService().gate()` directly against hand-written
`latest.json` fixtures (mirroring `src/commands/health-incomplete.test.ts`'s
`writeLatest` pattern, but under `src/health/` per ownership and not
importing anything from `src/commands/`):

1. `pass` control, `strictWarn` absent: `status` stays `"pass"`,
   `exitCode` is `0`.
2. `fail`, at both `strictWarn` settings: `exitCode` is `1` both times.
3. `incomplete`, at both `strictWarn` settings: `exitCode` is `1` both
   times (pins the existing `health-incomplete.test.ts` behavior stays
   intact, from the same-shaped fixture but exercised in this file too).
4. `warn`: `strictWarn` absent -> `exitCode` `0` and `status` stays
   `"warn"` (never `"pass"`, so "never signed as passed" is checked on the
   `status` field, not inferred from the exit code alone); `strictWarn:
   true` -> `exitCode` `1`.
5. An unrecognized/corrupted `status` string (`"banana"`, written directly
   into the fixture JSON, reaching `gate()` through the real
   `readLatest()` parse path — no `as unknown as GateStatus` cast needed,
   unlike the command-layer sibling test, because this seam is a JSON file
   on disk rather than an in-process value): `exitCode` is `1` at both
   `strictWarn: false` and `strictWarn: true`. This is the case that must
   invert (`0` before the fix, `1` after) — the regression this task
   exists to close.

Run the file once before the code change to confirm RED (case 5 fails,
all others already pass), then once after to confirm GREEN, both logged
under `.metaproject/data/gdctx/raw/`.

## No existing test encodes the bug

`src/commands/health-incomplete.test.ts` (read in full) exercises `gate()`
only through the three already-correct recognized-value paths
(`incomplete` unconditionally, `warn` at both `strictWarn` settings) — no
assertion describes the fallthrough as intentional, so nothing needs
correcting, only extending (in a new file, since that test file is outside
this task's ownership).

## Verification plan

- `bun test src/health/service-gate-exit.test.ts` before and after (RED
  then GREEN), raw logs under `.metaproject/data/gdctx/raw/`.
- `bun src/cli.ts ctx run -- bun test src/health/` — full module suite,
  confirms no currently-passing invocation regresses.
- `bun run typecheck`, filtered to lines referencing files this task
  touched.
- `bunx eslint src/health/service.ts src/health/service-gate-exit.test.ts`.

## Concerns to record going in

None yet — the five other reported/fixed sites and this one share the
exact same shape; if `bun test src/commands/` (out of ownership, not run
here, but its existing tests are read-only referenced above) turns out to
depend on the exact numeric value `0` for an unrecognized status, that
would be a sixth-instance-specific surprise worth flagging, but nothing
found in `health-incomplete.test.ts` suggests that dependency exists.
