# T69 — spec: close F-005 (raw caught text into health gate reasons)

## Finding being closed

`T62-review.md` F-005 (severity `info`): three sites in `src/health/run.ts`
build a source's `error` field as
`` `source detection failed: ${error instanceof Error ? error.message : String(error)}` ``
(and two siblings). `computeGate` (`src/health/gate.ts:78-79`, out of this
task's ownership, unmodified here) interpolates `source.error` into
`` `INCOMPLETE: required source unavailable: ${source.source}${detail}` ``,
which is persisted into `.metaproject/data/health/artifacts/latest.json` (a
committable artifact) and, through `healthGateOutcome`, into `flow.json`'s
`completion-failed` history (a durable, published record). A caught
`error.message` routinely embeds an absolute filesystem path (confirmed
empirically by T47/T49 for the analogous Node `fs` case in `src/flow/*`).

This is the third repair of the same leak shape this phase has closed:
T45/T47 (`src/flow/service.ts`, catch arms folded a throw to a leak-safe
constant `unevaluableGate(name)`), T49 (`src/flow/review-gate.ts`, a
closed-vocabulary Node errno code via `safeFsErrorCode`, surfaced without the
message). Both patterns apply here; which one fits depends on what
diagnostic value each site can honestly keep (see "Fix design" below).

## Enumeration (method and result) — confirming exactly three sites, no more

Two independent sweeps, both over the whole `src/health/` tree (not just
`run.ts`), because the dispatch requires checking whether F-005's own
"pre-existing, track separately" framing undercounted the surface:

1. `bun src/cli.ts ctx rg "error.message|String\(error\)|error instanceof Error|\.message\b" src/health/run.ts src/health/gate.ts src/health/service.ts src/health/config.ts src/health/sources`
   — 8 matches. Three are the named sites in `run.ts` (`:240`, `:275`,
   `:297`). The other five are `Finding.message` assignments in
   `sources/helpers.ts`, `sources/eslint.ts`, `sources/sonarqube.ts`,
   `sources/tests.ts` — a lint/test/Sonar tool's own reported finding text,
   a structurally different field (`Finding.message`, not
   `SourceRunInfo.error`/`GateResult.reasons`) that never flows through
   `computeGate`'s reason-building and is explicitly outside F-005's named
   flow (`SourceRunInfo.error → computeGate → HealthReport.gate.reasons`).
   Not touched, not in scope.

2. `bun src/cli.ts ctx rg "catch" src/health` — 22 matches across 14 files.
   `src/health/run.ts` is the ONLY file in the module that binds the caught
   value (`catch (error)`, 4 occurrences: `:234`, `:258`, `:269`, `:286`).
   Every other catch in `src/health/` (13 sites: `metrics/wiki-freshness.ts`
   ×3, `sources/eslint.ts` ×2, `service.ts` ×1, `sources/sonarqube.ts` ×1,
   `sources/dependency-audit.ts` ×1, `util.ts` ×1, `history.ts` ×1,
   `metrics/coverage.ts` ×1, `skills.ts` ×1) uses the bare `catch { ... }`
   form with no binding at all — by construction these cannot interpolate
   the caught value into anything, because nothing in the block can refer to
   it. Of `run.ts`'s four bound catches, one (`:258`, inside the
   `import`/`run` fallback) only does `error instanceof NoImportError` for
   control flow and re-throws or falls through to `adapter.run` — it builds
   no string and reaches no report field.

**Result: exactly three sites** (`run.ts:240`, `:275`, `:297`), matching
F-005's own citation exactly. No fourth site exists anywhere in
`src/health/`. `gate.ts:78-79`, the sole consumer that folds `source.error`
into `gate.reasons`, is unmodified — closing the three producer sites is
sufficient because the consumer performs no filtering of its own to defeat.

## Fix design

Ownership is `src/health/run.ts` and its focused tests only. `gate.ts`,
`service.ts`, `config.ts`, `types.ts` are not touched — `SourceRunInfo.error`
keeps its `string | undefined` type (`types.ts:165`, unedited); only what
`run.ts` writes into it changes.

**Diagnostic-value analysis per site**, per the dispatch's instruction to
name where a dropped detail can safely live rather than silently drop it:

- Site 1 (`adapter.detect(ctx)` throws, `:234`→`:240`): `detect()`
  implementations (`src/health/sources/*.ts`) typically probe for a config
  file or binary — a failure here is very likely to be a Node `fs`/spawn
  errno (`ENOENT`, `EACCES`, ...), the same shape T49 already established a
  safe carrier for.
- Site 2 (`adapter.import`/`adapter.run` throws, `:269`→`:275`, currently
  the ONE site with no category prefix at all — the rawest of the three):
  same reasoning — `import`/`run` spawn a tool or read its cached output;
  the realistic failure classes are the same `fs`/spawn errno shapes.
- Site 3 (`adapter.parse(...)` throws, `:286`→`:297`): parse failures are
  typically a `JSON.parse` `SyntaxError` (no `.code`) or a logic error in
  the adapter's own parser (no `.code` either) — an errno code will rarely
  apply here, and that is fine: the category constant ("source parse
  failed") already tells the operator which stage failed, and the
  per-source `dependencyAudit`/`eslint` adapters already carry their own
  format-specific safe messages for the well-understood parse failures
  (`"malformed JSON"`, `"format was not recognized"` — unaffected,
  untouched, still full detail because those are constructed from a closed
  vocabulary already, not from `error.message`).

**Chosen fix**: one shared helper, mirroring T49's `safeFsErrorCode`
(duplicated rather than imported — `src/flow/review-gate.ts` is a different,
off-limits module, and re-exporting a cross-module helper for one line is a
worse coupling than four lines of duplication):

```ts
function safeErrorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    return /^[A-Z][A-Z0-9]{2,15}$/.test(code) ? code : undefined;
  }
  return undefined;
}
```

Applied at all three sites, replacing the `error.message`/`String(error)`
interpolation with a constant category name plus an optional closed-set
code:

- `` `source detection failed${errorCodeSuffix(error)}` ``
- `` `source execution failed${errorCodeSuffix(error)}` `` (new category
  name — was unprefixed raw text before this fix)
- `` `source parse failed${errorCodeSuffix(error)}` ``

where `errorCodeSuffix(error)` is `` ` (${code})` `` when `safeErrorCode`
matches, else `""`. This keeps exactly the diagnostic value that is safe to
keep (which of three stages failed, plus a Node errno category when one
exists) and drops exactly what is not safe (the message, which is
unconstrained and routinely carries a path). No status, no `execution`/
`parse` field, no gate-fold logic changes — only the string content of
`error`.

## What must NOT move

`computeGate`'s `brokenRequired` filter (`gate.ts:68-75`) branches on
`s.status`, `s.execution`, `s.parse` — never on `s.error`'s content. Fixing
only the string means the gate's `status`/`coverage` verdict for every
existing scenario is unaffected by construction, not merely by testing.
Confirmed by reading `gate.ts` in full (already required reading for this
task; not edited).

## Regression-test plan

Three new tests in `src/health/health-truthful-gate.test.ts` (this task's
existing focused test file for `run.ts`'s gate-affecting behavior — it
already imports `runHealth` and drives it end to end through real fixtures,
per T45-T49's precedent of using the module's own established focused test
file rather than creating a new one).

Each plants `/Users/attacker/.ssh/id_rsa` and a fake credential
(`AKIAIOSFODNN7EXAMPLE`, the same synthetic AWS-shaped key literal this
repo's own tests already use per T62's own disclosure) inside a thrown
`Error`'s message, one per catch site, using `mock.module("./sources", ...)`
to substitute `FINDING_ADAPTERS` with a single synthetic adapter whose
`detect`/`import`/`parse` throws at the targeted site — the same
snapshot/override/restore discipline T47/T49 already established for
`mock.module` in this phase (capture the real module once, spread it, only
override `FINDING_ADAPTERS`, restore in `finally`).

Each asserts, at the real `runHealth()` entry point (not a unit call to a
helper):
- `report.sources.find(s => s.source === "eslint")?.error` contains neither
  the path nor the fake credential, and does name the stage
  (`"detection failed"` / `"execution failed"` / `"parse failed"`).
- `report.gate.reasons.join("\n")` contains neither the path nor the fake
  credential either (the second hop F-005 names — the artifact write and,
  through the same `report.gate`, the flow-record path).
- `report.gate.status` is `"incomplete"` (required source unavailable) —
  the fold does not move.

## Verification plan

- RED: run the three new tests against pre-fix `run.ts`, confirm they fail
  on the `not.toContain` assertions (the leak), not on `status`/setup.
- GREEN: same command, post-fix.
- `bun src/cli.ts ctx run -- bun test src/health/ src/commands` — must stay
  green (dispatch's stated bar).
- `bun run typecheck`, `bunx eslint` on every changed file.
- Raw logs under `.metaproject/data/gdctx/raw/`.
