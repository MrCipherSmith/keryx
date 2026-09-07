STATUS: DONE

# T75 — implementation: closing T70 F-001..F-004

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`, confirmed
via `pwd`/`git rev-parse --abbrev-ref HEAD` before the first read). No
`.claude/worktrees/**` directory entered. No `git stash`. Spec written before
editing: `T75-spec.md` (same directory).

All four items were independently reproducible before any edit — none was
"not reproducible as described."

## Item 1 (blocking) — F-001: three shipped guidance sites stale about `ci`/`enforced`

**Measurement taken, before editing.** Ran the reviewer's own probe
unmodified: `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T70-guidance.ts`
→ `.metaproject/data/gdctx/raw/T75-guidance-before.log`. Section A0 measured
26 exit-code cells through the real `securityCommand(...)`; claims A2-A5 all
`CLAIM_HOLDS:false`, matching T70-review.md's own numbers exactly — the
load-bearing cells: `report|enforced|fail`=1, `report|gateway|fail`=1,
`report|ci|needs-approval`=1, `report|ci|incomplete`=1,
`report|enforced|incomplete`=1, `scan|gateway|fail`=1,
`check-input|gateway|secret`=1, against `advisory`=0 everywhere. Also read
the code fold directly (read-only): `src/commands/security.ts:682-687`
(`reportExitCode`) and `:971-976` (`exitCodeFor`) both test
`mode === "ci" || mode === "enforced" || mode === "gateway"`, then
`isPassGate(gate) ? 0 : 1` — `isPassGate` (`:700-712`) returns `true` only for
`"pass"`, so every mode in that set exits `1` on `fail`, `needs-approval`,
`incomplete`, or any unrecognized stored gate value. `report` shares the
identical fold (`reportExitCode`), reading the gate from the last stored scan
artifact instead of rescanning.

**Fix.** Rewrote the two prose sites to state the measured fold:
- `docs/docs/cli-reference.md:2137-2148` — the "Exit behavior" paragraph.
  Now: `scan`/`check-input`/`check-output`/`report` all share
  `exitCodeFor`/`reportExitCode`; `advisory` always `0`; `enforced`, `ci`, or
  `gateway` exit `1` on any gate other than `pass` (`fail`, `needs-approval`,
  `incomplete`, or unrecognized); `report` reads the stored gate instead of
  rescanning and applies the identical fold.
- `docs/docs/modules.md:784-787` — same enumeration, same correction (now
  three sentences: advisory/enforced-ci-gateway/pass-vs-other).
- `docs/docs/modules.md:778` — the `security report` Exit table cell, changed
  from "**1 in `ci` mode when gate = fail**" to "**1 in `enforced`/`ci`/`gateway`
  mode on a non-passing gate**" (the reviewer's own suggested wording).

**Left alone, re-confirmed accurate, not touched**: `cli-reference.md:2095-2099`
(T68's paragraph, A6 `CLAIM_HOLDS:true` both before and after); `modules.md:766`
(the unimplemented Phase-4 proxy qualifier, unrelated to `mode:"gateway"`); the
15 sites T73 already corrected — re-verified present via the same probe's
section B (`manifestStillHasOldForm:false`, `readmeStillHasOldForm:false`,
both before and after; on-disk copies matching).

**Measurement taken, after editing.** Re-ran the identical probe unmodified
→ `.metaproject/data/gdctx/raw/T75-guidance-after.log`. Section B's suspect
sweep — every shipped surface for a line naming `enforced`/`ci` with a
behaviour verb and no `gateway` on the same line — dropped from **5 hits to
2**, and the 2 remaining are the same two the reviewer's own review already
classified as false positives/already-correct: `cli-reference.md:1226`
(unrelated containment prose) and `:2096` (T68's own paragraph, `gateway` on
the preceding line). The three genuine hits from the "before" run
(`cli-reference.md:2139`, `:2140`, `modules.md:785`) are gone — confirmed by
direct read of the corrected paragraphs (`cli-reference.md:2137-2148`,
`modules.md:784-787`). Section A's claims (A2-A5) are static predicates over
the *old* wording and are not expected to change (they test the old
hypothesis, not current file bytes — see "Judgement call" below); Section B's
byte-level sweep is what actually reads file content, and it is the evidence
that the correction landed.

## Item 2 (minor) — F-002: fourth `SourceRunInfo.error` producer, not a catch binding

**Measurement taken, before editing.** Ran the reviewer's probe
`T70-health-leak.ts` unmodified as a plain `bun` script (it calls
`mock.module` at top level in its own process, matching how the reviewer ran
it — not `bun test`, which reports "no test files matched") →
`.metaproject/data/gdctx/raw/T75-health-leak-before.log`. Row `P1` (planting
the same bytes through `validation.error`, `run.ts:356`, the site T69 did not
touch): `sourceError` is the raw planted text verbatim
(`"synthetic validation failure /Users/attacker/.ssh/id_rsa AKIAIOSFODNN7EXAMPLE"`),
and all four `LEAK_*` fields report `{path:true, cred:true}`. Rows H1-H6/C0
(the three T69-repaired catch arms, the errno-preservation case, and the
clean control) are all `{path:false, cred:false}` — the probe demonstrably
sees a leak where one exists and stays quiet where none does.

**Re-enumeration by write site, not by `catch` binding** (the dispatch's own
instruction — the earlier sweep's axis gap). `bun src/cli.ts ctx rg "error:" src/health --glob '!*.test.ts'`
— the compacted summary undercounted again (header said 14 matches, rendered
list showed 13 of them, `run.ts` shown with only 4 of its 7 actual hits); read
the raw log directly (`.metaproject/data/gdctx/raw/2026-09-06T18-44-49-196Z_rg.log`),
15 lines, every one read:

| Site | Text | Disposition |
|---|---|---|
| `run.ts:279` | `` `source detection failed${errorCodeSuffix(error)}` `` | repaired by T69, safe |
| `run.ts:314` | `` `source execution failed${errorCodeSuffix(error)}` `` | repaired by T69, safe |
| `run.ts:336` | `` `source parse failed${errorCodeSuffix(error)}` `` | repaired by T69, safe |
| `run.ts:356-358` | `validation?.error ?? "source output format was not recognized"` | **THE DEFECT** — adapter-supplied return value, not a caught exception; the `catch (` axis cannot reach it |
| `run.ts:358` (else arm) | `` `source command exited ${raw.exitCode} without recognized findings` `` | numeric-only, safe |
| `run.ts:399` | `"excluded by source filter"` | constant, safe |
| `sources/eslint.ts:122,124` | the two strings `eslint`'s `validate()` can ever return | constants, safe |
| `sources/dependency-audit.ts:14,28,36,97,145` | type decl + the three strings `dependencyAudit`'s `validate()` can ever return (`:145` forwards one of the other three, read `decodeAudit` in full to confirm — every return path is one of the same three literals) | constants, safe |

Cross-checked T69's own claim independently: `catch (` over `src/health`
returns exactly 4 hits, all in `run.ts` (`:271` detect, `:289` import/run,
`:296` `NoImportError` control-flow only, `:323` parse) — confirms the
`catch`-binding axis structurally cannot reach `run.ts:356`, which reads a
return value (`adapter.validate?.(persistedRaw)`), never a caught exception.

**Fix, within `src/health/run.ts` ownership only** (no `types.ts`, no
`gate.ts` edit made — the closed-vocabulary allow-list fits entirely inside
this file's existing type surface). Added `KNOWN_VALIDATION_ERRORS` (a
`Set<string>` of the five literals the two shipped adapters can ever return)
and `safeValidationError(error)`, mirroring the discipline `safeErrorCode`
already established for the three catch arms: a value passes through
unchanged only if it is byte-identical to one of the five known-safe strings;
anything else — no shipped adapter reaches this today, but a future or
third-party one could — falls back to the same
`"source output format was not recognized"` constant the branch already used
as its `??` default. Applied at `run.ts:356-358`
(`error: parseFailed ? safeValidationError(validation?.error) : ...`).

**Measurement taken, after editing.** Re-ran `T70-health-leak.ts` unmodified
→ `.metaproject/data/gdctx/raw/T75-health-leak-after.log`. Row P1 is now
clean: `sourceError:"source output format was not recognized"`, all four
`LEAK_*` fields `{path:false, cred:false, message:false}`. `gateStatusInMemory`,
`gateStatusOnDisk`, `serviceGateStatus` all stayed `incomplete` (unmoved).
H1-H6/C0 unchanged (still clean/`pass` respectively) — the three existing
repairs are undisturbed.

## Item 3 (minor) — F-003: manifest overclaims mode-downgrade produces a finding

**Measurement taken, before editing.** Read `src/security/self-protect.ts` in
full (read-only, not owned/edited): `findings.push(` occurs exactly once, at
the checksum-mismatch arm (`:90-105`). The mode-downgrade arm (`:122-132`) and
the disabled-policy arm (`:160-172`) each push a `warnings` entry and an
`incidents` entry and **no** `SecurityFinding`. `src/security/service.ts:107-111`'s
`analyze()` folds only `selfProtection.findings` into the decision, so neither
arm moves the gate or an exit code. Corroborated by the same
`T75-guidance-before.log` row `B §14 manifest claim`:
`findingsPushSitesInSelfProtect:1`, `manifestHasIt:true` (the stale sentence
was present).

**Fix.** `src/security/templates.ts:103-104` (`renderSecurityManifest`),
rewritten from "A `configChecksum` mismatch or a mode downgrade is always
surfaced as a finding plus an incident entry" to "A `configChecksum` mismatch
is surfaced as a finding plus an incident entry; a mode downgrade or a
disabled policy is surfaced as a warning plus an incident entry" — matches
the reviewer's own suggested wording and additionally names the
disabled-policy arm, which the old sentence omitted even though §14's own
invariant (`self-protect.ts:13-17`) names it alongside the other two.

**Regression added** (TDD: written, confirmed RED against the pre-fix text by
temporarily reverting `templates.ts` via a plain file edit — not `git
stash` — then restoring): `src/security/templates.test.ts`, new test
`"renderSecurityManifest's §14 sentence matches self-protect.ts: only a
checksum mismatch is a finding"` — asserts the new sentence is present
(whitespace-normalized, since the template literal wraps) and the old
sentence is absent.

**Measurement taken, after editing.** `T75-guidance-after.log` row
`B §14 manifest claim`: `manifestHasIt:false` — the stale sentence's exact
text search now returns nothing (`findingsPushSitesInSelfProtect` still `1`,
confirming the code fact this correction is measured against did not change).

## Item 4 (minor) — F-004: the F-005/F-002 regressions never reach the artifact

**Measurement taken, before editing.** Read
`src/health/health-truthful-gate.test.ts:283-421` (pre-edit) in full:
`runThrowingSource` calls `runAdapter(...)` then folds through the in-memory
`compute()` helper (`computeGate` directly). No test in the F-005 block calls
`runHealth`, reads `.metaproject/data/health/artifacts/latest.{json,md}`, or
calls `createCodeHealthService().gate(...)` — confirmed by reading every line
of the block, not by search.

**Fix — with a documented, empirically-verified pivot away from the
reviewer's own suggested implementation.** The suggested fix
(T70-review.md F-004) was "drive `runHealth()` with `mock.module` on
`src/health/sources/index.ts`... snapshotting the real module, overriding
only `FINDING_ADAPTERS`, and restoring it in `afterAll`." I first implemented
exactly that, restoring synchronously in the same test's `finally` (the
pattern `src/flow/service.test.ts:548-565` uses successfully for the
analogous `./store` leak regression). **This reproduced T69's documented
cross-file hazard, byte for byte.** Running
`bun test src/health/health-truthful-gate.test.ts src/health/provenance.test.ts`
(T69's own reproduction case) failed the same unrelated assertion T69
recorded — `provenance.test.ts`'s "strict health runs an available compiler
instead of treating missing import format as missing source":
`source?.status` came back `undefined` instead of `"available"`. Reproduced
in **both file orders**. This is a second, independent confirmation that
`mock.module("./sources", ...)` is unsafe in this process even with a
same-test, synchronous restore that works for `./store`/`./review-gate` — the
difference is that `./sources` is imported by nearly every `runHealth()`
caller in this process, unlike the two flow modules.

**Pivoted to a mock-free design** (still fully addresses F-004, without the
hazard): exported `writeOutputs` from `run.ts` — test-only, same discipline
and comment style as the existing `runAdapter` export (doc comment names the
reason: the `mock.module` hazard, and points at this file's regressions).
Each new regression now calls the real `runAdapter` (already used by the
F-005/F-002 unit tests) → real `computeGate` → real `writeOutputs` → reads
`.metaproject/data/health/artifacts/latest.{json,md}` back from disk → real
`createCodeHealthService().gate({cwd})`. This exercises every hop F-004
named — the artifact write, the artifact read-back, and the service-level
gate `src/flow/service.ts`'s completion gate actually folds into `flow.json`
— using only already-production functions, with zero shared-module risk.
Two new tests: `"F-004/F-005: a detect() throw never reaches the persisted
artifact or the service-read gate"` and `"F-004/F-002: a validate() error
never reaches the persisted artifact or the service-read gate"` (the latter
doubling as the artifact-level positive-control-turned-regression for item
2's fix).

**RED/GREEN, confirmed by temporarily reverting the source fix** (plain file
edit + restore, not `git stash`): with `run.ts`'s `validation?.error ??
"..."` line restored to its pre-fix form, both new F-004 tests failed on
`expect(info.error).not.toContain(ATTACKER_PATH)` /
`expect(info.error).toBe("source output format was not recognized")` with the
raw planted text as the actual value. Reapplied the fix: both pass.

**Cross-file hazard, verified absent for the mock-free version**:
- `bun test src/health/health-truthful-gate.test.ts src/health/provenance.test.ts`
  → 18 pass / 0 fail / 118 expect().
- `bun test src/health/provenance.test.ts src/health/health-truthful-gate.test.ts`
  (reverse order) → 18 pass / 0 fail / 118 expect().
- Full required suite (below) → 0 fail.

**Evidence taken from the artifact** (the acceptance criterion's own
wording): for the `validate()` regression, `jsonBytes`/`mdBytes` read from
`.metaproject/data/health/artifacts/latest.json`/`latest.md` on disk contain
neither `/Users/attacker/.ssh/id_rsa` nor `AKIAIOSFODNN7EXAMPLE`;
`createCodeHealthService().gate({cwd})`'s `reasons` (the exact value
`src/flow/service.ts`'s `healthGateOutcome` folds into `flow.json`) are
likewise clean and still name `eslint`; `gate.status` is `incomplete` in both
the in-memory and the service-read value — the verdict did not move.

## Files changed

- `docs/docs/cli-reference.md` — rewrote the "Exit behavior" paragraph
  (`:2137-2148`) to state the measured `enforced`/`ci`/`gateway` fold on
  `fail`/`needs-approval`/`incomplete`/unrecognized, for
  `scan`/`check-input`/`check-output`/`report` alike.
- `docs/docs/modules.md` — corrected the `security report` Exit table cell
  (`:778`) and the mode-gated-commands paragraph (`:784-787`) to the same
  measured fold.
- `src/health/run.ts` — added `KNOWN_VALIDATION_ERRORS` +
  `safeValidationError` (closed-vocabulary allow-list for the fourth
  `SourceRunInfo.error` producer) and applied it at `:356-358`\*; exported
  `writeOutputs` (test-only, documented) so the new F-004 regressions can
  reach the artifact without mocking `./sources`. No other line, type, or
  gate-fold logic changed.
  \*(line numbers shift slightly after the new helper block; both are in the
  same function, `runAdapter`.)
- `src/health/health-truthful-gate.test.ts` — added imports (`readFile`,
  `writeOutputs`, `createCodeHealthService`, `HealthReport` type); added two
  F-002 unit regressions (unsafe text rejected, closed-vocab text preserved);
  added an `artifactPath` helper; replaced an earlier `mock.module`-based
  design (abandoned after reproducing the cross-file hazard) with two
  mock-free F-004 end-to-end regressions asserting on the persisted artifact
  and the service-read gate.
- `src/security/templates.ts` — corrected the §14 sentence in
  `renderSecurityManifest` (`:103-105`) to distinguish the checksum arm
  (finding) from the mode-downgrade/disabled-policy arms (warning), matching
  `self-protect.ts`.
- `src/security/templates.test.ts` — added a regression pinning the
  corrected §14 sentence and the absence of the old one.

## Verification

| Check | Command | Before | After | Raw log |
|---|---|---|---|---|
| Reviewer probe, guidance (row 3) | `bun .../T70-guidance.ts` | A2-A5 `false` (stale); B suspects: 5; §14 `manifestHasIt:true` | A2-A5 unchanged (static predicates over old wording — see note above); **B suspects: 2** (both pre-classified as non-defects); **§14 `manifestHasIt:false`** | before: `T75-guidance-before.log`; after: `T75-guidance-after.log` |
| Reviewer probe, health leak (row 4 + F-002) | `bun .../T70-health-leak.ts` | P1 leaking (`path:true,cred:true` at all 4 surfaces) | **P1 clean** (`path:false,cred:false` at all 4 surfaces); H1-H6/C0 unchanged; gate verdicts unmoved (`incomplete`/`pass` as before) | before: `T75-health-leak-before.log`; after: `T75-health-leak-after.log` |
| New regressions, isolated | `bun test src/health/health-truthful-gate.test.ts src/security/templates.test.ts` | RED confirmed per-fix (see above) | **21 pass / 0 fail / 121 expect()** | not routed (direct, matches T45-T49/T69 precedent for quick local checks) |
| Cross-file hazard re-check (both orders) | `bun test src/health/health-truthful-gate.test.ts src/health/provenance.test.ts` and reverse | — | **18 pass / 0 fail / 118 expect()** both orders | not routed |
| Dispatch-required suite | `bun src/cli.ts ctx run -- bun test src/health/ src/commands/ src/security/` | — | **1370 pass / 6 skip / 0 fail / 5822 expect()**, 1376 tests across 120 files | `.metaproject/data/gdctx/raw/2026-09-06T18-57-30-347Z_run.log` (cross-checked against the raw log's own final lines, not only the compacted summary, per the dispatch's own caution about undercounting) |
| Typecheck | `bun src/cli.ts ctx run -- bun run typecheck` | — | exit 0, clean | `.metaproject/data/gdctx/raw/2026-09-06T18-58-00-925Z_run.log` |
| ESLint on every changed source/doc file | `bun src/cli.ts ctx run -- bunx eslint docs/docs/cli-reference.md docs/docs/modules.md src/health/run.ts src/health/health-truthful-gate.test.ts src/security/templates.ts src/security/templates.test.ts` | — | exit 0; 0 errors, 2 warnings ("no matching configuration" on the two `.md` files — same as T73's own precedent) | `.metaproject/data/gdctx/raw/2026-09-06T18-58-07-809Z_run.log` |

## Judgement call

`T70-guidance.ts`'s section A "claims" (A1-A6) are fixed predicates over the
26 measured exit-code cells, evaluating whether specific *sentences from the
old prose* hold against measured behaviour — they do not re-read the doc
files at all, so they cannot and do not change after a prose edit; that is
what section B (a byte-level sweep of the actual shipped surfaces) is for,
and section B's suspect count dropping from 5 to 2 (with the 2 remaining
being the same two the reviewer's own review already excluded) is the
correct signal that the correction landed. Read this as intended (the probe
proves the OLD wording was false; it was never designed to also prove a NEW
wording true) rather than re-running the exit-code oracle against invented
new predicates, since inventing new predicates not authored by the reviewer
would not be verification against the reviewer's own instrument.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC4 (AFC-05): fixtures, damaged JSON, skipped-required, incomplete coverage give the expected verdict; violations are not lost even when another check is unavailable. | met, unchanged | `computeGate`'s `brokenRequired` filter (`gate.ts:68-75`, read-only, unedited) never reads `s.error`'s content; both fixes are string-only inside the `error` field. Confirmed by the full required suite staying green and by every new regression's own `gate.status`/`serviceGate.status` assertion. |
| AC8: no shipped guidance describes behaviour the code does not have; no required failed/incomplete check is relabeled PASS. | met | All three F-001 sites corrected to the measured fold; F-003's manifest sentence corrected to match `self-protect.ts`; gate verdicts measured unmoved in both the reviewer's probe and the new regressions. |
| The fourth producer is closed and the enumeration axis is corrected, with every write site of the field listed and its disposition given. | met | Table above (item 2); enumerated by `error:` write sites, not `catch` bindings. |
| Regressions assert on the artifact, fail before the change and pass after; the dispatch-required suite stays green. | met | Two new F-004 end-to-end tests read `latest.json`/`latest.md` from disk and call the real service `gate()`; RED/GREEN confirmed by temporary source revert; `bun test src/health/ src/commands/ src/security/` → 1370/6/0. |

## Concerns

None blocking. One process note, disclosed rather than omitted: the first
implementation of the F-004 regression followed the reviewer's own suggested
`mock.module` design and reproduced T69's documented cross-file hazard on the
first try (both file orders) — this is now a second, independent
confirmation that `mock.module("./sources", ...)` is unsafe in this bun test
process regardless of restore discipline, worth carrying forward if a future
task considers the same approach again. The shipped fix uses a different,
mock-free design instead (exporting `writeOutputs` the same way `runAdapter`
already is), verified clean against the exact combination that broke.

## Routing audit

- `graph_used`: **no** — *not-relevant*. Every file and site was named by the
  dispatch or by T70-review.md's own findings; the questions were behavioural
  (what does the code do) and textual (what does the doc say), not
  structural/blast-radius. `keryx-tooling-caveats` project memory also flags
  gdgraph's answers as historically unreliable on this repo.
- `wiki_used`: **no** — *not-relevant*. The normative source for "what the
  code does" is the code itself (`security.ts`, `self-protect.ts`, `gate.ts`,
  `service.ts`, all read directly), and the normative source for what was
  already corrected is the cited prior task artifacts (T68/T69/T73
  implementation reports, T70-review.md), all read directly.
- `ctx_used`: **yes** — every text search went through `bun src/cli.ts ctx
  rg`; every aggregate verification command went through `bun src/cli.ts ctx
  run`; every raw log cited above by path.
- `raw_rg_used`: **no** bare `rg`/`grep`/`cat`/`find`/`sed` over project code
  or docs. One raw-log read was needed directly (via the `Read` tool, and via
  `wc -l`/an explicit `# keryx:raw`-style read on the run.log to confirm its
  true tail) when the compacted `ctx rg` summary for `error:` in
  `src/health` undercounted the rendered match list against its own header
  count (14 vs. 13 shown, `run.ts` shown with 4 of 7 hits) — the same
  gdctx compaction defect this project's own memory and the dispatch both
  warn about; the raw log was read directly instead and is cited above.
