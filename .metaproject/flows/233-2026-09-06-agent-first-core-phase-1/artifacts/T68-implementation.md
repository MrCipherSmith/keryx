# T68 implementation — closing T62 F-002, F-003, F-004

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Files
changed: `src/security/self-protect.ts`, `src/security/security.test.ts`,
`src/security/templates.ts`, `src/security/templates.test.ts` (new),
`docs/docs/cli-reference.md`. Spec written before coding: `T68-spec.md` (same
directory).

All raw logs are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## Residual 1 — F-002: `MODE_RANK` still ranks `gateway` above `enforced`/`ci`

**Reproduced**: yes, exactly as described. `bun
.../artifacts/T62-mode.ts` before any edit (`T68-T62-mode-before.log`): `M3
rank` shows `{"from":"gateway","to":"enforced","downgradeDetected":true}` and
`{"from":"gateway","to":"ci","downgradeDetected":true}`, while `M1`/`M2` in
the same run show `gateway`, `ci`, `enforced` are behaviourally identical at
every command surface (`scan`/`report`/`check-input`/`check-output`) and both
module seams (`guardOutput`/`securityFlowGate`).

**What changed**: `MODE_RANK` in `self-protect.ts` — `gateway` moved from `3`
to `2`, tying it with `enforced`/`ci` (still `2`); `advisory` unchanged at
`1`.

**What the rank now expresses**: two behavioural classes, not four ranks for
four modes. `{gateway, enforced, ci}` block identically at every site that
branches on mode (`isBlockingMode`, `exitCodeFor`, `reportExitCode`,
`guardOutput`, `securityFlowGate` — T61/T65), so they are tied. `advisory`
alone does not block, so it alone ranks below. A transition within the tied
group is same-rank and stays silent (nothing was weakened — true, since
nothing observable changed). A transition from any of the three down to
`advisory` is still a strict rank drop and is still detected — this is the
"a genuine weakening must still be detected, including from every mode to the
advisory one" requirement, verified for `gateway → advisory`, `ci →
advisory`, and `enforced → advisory` below. The rank was not deleted: it
still exists and still separates the two classes the code actually has.

**Test correction, justified**: `security.test.ts`'s `"T58 D2"` pinned
`gateway → ci` as a detected downgrade — a claim the code no longer makes
once the two are tied. Corrected the test's final reconfigure step from `ci`
to `advisory`, the one mode that remains a genuine, detectable downgrade from
`gateway` under the corrected ranks. Comments explaining the choice were
added in place of the old (now-false) "ci, same rank as enforced, would NOT
read as a downgrade" reasoning. RED was confirmed by running the test against
the fixed `MODE_RANK` before this test correction: `expect(warnings.some(w =>
w.includes("downgraded"))).toBe(true)` failed with `Received: false` — the
predicted, correct consequence of retargeting `ci`, not a bug. GREEN after
retargeting to `advisory`.

`"T61 D1"`'s title and inline comments described `gateway` as "the strictest
rank" / "the only mode a forced enforced ranks below" — both now false
statements (no real mode outranks the forced `enforced` fallback any more,
since the fallback's own rank, 2, is the ceiling). The test's assertions were
unaffected (still pass, unmodified) — only the prose was corrected to state
that the mode-arm's `!config.configUnreadable` guard is now defensive rather
than actively load-bearing for any currently reachable rank pair, while
remaining correct to keep.

**Known, disclosed side-effect on the reviewer's own probe**: `T62-mode.ts`
`M3` is a bare observational dump with no hardcoded expectation and no
verdict field. Its `gateway → ci` and `gateway → enforced` rows now report
`downgradeDetected: false`, down from `true` before this fix — the intended,
correct consequence, not a regression. `T62-mode.ts` is a reviewer artifact,
not owned by this task, and was not edited.

**Known, disclosed side-effect on `T62-state.ts`**: its `MODE_MATRIX` hard-codes
`expectIncidentAfterRepair: true` for the row `["gateway", "ci", "weaker",
true]`, encoding the pre-T68 belief that `gateway` outranks `ci`. Both broken
shapes' `gateway -> BROKEN -> ci` rows now report `verdict: "MISMATCH"`
(`actualIncidentAfterRepair: false` vs the stale `expectedIncidentAfterRepair:
true`) — the same kind of stale-expectation drift T65's implementation report
recorded for `T57-report.ts`'s `R2d` row. `T62-state.ts` is a reviewer
artifact, not owned by this task, and was not edited; the correct new
behaviour is pinned instead by this task's own `security.test.ts` regressions
(`"T58 D2"`, corrected as above).

## Residual 2 — F-003: the disabled-policy guard suppresses a true signal

**Reproduced**: yes, exactly as described. `bun .../artifacts/T62-state.ts`
before any edit (`T68-T62-state-before.log`): row `B1 broken mode + REAL
policy disable in the same file` shows `trueDisableSuppressedDuringWindow:
true` and `B2 ... never repaired` shows `realDisableEverRecorded: false`.

**What changed**: `evaluateSelfProtection`'s disabled-policy loop
(`self-protect.ts`) no longer shares the mode arm's `!config.configUnreadable`
guard — the condition is now `if (previous)` only, same as before T61 added
the guard to this arm.

**Why this is safe and correct, not merely "narrowed"**: `config.configUnreadable`
covers two shapes (`config.ts:238-267`), and they are not the same kind of
value for `policies`:
- An UNUSABLE payload (unparseable, or parses to something other than an
  object) makes `loadSecurityConfig` fall back to `mergeSecurityConfig({})`
  — the built-in defaults, where every one of the five policies is `enabled:
  true` (`DEFAULT_SECURITY_CONFIG.policies`, `config.ts:22-28`). The loop's
  own condition (`previous.policies[name] === true && enabled === false`)
  requires `enabled === false`, which this shape can never produce. The old
  guard was provably a no-op for this shape (confirmed: `T62-state.ts` B3,
  unchanged before/after this fix), so removing it changes nothing here.
- An UNRECOGNIZED-MODE payload (the file parses as an object, but its
  declared `mode` is outside the recognized union) makes `loadSecurityConfig`
  keep the operator's REAL, parsed `policies` (`config.ts:257-267` — the
  loader's own comment: "the operator's own `policies`... are still theirs")
  while still setting `configUnreadable: true`. A policy the operator
  genuinely disabled in that very file is real news about their own bytes,
  not a derived substitute, and the old guard silenced it — the defect.
No second flag or default-comparison was needed to tell the two shapes apart:
the unusable-payload shape's policies are unconditionally all-`true`, not
merely usually so, so the loop's own `enabled === false` test already
discriminates correctly once the guard is not there to override it. This
reasoning, plus the two `config.ts` line references, is recorded as a comment
above the loop in `self-protect.ts` so a future reader does not need to
re-derive it.

**Comment correction**: the old comment ("a forced/derived config's
policies... are not an operator's choice either") was false for the
unrecognized-mode shape (the reviewer's own point). Replaced with the
shape-specific argument above.

**New regressions** (`security.test.ts`, `T68 B0`/`D1`/`D2`/`D3`): `B0`
control (readable config, real disable, detected — unaffected by this fix);
`D1` (broken mode + real disable in the same file → now detected DURING the
window, matching `T62-state.ts` B1's corrected reading); `D2` (never
repaired, three runs → detected on every run, matching B2); `D3` (unusable
payload after a real prior disable → stays silent, pinning that the guard's
removal changes nothing for that shape, matching B3). RED was established by
temporarily reverting the guard back to `!config.configUnreadable &&
previous` and re-running: `D1` and `D2` failed exactly as predicted
(`Expected: true, Received: false` at the "was disabled" warning assertion);
`B0` and `D3` passed regardless, as expected (they do not exercise the
defect). GREEN after restoring the fix — raw logs below.

## Residual 3 — F-004: stale prose describing `gateway` as unimplemented/non-blocking

**Reproduced**: yes, exactly as described, read directly.
`docs/docs/cli-reference.md:2096` (pre-edit): "Model/API backends and gateway
mode (Phase 4) are not implemented." `src/security/templates.ts:62-64` and
`:124` (pre-edit): enumerate only `enforced`/`ci` as blocking, omitting
`gateway`.

**What changed**:
- `docs/docs/cli-reference.md`: the sentence now states that `mode:
  "gateway"` already blocks like `enforced`/`ci` — the write seam, the flow
  completion gate, and the exit code of `scan`/`report`/`check-input`/
  `check-output` — and that only `gateway`'s own Phase-4 proxy behaviour (and
  model/API backends generally) are not implemented.
- `src/security/templates.ts:62-64` (`renderSecurityManifest`, the pre-push
  hook's blocking-mode enumeration): `enforced`/`ci` → `enforced`/`ci`/`gateway`.
- `src/security/templates.ts:124` (`renderSecurityCoreReadme`, the `check()`
  blocking-mode enumeration): `enforced`/`ci` → `enforced`/`ci`/`gateway`.

**What an existing project sees, and what must migrate**: `renderSecurityManifest`
and `renderSecurityCoreReadme` are only re-rendered onto disk by `keryx init`
(new project) or `keryx update` (existing project — its own "Lifecycle"
section states "`update` refreshes service files (this manifest, core
README, config if missing) without touching `data/security`"). An existing
project's `.metaproject/modules/security.md` and `.metaproject/core/README.md`
keep reading the old, incomplete `enforced`/`ci`-only enumeration until that
project's owner runs `keryx update` — nothing else migrates: no schema,
config shape, or state format changed, only the prose these two generator
functions return. This is not made automatic or mandatory by this task; it is
the same refresh path every other manifest-text correction in this module
already goes through.

**New regressions** (`src/security/templates.test.ts`, new file — no prior
test file existed for `templates.ts`): pins that `renderSecurityManifest`
contains `` `enforced`/`ci`/`gateway` block the push `` and does not contain
the old `` `enforced`/`ci` block the push `` string; pins that
`renderSecurityCoreReadme` contains `` `enforced`/`ci`/`gateway` mode a ``
and does not contain the old `` `enforced`/`ci` mode a `` string; plus two
baseline sanity tests (non-empty manifest prose, `securityCapabilities()`'s
canonical list) so the new file is not a single-purpose regression file. RED
was established by temporarily reverting both `templates.ts` edits and
re-running: both new "names gateway" tests failed exactly as predicted
(`toContain` mismatch showing the un-updated prose). GREEN after restoring
the fix.

**Out of ownership, disclosed not fixed** (F-004 named these too, but none
are in this task's ownership list — `src/security/self-protect.ts`,
`src/security/service.ts`, `src/security/security.test.ts`,
`src/security/templates.ts`+tests, and the gateway lines in
`docs/docs/cli-reference.md` only): `.metaproject/modules/security.md:48`,
`docs/docs/architecture.md:547,563`, `docs/docs/modules.md:865,874,881`,
`docs/docs/workspace-and-lifecycle.md:339,350`, the other
`docs/docs/cli-reference.md` sites (`:330,754,912,993,1058`), and
`src/commands/init.ts:497`'s interactive prompt string ("...enforced/ci mode
only)? Recommended") all still carry the same stale `enforced`/`ci`-only
framing. None edited; named here per the same discipline the rest of this
phase uses for disclosed-not-fixed residuals.

## Verification

| Check | Before | After | Raw log |
|---|---|---|---|
| Reviewer probe `T62-state.ts` | B1 `trueDisableSuppressedDuringWindow: true`; B2 `realDisableEverRecorded: false`; all 22 mode-matrix rows `OK` | B1 `trueDisableSuppressedDuringWindow: false`; B2 `realDisableEverRecorded: true`; 20/22 mode-matrix rows `OK`, 2 rows (`gateway -> BROKEN -> ci`, both broken shapes) `MISMATCH` against the probe's own stale hardcoded expectation — explained above, not a regression | `T68-T62-state-before.log` / `T68-T62-state-after.log` |
| Reviewer probe `T62-mode.ts` | `M3`: `gateway->ci` and `gateway->enforced` both `downgradeDetected: true`; `M1`/`M2` show gateway/ci/enforced behaviourally identical | `M3`: `gateway->ci` and `gateway->enforced` now `downgradeDetected: false`; `gateway->advisory`/`ci->advisory`/`enforced->advisory` still `true`; `M1`/`M2` unchanged (untouched by this fix, still identical) | `T68-T62-mode-before.log` / `T68-T62-mode-after.log` |
| `bun src/cli.ts ctx run -- bun test src/security/ src/commands/` | 1243 pass / 6 skip / 0 fail, 5214 expect(), 99 files | **1251 pass / 6 skip / 0 fail, 5233 expect(), 100 files** | `2026-09-06T17-47-31-892Z_run.log` / `2026-09-06T17-53-48-907Z_run.log` |
| `security.test.ts` `T58 D2` alone | RED after `MODE_RANK` fix, before test correction: `Expected: true, Received: false` | pass | inline (not `ctx run`, direct `bun test`, per gdctx-compaction-drops-rows precedent) |
| `security.test.ts` `T68 D1`/`D2` alone (RED via temporary guard revert) | 2 fail (`Expected: true, Received: false`), `B0`/`D3` pass regardless | 4 pass (`B0`/`D1`/`D2`/`D3`) | inline |
| `templates.test.ts` "names gateway" tests (RED via temporary revert) | 2 fail (`toContain` mismatch) | 4 pass (whole file) | inline |
| `bun src/cli.ts ctx run -- bun run typecheck` | — | clean, exit 0 | `2026-09-06T17-55-30-441Z_run.log` |
| `bun src/cli.ts ctx run -- bunx eslint src/security/self-protect.ts src/security/security.test.ts src/security/templates.ts src/security/templates.test.ts docs/docs/cli-reference.md` | — | clean, 0 errors (1 informational warning: eslint has no config for `.md`, expected) | `2026-09-06T17-55-46-255Z_run.log` |

Both reviewer probes were run directly (`bun .metaproject/flows/.../T62-state.ts`,
`bun .metaproject/flows/.../T62-mode.ts`), not through `ctx run`, per the same
stated reason prior tasks in this phase gave: gdctx's compaction can drop the
per-case rows that are the evidence. The RED/GREEN confirmations for
individual test corrections were likewise run with direct `bun test -t
"<name>"` invocations for the same reason; the required aggregate suite runs
and the typecheck/eslint runs were routed through `ctx run`.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC8: no durable record asserts something that did not happen, and no shipped guidance describes behaviour the code does not have. | met | F-002: `gateway → enforced`/`gateway → ci` no longer write a `mode-downgrade` incident or an "(enforcement weakened)" warning (`T62-mode.ts` M3, `T62-state.ts` MODE_MATRIX rows). F-004: `cli-reference.md` and `templates.ts` no longer say gateway is unimplemented/non-blocking. |
| A genuine weakening is still detected from every mode, including to the advisory one; a genuinely disabled policy in a window with an unrecognized mode is still reported. | met | F-002: `gateway → advisory`, `ci → advisory`, `enforced → advisory` all still `downgradeDetected: true` (`T62-mode.ts` M3) / still write `mode-downgrade` (`T62-state.ts` MODE_MATRIX). F-003: `T62-state.ts` B1/B2 now detect the real disable during the window and on every subsequent broken run; `security.test.ts` T68 D1/D2 pin the same at the unit level. |
| Regressions fail before the change and pass after; `bun test src/security/ src/commands/` stays green. | met | RED/GREEN tables above for every new/corrected test; suite went from 1243→1251 pass, 0 fail both before and after. |

## Concerns

1. Two out-of-ownership residuals from F-004 remain unfixed and are disclosed
   above (`src/commands/init.ts:497`'s prompt string, and five other doc
   files) — none are in this task's file-ownership list.
2. `T62-state.ts` and `T62-mode.ts` (reviewer artifacts, not owned by this
   task) now contain stale hardcoded expectations for the `gateway → ci`
   pair specifically in `T62-state.ts`'s `MODE_MATRIX`; not edited, per
   ownership, and the correct behaviour is independently pinned by this
   task's own `security.test.ts` regressions.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact files,
functions, and prior findings (T62 F-002/F-003/F-004, T61, T65); the open
questions are text-shape questions `ctx rg` answers directly, and the
graph's own manifest documents it answers from the last `gdgraph build`, not
the uncommitted working tree, which this branch is; `keryx-tooling-caveats`
project memory also flags gdgraph/gdctx blast-radius answers as historically
wrong on this repo); wiki_used: no (not-relevant — the normative sources are
`docs/requirements/keryx-agent-first-core/policies.md`, the frozen
`acceptance-criteria.md`, and the cited prior task artifacts (T61, T65,
T62-review.md), all read directly); ctx_used: yes (every project-code and doc
search via `bun src/cli.ts ctx rg`, the two required aggregate test/typecheck/
eslint runs via `bun src/cli.ts ctx run`, all raw logs cited above by path;
the two reviewer probes and the individual RED/GREEN test confirmations were
run directly via bare `bun test`/`bun <script>`, per the stated
gdctx-compaction-drops-rows reason this phase has used throughout);
raw_rg_used: no — no bare `rg`/`grep`/`cat`/`find`/`sed` was run over project
code or docs; every search went through `ctx rg`, every multi-line file
excerpt through the `Read` tool at bounded offsets.`
