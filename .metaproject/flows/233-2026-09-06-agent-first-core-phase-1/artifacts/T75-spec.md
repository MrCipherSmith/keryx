# T75 spec — closing T70 F-001..F-004

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Written
before any edit, per the dispatch's own requirement.

## Item 1 (blocking) — F-001: three shipped guidance sites stale about `ci`/`enforced`, not only `gateway`

**Reproduced independently before editing**, via the reviewer's own probe
`T70-guidance.ts`, run unmodified:
`bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T70-guidance.ts`
→ `.metaproject/data/gdctx/raw/T75-guidance-before.log`. Measured cells (section
A0) and claim predicates (A2-A5 all `CLAIM_HOLDS:false`) match T70-review.md's
own numbers exactly:
- `report|enforced|fail` = 1, `report|gateway|fail` = 1,
  `report|ci|needs-approval` = 1, `report|ci|incomplete` = 1,
  `report|enforced|incomplete` = 1, `scan|gateway|fail` = 1,
  `check-input|gateway|secret` = 1 — all against `advisory` = 0 everywhere.
- The code fold measured (read-only, not edited): `src/commands/security.ts:682-687`
  (`reportExitCode`) and `:971-976` (`exitCodeFor`) both test
  `mode === "ci" || mode === "enforced" || mode === "gateway"`, then
  `isPassGate(gate) ? 0 : 1` — i.e. every mode in that set exits `1` on
  anything except `pass` (`fail`, `needs-approval`, `incomplete`, or an
  unrecognized stored gate value, since `isPassGate`'s `switch` has no
  default-true arm). `report` uses the identical fold, reading the gate from
  the last stored scan artifact rather than rescanning.

**Sites to correct** (both inside T73's declared ownership, per T70-review.md
`class_scope`):
1. `docs/docs/cli-reference.md:2137-2146` — the "Exit behavior" paragraph.
   Currently claims: `ci` exits 1 only on `fail`; `enforced` exits 1 only on
   `fail`/`needs-approval`; `report` exits 1 only under `ci` on `fail`; and
   omits `gateway` from the `scan`/`check-input`/`check-output` enumeration.
   Correct to: `enforced`/`ci`/`gateway` all exit `1` on any gate other than
   `pass` (`fail`, `needs-approval`, `incomplete`, or unrecognized); `report`
   shares the same fold, reading the stored gate instead of rescanning.
2. `docs/docs/modules.md:784-786` — same enumeration, same correction.
3. `docs/docs/modules.md:778` — the `security report` Exit table cell,
   currently "**1 in `ci` mode when gate = fail**". Correct to "**1 in
   `enforced`/`ci`/`gateway` mode on a non-passing gate**" (reviewer's own
   suggested wording, matches the measured fold).

**Left alone, confirmed accurate** (not touched): `cli-reference.md:2095-2099`
(T68's paragraph — measured accurate by T70's own A6, `CLAIM_HOLDS:true`);
`modules.md:766` ("always-on gateway mode (Phase 4) remains not implemented" —
about the unimplemented Phase-4 proxy, not `mode:"gateway"`); the 15 other
sites T73 already corrected (`cli-reference.md:330,754,912,993,1058`;
`modules.md:865,874,881`; `architecture.md:547,563,634`;
`workspace-and-lifecycle.md:339,350`; `.metaproject/modules/security.md:48`;
`.metaproject/core/security/README.md:17`; `src/security/templates.ts:63,125`;
`src/commands/init.ts:497`) — re-verified present via the same probe's
section B (`manifestStillHasOldForm:false`, `readmeStillHasOldForm:false`,
on-disk copies matching), not re-touched.

## Item 2 (minor) — F-002: fourth `SourceRunInfo.error` producer, not a catch binding

**Reproduced independently before editing**, via the reviewer's own probe
`T70-health-leak.ts` run unmodified (as a plain `bun` script, not `bun test` —
it uses `mock.module` at top level in its own process, matching how the
reviewer ran it):
`bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T70-health-leak.ts`
→ `.metaproject/data/gdctx/raw/T75-health-leak-before.log`. Row `P1` (the
positive control planting the same bytes through `validation.error`, the site
T69 did not touch): `sourceError` is the raw planted text verbatim, and all
four `LEAK_*` fields report `path:true, cred:true` — reproduced exactly as
T70-review.md's F-002 states. Rows H1-H6/C0 (the three already-repaired catch
arms plus the errno-preservation and control rows) are all clean, confirming
the probe can see a leak and that the three T69 sites remain closed.

**Re-enumeration by write site, not by `catch` binding**, per the dispatch's
own instruction (item 2's whole point):
`bun src/cli.ts ctx rg "error:" src/health --glob '!*.test.ts'` — compacted
summary undercounted again (header said 14 matches, rendered list showed
13, run.ts shown with only 4 of its 7 actual hits); raw log
`.metaproject/data/gdctx/raw/2026-09-06T18-44-49-196Z_rg.log` read directly,
15 lines, every one read:

| Site | Text | Disposition |
|---|---|---|
| `run.ts:279` | `` `source detection failed${errorCodeSuffix(error)}` `` | repaired by T69, safe (constant + closed-vocab errno) |
| `run.ts:314` | `` `source execution failed${errorCodeSuffix(error)}` `` | repaired by T69, safe |
| `run.ts:336` | `` `source parse failed${errorCodeSuffix(error)}` `` | repaired by T69, safe |
| `run.ts:356-358` | `validation?.error ?? "source output format was not recognized"` (parseFailed branch) / `` `source command exited ${raw.exitCode} without recognized findings` `` (else branch) | **THE DEFECT** — `validation.error` is adapter-supplied free text from `SourceAdapter.validate()` (`types.ts:224`, a public extension point), interpolated verbatim into the same `SourceRunInfo.error` field the three repaired sites write, which `gate.ts:78-79` folds into `gate.reasons` identically. The `raw.exitCode` half is numeric-only, safe. |
| `run.ts:399` | `"excluded by source filter"` | constant, safe |
| `sources/eslint.ts:122,124` | `"ESLint JSON format was not recognized"` / `"ESLint JSON parse failed"` | constants, safe — the only two strings `eslint`'s `validate()` can return |
| `sources/dependency-audit.ts:14,28,36,97,145` | type decl, `"dependency audit JSON contains an invalid or unsupported entry"`, `"dependency audit JSON parse failed"`, `"dependency audit JSON format was not recognized"`, and `:145` which forwards `decoded.error` — read `decodeAudit` in full: every return path is one of the same three literals | constants, safe — the only three strings `dependencyAudit`'s `validate()` can return, `:145` forwards one of them, never fabricates new text |

Confirms T69's own claim independently too: `catch (` over `src/health`
returns exactly 4 hits, all in `run.ts` (`:271` detect, `:289` import/run
outer, `:296` NoImportError inner control-flow only, `:323` parse) — the
`catch`-binding axis structurally cannot reach `run.ts:356`, because that
line reads a **return value** (`adapter.validate?.(persistedRaw)`), not a
caught exception. This is the exact axis gap the dispatch names.

**Fix, within `src/health/run.ts` ownership only** (no `types.ts`, no
`gate.ts` edit needed or made): a closed-vocabulary allow-list,
`safeValidationError`, mirroring the discipline `safeErrorCode` already
established for the three catch arms — a value is trusted through only if it
is byte-identical to one of the five strings the two shipped adapters can
ever return (enumerated above); anything else — including no shipped adapter
today, but any future or third-party one — falls back to the same
"source output format was not recognized" constant the branch already uses as
its `??` fallback. This closes the axis at the type-safe boundary available
inside this file, without touching `SourceAdapter`'s public shape.

## Item 3 (minor) — F-003: manifest overclaims mode-downgrade produces a finding

**Reproduced independently before editing**, via the same
`T70-guidance.log`/`T75-guidance-before.log` row `B §14 manifest claim`:
`findingsPushSitesInSelfProtect: 1` — read `src/security/self-protect.ts` in
full (read-only, not owned/edited): `findings.push(` occurs exactly once, at
the checksum-mismatch arm (`:90`). The mode-downgrade arm (`:122-132`) and
the disabled-policy arm (`:160-172`) each push a warning + an incident and no
`SecurityFinding`. `service.ts:107-111`'s `analyze()` folds only
`selfProtection.findings` into the decision, so a mode downgrade does not
move the gate or any exit code.

**Site**: `src/security/templates.ts:103-104`, `renderSecurityManifest`.
Current sentence: "A `configChecksum` mismatch **or a mode downgrade** is
always surfaced as **a finding** plus an incident entry." Correct to state
what the code does: the checksum arm is a finding; the mode-downgrade and
disabled-policy arms are a warning, not a finding (each still writes an
incident). Also close the same manifest's own test if it pins the stale
sentence (see verification).

## Item 4 (minor) — F-004: the F-005 regressions never reach the artifact

**Reproduced independently before editing**: read
`src/health/health-truthful-gate.test.ts:283-421` in full. `runThrowingSource`
calls `runAdapter(...)` then folds through the in-memory `compute()` helper
(`computeGate` directly) — no call anywhere in the three `F-005:` tests writes
or reads `.metaproject/data/health/artifacts/latest.{json,md}`, and none goes
through `runHealth`'s `writeOutputs` or `createCodeHealthService().gate()`.
Confirmed by grep-by-eye (`readFile`/`writeFile`/`mkdtemp` calls in the file
are all in the pre-existing `auditFixture` tests and the F-005 block never
calls `runHealth`).

**Fix**: add one new end-to-end regression to
`src/health/health-truthful-gate.test.ts` (this file is the "focused tests"
of `run.ts` I own) that:
1. Drives the real `runHealth({cwd})` (not `runAdapter`+`compute`) with a
   synthetic, throwing/leaking adapter substituted for `FINDING_ADAPTERS` via
   `mock.module("./sources", ...)`, following the exact snapshot/override/
   restore-in-`finally` discipline `src/flow/service.test.ts:548-565` already
   uses successfully for an analogous leak regression (`./store`), captured
   BEFORE the mock so the restore uses the true pre-mock module object.
2. After `runHealth` returns, reads `.metaproject/data/health/artifacts/latest.json`
   and `latest.md` back from disk (matching the reviewer's `T70-health-leak.ts`
   template) and asserts neither contains the planted path or credential.
3. Calls `createCodeHealthService().gate({cwd})` — the exact value
   `src/flow/service.ts`'s completion gate folds into `flow.json` — and
   asserts its `reasons` are clean too, and that `status` is `incomplete`
   (verdict unmoved).
4. Adds a second such case exercising the new F-002 site (`validate()`
   returning attacker text) as the positive-control-turned-regression: this
   row must have been leaking before the item-2 fix and clean after, proving
   both fixes end to end together.

**Known hazard to test for, not assume away**: T69-implementation.md
documented that `mock.module("./sources", ...)` corrupted an unrelated
`provenance.test.ts` assertion when both files ran in the same `bun test`
process, in either file order, and gave up on it in favor of the `runAdapter`
export instead. T70-review.md's own suggested fix offers the
snapshot+override+restore-in-`afterAll` discipline (matching
`service.test.ts`'s working precedent) as the way to avoid this. Before
trusting that this works here, I will run the new test file together with
`src/health/provenance.test.ts` (the exact combination T69 found broken) and
with the full required `bun test src/health/ src/commands/ src/security/`
suite, and only keep this approach if both stay green. If the hazard
reproduces despite the restore, I will report that concretely rather than
land a regression that intermittently corrupts a sibling file's assertions,
and fall back to the narrowest change that still reaches the artifact (e.g.
restoring synchronously inside the same `test()` body with no `await` gap
between mock and restore, which is what `service.test.ts` already does).

## Ownership / constraints re-confirmed before editing

- Editing: `docs/docs/cli-reference.md`, `docs/docs/modules.md` (exit-behaviour
  paragraphs only), `src/health/run.ts`, `src/health/health-truthful-gate.test.ts`,
  `src/security/templates.ts`, and `src/security/templates.test.ts` if it pins
  the stale §14 sentence.
- Not editing: `src/commands/security.ts`, `src/health/gate.ts`,
  `src/health/types.ts`, anything under `src/security/detect/`,
  `src/security/detect/exfil.ts` (the other worker's file), the auto-fetch
  subsection of `docs/requirements/keryx-agent-first-core/policies.md` (the
  other worker's section) — policies.md is otherwise read-only for this task
  anyway (context, not a target).
- No `git stash`. No `bun test` without file arguments. No dependency/lockfile
  change. No `flow.json`/`acceptance-criteria.md` edit.
