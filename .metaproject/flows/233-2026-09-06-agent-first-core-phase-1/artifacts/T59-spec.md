# T59 — pre-code specification: `loadHealthConfig`'s unusable-payload hole

Ruling implemented: `T39-review.md` "Judgement calls" #4 (use the shared
shape-aware reader, do not add another sentinel). Item closed:
`T43-implementation.md` §3b, "Classified security/gate-relevant, deferred by
ownership" — `src/health/config.ts:71`, named there as "the strongest
remaining instance of the class."

Scope is limited to `src/health/config.ts`, a new focused test file
`src/health/config.test.ts`, and the two documentation lines at
`docs/docs/cli-reference.md:2116` and `:2139`. No other file is read for
edit; `src/health/types.ts` and `src/health/gate.ts` are read-only references
for how the returned `HealthConfig` is consumed.

## 1. The defect, precisely

`loadHealthConfig` reads via `readJsonFileOr<Partial<HealthConfig>>(file, {})`
and then accesses `parsed.schemaVersion`, `parsed.ignore?.paths`, … without
checking `parsed` is an object first.

- A file containing the four bytes `null` parses successfully (valid JSON),
  so `readJsonFileOr` returns `null` unchanged (it only falls back on a parse
  *failure*). `parsed.schemaVersion` then throws
  `TypeError: Cannot read properties of null (reading 'schemaVersion')`,
  which propagates out of `loadHealthConfig` uncaught — neither of its two
  callers (`src/health/run.ts:43`, `src/health/service.ts:102`) wraps the call
  in a try/catch, so `keryx health run` and `keryx health sources` crash
  instead of producing a report.
- A file containing any other non-object JSON (an array, a number, a string,
  a boolean) does NOT throw — property access on those auto-boxes and yields
  `undefined` — so every field silently falls through to
  `DEFAULT_HEALTH_CONFIG`. Unparseable JSON takes the same path via
  `readJsonFileOr`'s `{}` fallback.
- The second case is the more serious one. `DEFAULT_HEALTH_CONFIG.gate` is
  `{failOnPriorities:["P0"], failOnRegressionDrop:10, warnOnRegressionDrop:3,
  failOnMissingRequiredSource:true}` and every optional source
  (`tests`, `coverage`, `dependencyAudit`, `sonarqube`, `complexity`) defaults
  to `required:false`. An operator who tightened either — added `"P1"` to
  `failOnPriorities`, lowered `failOnRegressionDrop`, or marked a source
  `required:true` — has that tightening silently reverted the moment the file
  is destroyed, truncated, or replaced by something that still parses. The
  gate then computes as if the operator had never configured anything, with
  no signal that the file it read was not the file on disk.

## 2. The three-case decision (full argument in T59-implementation.md)

`readJsonObjectFile` (`src/lib/json.ts`, added by T43) is the shared
shape-aware reader this ruling requires. It answers exactly the question
`loadHealthConfig` needs: `state: "object"` (trustworthy), `"non-object"`
(parsed, but not the shape the loader needs), `"unreadable"` (did not parse —
an absent file is excluded upstream by the existing `pathExists` check, which
`loadHealthConfig` already has and keeps).

Three cases, each with a distinct meaning:

1. **Absent** (`!pathExists`) — unchanged: `DEFAULT_HEALTH_CONFIG`, byte-identical
   to today. "Never configured."
2. **Present, well-formed** (`read.state === "object"`) — unchanged code path,
   byte-identical merge to today. The operator's file is trusted exactly as
   before.
3. **Present, unusable** (`read.state !== "object"`) — NEW. Neither a throw
   (case 1's bug) nor a silent full-default fallback (case 2's bug). The two
   gate-relevant blocks T43-implementation.md names for this exact site —
   `gate` and "the `required` flag of every source" — are forced to the
   strictest value the `HealthConfig` type can express. Every other block
   (`ignore`, `metrics`, `scoring`, `schemaVersion`) falls back to the
   built-in default, because those are not gate-relevant by the criterion
   T43 already established (a block whose payload cannot change a gate
   status, exit code, or persisted decision stays a plain default merge).

`security/config.ts` resolves the identical question by forcing `mode` to its
strictest recognized value and setting a `configUnreadable` boolean the type
already carries, which `guard.ts` and `guard.ts`'s two consumers branch on
directly for an unconditional block. `HealthConfig` has no such carrier field
and no single "mode" — the gate is computed from several independent
thresholds — and adding one would touch `src/health/types.ts` and
`src/health/gate.ts`, both outside this task's ownership. The chosen
alternative reaches an equivalent outcome through the existing, unmodified
`computeGate()`: forcing every source's `required` to `true` guarantees at
least one source (`sonarqube`, `mode:"disabled"` by default, so its status is
always `"skipped"`, never `"available"`) is a broken required source, which
`computeGate` already escalates to `GateStatus:"incomplete"` — exactly the
vocabulary `policies.md` §"Health и security gate" assigns to "required check
missing/skipped/unparsed/incomplete," deterministically, regardless of what
the corrupted file might have said. Forcing `gate.failOnPriorities` to all
four priorities and both drop thresholds to `0` additionally guarantees any
real finding at any priority, or any measurable regression, escalates to
`fail` — provably at least as strict as any config a real operator could have
written, since every legal `failOnPriorities` is a subset of the four
priorities and every legal drop threshold is non-negative.

Full three-case description of what a reader of the resulting gate sees is
written in T59-implementation.md, not restated here.

## 3. Known, disclosed residual (not fixed here)

`computeGate` also reads `config.metrics.coverageSoftFloor` for its coverage
warn escalation. That field is not named by T43-implementation.md's
description of this site's gate-relevant surface (`gate` and sources'
`required`), and forcing it is a judgment call this spec does not extend to.
Left as `metrics` falling back to the plain default, same as an absent file,
consistent with the "unchanged, not gate-relevant by this criterion" bucket —
recorded here so it is a disclosed scope boundary, not a silent gap.

## 4. Implementation contract

- `src/health/config.ts`: replace the `readJsonFileOr` read with
  `readJsonObjectFile`; branch on `read.state`; the well-formed branch's merge
  logic is untouched line-for-line; the unusable branch is new code, forcing
  `gate` and `sources[*].required` as described above. `readJsonFileOr`
  import is dropped (no other use in this file); `readJsonObjectFile` import
  added from the same module.
- `src/health/config.test.ts` (new): regressions for
  - `null` payload → does not throw, returns a `HealthConfig`.
  - a non-object payload not previously throwing (e.g. `42`) → does NOT
    silently equal `DEFAULT_HEALTH_CONFIG.gate`; `failOnPriorities` covers all
    four priorities, both drop thresholds are `0`, every source has
    `required:true`.
  - unparseable JSON → same as above (both `unreadable` and `non-object`
    states are exercised).
  - a well-formed config with an explicitly tightened `gate.failOnPriorities`
    (e.g. adding `"P1"`) and a custom `metrics`/`ignore` value → returned
    unchanged, proving the well-formed path is untouched.
  - existing two tests in `src/health/parsers.test.ts` (absent file, ignore
    merge) are not touched and must keep passing unmodified.
- `docs/docs/cli-reference.md:2116` and `:2139`: append the
  "…or when the scan could not read a manifest or the pinned baseline
  (`coverage: incomplete`)" clause T43-implementation.md already drafted for
  this exact drift, verbatim in intent.

## 5. Verification plan

1. Regressions RED: write `src/health/config.test.ts` against the *current*
   `config.ts`, run it, capture the null-payload throw and the silent-default
   failures.
2. Implement the fix.
3. Regressions GREEN: same file, all passing.
4. `bun src/cli.ts ctx run -- bun test src/health/ src/commands`.
5. `bun run typecheck`.
6. `bunx eslint` on `src/health/config.ts` and `src/health/config.test.ts`.
7. Confirm `src/health/parsers.test.ts`'s two `loadHealthConfig` tests still
   pass unmodified (absent-file default, ignore-path merge).

All raw logs under `.metaproject/data/gdctx/raw/`.
