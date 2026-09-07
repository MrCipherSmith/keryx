# T61 spec — closing T57's F-002 and F-003, and the gateway mode disagreement

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Written
before any code change. Extends `T58-implementation.md` (which left F-002's
live-comparison residual disclosed, not fixed) and `T55-implementation.md`
(whose `hasGateShape` guard stopped one field short of what `status()`
dereferences).

Owned files: `src/security/self-protect.ts`, `src/security/service.ts`,
`src/security/security.test.ts`, `src/security/guard.ts` and its test
(`src/security/guard.test.ts`), `src/health/service.ts` and its focused tests
(`src/health/service-gate-exit.test.ts`, `src/health/service-status.test.ts`).
Everything else is read-only; two other workers are concurrently editing
`src/health/config.ts` and `src/flow/service.ts` and are left untouched.

## Defect 1 — a broken-config window writes a durable, false incident

### Part A: stop the write

`analyze()` (`service.ts:90-94`) calls `evaluateSelfProtection(config,
previous)` and, if it returns any incidents, persists them via
`appendIncidents` *before* the state-write guard T58 added. T58 stopped the
forced posture from becoming the recorded `previous`, but did not touch this
call: `evaluateSelfProtection`'s mode-downgrade arm
(`self-protect.ts:88-98`) and disabled-policy arm (`:101-113`) both compare
the **current, possibly-forced** `config` against the **real** `previous`,
with no guard on `config.configUnreadable`. When the real `previous` ranks
above the forced `"enforced"` — `gateway` is the only such case — the live
comparison reads as a decrease and appends a `mode-downgrade` incident to
`incidents.jsonl` on the broken run itself, before any repair. That entry is
never removed by a later repair to the *same* mode (nothing rewrites
`incidents.jsonl`; it is intentionally append-only), so the trail
permanently asserts a downgrade that never happened.

T58's own disclosed argument for leaving this alone — "a true statement
about the current run" — does not hold, measured two ways (T57 F-002):

1. It is not merely a warning. `appendIncidents` runs before the state-write
   guard, so the broken run's `mode-downgrade` entry is durable, not
   ephemeral, and outlives the run that produced it.
2. The statement is not true of the run. While `config.configUnreadable` is
   set, `guardOutput` and `securityFlowGate` refuse **every** write through
   their posture-unavailable branches (`INCOMPLETE_DECISION`,
   `POSTURE_UNAVAILABLE_REASON`) — stricter than any recognized mode, not
   weaker. "Enforcement weakened" is false of this window; "evidence about
   the operator's posture is temporarily unavailable" is the true statement,
   and unavailable evidence is not a downgrade.

**Fix**: gate the mode-downgrade and disabled-policy arms in
`evaluateSelfProtection` on `!config.configUnreadable`, mirroring the
condition `service.ts:103`'s `writeState` guard already uses. The
checksum-mismatch arm (`self-protect.ts:57-85`) is untouched — it compares
`config.policies`/`config.configChecksum` against each other, never against
`previous`, so it owes nothing to this window's forced value and keeps
firing on a genuinely tampered checksum regardless of `configUnreadable`.

This does not touch `service.ts`'s `writeState` guard (T58, already
correct) or the checksum block. It also does not need to touch the
AFTER-repair comparison: by the time a repaired config is read, a new
`analyze()` call has `config.configUnreadable === false`, so the guard does
not apply there and the comparison runs exactly as T58 left it — against the
real, unmolested `previous` — which is why the four genuine-downgrade shapes
below are unaffected.

### Part B: the blocking-mode / rank disagreement

T57 also found the mechanism that makes this defect class easy to
reintroduce: `isBlockingMode` (`guard.ts:223-234`) classifies `gateway`
non-blocking (grouped with `advisory`), while `MODE_RANK`
(`self-protect.ts:32-37`) ranks `gateway` **strictest** (3, above
`enforced`/`ci` at 2). Both cannot be the intended meaning of the same mode
at once: if `gateway` truly is report-only like `advisory`, ranking it above
`enforced`/`ci` fabricates a "downgrade" on `gateway → advisory` (identical
report-only behavior, i.e. no real change) and on `gateway → ci`/`gateway →
enforced` (an *upgrade* in real blocking behavior, ranked as a decrease). If
`gateway` truly is the strictest posture, letting it fall through
`isBlockingMode`'s report-only branch means a build that has not finished
implementing `gateway`'s extra behavior silently gives it the **most**
permissive behavior of any recognized mode — backwards from this module's
fail-closed posture everywhere else (`loadSecurityConfig` forces an
unrecognized `mode` to the strictest recognized value, never the most
permissive; `isBlockingMode`'s own `default` arm blocks).

**Which is intended, and the evidence**:

- `MODE_RANK` is anchored by committed, must-keep-passing behavior: T58's
  own regression `"T58 D2"` (`security.test.ts`) is titled around "Real
  state: gateway (the strictest rank)" and asserts `gateway → ci` **is** a
  detected downgrade; T57's own probe (`T57-state.ts` S2, four shapes:
  `gateway→ci`, `enforced→advisory`, `ci→advisory`, `gateway→advisory`) is
  the explicit "keep passing" bar this dispatch names. Two of those four
  shapes (`gateway→ci`, `gateway→advisory`) are ONLY downgrades if
  `gateway` outranks `ci`/`enforced`/`advisory`. Moving `MODE_RANK` down to
  match `isBlockingMode`'s non-blocking classification breaks both — not an
  option that keeps the required regressions green.
- No design document (`docs/requirements/keryx-agent-first-core/*.md`,
  `.metaproject/modules/security.md`, `schemas.ts`) describes `gateway` at
  all beyond enumerating it as a valid `SecurityMode` value; the only prose
  is `guard.ts`'s own `"(Phase 4)"` comment, which reads as a placeholder
  for an unfinished mode, not a considered decision that it should be
  *more* permissive than `enforced`/`ci`.
- The module's fail-closed discipline (`isBlockingMode`'s `default` arm,
  `loadSecurityConfig`'s forced-strictest fallback, the header comment
  at `guard.ts:1-19`) treats "not yet fully specified" as a reason to
  block, never a reason to pass through — the opposite of what the current
  `isBlockingMode` does for `gateway`.

**Conclusion**: `MODE_RANK` reflects the intended meaning (`gateway` is the
strictest recognized posture); `isBlockingMode` is the stale half. Fix:
group `"gateway"` with `"enforced"`/`"ci"` in `isBlockingMode` (blocking),
leaving only `"advisory"` on the non-blocking side. This flows automatically
into `securityFlowGate` (`guard.ts:438`), which already calls
`isBlockingMode(mode)`.

**Committed expectation to correct**: `guard.test.ts`'s `"T54 D1c"` test
(`recognized` table, line ~801) asserts `{ mode: "gateway", blocks: false }`
and, in the same test, that a planted AWS key is `allowed: true` under
`gateway`. This encodes the now-refuted classification and will be corrected
to `{ mode: "gateway", blocks: true }` with a comment recording why (T57
F-002, judgement call #4, this spec).

**Residual, disclosed and out of this task's ownership**:
`src/commands/security.ts`'s `reportExitCode`/`exitCodeFor` still group
`gateway` with `advisory` (report-only) for the CLI exit code, per
T55-implementation.md's truth table. That file is not in this task's
ownership (T55 owned it), so this is a further, real inconsistency this task
does not close — named here rather than silently left, matching how T57
named the disagreement rather than fixing it.

### Regressions (`src/security/security.test.ts`)

- `T61 D1`: for both broken shapes (`"null"` and `'{"mode":"ENFORCED"}'`), a
  real `gateway` previous state, then a broken run: assert `listIncidents`
  contains no `mode-downgrade` entry immediately after the broken run
  (before any repair) — pins the part of F-002 that T58 D2 did not check
  (T58 D2 only asserts state after the *final* reconfigure, never the
  incidents mid-window). Then repair to the SAME `gateway`: still no
  `mode-downgrade` incident, and `readState` still `gateway`.
- Existing `T58 D1/D2/D3` stay unmodified and passing (D2 in particular
  pins that `gateway → ci` after a broken window is still detected as a
  downgrade, unaffected by the new gate since the comparison that fires it
  happens on a config-readable run).

### Regressions (`src/security/guard.test.ts`)

- Correct `T54 D1c`'s `gateway` row from `blocks: false` to `blocks: true`,
  with a comment pointing to T57 F-002 / this spec, per the "committed
  expectation encoding the refuted argument must be corrected in writing"
  constraint.

### Non-regression

`T37 D2/D2b/D2c`, `T54 D1/D1b/D1c` (all other rows), `T58 D1/D2/D3`, and the
two pre-existing self-protection scenarios ("enforced→advisory downgrade +
checksum mismatch...", "a mode downgrade at check() time writes an
incident") must keep passing unmodified — none of them exercise a broken
config together with a higher-ranked real previous mode, so none depend on
the behavior this task changes.

## Defect 2 — the health shape guard stops one field short

`hasGateShape` (`health/service.ts:48`) validates that the payload is an
object and that `.gate` is `{status: string, reasons: array}`, and nothing
else. `HealthReport` (`health/types.ts:158`) also requires `metrics:
ScopeMetrics[]`, `sources: SourceRunInfo[]`, and `findings: Finding[]` — all
non-optional arrays — and T55-implementation.md's claim that `status()`
"also benefits from this fix" is true only for the payloads it tested; a
report with a well-formed `gate` but no `metrics` key, or `metrics` as a
non-array, passes `hasGateShape` and then throws a raw `TypeError` out of
`status()` at `latest?.metrics.find` (T57 F-003, rows E18/E19).

### Enumeration method

`readLatest()` has exactly four callers in `service.ts` — confirmed by
reading the whole file (`ctx rg "readLatest\("` under-counted in its
truncated summary view; a direct `Read` of the file confirmed all four call
sites at lines 212, 235, 251, 283) — `status()`, `gate()`, `explain()`, and
`updateBaseline()`. I read each one and listed every property access on the
returned `latest` value that is not already protected by its own
null/undefined check at the access site:

| Reader | Field accessed | Guarded today? |
|---|---|---|
| `gate()` (:243, :245) | `.gate.status`, `.gate.reasons` | yes — `hasGateShape` already covers `.gate` |
| `status()` (:213, :214-219) | `.metrics` (three uses: `.find`, `.filter`×2) | **no** — `latest?.metrics` only guards `latest` being null, not `.metrics`'s own shape |
| `status()` (:224-226) | `.sources` (`.map`) | **no**, same reason |
| `explain()` (:257, :264) | `.metrics` (`.find`), `.findings` (`.filter`) | **no** — reached after `if (!latest) return ...`, so `latest` itself is non-null, but `.metrics`/`.findings` are unguarded |
| `updateBaseline()` (:291) | `.metrics` | **no** — reachable only if `readLatest` wrongly returns a truthy-but-malformed report; the pre-existing `if (!latest)` branch (recompute via `runHealth`) is what currently protects this call and is unaffected by this fix |

Three fields are dereferenced without their own guard across these readers:
`.metrics`, `.sources`, `.findings` — all required to be arrays by
`HealthReport`. `status()`'s `.gate.status` at `:223` is already safe
(`latest?.gate.status`, and `.gate`'s shape is already validated).

### Fix

Extend `hasGateShape` to additionally require
`Array.isArray(value.metrics) && Array.isArray(value.sources) &&
Array.isArray(value.findings)`, applied at the same single choke point
(`readLatest`) so every one of the four readers gets the same "unusable
evidence → treated as absent" outcome instead of a second guard per call
site — the shape T55 chose and the dispatch says to finish in that shape.
Deliberately does not validate element-level shape (e.g. that each
`ScopeMetrics` entry has a `key`) — that is deeper than what any of the four
readers dereference without their own per-element narrowing, and out of
this defect's scope.

### Regressions

`src/health/service-gate-exit.test.ts` (extends the existing `writeRawLatest`
pattern from T55's F-004 regressions): two new raw fixtures, each verified
through `gate()`, `status()`, and `explain()`:

- "gate shape sound, `metrics`/`sources`/`findings` ABSENT" (mirrors T57
  E18) — all three readers get their existing no-report answer, no throw.
- "gate shape sound, `metrics` is a string" (mirrors T57 E19) — same.

`updateBaseline()` is not given a dedicated regression: exercising it
authentically requires a real `runHealth()` pass (file scanning, source
detection) over the fixture directory, which is a much heavier integration
surface than the other three readers and orthogonal to what this defect
actually changes in that function (the pre-existing `if (!latest)` fallback
is untouched by this fix; the fix only makes `readLatest` correctly return
`null` for a wider set of malformed shapes it was previously missing).
Disclosed here rather than silently left, per T55's own disclosed gap for
`status()` that this task is closing.

## Verification plan

Reviewer's probes, before and after, run directly (not through `ctx run`,
per this repo's documented reason that gdctx compaction drops per-case
rows): `T57-state.ts`, `T57-health.ts`. This task's own regressions, RED
then GREEN. `bun src/cli.ts ctx run -- bun test src/security/ src/health/`.
`bun run typecheck`. `bunx eslint` on every changed file. All raw logs under
`.metaproject/data/gdctx/raw/`.

## Constraints honoured

No git state change, no network, no model calls, no `bun test` without file
arguments, no dependency/lockfile change, no `flow.json` or
`acceptance-criteria.md` edit, fixtures under `mkdtemp` only, no incident
record deleted or rewritten (only a class of write suppressed going
forward), no write to a real `.metaproject/security.config.json`. Stays out
of `src/health/config.ts` and `src/flow/service.ts` (concurrent workers).
