# T64 — implementation: legibility for the health gate's forced-strict verdict

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Files
changed: `src/health/types.ts`, `src/health/config.ts`, `src/health/gate.ts`,
`src/health/config.test.ts`, `src/health/gate.test.ts` — nothing else.
`src/health/service.ts` was read-only (and, independently, was already
modified by a concurrent worker in this working tree before this task
started — confirmed unrelated: `git status` shows it `M` and `git diff
--stat -- src/health/` shows ~138 lines changed there and in five other
`src/health/**` files this task never opened for write —
`dependency-audit.ts`, `run.ts`, `report.ts`, `sources/eslint.ts`,
`metrics/complexity.ts`, `skills.ts` — consistent with the dispatch's own
notice that other workers are concurrently editing `src/health/service.ts`
and that the repo already carried substantial uncommitted state before this
task began (per the session's `gitStatus` snapshot). Nothing in that set was
touched by this task, and none of it is required by this task's own diff or
verification). `src/security/config.ts` and `src/security/guard.ts` were
read-only references. Spec written before coding: `T64-spec.md` (same
directory).

All raw logs are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## 1. What was missing

`T59-implementation.md` (previous repair) made `loadHealthConfig`'s
"present, unusable" branch force `gate` and every `sources[*].required` to
the strictest values `HealthConfig` can express, so a corrupted/unusable
`.metaproject/health.config.json` can never silently revert an operator's
tightened thresholds back to the loose defaults. That task explicitly
disclosed it could not close one half of the parity it drew against
`src/security/config.ts`: security sets a `configUnreadable` flag that
`guard.ts` turns into a discrete, constant reason string
(`POSTURE_UNAVAILABLE_REASON`); health had "no such carrier field" because
adding one required editing `src/health/types.ts` and `src/health/gate.ts`,
both outside T59's ownership. The result: an operator who saw an
`incomplete`/`fail` gate on an otherwise clean project had no way to tell
"my config is unusable" from "there is a real broken required source"
without reading `config.ts`'s source.

This task owns `types.ts`, `config.ts`, and `gate.ts`, so that gap is now
closable.

## 2. Shape decision: a flag on `HealthConfig`, turned into a constant reason by `computeGate`

**Chosen and implemented, mirroring `security/config.ts` exactly in name,
shape, and the condition that sets it:**

- `src/health/types.ts` — `HealthConfig` gains one additive, optional field:

  ```ts
  /**
   * Set only by `loadHealthConfig` (`config.ts`) when `health.config.json`
   * EXISTS but could not be read as a mergeable object (T59: `null`, a
   * non-object payload, or unparseable JSON) -- never for an absent file.
   * Mirrors `SecurityConfig.configUnreadable` (`src/security/types.ts`, T35/T54)
   * in name, shape, and the condition that sets it. `gate`/`sources[*].required`
   * are already forced to their strictest values in that branch (T59); this
   * flag lets `computeGate` (`gate.ts`) surface a discrete, constant,
   * leak-safe reason for why, rather than leaving that only readable from this
   * loader's source (T64).
   */
  configUnreadable?: boolean;
  ```

- `src/health/config.ts` — the existing "present, unusable" branch (T59)
  now also returns `configUnreadable: true` alongside the already-forced
  `gate`/`sources`.
- `src/health/gate.ts` — `computeGate` reads `config.configUnreadable` off
  the `HealthConfig` it already receives and, when set, pushes ONE constant
  string onto the `reasons` array it already builds and already returns:

  ```ts
  const CONFIG_UNREADABLE_REASON =
    "CONFIG: health configuration is unreadable; gate forced to strictest thresholds";
  // ...
  if (config.configUnreadable) {
    reasons.push(CONFIG_UNREADABLE_REASON);
  }
  ```

  No interpolation, no path, no file contents, no raw error text — the
  string names the fact that the read was not trusted, never any detail of
  why, exactly the leak-safety bar `POSTURE_UNAVAILABLE_REASON` sets on the
  security side.

**Why this shape, and not the alternatives:**

1. *Re-deriving "looks forced" by comparing `config.gate` against
   `config.ts`'s `STRICTEST_GATE` constant, without a flag* — rejected.
   `gate.ts` would have to import (or duplicate) a loader-internal constant,
   coupling a pure computation function to one caller's implementation
   detail, and it would false-positive on a real operator config that
   legitimately sets all four priorities and zero drop thresholds (unusual
   but legal). The flag has neither problem: it is set by the one piece of
   code that actually knows whether the bytes were trusted, not inferred
   from the shape of values that could coincidentally match.
2. *A flag the gate turns into a reason* is the literal shape
   `security/config.ts`/`guard.ts` already use, and `HealthConfig`/
   `computeGate` already had both halves that answer needs: a reasons list
   (`GateResult.reasons`) and, in the same function, the exact place that
   already distinguishes "a required check is missing" from "a required
   check failed" — the `brokenRequired` filter, which already produces
   per-source `incomplete` reasons through the same
   constant-category-plus-safe-identifier convention this task's line
   follows (`` `INCOMPLETE: required source unavailable: ${source.source}${detail}` ``,
   where `detail` is empty unless `source.error` is set). The new
   `configUnreadable` line sits at the same layer, one level up: it names a
   fact about the whole read, not about one source, so it does not belong
   inside that loop — it is pushed once, unconditionally on the flag, before
   any of the per-check logic runs.
3. `HealthGateResult` (`types.ts`, `src/health/service.ts`'s `gate()`
   method) was deliberately left untouched. Read (not edited):
   `src/health/run.ts:152` builds `report.gate` by calling `computeGate(...)`
   directly and persists it as `HealthReport.gate`; `service.ts:264-266`'s
   `gate()` method later re-serves that persisted value verbatim
   (`reasons: latest.gate.reasons`). Because the new line lives inside
   `computeGate` itself, the new reason reaches both `keryx health run`'s
   report and `keryx health gate`'s output through code this task did not
   have to touch and is forbidden from touching.

## 3. Enumeration of `HealthConfig` and `computeGate` consumers, and how it was done

Method: `bun src/cli.ts ctx rg` (routed search, never bare `rg`/`grep`) for
`HealthConfig`, `computeGate\(`, and `loadHealthConfig\(` across `src/`,
then reading every match's surrounding lines.

`HealthConfig` (52 matches, 15 files):

| File | How it uses `HealthConfig` | Affected by the additive field? |
|---|---|---|
| `src/health/config.ts` | Owns `DEFAULT_HEALTH_CONFIG` (object literal, no `configUnreadable` key — optional field, no error) and `loadHealthConfig`'s return type | Modified by this task |
| `src/health/types.ts` | Declares the type | Modified by this task |
| `src/health/gate.ts` | `computeGate`'s `config` param | Modified by this task |
| `src/health/run.ts` | Reads `config.ignore`/passes `config` to `computeGate`/`filterIgnoredFindings` | Read-only field access; unaffected |
| `src/health/scoring.ts` | Reads `config.metrics.coverageTarget` etc. for scoring, not gating | Unaffected — does not read `coverageSoftFloor` or `configUnreadable` |
| `src/health/scopes.ts` | Threads `config` through as an opaque param | Unaffected |
| `src/health/service.ts` | Calls `loadHealthConfig`, passes `config` into `HealthContext` | Read-only field access; unaffected — not edited |
| `src/commands/init.ts`, `src/commands/update.ts` | Call `renderHealthConfig()`, which serializes `DEFAULT_HEALTH_CONFIG` only — `configUnreadable` is never set there | Unaffected |
| `src/health/config.test.ts`, `src/health/parsers.test.ts`, `src/health/wiki-freshness-gate.test.ts` | Construct/consume `HealthConfig` values in tests | `config.test.ts` extended by this task; the other two untouched and re-run green |

An **optional** field on a structurally-typed object is additive by
construction: no existing object literal that satisfies `HealthConfig`
today (`DEFAULT_HEALTH_CONFIG`, every fixture, every inline test config)
needs a new key to keep type-checking, and no code that only reads existing
fields (`scoring.ts`, `run.ts`, `scopes.ts`, `service.ts`) is affected by a
field it never looks at. `bun run typecheck` (clean, exit 0) is the
independent confirmation that every one of these sites still type-checks
with the field added.

`computeGate(` (19 matches, 8 files) — narrowed to the health one
(`src/security/resolve.ts` also exports a same-named, unrelated
`computeGate` for a different domain; confirmed by reading both signatures):

| Call site | Effect of the new line |
|---|---|
| `src/health/run.ts:152` | Receives one more `reasons` entry only when `config.configUnreadable` is true; `status`/`coverage` unchanged (see §4) |
| `src/health/gate.test.ts` (8 pre-existing tests) | None use a config with `configUnreadable` set — re-run green, unmodified |
| `src/health/metrics/hotspot.test.ts` (2 call sites) | Same — configs built from `DEFAULT_HEALTH_CONFIG`/derivatives, no flag set |
| `src/health/health-truthful-gate.test.ts` (1 call site) | Same, and its assertions use `.reasons.join("\n")` with `toContain`/`toMatch`, tolerant of an extra unrelated entry even if one appeared |

`loadHealthConfig(` (12 matches, 5 files) — `src/health/run.ts:43`,
`src/health/service.ts:123` (both read-only call sites, unmodified),
`src/health/config.test.ts` (extended), `src/health/parsers.test.ts` (its
two `loadHealthConfig` tests — absent-file default, ignore-path merge — read
but not edited, re-run green below).

## 4. Why the verdict is unchanged

`status` is set only inside `computeGate`'s local `escalate()` closure,
called from five sites: the priorities check, the regression check, the
required-source check, the optional-source-failure check, and the
coverage-soft-floor check. The new line
(`if (config.configUnreadable) reasons.push(CONFIG_UNREADABLE_REASON);`)
calls none of them — it is a single unconditional `reasons.push`, placed
before `status` is even initialized to `"pass"` and before any `escalate`
call, with the same shape as the other two non-escalating pushes already in
this function (`OPTIONAL: ... skipped`, `PASS: no gate conditions
triggered`). `coverage` (the `GateResult` field) is computed from
`brokenRequired.length`, untouched by the new line. `gate.test.ts`'s new
regression `"configUnreadable adds a discoverable, constant reason without
changing the verdict"` asserts this directly: the same inputs with and
without the flag produce identical `status` and `coverage`, and the only
difference in `reasons` is the new element's presence.

No case in the implementation required changing an existing verdict, so the
dispatch's stop condition ("if you find you cannot add the explanation
without changing a verdict, stop") was never triggered.

## 5. The coverage-soft-floor residual: determination

`T59-implementation.md` §3 disclosed, without resolving: `computeGate` also
reads `config.metrics.coverageSoftFloor` (its coverage-warn escalation,
`gate.ts:98-99` before this task's edits), which makes it gate-relevant by
T43's own migration criterion ("a block whose payload can change a gate
status is gate-relevant"), yet the unusable branch left the whole `metrics`
block — `coverageSoftFloor` included — at the plain default, identical to
an absent file. T59 recorded this as a disclosed boundary rather than a
decision, because that task owned only `config.ts` and classed a
single-field carve-out inside `metrics` as a judgment call beyond its own
spec.

**Determination: it was not right, and this task corrects it.**

Verified (`bun src/cli.ts ctx rg "coverageSoftFloor|coverageTarget" src`,
7 matches before this task's edit, now 9): `gate.ts` is the ONLY reader of
`coverageSoftFloor`, at exactly the one line already named; `coverageTarget`
is read only by `scoring.ts`, which feeds the health *score*, not the gate.
No other `metrics` field (`complexityThreshold`, `churnWindowDays`,
`hotspotThreshold`) is read by `computeGate` at all. So `coverageSoftFloor`
is the single field of `metrics` capable of moving a gate `status`, and
leaving it at `60` while every other gate-relevant value (`gate.*`,
`sources[*].required`) was forced to its ceiling reopened the exact bug T59
closed, narrowed to this one field: an operator who tightened
`metrics.coverageSoftFloor` (e.g. to `90`, to warn earlier on coverage
drops) had that tightening silently reverted to `60` the instant the
config became unusable — a coverage number between `60` and `90` would stop
warning under the corrupted-config default, though the operator's real
config would have caught it.

**Fix implemented:** the unusable branch now returns
`metrics: { ...base.metrics, coverageSoftFloor: 100 }`. `100` is the
ceiling of the field's percentage range — `coverage` is always compared and
reported as a percentage everywhere it is produced or read in this module —
so `coverage < 100` is the maximal trigger `computeGate`'s comparison can
express, and by the same "every legal value is bounded by this constant"
argument already used for `gate.failOnPriorities`/drop-thresholds, it is
provably at least as strict as any real operator's setting (every legal
`coverageSoftFloor` a config could declare is `<= 100`). The other four
`metrics` fields stay at the plain built-in default, because none of them
is gate-relevant by the verified criterion above.

**Test correction, justified (not a weakening):** `config.test.ts`'s
pre-existing test `"non-gate blocks fall back to the built-in default for an
unusable config"` asserted `expect(config.metrics).toEqual(DEFAULT_HEALTH_CONFIG.metrics)`
— an assertion that pinned exactly the T59-era behaviour this task
deliberately changes for one field. The test was not deleted or weakened;
it was corrected to destructure `coverageSoftFloor` out, assert the
remaining four `metrics` fields are still byte-identical to the default
(unchanged, as before), and assert `coverageSoftFloor` is specifically
`100` and specifically NOT the default `60`. The corrected assertion is
strictly more precise than the one it replaced, with an inline comment
naming this task and the reasoning above.

## 6. Regressions

New assertions, `src/health/config.test.ts`:

- Corrected: `"non-gate blocks fall back to the built-in default for an
  unusable config"` — `coverageSoftFloor` is `100`, not `60`; every other
  `metrics` field is unchanged.
- New: `"an unusable config sets configUnreadable; absent and well-formed
  configs do not"` — `null`, `42`, and unparseable JSON all set
  `configUnreadable: true`; an absent config and a well-formed config both
  leave it `undefined`.

New assertions, `src/health/gate.test.ts`:

- New: `"configUnreadable adds a discoverable, constant reason without
  changing the verdict"` — identical `status`/`coverage` with and without
  the flag; `reasons` differs; the new reason matches
  `/config/i` and `/unreadable|unusable/i`; leak-safety asserted directly
  (`reasons.join(" ")` contains neither `process.cwd()`, the literal word
  `"undefined"`, nor any `.metaproject`/`.json` path fragment).
- New: `"configUnreadable is reported even when it is the only gate
  condition (clean project)"` — an otherwise-clean project (no findings, no
  regression, no broken sources) still surfaces the reason, proving the line
  is unconditional on any other gate condition.

RED (before the change, both new test files against the pre-implementation
code): **14 pass / 4 fail, 86 expect() calls**, 2 files —
`.metaproject/data/gdctx/raw/2026-09-06T16-55-57-800Z_run.log`. The four
failures are exactly the four new/corrected assertions:
`coverageSoftFloor` still `60`; `configUnreadable` still `undefined`; the
new gate reason absent from both new gate tests.

GREEN (after the change): **18 pass / 0 fail, 98 expect() calls**, 2 files
— `.metaproject/data/gdctx/raw/2026-09-06T16-56-34-454Z_run.log`.

The two pre-existing `loadHealthConfig` tests in `src/health/parsers.test.ts`
(absent-file default, ignore-path merge) and all 8 pre-existing
`gate.test.ts` tests were not touched and are included, still passing, in
the broad run below.

## 7. Broader verification

| What | Result | Raw log |
|---|---|---|
| `bun src/cli.ts ctx run -- bun test src/health/config.test.ts src/health/gate.test.ts` (focused, GREEN) | 18 pass / 0 fail / 98 expect() | `2026-09-06T16-56-34-454Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/health/ src/commands` (first pass, before a doc-comment-only follow-up edit) | 1088 pass / 6 skip / 0 fail / 4013 expect(), 1094 tests, 97 files | `2026-09-06T16-57-19-415Z_run.log` |
| Same command, re-run after correcting a stale comment in `config.ts` (§8) | 1088 pass / 6 skip / 0 fail / 4013 expect(), 1094 tests, 97 files — byte-identical counts | `2026-09-06T16-59-09-479Z_run.log` |
| `bun run typecheck` (first pass) | exit 0, no errors | `2026-09-06T16-57-50-177Z_run.log` |
| `bun run typecheck` (re-run after §8) | exit 0, no errors | `2026-09-06T16-59-23-066Z_run.log` |
| `bunx eslint src/health/types.ts src/health/config.ts src/health/gate.ts src/health/config.test.ts src/health/gate.test.ts` (first pass) | exit 0, no output | `2026-09-06T16-57-57-730Z_run.log` |
| Same eslint command, re-run after §8 | exit 0, no output | `2026-09-06T16-59-26-673Z_run.log` |

No existing test was deleted or weakened. The one corrected expectation
(`config.metrics` full-equality → the four-field-plus-`coverageSoftFloor:100`
split) is justified in §5. No other existing expectation changed.

## 8. A stale comment, found and corrected mid-task

While re-reading the diff for this report, the "present, unusable" branch's
existing (T59) comment still said *"Every other block (`ignore`, `metrics`,
`scoring`, `schemaVersion`) is not gate-relevant... and falls back to the
built-in default"* — no longer true once `coverageSoftFloor` was forced.
Corrected to name `coverageSoftFloor` as the one `metrics` exception. Comment
only; both broad test and typecheck/lint runs above were re-executed after
this edit and are byte-identical in every count to the runs taken before it,
confirming it changed no behavior.

## 9. Files changed

| File | Change |
|---|---|
| `src/health/types.ts` | `HealthConfig` gains one additive optional field, `configUnreadable?: boolean`, documented as mirroring `SecurityConfig.configUnreadable` |
| `src/health/config.ts` | The existing (T59) "present, unusable" branch now also sets `configUnreadable: true` and forces `metrics.coverageSoftFloor` to `100`; one stale comment corrected (§8) |
| `src/health/gate.ts` | `computeGate` pushes a new module-local constant, `CONFIG_UNREADABLE_REASON`, onto `reasons` when `config.configUnreadable` is true — unconditional on any other gate condition, never calling `escalate` |
| `src/health/config.test.ts` | One existing assertion corrected (metrics/`coverageSoftFloor`, justified in §5); one new test (`configUnreadable` set only for the unusable case) |
| `src/health/gate.test.ts` | Two new tests: the flag adds a reason without moving the verdict, and the reason still appears on an otherwise-clean gate |

## 10. Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC4 (AFC-05): fixtures, a corrupted payload, a skipped required check and an incomplete area each produce the expected outcome; violations are not lost when another check is unavailable. | met | Unchanged from T59 (this task does not touch the logic that produces those outcomes — §4); `config.test.ts`'s corrupted-payload fixtures (`null`, `42`, unparseable JSON, from T59) all still produce the strictest reachable `HealthConfig`, now additionally carrying `configUnreadable: true` and `coverageSoftFloor: 100`. `gate.test.ts`'s pre-existing "missing required source is incomplete" and "optional skipped source does not affect gate" tests pass unmodified, proving a skipped/incomplete area is still surfaced and a real violation is never dropped by the new reason line. |
| An operator reading the gate result can tell that the configuration was unusable, from a constant, leak-safe reason; the verdicts themselves are unchanged from what the previous repair established. | met | `computeGate` pushes `CONFIG_UNREADABLE_REASON` (a fixed, non-interpolated string) into `GateResult.reasons` whenever `config.configUnreadable` is true; that value reaches both `keryx health run`'s persisted report and `keryx health gate`'s output through `run.ts`/`service.ts` code this task read but did not modify (§2 point 3). `gate.test.ts`'s new regression asserts identical `status`/`coverage` with and without the flag, and asserts the reason string leaks no cwd path, no literal `"undefined"`, and no `.metaproject`/`.json` fragment. |
| Regressions fail before the change and pass after; `bun test src/health/ src/commands` stays green. | met | RED 14 pass / 4 fail, 86 expect() → GREEN 18 pass / 0 fail, 98 expect() (focused). `bun src/cli.ts ctx run -- bun test src/health/ src/commands`: 1088 pass / 6 skip / 0 fail, 4013 expect(), unchanged before and after the §8 comment fix. `bun run typecheck`: exit 0. `bunx eslint` on every changed file: exit 0, no output. |

## Concerns

None. The dispatch's stop condition (cannot add the explanation without
changing a verdict) was never reached; the one existing test expectation
that changed is a corrected pin, justified in §5, and not a weakening —
verified by `gate.test.ts`'s explicit same-inputs/same-verdict regression in
§4/§6. `src/health/service.ts` and five other `src/health/**` files carry
unrelated concurrent changes from other workers/sessions in this shared
tree; none was read for anything this task's own logic depends on beyond
the two call sites already cited (`run.ts:152`, `service.ts:264-266`), both
read-only and both unmodified.

## Routing audit

`graph_used: no (not-relevant — the dispatch named the exact files and the
consumer enumeration in §3 is a text-shape/reference question, answered by
routed search and direct reads, not a structural graph query); wiki_used: no
(not-relevant — the governing texts are `policies.md`, the frozen
`acceptance-criteria.md`, and this flow's own T59/T54 artifacts, all read
directly per the dispatch); ctx_used: yes (every code search via `bun
src/cli.ts ctx rg`, every test/typecheck/eslint run via `bun src/cli.ts ctx
run`, the diff/stat check via `bun src/cli.ts ctx diff --stat`, all raw logs
cited above); raw_rg_used: no — every search used the routed `ctx rg` form;
`git status --porcelain` (not a content search) was run directly via Bash to
confirm which files this task actually modified versus a concurrent
worker's changes, which is a repository-state check rather than a text/code
search.`

## Constraint compliance

No git state changed (only `git status --porcelain` and `git diff --stat`
were run, both read-only); no flow CLI or flow state touched; no
`flow.json` or `acceptance-criteria.md` edit; no network; no model calls; no
dependency or lockfile change; no `bun test` without file arguments; no
synthetic fixture was needed for this task (no new files on disk were
required — `config.test.ts`'s existing `mkdtemp`-based fixtures, unmodified
in mechanism, were reused for the new/corrected assertions); nothing was
written to a real `.metaproject/health.config.json`; `src/health/service.ts`
and every other file outside this task's ownership are unmodified by this
task.
