# T61 implementation — closing T57 F-002 and F-003

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Files
changed: `src/security/self-protect.ts`, `src/security/guard.ts`,
`src/security/guard.test.ts`, `src/security/security.test.ts`,
`src/health/service.ts`, `src/health/service-gate-exit.test.ts`. Read only
(confirmed by `git status --porcelain` before/after — no new diff on them
from this task): `src/security/service.ts` (already correct, per T58),
`src/security/types.ts`, `src/security/config.ts`, `src/health/config.ts`,
`src/flow/service.ts`, `src/health/service-status.test.ts` (read, no change
needed — its one existing test does not touch a malformed report). Spec
written before coding: `T61-spec.md` (same directory).

All raw logs are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## Defect 1 — F-002: the false incident, and the mode determination

### Part A: the fix

`evaluateSelfProtection` (`self-protect.ts`)'s mode-downgrade and
disabled-policy arms now both start `if (!config.configUnreadable && ...)`.
`writeState`'s call site in `service.ts` already had this guard from T58;
this task adds the same guard to the two `appendIncidents`-feeding arms in
`evaluateSelfProtection`, which T58 left unguarded. The checksum-mismatch arm
is untouched — it compares `config.policies`/`config.configChecksum`
against each other, never against `previous`, so a broken config owes it
nothing.

### Part B: the mode determination (`isBlockingMode` vs `MODE_RANK`)

**Conclusion: `MODE_RANK` (`self-protect.ts`) reflects the intended
meaning — `gateway` is the strictest recognized posture — and
`isBlockingMode` (`guard.ts`) was the stale half. `isBlockingMode` now
groups `"gateway"` with `"enforced"`/`"ci"` (blocking); only `"advisory"`
stays non-blocking.**

**Evidence, in the order it was weighed:**

1. **What must keep passing pins the direction.** T58's own committed
   regression `"T58 D2"` in `security.test.ts` is titled around "Real state:
   gateway (the strictest rank)" and asserts `gateway → ci` (across a broken
   window) **is** a detected downgrade. This dispatch separately requires
   T57's own probe (`T57-state.ts` S2 — `gateway→ci`, `enforced→advisory`,
   `ci→advisory`, `gateway→advisory`) to keep reporting
   `genuineDowngradeDetected: true` for all four shapes. Two of those four
   (`gateway→ci`, `gateway→advisory`) are downgrades **only if** `gateway`
   outranks `ci`/`enforced`/`advisory`. Moving `MODE_RANK` down to agree
   with the *old* `isBlockingMode` (report-only) would flip both from
   "detected" to "missed" — not an available option, since both are
   must-keep-passing. This alone rules out changing `MODE_RANK`.
2. **No design document contradicts it, and none of them describe `gateway`
   at all** beyond enumerating it as a valid `SecurityMode` (checked:
   `docs/requirements/keryx-agent-first-core/{policies,specification,prd}.md`,
   `.metaproject/modules/security.md`, `schemas.ts` — zero prose hits for
   "gateway" outside the enum declaration; `git log --grep=gateway` over the
   whole history returns commits about unrelated model-provider/HTTP
   gateways, none about this mode). The only prose describing intent is
   `guard.ts`'s own `"(Phase 4)"` comment on `isBlockingMode` — which reads
   as a placeholder for a mode whose full behavior was not yet built, not a
   considered decision that `gateway` should be the single MOST permissive
   recognized mode.
3. **The module's own fail-closed discipline argues the same direction.**
   `isBlockingMode`'s `default` arm already blocks for anything outside the
   four recognized modes; `loadSecurityConfig` forces an unrecognized
   *declared* mode to the strictest recognized value, never the most
   permissive. A mode explicitly named for being not-yet-fully-specified
   ("Phase 4") defaulting to the single most permissive recognized behavior
   — even more permissive than `advisory`'s reason for being non-blocking,
   since `gateway` isn't `advisory` — runs against that pattern everywhere
   else in this file.

Given (1) forces `MODE_RANK` to stay fixed and (2)+(3) supply no
counter-evidence for keeping `gateway` non-blocking, `isBlockingMode` is the
one that moves. This flows automatically into `securityFlowGate`
(`guard.ts:438`, unedited — it already calls `isBlockingMode(mode)`), so
`gateway` now also takes the `enforced`/`ci` path there instead of the
"informational pass" shortcut.

**Committed expectation corrected**: `guard.test.ts`'s `"T54 D1c"` test
asserted `{ mode: "gateway", blocks: false }` and, under that mode, that a
planted AWS key is `allowed: true`. Corrected to `{ mode: "gateway", blocks:
true }`, with a comment recording why (not silently flipped — see the diff
and the comment above the table). RED for this correction was verified by
temporarily reverting `isBlockingMode` and re-running the test (see
Verification below) — it fails at exactly `expect(guard.allowed).toBe(!blocks)`,
`Expected: false, Received: true`, i.e. the pre-fix code lets a real AWS key
through under `gateway`.

**Residual, disclosed, out of ownership**: `src/commands/security.ts`'s
`reportExitCode`/`exitCodeFor` still classify `gateway` with `advisory`
(report-only) for the `security report`/`security scan` CLI exit code —
confirmed by `ctx rg "isBlockingMode|MODE_RANK" src/commands/security.ts`
(three doc-comment mentions, no import; its own hard-coded
`mode === "ci" || mode === "enforced"` checks do not include `gateway`).
That file is owned by a different task (T55) and is not in this dispatch's
file set, so this task does not close it — named here rather than left
silent, the same discipline T57 used when it named this exact disagreement
without fixing it.

### What an operator sees, in each window

- **Config fine, mode unchanged.** No change from before this task.
- **Config broken (either shape — unusable payload or unrecognized mode),
  prior real mode ranked at or below the forced `enforced`.** No change:
  this was already silent before (the forced value never ranked lower than
  the real `previous` in these cases), and stays silent.
- **Config broken, prior real mode `gateway` (the only mode above the forced
  `enforced`).** Before this task: a `mode-downgrade` warning is printed on
  the broken run AND a durable incident is appended to `incidents.jsonl`,
  which survives an eventual repair back to the same `gateway`. After: the
  broken run prints nothing about a downgrade and appends no incident — the
  window is silent, which is correct because nothing was actually weakened
  (during this exact window, `gateway` now blocks exactly like
  `enforced`/`ci`, and the forced `enforced` blocks too — same class of
  posture, not a weaker one; and even before Part B, `guardOutput`/
  `securityFlowGate` were already refusing everything for the
  posture-unavailable reason, so "weakened" was never the true story here).
- **Config repaired, to the SAME mode that was recorded before the break.**
  No warning, no incident — real compared to real, matching.
- **Config repaired, to a GENUINELY different (weaker) mode than what was
  recorded before the break.** Warning printed and incident appended,
  exactly as before this task (T58's behavior, unaffected — the comparison
  that fires this happens on a config-readable run, where the new
  `!config.configUnreadable` guard does not apply).
- **First run ever, config already broken, no prior state.** Unchanged:
  silent, no incident, `state.json` still does not exist (the mode/policy
  comparisons are `if (previous)`-guarded and `previous` is `null`).

## Defect 2 — F-003: the health shape guard, and the field enumeration

### Enumeration method

`readLatest()` (`health/service.ts`) has exactly four callers, all within
the same file. I found this by reading the whole file top to bottom (a
`ctx rg "readLatest\("` search under-reported the count in its truncated
match display — it showed 4 of the 6 raw hits it counted; a direct `Read` of
`service.ts` confirmed the true count) and listing every call: `status()`
(:212), `gate()` (:235), `explain()` (:251), `updateBaseline()` (:283). For
each, I read every property access on the returned `latest` value and
classified it as "already null/shape-safe at this access site" or not:

| Reader | Field | Access | Guarded before this fix? |
|---|---|---|---|
| `gate()` | `.gate.status`, `.gate.reasons` | `:243`, `:245`, reached only after `if (!latest)` | yes — `hasGateShape` already validated `.gate` (T55) |
| `status()` | `.metrics` | `.find` (:213), `.filter`×2 (:214, :217) | **no** — `latest?.metrics` only short-circuits on `latest` being null, not on `.metrics` itself |
| `status()` | `.sources` | `.map` (:224-226) | **no**, same reason |
| `explain()` | `.metrics` | `.find` (:257) | **no** — reached after `if (!latest) return`, so `latest` itself is safe, but `.metrics` is not |
| `explain()` | `.findings` | `.filter` (:264) | **no**, same reason |
| `updateBaseline()` | `.metrics` | passed to `writeBaseline` (:291) | **no**, but only reachable when `readLatest` wrongly returns a truthy-but-malformed value; the existing `if (!latest) { ...runHealth... }` fallback (unmodified) is what protects this call once `readLatest` correctly returns `null` |

Three fields were dereferenced without their own guard: `.metrics`,
`.sources`, `.findings` — all required (non-optional) arrays on
`HealthReport` (`health/types.ts:158`). The dispatch's own text named only
`status()` and its `.metrics` case (matching F-003's exact reproduction),
but reading all four callers — not just the two F-003 measured — surfaced
that `explain()` has the identical unguarded-`.metrics`/`.findings` pattern,
independently of F-003's own probe (which only exercised `gate()` and
`status()`).

### Fix

`hasGateShape` (kept its name — minimal diff, still the single choke point
both existing callers and the doc comment already point to) now additionally
requires `Array.isArray(value.metrics) && Array.isArray(value.sources) &&
Array.isArray(value.findings)`, checked after the existing `.gate` shape
check. A report failing any of these folds into the exact same "unusable
evidence" path `readLatest` already used for an absent file — `null` — so
every one of the four readers gets its own existing null-handling behavior:
`gate()`/`explain()` return their built-in "no report"/"not found" answers,
`status()` returns its all-null/empty defaults, `updateBaseline()` recomputes
via `runHealth()`. None of the four readers throws.

One consequence worth stating plainly: for a report whose `gate` sub-object
is well-formed but the surrounding report is truncated (E18: no
`metrics`/`sources`/`findings` at all), `gate()`'s answer changes from a
clean `pass` (T57's own measured baseline: `{"status":"pass","exitCode":0}`)
to the "no report" `fail`. This is the correct, stricter direction — a
report missing most of its own fields is not trustworthy evidence that
nothing else about it might also be wrong, and AC4/AC8 read "a required
check that is missing, skipped, unparsed or unfinished is an incomplete
outcome and never a pass." Confirmed by temporarily reverting the extended
check and re-running the new regression: RED shows `gate()` returning
`"pass"` on that exact fixture before the fix (see Verification).

### What an operator sees

- **A genuinely absent report** (`latest.json` never written). Unchanged:
  `gate()` and `explain()` give their existing "no report"/"not found"
  answers; `status()` gives its all-null defaults; `updateBaseline()` runs a
  fresh `runHealth()`.
- **A well-formed report.** Unchanged: every reader reads real data.
- **A stored report with a malformed `gate` (no `gate` key, `gate` a bare
  array/string/null, `status`/`reasons` wrong type).** Unchanged from T55 —
  already folds to "no report" at every reader, no throw.
- **A stored report with a well-formed `gate` but `metrics`/`sources`/
  `findings` absent or wrongly typed (T57 F-003's own case).** Before this
  task: `gate()` returned whatever the well-formed `gate` said (a false
  "clean pass" for E18, since nothing else was checked); `status()` and
  `explain()` threw a raw `TypeError` to their caller (`keryx health
  status`/`keryx health explain`/their MCP tools). After: all three readers
  give the same "no report"/"not found" answer as a genuinely absent report
  — no throw, no false pass.

### Regressions (`src/health/service-gate-exit.test.ts`)

Two new tests, each verified through `gate()`, `status()`, AND `explain()`
(mirroring the reviewer's E18/E19 rows, extended to the two readers the
reviewer's probe did not check):

- `"a stored report with a sound gate but ABSENT metrics/sources/findings is
  unusable evidence at gate(), status() and explain(), not a thrown error"`
- `"a stored report with a sound gate but metrics as a STRING is unusable
  evidence at gate(), status() and explain(), not a thrown error"`

`updateBaseline()` was deliberately not given its own regression: exercising
it authentically triggers a real `runHealth()` pass (file scanning, source
detection) over the fixture directory — a much heavier integration surface
than the other three readers, and the code path it exercises when
`readLatest` returns `null` (recompute via `runHealth`) is pre-existing and
unmodified by this fix. Disclosed here explicitly rather than silently
omitted, which is the exact gap this task closes for `status()`.

## Regressions (`src/security/security.test.ts`)

`"T61 D1"`: for both broken shapes (`"null"`, unusable payload; and
`'{"mode":"ENFORCED"}'`, unrecognized mode), pins that a broken run against a
real, higher-ranked `previous` (`gateway`) writes no `mode-downgrade`
incident and prints no "downgraded" warning — neither during the broken
window itself (which T58's own `"T58 D2"` never checked: D2 only asserts
`readState` after the broken run and incidents after the FINAL reconfigure,
never incidents immediately after the broken run) nor after a repair back to
the same mode. `"T58 D1/D2/D3"` are unmodified and still pass, including D2's
pin that `gateway → ci` after a broken window is still a detected downgrade.

## RED (established by temporary revert, not git)

Per this repo's "no git state changes" constraint, RED for each change was
established by temporarily reverting the specific line(s) with `Edit`
(never `git`), running the new/corrected test, observing the failure, then
re-applying the fix with `Edit` — not by quoting pre-edit source, since the
code was easy to revert precisely:

| Change | RED command | RED result | Raw log |
|---|---|---|---|
| `evaluateSelfProtection`'s new guard | `bun test src/security/security.test.ts -t "T61 D1"` | 1 fail at the intermediate `broken.warnings` assertion (`Expected: false, Received: true`) — pins the bug, not a downstream symptom | `2026-09-06T16-47-58-055Z_run.log` |
| `isBlockingMode`'s `gateway` reclassification | `bun test src/security/guard.test.ts -t "T54 D1c"` | 1 fail at `expect(guard.allowed).toBe(!blocks)` (`Expected: false, Received: true`) — a real AWS key let through under `gateway` | `2026-09-06T16-48-11-929Z_run.log` |
| `hasGateShape`'s extended fields | `bun test src/health/service-gate-exit.test.ts -t "ABSENT metrics"` | 1 fail at `gateResult.status` (`Expected: "fail", Received: "pass"`) — a truncated report reads as a clean pass | `2026-09-06T16-48-58-249Z_run.log` |

## Verification

| Check | Result | Raw log |
|---|---|---|
| Baseline (before any edit): `bun src/cli.ts ctx run -- bun test src/security/security.test.ts src/security/guard.test.ts src/health/service-gate-exit.test.ts src/health/service-status.test.ts` | **60 pass / 0 fail**, 440 expect() | `2026-09-06T16-46-05-750Z_run.log` |
| Same command, after | **63 pass / 0 fail**, 473 expect() | `2026-09-06T16-49-27-654Z_run.log` |
| Required: `bun src/cli.ts ctx run -- bun test src/security/ src/health/` | **336 pass / 0 fail**, 1722 expect(), 42 files | `2026-09-06T16-49-38-257Z_run.log` |
| Reviewer probe `T57-state.ts`, before | S6 (both broken shapes): `durableIncidentWrittenByTheBrokenRun: true` | `T61-state-before.log` |
| Reviewer probe `T57-state.ts`, after | S6 (both broken shapes): `durableIncidentWrittenByTheBrokenRun: false`; S2 (both broken shapes, all 4 shapes): `genuineDowngradeDetected: true`, unchanged; S1/S3/S4/S5/S7 byte-identical | `T61-state-after.log` |
| Reviewer probe `T57-health.ts`, before | E18/E19: `statusThrew` non-null; E18 `gateResult.status: "pass"` | `T61-health-before.log` |
| Reviewer probe `T57-health.ts`, after | E18/E19: `statusThrew: null`, `gateResult` the constant "no report" fail; E01-E17 byte-identical | `T61-health-after.log` |
| `bun src/cli.ts ctx run -- bun run typecheck` | clean, exit 0 | `2026-09-06T16-50-33-615Z_run.log` |
| `bun src/cli.ts ctx run -- bunx eslint src/security/self-protect.ts src/security/service.ts src/security/security.test.ts src/security/guard.ts src/security/guard.test.ts src/health/service.ts src/health/service-gate-exit.test.ts` | clean, no output, exit 0 | `2026-09-06T16-50-39-580Z_run.log` |

Both reviewer probes were run directly (`bun .metaproject/flows/.../T57-state.ts`,
`bun .metaproject/flows/.../T57-health.ts`), not through `ctx run`, for the
same stated reason T57 itself gave: gdctx's compaction drops the per-case
rows that are the evidence. Test/typecheck/eslint runs were routed through
`ctx run`.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| No incident is written for a window in which enforcement was not weakened; a genuine downgrade across such a window is still detected, including the four shapes already covered. | met | `T61 D1` (new, RED→GREEN) + probe `T57-state.ts` S6 (`durableIncidentWrittenByTheBrokenRun: false`, both broken shapes) and S2 (`genuineDowngradeDetected: true`, all 4 shapes × both broken shapes, unchanged). |
| The two mode notions agree, with the conclusion justified from the code and the policy rather than by preference. | met | `isBlockingMode` now groups `gateway` with `enforced`/`ci`; justification above cites the must-keep-passing regressions, the absence of any design doc naming a different intent, and the module's own fail-closed pattern elsewhere. `guard.test.ts`'s refuted `blocks: false` row corrected in writing. |
| An unusable stored health report yields the existing unusable-evidence outcome from every reader, with no thrown exception; regressions fail before and pass after. | met | `hasGateShape` extended; two new regressions verified through `gate()`/`status()`/`explain()`, RED confirmed by temporary revert, GREEN after. `updateBaseline()`'s reliance on the same fix is structural (unmodified fallback branch) and disclosed, not silently untested. |
| AC4 (AFC-05) and AC8: a required check that is missing, skipped, unparsed or unfinished is an incomplete outcome and never a pass; no durable record asserts something that did not happen; reasons and details stay constant and leak-safe. | met | E18's `gate()` answer moved from a false `pass` to the constant "no report" `fail`. No new incident, warning, or health reason string was introduced — the mode-downgrade guard only suppresses an existing call under a condition; the health fix reuses the pre-existing constant reasons. Neither change touches leak-safety (no new interpolation of raw content, paths, or error text). |

## Concerns

1. **`src/commands/security.ts`'s exit-code folds still classify `gateway`
   with `advisory`**, now diverging from the corrected `isBlockingMode` —
   disclosed above, out of this task's ownership (T55 owns that file).
2. **`updateBaseline()` has no dedicated regression** for the shape hole it
   shares structurally with the other three readers — disclosed above with
   the reasoning (heavier integration surface, unmodified fallback branch)
   rather than left silent.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact files,
functions, and prior findings (T57 F-002/F-003, T58, T55); the open
questions — who else reads `state.json`/`readLatest`, whether `gateway` is
described anywhere else — are text-shape questions `ctx rg` answers
directly, and the graph's manifest documents that it answers from the last
`gdgraph build`, not the uncommitted working tree, which this branch is);
wiki_used: no (not-relevant — the normative sources are
`docs/requirements/keryx-agent-first-core/policies.md`, the frozen
`acceptance-criteria.md`, and the cited prior task artifacts (T57, T58,
T55), all read directly; `keryx-tooling-caveats` project memory also flags
gdgraph/gdctx blast-radius answers as historically wrong on this repo, an
independent reason to prefer direct reads and `ctx rg` here); ctx_used: yes
(every project-code and doc search via `bun src/cli.ts ctx rg`, every
test/typecheck/eslint run via `bun src/cli.ts ctx run`, all raw logs cited
above by path; the two reviewer probes and the RED confirmations were run
directly, per the stated gdctx-compaction-drops-rows reason); raw_rg_used:
no — no bare `rg`/`grep`/`cat`/`find`/`sed` was run over project code or
docs; every search went through `ctx rg`, every multi-line file excerpt
through the `Read` tool with bounded offsets, and the one bare `git status
--porcelain` invocation used for ownership verification is not a content
search.`
