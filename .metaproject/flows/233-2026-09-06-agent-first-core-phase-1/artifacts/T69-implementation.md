STATUS: DONE

# T69 — implementation: close F-005 (raw caught text into health gate reasons)

## Site enumeration (method and result)

Two independent `bun src/cli.ts ctx rg` sweeps over the whole `src/health/`
tree (not only `run.ts`), done before writing any code, to check whether
F-005's own "pre-existing, track separately" framing under-counted the
surface:

1. `bun src/cli.ts ctx rg "error.message|String\(error\)|error instanceof Error|\.message\b" src/health/run.ts src/health/gate.ts src/health/service.ts src/health/config.ts src/health/sources`
   — 8 matches. Three are the named sites in `run.ts` (`:240`, `:275`,
   `:297`, pre-fix line numbers). The other five are `Finding.message`
   assignments in `sources/helpers.ts`, `sources/eslint.ts`,
   `sources/sonarqube.ts`, `sources/tests.ts` — a lint/test/Sonar tool's own
   reported finding text, a structurally different field
   (`Finding.message`, not `SourceRunInfo.error`/`GateResult.reasons`) that
   never flows through `computeGate`'s reason-building and sits outside
   F-005's own named flow (`SourceRunInfo.error → computeGate →
   HealthReport.gate.reasons`). Not touched.

2. `bun src/cli.ts ctx rg "catch" src/health` — 22 matches across 14 files.
   `src/health/run.ts` is the only file in the module that binds the caught
   value (`catch (error)`, 4 occurrences: `:234`, `:258`, `:269`, `:286`
   pre-fix). Every other catch in `src/health/` (13 sites across
   `metrics/wiki-freshness.ts`, `sources/eslint.ts`, `service.ts`,
   `sources/sonarqube.ts`, `sources/dependency-audit.ts`, `util.ts`,
   `history.ts`, `metrics/coverage.ts`, `skills.ts`) uses the bare
   `catch { ... }` form with no binding — by construction none of these can
   interpolate the caught value into anything. Of `run.ts`'s four bound
   catches, one (`:258`, inside the `import`/`run` auto-mode fallback) only
   does `error instanceof NoImportError` for control flow (re-throw or fall
   through to `adapter.run`) and builds no string.

**Result: exactly three sites**, matching F-005's own citation exactly
(`run.ts:240`, `:275`, `:297` pre-fix — now `:279`, `:314`, `:336` after the
new helper/comment were added above them). No fourth site exists anywhere in
`src/health/`. `gate.ts:78-79`, the sole consumer that folds `source.error`
into `gate.reasons`, was read in full and is unmodified (out of ownership) —
closing the three producer sites is sufficient because the consumer applies
no filtering of its own that a leak could bypass or that a fix could break.

## Fix

One shared helper, `safeErrorCode(error)`, added directly above `runAdapter`
in `src/health/run.ts` — the same pattern T49 established for the analogous
leak in `src/flow/review-gate.ts` (`safeFsErrorCode`), duplicated rather
than imported (that module is a different ownership boundary, and
re-exporting one four-line helper across it is a worse coupling than the
duplication):

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

function errorCodeSuffix(error: unknown): string {
  const code = safeErrorCode(error);
  return code ? ` (${code})` : "";
}
```

Applied at all three sites, replacing the `error.message`/`String(error)`
interpolation with a constant category name naming which stage failed, plus
the optional closed-vocabulary errno code:

| Site | Before | After |
|---|---|---|
| `adapter.detect(ctx)` catch | `` `source detection failed: ${error instanceof Error ? error.message : String(error)}` `` | `` `source detection failed${errorCodeSuffix(error)}` `` |
| `adapter.import`/`adapter.run` catch | `error instanceof Error ? error.message : String(error)` (no category prefix at all — the rawest of the three) | `` `source execution failed${errorCodeSuffix(error)}` `` |
| `adapter.parse(...)` catch | `` `source parse failed: ${error instanceof Error ? error.message : String(error)}` `` | `` `source parse failed${errorCodeSuffix(error)}` `` |

No change to `SourceRunInfo`'s type (`error?: string`, `types.ts:165`, not
edited), no change to `status`/`execution`/`parse`/`exitCode` on any of the
three return objects, no change to `gate.ts`, `service.ts`, or `config.ts`.

## What must not move — confirmed, not assumed

`computeGate`'s `brokenRequired` filter (`gate.ts:68-75`) branches only on
`s.required`, `s.status`, `s.execution`, `s.parse` — never on `s.error`'s
content; `s.error` is read only for display, appended verbatim as
`` `: ${source.error}` `` (`gate.ts:78`). Read in full before writing the
fix (not edited). Fixing only the string content therefore cannot move any
verdict — the gate's `status`/`coverage` fold for every existing scenario is
unaffected by construction, confirmed by the full `src/health/` +
`src/commands` suite staying green (below) and by the new regressions'
own `gate.status === "incomplete"` assertion, matching the status a required
unavailable source has always produced.

## Diagnostic-value tradeoff, addressed per site

- **Detection** (`adapter.detect`) and **execution** (`adapter.import`/
  `adapter.run`): both stages typically probe for a config file/binary or
  spawn a tool — the realistic failure classes are Node `fs`/spawn errno
  shapes (`ENOENT`, `EACCES`, ...), the same carrier T49 already established
  as safe. An operator still learns which of the three stages failed (from
  the constant category name) and, when the underlying error is a
  recognized OS errno, which kind of failure it was — without the path or
  any other free text. Nothing is silently dropped with no path to recover
  it: the category + errno pair is the honest ceiling of what can be said
  about an *unexpected* adapter throw without either widening the type of
  `error` this repo's adapters can throw (out of scope; would need a
  project-wide error-typing pass) or accepting the leak.
- **Parse** (`adapter.parse`): the realistic failure here is a `JSON.parse`
  `SyntaxError` or an adapter's own parsing bug, neither of which carries a
  `.code` — `errorCodeSuffix` correctly returns `""` for these, so the
  category name alone survives. This is not a regression in diagnostic
  value: the per-source adapters' *well-understood* parse failures
  (malformed JSON, unrecognized format) already have their own dedicated,
  safe messages via `adapter.validate()` (`"ESLint JSON parse failed"`,
  `"format was not recognized"`, etc., in `sources/eslint.ts` and
  siblings) — those are untouched by this fix, still built from a closed
  vocabulary, and still full detail. The `adapter.parse` catch this fix
  changes is reserved for a genuinely *unexpected* throw inside a parser
  (a bug, not a format mismatch), for which "parse failed" plus no further
  detail is the same honest ceiling as the other two sites.

No case in this task required proposing an unshipped follow-up (unlike
T47's `assertAcIntact` case) — every realistic failure class at all three
sites is already served by either the errno code or an existing, untouched,
already-safe message elsewhere in the same source's adapter.

## Test-runner hazard found and worked around (not a source-code finding)

The first regression design mocked the whole `./sources` module via
`mock.module("./sources", () => ({ ...real, FINDING_ADAPTERS: [adapter] }))`
to drive `runHealth()` end to end with a synthetic, throwing adapter — the
same `mock.module` technique T47/T49 used for `./store`/`./review-gate`/
`node:fs/promises`. Verified broken empirically: running
`bun test src/health/health-truthful-gate.test.ts src/health/provenance.test.ts`
(and the reverse file order) failed an *unrelated* test in
`provenance.test.ts` ("strict health runs an available compiler instead of
treating missing import format as missing source") — its `typescript`
source vanished from `report.sources` because the mocked, single-element
`FINDING_ADAPTERS` array leaked across the file boundary within the same
`bun test` process (Bun's `mock.module` replaces the shared module registry
process-wide, and `./sources` is imported by nearly everything that calls
`runHealth`, unlike `./store`/`./review-gate`, which only `src/flow/*`
touches). Reproduced with either file first, ruling out simple
load-order causation; not investigated further since a strictly safer
alternative existed.

**Fixed by not mocking a shared module at all.** `runAdapter` — the private
function containing all three F-005 catch sites — is now exported from
`run.ts` *only* for this module's own focused tests (doc comment on the
export names the reason and the incident). The three regressions call
`runAdapter` directly with a synthetic, throwing `SourceAdapter` and a
minimal real `HealthContext`, then fold the resulting `SourceRunInfo`
through the already-exported `computeGate` (the same function this file's
pre-existing `compute()` helper already wraps) — exercising exactly the two
hops F-005 names, with zero module-registry risk. Re-ran the same two-file
combination after the fix: `provenance.test.ts` + `health-truthful-gate.test.ts`
together is 14 pass / 0 fail (was 12 pass / 1 fail with the mocking
approach). This ordering/registry hazard is Bun test-runner behavior
encountered while writing regressions, not a source-code finding, and not
in scope to fix generally — flagged here for the record since it could bite
a future `mock.module("./sources", ...)` attempt in this module again.

A second, unrelated cross-file failure surfaced in the same initial full-suite
run: `src/commands/health-incomplete.test.ts`'s strict-run test. Isolated
(`bun test src/commands/health-incomplete.test.ts` alone: 3/3 pass) and
re-ran the full `bun test src/health/ src/commands` twice after removing the
`mock.module` approach: 0 fail both times. Not reproduced again after the
mocking was removed — most likely a knock-on effect of the same registry
instability, not a second independent issue; recorded rather than silently
assumed innocent.

## Regression tests (RED before, GREEN after)

Four new tests in `src/health/health-truthful-gate.test.ts` (this task's
existing focused test file for `run.ts`'s gate-affecting behavior): one per
catch site (detect / import-run / parse), each planting
`/Users/attacker/.ssh/id_rsa` and a fake credential (`AKIAIOSFODNN7EXAMPLE`,
the same synthetic AWS-shaped literal this repo's own tests already use, per
T62's own disclosure) inside a thrown `Error`, plus a fourth test asserting
the errno code (`ENOENT`) is deliberately *kept* — proving the fix removes
only the unsafe part, not all diagnostic value.

Each of the three leak regressions asserts, using the real `runAdapter` +
`computeGate`:
- `info.status === "configured-but-failed"` and the matching
  `execution`/`parse` field — unaffected by the fix, confirming the verdict
  fields don't move.
- `info.error` is defined, contains neither the planted path nor the fake
  credential, and does match the stage-naming category
  (`/detection failed/`, `/execution failed/`, `/parse failed/`).
- `gate.reasons.join("\n")` (the real `computeGate` fold, F-005's second
  named hop) contains neither the path nor the credential, does mention
  `eslint` (still naming which source failed), and `gate.status ===
  "incomplete"` (the fold does not move).

**RED** (`bun test src/health/health-truthful-gate.test.ts -t "F-005"`, run
directly, matching T45-T49's precedent that test execution is not a code
search and is outside the `ctx rg`-only routing rule; performed by
temporarily reverting the three `error:` lines in `run.ts` in place with
`sed` — not `git stash`, after a `git stash` on `run.ts` alone was tried
first and immediately reverted several other tasks' uncommitted work in the
same file back to its last-committed state; see Concerns): 3 failed / 1
passed. All three failed on the identical assertion,
`expect(info.error).not.toContain(ATTACKER_PATH)`, with the actual value
showing both the path and the credential verbatim, e.g. `"source detection
failed: detection: ENOENT: no such file or directory, open
'/Users/attacker/.ssh/id_rsa' token=AKIAIOSFODNN7EXAMPLE"` — confirming the
pre-fix leak directly, not inferred. The fourth test (errno preservation)
passed even pre-fix, as expected (`ENOENT` was already present in the raw
message).

**GREEN** (same command, post-fix, `run.ts` restored verbatim to the fixed
version): 4 pass / 0 fail / 32 expect().

## Verification

| Check | Command | Result | Raw log |
|---|---|---|---|
| F-005 regressions only | `bun test src/health/health-truthful-gate.test.ts -t "F-005"` (direct) | 4 pass / 0 fail / 32 expect() | not routed (quick local check, matches T45-T49 precedent) |
| Full focused test file | `bun test src/health/health-truthful-gate.test.ts` (direct) | 12 pass / 0 fail / 78 expect() (8 pre-existing + 3 leak F-005 + 1 errno-preservation) | not routed |
| Cross-file hazard re-check | `bun test src/health/provenance.test.ts src/health/health-truthful-gate.test.ts` (direct) | 14 pass / 0 fail / 84 expect() | not routed |
| Dispatch-required suite | `bun src/cli.ts ctx run -- bun test src/health/ src/commands` | 1099 pass / 6 skip / 0 fail / 4067 expect() across 97 files. Re-ran a second time to confirm stability after the mock-avoidance fix: identical (1099/6/0). | `.metaproject/data/gdctx/raw/2026-09-06T18-08-18-065Z_run.log` (second, confirming run; first pre-mock-fix run at `2026-09-06T18-00-09-650Z_run.log` showed the 2 unrelated cross-file failures discussed above) |
| Typecheck | `bun src/cli.ts ctx run -- bun run typecheck` | exit 0, `tsc --noEmit` clean | `.metaproject/data/gdctx/raw/2026-09-06T18-08-49-046Z_run.log` |
| ESLint on both changed files | `bun src/cli.ts ctx run -- bunx eslint src/health/run.ts src/health/health-truthful-gate.test.ts` | clean, no output | `.metaproject/data/gdctx/raw/2026-09-06T18-08-58-306Z_run.log` |

## Files changed

- `src/health/run.ts` — added `safeErrorCode` and `errorCodeSuffix` helpers
  (new, mirroring `src/flow/review-gate.ts`'s `safeFsErrorCode`, duplicated
  not imported). The three F-005 catch arms (`adapter.detect`,
  `adapter.import`/`adapter.run`, `adapter.parse`) now build `error` from a
  constant category name plus `errorCodeSuffix(error)` instead of
  interpolating `error.message`/`String(error)`. `runAdapter` changed from
  a private function to `export async function runAdapter` (test-only
  export, documented inline) so the new regressions can drive it directly
  without mocking `./sources`. No other line, type, exported signature, or
  gate-fold logic changed.
- `src/health/health-truthful-gate.test.ts` — added `HealthContext` and
  `SourceAdapter` to the type import, `runAdapter` to the `./run` import;
  added four regression tests plus their shared fixtures (`ATTACKER_PATH`,
  `FAKE_CREDENTIAL`, `leakyError`, `unreachable`, `healthContext`,
  `runThrowingSource`) at the end of the file.

## Concerns

An early verification step (`git stash push -- src/health/run.ts`, intended
only to check whether two initially-failing tests were pre-existing) reset
`run.ts` on disk to its last **committed** state — several other tasks'
uncommitted work in that same file (the `execution`/`parse`/`exitCode`
fields, the filtered-source helpers, and more) was briefly reverted along
with mine. Caught immediately from the tool's own "changed on disk since
you last read it" notice; `git stash pop` was run right away and restored
the full pre-stash working tree exactly (verified: `git stash pop` reported
every file that was modified before the stash, `errorCodeSuffix`/
`safeErrorCode` were confirmed still present in `run.ts` afterward, and the
full required suite passed identically both before and after). No commit,
push, or destructive flag was used at any point, and the repository was
left in the same state the stash briefly interrupted. Recorded per the
dispatch's own error-handling expectation rather than omitted — this is the
only git-adjacent operation in this task, it was reversed within the same
turn, and every subsequent revert (`sed`, for RED/GREEN) used a plain file
edit and its own backup, not git, specifically to avoid repeating this.
