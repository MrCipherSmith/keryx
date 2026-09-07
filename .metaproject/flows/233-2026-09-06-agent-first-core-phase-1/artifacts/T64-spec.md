# T64 — pre-code specification: make the health gate's forced-strict verdict legible

Follows: `T59-implementation.md` §3–4 (the three-case decision that forces
`gate` and every source's `required` to their strictest values when
`.metaproject/health.config.json` exists but is unusable) and its disclosed
gap in §4 point 3: "What that reader does NOT see, unlike the security side,
is a discrete 'the config file was unreadable' reason string in
`gate.reasons`... adding that string is exactly the out-of-scope
`gate.ts`/`types.ts` change." This task now owns `types.ts` and `gate.ts`, so
that gap is closable.

Also follows: `T54-implementation.md` §"Defect 1", the pattern being mirrored
— `SecurityConfig.configUnreadable?: boolean`, set only by the loader when
the file exists but cannot be trusted, consumed by `guard.ts` through an
existing constant (`POSTURE_UNAVAILABLE_REASON`) rather than an interpolated
string.

Scope: `src/health/types.ts`, `src/health/config.ts`, `src/health/gate.ts`,
and their focused tests (`src/health/config.test.ts`, `src/health/gate.test.ts`).
Not `src/health/service.ts` (owned by a concurrent worker). `src/security/config.ts`
is read-only reference, already read.

## 1. The gap, precisely

`loadHealthConfig`'s "present, unusable" branch (T59) already forces the
verdict to the strictest reachable outcome: every source's `required` is
`true`, so `sonarqube` (disabled by default) is always a broken required
source and `computeGate` (unmodified) escalates to `GateStatus:"incomplete"`
at minimum; `gate.failOnPriorities`/drop-thresholds are forced to their
ceiling, so any real finding or regression escalates to `fail`. This is
correct and is not being revisited.

What is missing: nothing in the returned `GateResult` says *why* the gate is
that strict. An operator who tightened their own config, had the file
destroyed or corrupted, and now sees `incomplete`/`fail` on a clean project
cannot tell "the config is unusable" from "there is a real broken required
source" by reading the gate result — they would have to read
`src/health/config.ts`'s source to learn that. That is the same shape T39
named for `security.config.json` before T54/T37 closed it there.

## 2. Shape decision: flag on `HealthConfig`, turned into a constant reason by `computeGate`

**Chosen:** add `configUnreadable?: boolean` to `HealthConfig` (`types.ts`),
set to `true` only in `loadHealthConfig`'s existing "present, unusable"
branch (`config.ts`) — mirroring `SecurityConfig.configUnreadable` exactly in
name, shape, and the condition that sets it (file exists, cannot be trusted;
never set for an absent file). `computeGate` (`gate.ts`) reads the flag off
the `HealthConfig` it already receives as `input.config` and, when set,
pushes one constant, non-interpolated string onto the `reasons` array it
already builds and already returns to every caller.

**Why this shape and not the alternatives the dispatch names:**

- *A reason entry produced without a flag* (e.g. `computeGate` re-deriving
  "config looks forced" by inspecting whether `config.gate` equals
  `STRICTEST_GATE`) was rejected: it would require `gate.ts` to import or
  duplicate `STRICTEST_GATE` from `config.ts` to compare against, coupling a
  pure computation function to a specific loader's internal constant, and it
  would silently stop working the day an operator's own config happens to
  legitimately set every priority and zero drop thresholds (a legal, if
  unusual, real config) — a false positive the flag cannot have, because the
  flag is set by the loader that alone knows whether the bytes were trusted,
  not inferred from the shape of the values.
- *A flag the gate turns into a reason* is exactly `security/config.ts`'s
  answer, and the module already has the two things that answer needs: a
  reasons list (`GateResult.reasons`) and a place that already distinguishes
  "a required check is missing" from "a required check failed" (the
  `brokenRequired` filter in `computeGate`, which already produces per-source
  incomplete reasons through the same non-interpolated-prefix convention:
  `` `INCOMPLETE: required source unavailable: ${source.source}${detail}` ``
  where `detail` is empty unless `source.error` is set — the file already
  practices "the category is a constant, the identifier is safe to name"). A
  `configUnreadable` flag is the same instrument at the layer above: it does
  not name a source, a path, or an error — it names the fact that the whole
  configuration read was not trusted, which is not a per-source fact and
  does not belong inside the `brokenRequired` loop.
- Kept **out of scope**, deliberately: `HealthGateResult` (`types.ts:243`,
  `src/health/service.ts`'s `gate()` method) is a second reasons carrier that
  reads `latest.gate.reasons` off a persisted report. Because the flag is
  consumed inside `computeGate` and `computeGate`'s output (`GateResult`) is
  what gets persisted as `report.gate` (`src/health/run.ts:152` →
  `HealthReport.gate`) and later re-served verbatim by `service.ts`'s
  `gate()` (`reasons: latest.gate.reasons`), the new reason string reaches
  both `keryx health run`'s report and `keryx health gate`'s output without
  any change to `service.ts` — confirmed by reading (not editing) both call
  sites.

## 3. Why this does not change the verdict

`computeGate`'s `status` is set only inside `escalate()`, which is called
from the findings/regression/required-source/optional-source checks — never
from the new branch. The new branch does exactly one thing:
`if (config.configUnreadable) reasons.push(CONFIG_UNREADABLE_REASON);` with
no call to `escalate`. `status` and `coverage` (the two fields that
constitute "the verdict") are computed identically to before this task,
from identical inputs, because `config.gate`, `config.sources`, and every
other field `computeGate` reads are unchanged by this task — they are the
values T59 already forces. The new reason changes only the `reasons` array's
*contents*, and only by adding one element, never by removing, reordering,
or altering the meaning of an existing one. `gate.test.ts`'s eight existing
tests assert only `.status`, never a `reasons` array length or exact
equality, and none of them uses a config with `configUnreadable` set, so
none can observe the new line.

If, while implementing, the flag is found to change `status` or `coverage`
for any existing pinned case, that is a stop condition per the dispatch —
not something to work around — but nothing in the plan above touches either
field's computation, so no such case is expected.

## 4. The coverage-soft-floor residual: decision

T59-implementation.md §3 disclosed: `computeGate` reads
`config.metrics.coverageSoftFloor` for its coverage-warn escalation
(`gate.ts:80-81`), which makes it gate-relevant by T43's own criterion ("a
block whose payload can change a gate status... is gate-relevant"), yet the
unusable branch leaves the whole `metrics` block — including
`coverageSoftFloor` — at the plain built-in default, identical to an absent
file. T59 left this open because that task owned only `config.ts` and
classed the one-field carve-out as a judgment call beyond its spec.

**Determination: it is not right, and this task corrects it.** Verified by
reading `gate.ts` (only line 80's `coverage < config.metrics.coverageSoftFloor`
reads any `metrics` field for gate purposes) and `scoring.ts` (the only other
`metrics` field consumer, `coverageTarget`, feeds the health *score*, not the
gate). So `coverageSoftFloor` is the ONLY field of `metrics` that can move
`status`, and leaving it at `60` (the default) while every other
gate-relevant value is forced to its ceiling reopens exactly the bug T59
closed, narrowed to one field: an operator who tightened
`metrics.coverageSoftFloor` (say to `90`) to warn earlier on coverage drops
has that tightening silently reverted to `60` the moment the file becomes
unusable — the gate would fail to warn on a coverage number between 60 and
90 that the operator's real config would have caught.

**Fix:** in the unusable branch, force `metrics.coverageSoftFloor` to `100`
— the ceiling of the field's percentage range (`coverage` is compared as a
percentage everywhere it is produced/read in this module) and therefore, by
the same "every legal value is bounded by this constant" argument already
used for `gate.failOnPriorities`/drop-thresholds, provably at least as
strict as any real operator's setting: `coverage < 100` is true for every
`coverage` short of a perfect 100%, the maximal trigger this comparison can
express. Every other `metrics` field (`coverageTarget`, `complexityThreshold`,
`churnWindowDays`, `hotspotThreshold`) stays at the plain default, because
none of them is read by `computeGate` — confirmed by the same grep.

**Test correction required, justified:** `config.test.ts`'s existing test "non-gate
blocks fall back to the built-in default for an unusable config" currently
asserts `expect(config.metrics).toEqual(DEFAULT_HEALTH_CONFIG.metrics)`. That
assertion pinned the T59-era behaviour this task is deliberately changing for
the one gate-relevant sub-field. The test is not deleted or weakened — it is
corrected to assert the other four `metrics` fields still equal the default
(unchanged) and `coverageSoftFloor` specifically equals `100` (the new,
intentional exception), with a comment naming this task and the reasoning
above. This is the "corrected expectation... justified in writing" case the
dispatch anticipates, not a weakening: the corrected test is strictly more
specific than the one it replaces.

## 5. Implementation contract

- `src/health/types.ts`: add `configUnreadable?: boolean;` to `HealthConfig`,
  with a doc comment mirroring `SecurityConfig.configUnreadable`'s (who sets
  it, when, and that it is additive/optional so no existing literal —
  `DEFAULT_HEALTH_CONFIG`, every fixture, every test's inline config object —
  needs to change).
- `src/health/config.ts`: in the `read.state !== "object"` branch, add
  `configUnreadable: true` to the returned object; force
  `metrics: { ...base.metrics, coverageSoftFloor: 100 }` alongside the
  existing `gate`/`sources` forcing. The well-formed branch and the absent
  branch are untouched.
- `src/health/gate.ts`: `computeGate` pushes one constant string — not
  interpolated, no path/error/file-content — onto `reasons` when
  `config.configUnreadable` is true, without calling `escalate`. Placed
  right after `reasons` is declared, so it reads first and explains the
  forced-strict values that follow it in the array.
- `src/health/config.test.ts`: correct the one assertion named in §4; add
  regressions proving `configUnreadable` is `true` only for the unusable
  branch and `undefined` for both the absent and well-formed cases, and that
  `metrics.coverageSoftFloor` is `100` only for the unusable branch.
- `src/health/gate.test.ts`: add a focused regression: a `computeGate` call
  with `config.configUnreadable = true` (a shallow copy of `DEFAULT_HEALTH_CONFIG`
  with the flag set) produces a `reasons` entry containing the constant
  marker text and does not, by itself, contain the project root, a file
  path, or the literal word "undefined" (leak-safety, mirroring
  `guard.test.ts`'s own leak assertions for the same pattern).

## 6. Verification plan

1. RED: write the new regressions in `config.test.ts` and `gate.test.ts`
   against the pre-change code (`configUnreadable` does not exist yet /
   `coverageSoftFloor` still defaults to `60`); capture failures.
2. Implement.
3. GREEN: same files, all passing.
4. `bun src/cli.ts ctx run -- bun test src/health/ src/commands`.
5. `bun run typecheck`.
6. `bunx eslint` on every changed file.
7. Confirm `src/health/parsers.test.ts`'s two `loadHealthConfig` tests and
   `gate.test.ts`'s eight pre-existing tests still pass unmodified.

All raw logs under `.metaproject/data/gdctx/raw/`.
