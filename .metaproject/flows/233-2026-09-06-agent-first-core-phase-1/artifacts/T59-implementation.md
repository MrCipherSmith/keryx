# T59 — implementation: `loadHealthConfig`'s unusable-payload hole, closed

Item closed: `T43-implementation.md` §3b, "Classified security/gate-relevant,
deferred by ownership" — `src/health/config.ts:71`, named there as "the
strongest remaining instance of the class" this phase repaired seven times.
Ruling implemented: `T39-review.md` "Judgement calls" #4 — use the shared
shape-aware reader (`readJsonObjectFile`, `src/lib/json.ts`), do not add
another module-local sentinel. Spec: `T59-spec.md`.

## 1. What was wrong

`loadHealthConfig` read via `readJsonFileOr<Partial<HealthConfig>>(file, {})`
and then accessed `parsed.schemaVersion`, `parsed.ignore?.paths`, `parsed.gate`,
etc. without checking `parsed` was an object.

- **`null`** (the file literally contains the four bytes `null`) parses
  successfully, so `readJsonFileOr` returns it unchanged — it only falls back
  on a parse *failure*. `parsed.schemaVersion` then threw
  `TypeError: Cannot read properties of null (reading 'schemaVersion')`,
  uncaught by either caller (`src/health/run.ts:43`, `src/health/service.ts:102`
  — neither wraps the call), crashing `keryx health run` / `keryx health sources`
  instead of producing a report.
- **Every other non-object payload** (an array, a number, a string, a
  boolean) did NOT throw — property access on those auto-boxes to `undefined`
  in JavaScript — so every field silently fell through to
  `DEFAULT_HEALTH_CONFIG`. Unparseable JSON took the same path via
  `readJsonFileOr`'s `{}` fallback. This is the worse half of the bug: an
  operator who tightened `gate.failOnPriorities`, lowered
  `gate.failOnRegressionDrop`/`warnOnRegressionDrop`, or marked a source
  `required:true` had that tightening silently reverted the moment the file
  was destroyed or replaced by anything that still parses — with no signal
  anywhere that the file read was not the file on disk.

## 2. The fix

`src/health/config.ts` now reads via `readJsonObjectFile` (`src/lib/json.ts`,
T43) instead of `readJsonFileOr`, and branches on its three-state result:

```ts
const read = await readJsonObjectFile(file);
if (read.state !== "object") {
  // forced-strictest branch — see §3
}
const parsed = read.value as Partial<HealthConfig>;
// unchanged merge, line-for-line identical to before
```

No new sentinel was added — the whole point of `readJsonObjectFile` existing
is that a caller with this exact need no longer has to invent one. `pathExists`
still gates the absent-file case ahead of the read, unchanged.

## 3. The three-case decision, and the comparison against the security side

**The question, stated the way T39 stated it for `security.config.json`:** what
should an unusable-but-present config mean, given that a corrupted config is
not the same posture as an absent one?

**`src/security/config.ts`'s answer** (read-only reference for this task): a
present-but-unusable config forces `mode` to its strictest recognized value
(`"enforced"`) and sets `configUnreadable: true`, a boolean the `SecurityConfig`
type already carries. `guard.ts` branches on that flag directly, at two call
sites, for an unconditional block — the decision is visible as a discrete flag
a caller can test, independent of whatever the corrupted bytes might have said.

**Why health cannot do the literal same thing, and what it does instead.**
`HealthConfig` has no single "mode" — the gate is computed from several
independent numeric/array thresholds (`gate.failOnPriorities`,
`failOnRegressionDrop`, `warnOnRegressionDrop`) plus a per-source `required`
flag, not one enum a whole posture hangs off. There is also no
`configUnreadable`-shaped carrier on the type, and this task's ownership is
`src/health/config.ts` and its tests only — adding one would mean editing
`src/health/types.ts` (the field) and very likely `src/health/gate.ts` or
`src/health/service.ts` (a consumer that surfaces it in `reasons`), both
outside scope. Per the dispatch's own instruction, that is a BLOCKED-shaped
situation for a flag *field* — but it is not the only way to reach the
substance of what a flag buys: a value that is worse than any real
config, deterministically, through code nobody had to touch.

So the decision is: **do not add a flag; force the two gate-relevant blocks to
values that are provably at least as strict as anything a real operator could
have written, and let the existing, UNMODIFIED `computeGate()` do the rest.**

- `gate` is forced to `{failOnPriorities:["P0","P1","P2","P3"],
  failOnRegressionDrop:0, warnOnRegressionDrop:0,
  failOnMissingRequiredSource:true}`. Every legal `failOnPriorities` a real
  config could set is a subset of all four priorities; every legal drop
  threshold is non-negative. This is the ceiling, not a guess.
- Every entry in `sources` gets `required:true` (its `mode` is left at the
  built-in default). `sonarqube`'s default `mode` is `"disabled"`, and
  `src/health/run.ts` / `src/health/service.ts`'s `detectStatuses` already
  short-circuit a disabled source's status to `"skipped"` before it is ever
  asked to run — so a required-but-disabled `sonarqube` is *always* a broken
  required source, deterministically, regardless of the project under test.
  `computeGate` (untouched) already escalates that to `GateStatus:"incomplete"`
  — exactly the vocabulary `docs/requirements/keryx-agent-first-core/policies.md`
  §"Health и security gate" assigns to "required check missing / skipped /
  unparsed / incomplete": `INCOMPLETE`, never `PASS`.
- Every other block — `ignore`, `metrics`, `scoring`, `schemaVersion` — falls
  back to the plain built-in default, same as an absent file. These are not
  gate-relevant by T43's own migration criterion (a block whose payload
  cannot change a gate status, exit code, or persisted decision is not
  security-relevant for this purpose), and forcing them would be scope beyond
  what this task's dispatch or T43's enumeration names for this site.

**Residual, disclosed rather than fixed:** `computeGate` also reads
`config.metrics.coverageSoftFloor` for its coverage-warn escalation, which
technically makes `metrics` gate-adjacent too (T39-review.md never audited
this site, so no ruling covers it). T43-implementation.md's own description of
this deferred item names only `gate` and sources' `required` as the
gate-relevant surface, and I have not extended the fix to `metrics` — recorded
here as a disclosed boundary, in the same spirit T43 recorded its own deferred
items, rather than silently left unexamined.

## 4. What a reader of the resulting gate sees, in each of the three cases

1. **Config absent.** Unchanged. `loadHealthConfig` returns
   `DEFAULT_HEALTH_CONFIG` exactly as before `pathExists` was even checked
   against a corrupted-file scenario. The gate behaves as "never configured" —
   same reasons, same thresholds, same everything.
2. **Config present and well-formed.** Unchanged. The merge branch
   (`read.state === "object"`) is line-for-line identical to the code that
   ran before this fix. An operator's tightened `failOnPriorities`, drop
   thresholds, or `required` flags apply exactly as written; nothing about
   this fix touches this path.
3. **Config present and unusable.** New, and different from both of the
   above. The gate is computed (by the unmodified `computeGate`) against the
   strictest thresholds this type can express: any finding at any priority
   escalates to `fail`; any measurable regression, however small, escalates
   to at least `warn`/`fail`; and at least one source (`sonarqube`) is always
   a broken required source, which alone guarantees the gate is never better
   than `incomplete` even on a project with zero findings and zero
   regression. A reader who only looks at pass/fail sees the gate refuse to
   certify clean — `incomplete` at minimum, `fail` the moment there is
   anything real to fail on — never the permissive "nothing was configured"
   reading a silently-restored default would have produced. What that reader
   does NOT see, unlike the security side, is a discrete "the config file was
   unreadable" reason string in `gate.reasons` — `computeGate` produces
   `reasons` from findings/sources/regression, not from configuration
   validity, and adding that string is exactly the out-of-scope
   `gate.ts`/`types.ts` change described in §3. The behavioral guarantee (never
   laxer than any real config, never a silent PASS) holds regardless; the
   *legibility* of the specific cause is the one piece of parity with the
   security side this task's ownership boundary does not reach, and is
   recorded as a candidate follow-up rather than silently assumed away.

## 5. Regressions

New file `src/health/config.test.ts`, 7 tests:

| Test | Before | After |
|---|---|---|
| `null` payload does not throw | throws `TypeError` | passes; strictest gate |
| `42` (number) does not silently restore default gate | `gate` equals `DEFAULT_HEALTH_CONFIG.gate` | `gate` is the strictest, not the default |
| `[]` (array) does not silently restore default gate | same silent-default failure | strictest gate |
| `"advisory"` (string) — strictest gate | same silent-default failure | strictest gate |
| unparseable JSON (`{not valid json`) — same treatment | throws-adjacent silent default via `readJsonFileOr`'s catch, still silently defaults | strictest gate |
| non-gate blocks (`metrics`/`scoring`/`ignore`/`schemaVersion`) fall back to plain default for `null` | (incidentally passed before the throw, but only by accident of ordering) | passes deliberately |
| a well-formed config with tightened `gate`/`sources`/`metrics`/`ignore` survives unchanged | passes | passes (unchanged path, pinned) |

RED (before the change): **1 pass / 6 fail, 11 expect()**, 1 file —
`.metaproject/data/gdctx/raw/2026-09-06T16-37-38-810Z_run.log`.

GREEN (after the change): **7 pass / 0 fail, 74 expect()**, 1 file —
`.metaproject/data/gdctx/raw/2026-09-06T16-39-29-758Z_run.log` (the run
immediately after the `Priority[]` type-annotation fix noted in §7; an
identical 7/0/74 result was also captured immediately after the
implementation edit, before that unrelated test-file type fix, at
`.metaproject/data/gdctx/raw/2026-09-06T16-38-05-560Z_run.log`).

The two pre-existing `loadHealthConfig` tests in `src/health/parsers.test.ts`
("config falls back to defaults when file is absent", "config merges default
ignored paths with project-specific ignored paths") were not touched and are
included, still passing, in the broad run below.

## 6. Broader verification

| What | Result | Raw log |
|---|---|---|
| `bun src/cli.ts ctx run -- bun test src/health/config.test.ts` (focused, GREEN) | 7 pass / 0 fail / 74 expect() | `2026-09-06T16-39-29-758Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/health/ src/commands` | 1083 pass / 6 skip / 0 fail / 3981 expect(), 1089 tests, 97 files | `2026-09-06T16-40-10-858Z_run.log` |
| `bun run typecheck` | exit 0, no output | ran directly; clean after the `Priority[]` annotation fix in `config.test.ts` |
| `bunx eslint src/health/config.ts src/health/config.test.ts` | exit 0, no output | ran directly |

No existing test was deleted or weakened; no existing expectation was
changed. The only test-file edit after the initial write was adding
`import type { Priority } from "./types"` and typing `ALL_PRIORITIES:
Priority[]` to satisfy `tsc --noEmit` (`string[]` is not assignable to
`Priority[]`) — a type annotation, not a behavior or expectation change.

## 7. Files changed

| File | Change |
|---|---|
| `src/health/config.ts` | `readJsonFileOr` import replaced with `readJsonObjectFile`; `loadHealthConfig` branches on `read.state`; well-formed-merge branch is untouched line-for-line; new "present, unusable" branch forces `gate` to `STRICTEST_GATE` and every `sources[*].required` to `true`, leaving `ignore`/`metrics`/`scoring`/`schemaVersion` at the built-in default |
| `src/health/config.test.ts` | **new** — 7 regressions: the four-byte-empty-value non-throw, three more non-object/unparseable-payload cases proving the gate is not silently defaulted, one case pinning which blocks DO stay at plain defaults, and one pinning the well-formed path is byte-unchanged |
| `docs/docs/cli-reference.md:2116` | `scan-mcp` table row: added "or when the scan could not read a manifest or the pinned baseline (`coverage: incomplete`)" to the `--strict` exit description |
| `docs/docs/cli-reference.md:2139-2141` | "Exit behavior" paragraph: same addition to the `scan-mcp` sentence |

## 8. Routing audit

- `graph_used`: not-relevant — this task targets one named file/line from
  T43's own enumeration; no navigation question needed the code graph.
- `wiki_used`: not-relevant — no architecture/domain-model question; the
  governing text is `policies.md` and the flow's own review/implementation
  artifacts, read directly per the dispatch.
- `ctx_used`: yes — every test run, the two `rg` lookups (`loadHealthConfig`
  call sites and test references, `failOnMissingRequiredSource` usage,
  `configUnreadable` usage), and the diff/stat check all went through
  `bun src/cli.ts ctx run -- …` / `bun src/cli.ts ctx rg …` / `bun src/cli.ts
  ctx diff --stat`.
- `raw_rg_used`: no — every search used `keryx ctx rg`; `find`/`git diff`
  attempts were caught by the hook and re-run through the routed form.
