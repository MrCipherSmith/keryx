STATUS: DONE_WITH_CONCERNS

# T70 — independent recheck of four repairs (T67, T68, T69, T73)

Reviewer: independent `review-security-code` + `review-logic`. I wrote none of the
code and none of the reviews under recheck.

## Scope

- Root: `/Users/Goodea/goodea/keryx` (the only checkout used; `pwd` confirmed
  before the first read). No `.claude/worktrees/**` directory was entered.
- Branch: `codex/agent-first-core`. Base commit: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
  (`feat(metaproject): shrink the routing gate…`). All work under review is
  uncommitted in this checkout.
- No git state was changed. No `git stash`, no flow CLI, no dependency change, no
  network, no model call. Every fixture is `mkdtemp`, removed in `finally`.
- Rows verified: (1) the reverted `<base href>` inert-span suppression, (2)
  `MODE_RANK` and the disabled-policy arm, (3) shipped guidance vs. code, (4) the
  health gate-reason leak.

### File hashes (SHA-256)

Start (`T70-hashes-start.txt`) → end (`T70-hashes-end.txt`):

| File | start | end | drift |
|---|---|---|---|
| `src/security/detect/exfil.ts` | `c03bd83f…735dab` | `ef029fe3…efed8a` | **CHANGED** (1109 → 1198 lines) |
| `docs/requirements/keryx-agent-first-core/policies.md` | `61ddb7f6…c80cfb4` | `024d1d03…95beb97` | **CHANGED** |
| `src/security/self-protect.ts` | `c9fbe520…65e6287` | identical | none |
| `src/security/service.ts` | `e08be640…8fb71b6632` | identical | none |
| `src/security/guard.ts` | `73dbecf3…5780fc792`¹ | identical | none |
| `src/security/templates.ts` | `6d451a36…2132555a` | identical | none |
| `src/health/run.ts` | `18ebeed5…e93b46a`¹ | identical | none |
| `src/health/gate.ts` | `4d31021c…44514faa5` | identical | none |
| `src/commands/init.ts` | `bab99102…830dd87b` | identical | none |
| `.metaproject/modules/security.md` | `29ba2cb4…c6ba84c` | identical | none |
| `docs/docs/modules.md` | (added mid-run) `24a7e393…b0b2c79` | identical | none |
| `docs/docs/cli-reference.md` | (added mid-run) `102ad631…b05794951` | identical | none |

¹ full values in `T70-hashes-start.txt` / `T70-hashes-end.txt`.

**Concurrent-worker drift, and which conclusions it touches.** The two files the
dispatch warned about — `src/security/detect/exfil.ts` and the requirements
`policies.md` — both changed mid-review, exactly as predicted; nothing else did.
I re-ran the entire row-1 matrix set against the post-drift bytes
(`T70-post-*.log`) and re-checked the revert by symbol search. `T70-exfil.log`
and `T70-post-T62-exfil.log` are **byte-identical** (both
`abb3fe32…1af49a`), as are `T70-boundary.log` and `T70-post-T62-boundary.log`
(both `430bedbe…f69c962`), so the drift changed nothing observable in row 1. No
suppression mechanism was reintroduced (`ctx rg` for
`isIn|Span|suppress|skipBase|inert` over the post-drift file returns only prose
and the unrelated `Number.isInteger` / SVG-`inert` hits). Rows 2 and 4 touch
neither file. Row 3's `policies.md` is a requirements document, not shipped
guidance, and none of my row-3 findings cite it. **No conclusion in this review
depends on the pre-drift bytes.**

## Summary

| Severity | Count |
|---|---|
| blocker | 0 |
| major | 1 |
| minor | 3 |
| info | 3 |

Stage 1 **FAILS on row 3**. Rows 1, 2 and 4 pass under my own execution. Stage 2
was therefore not entered.

## Stage 1

| # | Item | Verdict | My probe and what it showed |
|---|---|---|---|
| 1 | The reverted suppression: a base element is a finding wherever it appears, including all six shapes; T63's valuable half is intact; the recorded reason is accurate | **PASS** | `T70-exfil.log` (`bun …/T62-exfil.ts`): `{"cases":13,"bypasses":0}` — `x01` abrupt-empty-comment, `x02` abrupt-dash-comment, `x03` comment-end-bang, `x05` comment delimiters quoted in fences, `x06` comment delimiters in code spans, `x07` fence markers quoted inside a comment **all** now report `baseFindings:1`, `allPolicyIds:["egress.html-base-href-exfil"]` and `attackerHostStillInRedactedOutput:false`, with the lol-html oracle still reporting `rendererSeesLiveAttackerBase:true` for each. `T70-boundary.log` (`T62-boundary.ts`, advisory redaction OFF so the mandatory floor is what is measured): `{"hostileLeakingAtAnyBoundary":0,"ids":[]}` — the four previously-leaking shapes are `mcpState/persistState/transportState: "redacted"` with `reasons ["egress.html-base-href-exfil"]` and `leaksHost {mcp:false,persist:false,transport:false,seam:false}` at all four boundaries. The reverted symbols are gone: `ctx rg "fencedCodeBlockSpans\|nonRenderedSpans\|isInNonRenderedSpan\|getNonRenderedBaseSpans\|HTML_COMMENT_SPAN\|FENCE_LINE\|nonRenderedBaseSpansCache"` over `src/` returns **only** two hits in the unrelated TUI helper `src/lib/md-blocks.ts` (imported by `src/tui/*`, `src/commands/shell.ts`, `src/lib/ui.ts`; nothing in `src/security`). The guard is back to `attribute.name === "href"` (`exfil.ts:1138-1140` post-drift). **T63's valuable half is all present**: `BASE_REMEDIATION` (`:423`) separate from `FETCH_REMEDIATION` and `META_REFRESH_REMEDIATION`, `UrlHit.remediation` and its `?? FETCH_REMEDIATION` default, the whole-document blast-radius disclosure in the header (`:44-47`), the corrected `SYNTHETIC_BASE_PAIRS` sufficiency argument (T53#F-002) with its execution pin (`exfil.test.ts:731`, the `file:`/`ws:`/`wss:`/`ftp:` non-finding test that goes red the moment `resolvedHost` widens), the corrected `readStartTag` EOF paragraph (T53#F-003) with its pin (`exfil.test.ts:746`), and the asymmetry paragraph at the `<base>` branch. **The recorded reason is accurate**: the block comment above `SENSITIVE_URL_VALUE` names the right failure (a regex approximating two grammars in the one direction where being wrong releases attacker bytes), enumerates the three missing comment terminators and the independent-span-computation defect, states what the "both delimiters present" bound does and does not buy, and states the revisit condition (a conformant tokenizer — lol-html via `HTMLRewriter` — plus a real CommonMark pass, failing toward flagging on **every** ambiguity, with hostile payloads inside every span kind) plus the two measurements that must go green. The T53#F-004 cross-reference at `:1072` is corrected to "this is the ONLY place…". `exfil.test.ts:654` pins all six shapes in one table. |
| 2 | The mode rank and the policy arm | **PASS** | `T70-mode-policy.log`, my own probe, driven through the real `analyze()` and read back from the durable `incidents.jsonl` on disk — never from `evaluateSelfProtection`. **M1**: all **12** ordered pairs of the four recognized modes with no broken window at all (a matrix `T62-state.ts` never runs — its own matrix always inserts a broken config and omits `gateway→enforced`, `enforced→ci` and `ci→enforced`). Every pair matches the contract-derived expectation (record iff `from` is blocking and `to` is `advisory`): `enforced→advisory`, `ci→advisory`, `gateway→advisory` each write `mode-downgrade` with `"Mode changed from X to advisory."`; the other nine write nothing. **M2**: all **6** within-blocking transitions are silent in the stronger sense — zero new incidents **and** zero warnings. **P1**: the disabled-policy arm now fires during an unrecognized-mode window for **five** different spellings of "unrecognized" (`"ENFORCED"`, `"enforced "` with a trailing space, `null`, `7`, the typo `"enfoced"`), each producing `policy-disabled` + `security policy "promptInjection" was disabled.` while `state.json` is correctly *not* overwritten with the forced substitute. **P2 — the "mathematical no-op" argument, tested rather than accepted**: 12 rows (six unusable payload shapes × prior state with 0 and with **all 5** policies already disabled — the shape most likely to produce a spurious record) are **all silent**. The argument also holds by reading: `config.ts:254` returns `mergeSecurityConfig({})` with a *literal* `{}`, and `DEFAULT_SECURITY_CONFIG.policies` is `enabled:true` for all five, so `enabled === false` is unsatisfiable for that shape by construction; `configUnreadable:true` has exactly two producers in the whole tree (`config.ts:254`, `:265` — `ctx rg`), so there is no third shape the argument would miss. **P3 — the system's own defensive reaction stays suppressed**: from each of the four real prior modes into an unrecognized-mode window, `modeDowngradeFabricated:false` every time while `realDisableStillReported:true` every time. `T70-state.log` (the reviewer's own probe re-run) agrees: B1 `trueDisableSuppressedDuringWindow:false` with `incidentsDuringWindow ["policy-disabled"]`, B2 `realDisableEverRecorded:true`, B3 `incidentsDuringWindow []` (still silent for the unusable payload). |
| 3 | The shipped guidance: every description of what the security modes do matches the code | **FAIL** | `T70-guidance.log`, my own oracle: 26 exit-code cells measured through the real `securityCommand(...)`, then each shipped sentence evaluated **as a predicate** over those cells. The two deliberate omissions are **genuinely accurate**: `cli-reference.md:2095-2099` (claim `A6`, `CLAIM_HOLDS:true` — `gateway` matches `enforced` cell-for-cell at `scan`, `report`×3 gates and `check-input`) and `modules.md:766` ("the **always-on** gateway mode (Phase 4) remains not implemented" — the qualifier makes it true; `mode:"gateway"` is not claimed inert). All 16 corrections T73 made and both T68 made are present and correct (re-enumerated from file bytes, not from either task's table: `templates.ts:63,125`; `.metaproject/modules/security.md:48`; `.metaproject/core/security/README.md:17`; `architecture.md:547,563,634`; `modules.md:865,874,881`; `workspace-and-lifecycle.md:339,350`; `cli-reference.md:330,754,912,993,1058`; `init.ts:497`; and both generators, `manifestStillHasOldForm:false`, `readmeStillHasOldForm:false`, on-disk copies matching). **But three shipped sites still describe behaviour the code does not have, all in T73's own ownership, and the error runs in the direction the dispatch asked me to check** — stale about `ci` and `enforced`, i.e. about folds *this phase corrected* — see **F-001**. Two further guidance defects of adjacent classes: **F-003** (the §14 sentence the `keryx init`/`update` manifest ships) and **F-005**. |
| 4 | The health reason leak: three catch arms, no caught message in a committable artifact or the flow record, the stage still named, gate verdicts unmoved | **PASS** | `T70-health-leak.log`, my own probe, measured **on the artifact**: each row runs the real `runHealth()` end to end (via `mock.module` on `src/health/sources/index.ts` in its **own process**, so the registry hazard T69 hit inside one `bun test` process cannot apply), then reads `.metaproject/data/health/artifacts/latest.json` and `latest.md` **back from disk**, then re-reads the gate through the real `createCodeHealthService().gate({cwd})` — the exact value `src/flow/service.ts:640`'s `healthGateOutcome` folds into `flow.json`. Rows H1/H2/H3 (detect / import-run / parse throwing an `Error` whose message carries `/Users/attacker/.ssh/id_rsa` and `AKIAIOSFODNN7EXAMPLE`): `sourceError` is exactly `source detection failed` / `source execution failed` / `source parse failed`; `LEAK_committableArtifactJson`, `LEAK_committableArtifactMd`, `LEAK_serviceGateReasons` and `LEAK_inMemoryReasons` are all `{path:false,cred:false,message:false}`; `namesTheStage:true`. **The gate verdict did not move**: `gateStatusInMemory`, `gateStatusOnDisk` and `serviceGateStatus` are all `incomplete` at every site, and the control row C0 is `pass` — which is also what `gate.ts:68-75` guarantees by construction (`brokenRequired` branches on `s.status`/`s.execution`/`s.parse`, never on `s.error`). H4 shows the closed-vocabulary suffix working (`source detection failed (ENOENT)`); **H5 and H6 attack `safeErrorCode` directly** — a `code` of `"EACCES /Users/attacker/… AKIA…"` and a 64-character all-caps code are both rejected by `/^[A-Z][A-Z0-9]{2,15}$/`, leaking nothing. **The probe is proven capable of seeing a leak**: row P1 is a positive control that plants the same bytes through a producer T69 did *not* change, and it **does** leak at all four surfaces — which is simultaneously the evidence that clean rows mean something and finding **F-002**. **The implementer's enumeration claim is true**: `ctx rg "catch \("` over `src/health` returns exactly four hits, all in `run.ts` (`:273`, `:297`, `:308`, `:325`) — `run.ts` is the only file in the module that binds a caught value at all, and `:297` is `NoImportError` control flow that builds no string. |

**Stage 1 result: rows 1, 2 and 4 are closed under my own execution. Stage 1
FAILS on row 3 (F-001), so Stage 2 was not entered.**

### Prior measurements, all re-run post-drift

| Matrix | Required | Measured (`T70-post-*.log`) |
|---|---|---|
| `T53-extract.ts` (extraction) | 88 cases, 0 bypasses | `"cases":88, "bypasses":0, "bypassIds":[]` ✓ |
| `T53-resolve.ts` (resolution) | 41 × 15 = 615, 0 bypasses, 0 FP | `"destinations":41,"rendererBases":15,"bypasses":0,"falsePositives":0` ✓ |
| `T42-exfil-attack.ts` (forty-two case) | 42 cases, 0/0 | `"cases":42,"bypasses":[],"falsePositives":[]` ✓ |
| `T24-recheck2-exfil.ts` (forty-eight case) | 48 cases, 0/0 | `cases=48 bypasses=0 falsePositives=0` ✓ |
| `T42-charrefs.ts` (character-reference) | 240 cases, `absentButUrlSyntax: []` | `"casesTested":240, "namedSpellingBypasses":[], "numericSpellingBypasses":[], "absentButUrlSyntax":[]` ✓ |
| `T46-surfaces.ts` (surface matrix) | `flaggedNonFetching [X04.templateImg]` | `"flaggedNonFetchingCount":1`, `X04.templateImg` ✓ |
| `T24-recheck2-boundary.ts` (canonicalization + persistence boundary rows) | 12 + 28 rows | present, `p.public-link state=none`, every `p.*` `leakS=false leakHost=false` ✓ |
| `T42-boundary.ts` | ROW 1 six shapes closed, `ctlPublicLink` `none` | ROW 1 present, `ctlPublicLink … state=none reasons=[] leaksHost=false` ✓ |
| `T53-base.ts` | `hostileNotNeutralized 0`, `benignFlaggedIds [g05,g06,g07,g08]` | exactly that — T53's original set, `g07`/`g08` back, the accepted reverted false positive ✓ |
| `T53-boundary.ts` | 0 leaking | `"hostileLeakingAtAnyBoundary":0` ✓ |
| `T52-base.ts` | `reachableAfterRedaction []` | `[]` ✓ |
| `T53-corpus.ts` part B | 7 of 30, `codeFenceBaseExample` back | 7 flagged, `codeFenceBaseExample ["egress.html-base-href-exfil"]` present ✓ |
| Suites | green | `bun test src/security/ src/health/ src/commands/init.test.ts src/commands/init.no-git.test.ts` → **380 pass / 0 fail**, 2179 expect(), 45 files (`T70-tests.log`) |
| `bun run typecheck` | exit 0 | exit 0 (`T70-typecheck.log`) |
| `bunx eslint` on the changed files | exit 0 | exit 0, empty output (`T70-eslint.log`) |

### The two stale probe expectations (identified, not reported as regressions)

1. **`T62-state.ts:103`** — the `MODE_MATRIX` row `["gateway", "ci", "weaker", true]`
   hard-codes `gateway → ci` as a downgrade. `T70-state.log` lines 2 and 13 report
   `verdict:"MISMATCH"` for exactly that pair under both broken shapes. This is the
   transition T68 deliberately changed (the three blocking modes are now tied at
   rank 2); the code is right and the probe's expectation is stale. My own M1/M2
   matrix, whose expectations are derived from the contract rather than from a
   pre-T68 artifact, reports OK for the same cells.
2. **`T62-boundary.ts:66-75`** — the two controls `ctlCdnBaseInComment` and
   `ctlCdnBaseInFence` are labelled `hostile: false` under the section comment
   "Controls that must still be caught / **still be quiet**", and their
   `benignByteIdentical` field now reports `false`. That expectation encodes T63's
   suppression, which T67 reverted; the returning false positive is the cost
   T67-spec.md pre-declared and priced. It does not feed the probe's SUMMARY
   verdict, which is why the run still reports `hostileLeakingAtAnyBoundary:0`.
   `T53-base.ts`'s `benignFlaggedIds` returning to `[g05,g06,g07,g08]` is the same
   fact, correctly reported there with no expectation attached.

`T62-mode.ts`'s `M3` is a bare observational dump with no expectation field, as
T68-spec.md said; its `gateway→ci` / `gateway→enforced` rows now read
`downgradeDetected:false` (`T70-mode.log:53-54,59-60`), which is the intended
consequence of the fix.

## Findings

### [F-001] Three shipped documentation sites still describe security-mode exit behaviour the code does not have — and the error is not only the omitted `gateway`: they are stale about `ci` and `enforced`, i.e. about folds this phase itself corrected

- **Severity**: major
- **File**: `docs/docs/cli-reference.md:2137` (with `:2140-2141`), `docs/docs/modules.md:784-786` and `:778`
- **Symbol**: the `security` command's documented exit behaviour
- **Problem**: `cli-reference.md:2137-2141` reads: *"`scan`, `check-input`, and
  `check-output` honor the config `mode`: in **advisory** mode (the default) they
  always exit `0` after reporting; in **ci** mode they exit `1` on a gate **fail**;
  in **enforced** mode they exit `1` on a gate **fail** or **needs-approval**.
  `report` exits `1` only under `ci` mode when the aggregated gate is `fail`."*
  Four separate claims here are false against `src/commands/security.ts:683`
  (`reportExitCode`) and `:972` (`exitCodeFor`), which both test
  `mode === "ci" || mode === "enforced" || mode === "gateway"` over the gate values
  `fail`, `needs-approval`, `incomplete` and anything unrecognized:
  1. `gateway` is absent from the enumeration entirely — the F-004 class T68 and
     T73 were correcting.
  2. `ci` is claimed to exit `1` only on `fail`. Measured: `ci` exits `1` on
     `needs-approval` and on `incomplete` too. That asymmetry was closed by
     T38 / T39 F-003 — a fold *this phase* corrected.
  3. `enforced` is claimed to exit `1` on `fail` or `needs-approval`. Measured:
     also on `incomplete` (and on an unrecognized stored gate).
  4. `report` is claimed to exit `1` **only** under `ci`, **only** on `fail`.
     Measured: `enforced` and `gateway` exit `1` as well, and on `needs-approval`,
     `incomplete` and an unrecognized gate as well.
  `modules.md:784-786` repeats claims 1–3 verbatim in the module reference, and
  `modules.md:778`'s table cell repeats claim 4 (`security report` → Exit:
  "**1 in `ci` mode when gate = fail**"). All three sites are inside T73's declared
  ownership (`docs/docs/cli-reference.md` "every line except the already-corrected
  gateway lines around 2086-2099", and `docs/docs/modules.md`); the
  `cli-reference.md` site sits **38 lines below** the paragraph T68 fixed. Neither
  T68's nor T73's enumeration reached them, because both searched for the token
  pairing `enforced/ci` / `advisory.*enforced` and these sentences spell the modes
  out in prose and in a table cell instead.
- **Impact**: AC8's clause *"no shipped guidance describes behaviour the code does
  not have"* fails. Reachability is materially higher than T62 F-004's, because the
  false half is about `ci` — the mode CI pipelines actually set — not about
  `gateway`. An operator reading the canonical CLI reference would conclude that
  `keryx security report` exits `0` under `enforced` and `gateway` (so a pre-merge
  script gating on it silently passes), and that a `needs-approval` decision does
  not stop a `ci` run. Both are the "a check that did not pass looks like a pass"
  shape this phase exists to close, one layer out from the code.
- **Reproduction**: `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T70-guidance.ts`
  (raw `.metaproject/data/gdctx/raw/T70-guidance.log`, sha256
  `b0d65a593d8b2dbba78d8b22312eed0877ca9478f31b4cd7b704b164170a1b6c`). Section
  `A0` measures 26 cells through the real `securityCommand(...)`; each doc
  sentence is then evaluated as a predicate over them:
  ```
  A2 cli-reference.md:2137-2140 "{advisory, ci, enforced} covers it"   CLAIM_HOLDS: false
  A3 cli-reference.md:2140-2141 "report exits 1 ONLY under ci on fail" CLAIM_HOLDS: false
  A4 modules.md:778             "1 in `ci` mode when gate = fail"      CLAIM_HOLDS: false
  A5 modules.md:784-786         "ci on fail; enforced on fail/n-a"     CLAIM_HOLDS: false
  A6 cli-reference.md:2095-2099 (deliberate omission)                  CLAIM_HOLDS: true
  ```
  The load-bearing cells: `report|enforced|fail 1`, `report|gateway|fail 1`,
  `report|ci|needs-approval 1`, `report|ci|incomplete 1`,
  `report|enforced|incomplete 1`, `scan|gateway|fail 1`,
  `check-input|gateway|secret 1`, against `advisory` `0` everywhere. Independently
  corroborated by my re-run of the reviewer's own probe,
  `.metaproject/data/gdctx/raw/T70-mode.log` lines 23-44 (sha256
  `370580ee18e364da14f2f1e4312e5516ad574b679cd6bdf1af75015ce91e68f1`).
- **Suggested fix**: rewrite the `cli-reference.md:2137-2146` "Exit behavior"
  paragraph and `modules.md:784-786` to state the fold the code actually
  implements — `advisory` always `0`; `enforced`, `ci` and `gateway` exit `1` on
  `fail`, `needs-approval`, `incomplete` **and any unrecognized stored gate** — and
  change the `modules.md:778` table cell to "**1 in `enforced`/`ci`/`gateway` mode
  on a non-passing gate**". Consider deriving these two sentences from
  `isBlockingMode`'s own doc comment so they cannot drift again, and add a doc
  oracle of the shape in `T70-guidance.ts` §A so a future re-ranking is caught by
  a test rather than by a review round.
- **class_scope**:
  - sites: `docs/docs/cli-reference.md:2137-2139` (scan/check-input/check-output
    enumeration); `docs/docs/cli-reference.md:2140-2141` (`report` "only ci … only
    fail"); `docs/docs/modules.md:784-786` (same enumeration); `docs/docs/modules.md:778`
    (`security report` Exit table cell). Correct and left alone, listed so the
    class is closed: `docs/docs/cli-reference.md:2095-2099`, `:330`, `:754`,
    `:912`, `:993`, `:1058`; `docs/docs/modules.md:766`, `:865`, `:874`, `:881`;
    `docs/docs/architecture.md:547`, `:563`, `:634`;
    `docs/docs/workspace-and-lifecycle.md:339`, `:350`;
    `.metaproject/modules/security.md:48`; `.metaproject/core/security/README.md:17`;
    `src/security/templates.ts:63`, `:125`; `src/commands/init.ts:497`.
  - enumeration_method: two independent passes, neither inheriting T68's or T73's
    list. (a) A byte-level line sweep in `T70-guidance.ts` §B over seven shipped
    surfaces for lines that name `enforced`/`ci`, assert a behaviour verb
    (`block|suppress|exit|refus|stop the write|fail the gate|never blocks|warns`)
    and do not name `gateway` — 5 hits, of which `cli-reference.md:1226` is
    unrelated containment prose and `:2096` is the T68-corrected paragraph whose
    `gateway` sits on the preceding line, leaving `:2139`, `:2140` and
    `modules.md:785` as genuine. (b) `bun src/cli.ts ctx rg` over `docs`,
    `.metaproject/modules`, `.metaproject/core`, `src/security`, `src/commands`,
    `src/flow`, `src/health` for
    `enforced.{0,40}(ci|block)|(ci|advisory).{0,40}enforced|block.{0,40}enforced|gateway.{0,60}(not implemented|pending|unimplemented)`
    — 98 raw lines, read directly from
    `.metaproject/data/gdctx/raw/2026-09-06T18-23-19-788Z_rg.log`, **not** from the
    compacted summary, then every hit's surrounding paragraph read with `Read`.
    Pass (b) is what found `modules.md:778`, whose table cell carries no behaviour
    verb and which pass (a) therefore missed — recorded because it shows a single
    regex enumeration is not sufficient for this class, which is the same lesson
    T68 and T73 each learned once.
- **Confidence**: high (every claim executed against the real command dispatcher;
  the docs read in full paragraphs, not in search snippets).

### [F-002] A fourth producer of `SourceRunInfo.error` interpolates adapter-supplied text verbatim into a gate reason that reaches the committable artifact and the flow record — T69 closed three of four, because it enumerated `catch` bindings rather than `error:` producers

- **Severity**: minor
- **File**: `src/health/run.ts:356`
- **Symbol**: `runAdapter` → `validation?.error` → `SourceRunInfo.error` → `computeGate` (`gate.ts:78-79`) → `HealthReport.gate.reasons`
- **Problem**: T69 correctly closed `run.ts:279`, `:314` and `:336`, and its claim
  that `run.ts` is the only file in `src/health/` binding a caught error value is
  **true** (I verified it independently: `ctx rg "catch \("` over `src/health`
  returns four hits, all in `run.ts`). But `SourceRunInfo.error` has a fourth
  producer that is not a `catch` arm at all:
  `error: parseFailed ? validation?.error ?? "source output format was not recognized" : …`.
  `validation` is whatever the source adapter's optional `validate?()` returned
  (`types.ts:224`), so this line writes **unconstrained adapter-supplied text**
  into the same field the three repaired sites write, and `gate.ts:78-79` folds it
  into `INCOMPLETE: required source unavailable: <source>: <text>` exactly the
  same way. The enumeration in T69-spec.md §"Enumeration (method and result)" was
  over `error.message|String(error)|error instanceof Error|\.message\b` and over
  `catch`; neither pattern can reach a site that interpolates a *return value*.
- **Impact**: **latent, not live.** Every shipped adapter supplies a constant from
  a closed vocabulary (`ctx rg "error:" src/health --glob '!*.test.ts'` returns
  exactly two literals in `sources/eslint.ts` and four in
  `sources/dependency-audit.ts`, plus `dependency-audit.ts:145` which forwards one
  of its own constants), so no payload reachable through today's code puts a path
  or a credential into a durable record here. It matters because `validate?()` is
  an **extension point** on a public interface: the next adapter — or a
  third-party one — that returns `` `parse failed: ${err.message}` `` reopens the
  exact leak F-005 named, in the exact field F-005 named, past a fix that looks
  complete. AC8's "no durable or published record contains raw error text, a path
  or source bytes" is met today and is not structurally guaranteed.
- **Reproduction**: `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T70-health-leak.ts`
  (raw `.metaproject/data/gdctx/raw/T70-health-leak.log`, sha256
  `9bf31aaf424ff2dac1c7f74b7090f1ffcf5b4b5aa3de1d468c57a1bad8468eca`), row `P1`,
  a synthetic adapter whose `validate()` returns
  `synthetic validation failure /Users/attacker/.ssh/id_rsa AKIAIOSFODNN7EXAMPLE`,
  driven through the real `runHealth()`:
  ```
  sourceError:        "synthetic validation failure /Users/attacker/.ssh/id_rsa AKIAIOSFODNN7EXAMPLE"
  serviceGateReasons: ["INCOMPLETE: required source unavailable: eslint: synthetic validation failure /Users/attacker/…"]
  LEAK_committableArtifactJson: {path:true, cred:true}
  LEAK_committableArtifactMd:   {path:true, cred:true}
  LEAK_serviceGateReasons:      {path:true, cred:true}
  ```
  Rows H1–H6 in the same run are the negative controls and are all clean, so this
  row is also the proof that the probe can see a leak when one exists.
- **Suggested fix**: apply the same discipline the three repaired sites now use —
  either give this branch a constant category (`source output format was not
  recognized`) unconditionally and move `validation.error` to a field the gate
  does not serialise into `reasons`, or constrain `validate()`'s `error` to a
  closed vocabulary at the type level (a union of the literals the shipped
  adapters already use) so a future adapter cannot supply free text. The latter
  also makes the guarantee checkable by `tsc` rather than by the next review.
- **class_scope**:
  - sites: `src/health/run.ts:356` (the defect); already-safe siblings in the same
    field, listed so the class is closed: `run.ts:279`, `:314`, `:336` (repaired by
    T69), `run.ts:358` (`source command exited ${raw.exitCode} …`, numeric only),
    `run.ts:399` (`"excluded by source filter"`, constant),
    `sources/eslint.ts:122`, `:124`, `sources/dependency-audit.ts:28`, `:36`,
    `:97`, `:145` (all constants).
  - enumeration_method: `bun src/cli.ts ctx rg "error:" src/health --glob '!*.test.ts'`
    read from the raw log `.metaproject/data/gdctx/raw/2026-09-06T18-19-34-569Z_rg.log`
    (14 lines, every one read) — an enumeration over the FIELD rather than over the
    `catch` keyword, which is the axis T69's two sweeps did not cover. Cross-checked
    with `ctx rg "catch \(" src/health` (raw
    `2026-09-06T18-19-26-042Z_rg.log`, 4 hits, all `run.ts`) to confirm T69's own
    claim independently.
- **Confidence**: high (executed end to end at the real entry point and asserted on
  the on-disk artifact; the "no shipped adapter can reach it" half established by
  reading all six constant producers).

### [F-003] The security manifest `keryx init`/`update` writes into every user project claims a mode downgrade produces a finding; only the checksum arm does

- **Severity**: minor
- **File**: `src/security/templates.ts:103-104`, shipped to `<project>/.metaproject/modules/security.md`
- **Symbol**: `renderSecurityManifest`
- **Problem**: the generated manifest's Lifecycle section states *"A `configChecksum`
  mismatch **or a mode downgrade** is always surfaced as **a finding** plus an
  incident entry (self-protection, specification.md §14)."* Against
  `src/security/self-protect.ts`, only the checksum arm pushes a `SecurityFinding`
  (`:90`, the module's **only** `findings.push(` — one occurrence in the whole
  file); the mode-downgrade arm (`:122-132`) and the disabled-policy arm
  (`:160-172`) each push a warning and an incident and **no** finding. `analyze()`
  (`service.ts:107-111`) folds `selfProtection.findings` into the decision, so a
  mode downgrade also does not move the gate or any exit code, which is what a
  reader of this sentence would expect a "finding" to do. The sentence also omits
  the disabled-policy arm, which §14's own invariant (`self-protect.ts:13-17`)
  names alongside the other two.
- **Impact**: AC8's "no shipped guidance describes behaviour the code does not
  have" again, on a surface with a wider blast radius than the docs site: this text
  is written into every project that enables the module and is read by agents as
  the module's own rules. An agent or operator relying on it would expect
  `keryx security scan` to fail on a mode downgrade; it exits `0`. Pre-existing —
  introduced by none of the four repairs, and outside T62 F-004's mode-blocking
  enumeration, which is why neither T68 nor T73 looked at it even though both
  edited this exact function.
- **Reproduction**: `bun …/T70-guidance.ts` (raw `T70-guidance.log`, sha256
  `b0d65a593d…170a1b6c`), row `B §14 manifest claim`:
  `{"manifestHasIt":true,"findingsPushSitesInSelfProtect":1,"note":"only ONE findings.push in the whole module (the checksum arm) — the mode-downgrade arm emits warning+incident and NO finding"}`.
  Corroborated behaviourally by `T70-mode-policy.log` rows `M1 gateway→advisory` /
  `enforced→advisory` / `ci→advisory`, each of which records `mode-downgrade` and a
  warning while `analyze()` returns a decision the same run's `scan` exits `0` on.
- **Suggested fix**: rewrite as "A `configChecksum` mismatch is surfaced as a
  finding plus an incident entry; a mode downgrade or a disabled policy is
  surfaced as a warning plus an incident entry (self-protection, specification.md
  §14)". Note in `T73`'s migration terms that an already-scaffolded project keeps
  the old text until its owner runs `keryx update`.
- **class_scope**:
  - sites: `src/security/templates.ts:103-104` (generator);
    `.metaproject/modules/security.md` (this repo's own checked-in output of it).
    `renderSecurityCoreReadme` (`templates.ts:121`) says only "record incidents on
    tamper or mode downgrade" and is accurate; not touched.
  - enumeration_method: `ctx rg "findings\.push\("` over `src/security/self-protect.ts`
    (1 hit) plus a full read of `evaluateSelfProtection` and of `analyze()`'s
    `selfProtection.findings` fold (`service.ts:107-111`); the manifest and core-README
    generators both read in full in `templates.ts`.
- **Confidence**: high.

### [F-004] The regressions shipped with the health fix never reach `runHealth()` or the persisted artifact, so two of the four hops F-005 named are unpinned

- **Severity**: minor
- **File**: `src/health/health-truthful-gate.test.ts:326-338` (`runThrowingSource`)
- **Symbol**: `runThrowingSource` / the three `F-005:` tests
- **Problem**: T69-spec.md's regression plan committed to asserting "at the real
  `runHealth()` entry point (not a unit call to a helper)" and to checking that the
  reasons reach neither the committable artifact nor the flow record. The delivered
  tests call `runAdapter(...)` and fold the result through `computeGate(...)`
  in memory. That covers the first two hops (`SourceRunInfo.error → computeGate →
  gate.reasons`) but never writes or reads
  `.metaproject/data/health/artifacts/latest.{json,md}` and never goes through
  `runHealth`'s `writeOutputs`. F-005's own problem statement names the artifact
  and the `flow.json` history as the reason the finding exists; a regression that
  stops at the in-memory value is the third evidence-failure shape this phase has
  already been bitten by ("a claim about an artifact must be tested on the
  artifact"). The substitution was reasonable at the time — the `mock.module`
  hazard was real and reproduced — but the coverage it cost was not restored by
  any other means.
- **Impact**: no live defect. My own probe drives the real `runHealth()` and reads
  the artifact from disk, and it is clean at all three sites (`T70-health-leak.log`
  H1–H3). The cost is future: a change to `writeOutputs`, to `report.ts`'s markdown
  rendering, or to `computeGate`'s consumer that reintroduced raw text between
  `runAdapter` and the persisted file would leave every shipped F-005 test green.
- **Reproduction**: read `src/health/health-truthful-gate.test.ts:283-338` — the
  helper's whole body is `runAdapter(...)` + `compute([info])` inside a `mkdtemp`
  that is never read back. Contrast with
  `.metaproject/data/gdctx/raw/T70-health-leak.log` (sha256 `9bf31aaf…8468eca`),
  whose every row carries `LEAK_committableArtifactJson`,
  `LEAK_committableArtifactMd` and `LEAK_serviceGateReasons` measured from disk and
  from `createCodeHealthService().gate(...)`.
- **Suggested fix**: add one end-to-end regression alongside the three unit ones,
  driving `runHealth()` with `mock.module` on `src/health/sources/index.ts` and
  asserting on the bytes of `latest.json`. The registry hazard T69 hit is a
  *within-one-`bun test`-process* effect; a test file that snapshots the real
  module, overrides only `FINDING_ADAPTERS`, and restores it in `afterAll` (the
  discipline T47/T49 established) or a separate single-file test invocation both
  avoid it. `T70-health-leak.ts` is a working template.
- **Confidence**: high (the test file read in full; the alternative demonstrated to
  work in `T70-health-leak.ts`).

### [F-005] The `security hooks install` advisory-mode note tells the operator to set `enforced` or `ci` and omits `gateway`

- **Severity**: info
- **File**: `src/commands/security.ts:801`
- **Symbol**: `securityCommand` (`hooks install`)
- **Problem**: the operator-facing note printed after a hook install under
  `advisory` reads *"Set `mode` to `enforced` or `ci` in
  .metaproject/security.config.json to make it refuse."* Since T61/T65, `gateway`
  makes it refuse identically (`T70-guidance.log` `check-input|gateway|secret: 1`).
  Unlike `init.ts:497`, which T73 corrected because its "mode only" made the
  sentence false, this one has no "only" and is therefore incomplete rather than
  false. It is a runtime string, not a code comment, so it is closer to shipped
  guidance than the sites in F-006. T73's own enumeration regex
  (`advisory.*enforced`) matches this line and its stated scope included
  `src/commands`, but only `init.ts:497` was listed.
- **Impact**: none demonstrated — no check is relabeled and nothing is let through;
  an operator who follows the advice gets a refusing guard. Recorded because it is
  a residual of the exact class the dispatch asked me to close, on a surface an
  operator actually reads.
- **Reproduction**: read `src/commands/security.ts:799-803`; behaviour measured in
  `.metaproject/data/gdctx/raw/T70-guidance.log` row `A0`
  (`check-input|gateway|secret: 1` vs `check-input|advisory|secret: 0`).
- **Suggested fix**: "Set `mode` to `enforced`, `ci` or `gateway` …".
- **Confidence**: high.

### [F-006] Seven internal comments still enumerate `enforced`/`ci` as the blocking set

- **Severity**: info
- **File**: `src/security/guard.ts:271`, `:337`, `:349`, `:406`; `src/security/service.ts:373`; `src/flow/service.ts:647`; `src/flow/types.ts:214`
- **Symbol**: assorted doc comments
- **Problem**: each says "enforced/ci blocks" / "enforced/ci → may fail" where
  `gateway` behaves identically. `guard.ts:260-262` and `:213` and `:9` and `:418`
  in the same file are correct and name all three, so the file contradicts itself
  within eleven lines (`:260` correct, `:271` incomplete).
  `src/security/service.ts:373` is notable because `service.ts` was inside T68's
  own declared ownership.
- **Impact**: none at runtime. Developer- and agent-facing only; these are not
  written into user projects and are not published documentation, which is why this
  is `info` and not part of F-001. Recorded so the class is closed rather than
  rediscovered in a seventh round.
- **Reproduction**: `bun src/cli.ts ctx rg` sweep, raw
  `.metaproject/data/gdctx/raw/2026-09-06T18-23-19-788Z_rg.log`, lines 1, 3, 7,
  56-59 read directly (the compacted summary is not sufficient here — see the
  routing audit).
- **Suggested fix**: one pass adding `gateway` to each, or replacing the
  enumeration with a reference to `isBlockingMode`, whose own comment
  (`guard.ts:212-213`) is already correct and is the single source of truth.
- **Confidence**: high.

### [F-007] `MODE_RANK`'s new comment cites a matrix that lives in a different probe

- **Severity**: info
- **File**: `src/security/self-protect.ts:51`
- **Symbol**: `MODE_RANK`
- **Problem**: the comment says the surviving `→ advisory` invariant is "verified in
  `T62-state.ts`'s M3 matrix and `security.test.ts`". `T62-state.ts` has no M3
  section — its sections are `A`, `B0`–`B3`, `C`, `D`; `M3` is in `T62-mode.ts`.
  A reader following the citation to check the claim finds nothing.
- **Impact**: none on behaviour. The claim itself is true — I re-measured it
  independently across all twelve ordered pairs — only the pointer is wrong.
- **Reproduction**: `T70-state.log` (the full output of `T62-state.ts`, 29 rows, no
  `M3`) against `T70-mode.log:49-60` (`"label":"M3 rank"`).
- **Suggested fix**: cite `T62-mode.ts`'s M3, or cite the section by name rather
  than by file.
- **Confidence**: high.

## Judgement calls

### The `runAdapter` test-only export — **acceptable as made, with one condition the implementer did not meet**

The export is narrow and honest. Three things establish that:

1. **Blast radius, enumerated rather than asserted.** `ctx rg "runAdapter"` over
   `src/` returns four hits: the definition, `run.ts`'s own call site,
   and two in `src/health/health-truthful-gate.test.ts`. There is no
   `src/health/index.ts` barrel; `run.ts` is imported by exactly three non-test
   files/sites and every one of them imports only `runHealth`
   (`src/health/service.ts:5`, `src/testing/block-d-no-network.test.ts:6`,
   `src/health/provenance.test.ts:5`). The module's public seam is
   `createCodeHealthService()` in `service.ts`, which is unchanged. So nothing in
   production can reach the new symbol, and the CLI/MCP surface is untouched.
2. **The hazard it avoids is real and was reproduced.** Bun's `mock.module`
   replaces the shared module registry for the remainder of a `bun test` process,
   and `./sources` is imported by nearly everything that calls `runHealth`; T69
   reproduced the resulting `provenance.test.ts` failure with either file ordered
   first. That is not a hypothetical.
3. **The cost is documented at the site.** `run.ts:237-246` states the reason, the
   incident, and the invariant ("No other caller outside this module's tests uses
   this export; `runHealth` above remains the only production entry point") — which
   is the convention this repository already applies to every other deliberate
   asymmetry.

I do not accept the implied stronger claim that `mock.module` was unusable. It was
unusable *for a test file sharing a process with `provenance.test.ts`*. My own
`T70-health-leak.ts` uses exactly `mock.module` on
`src/health/sources/index.ts` in its own process and drives the real `runHealth()`
through all three catch sites with no cross-talk at all. The condition that should
have come with the export is that the coverage it displaced be restored some other
way — and it was not: the shipped regressions stop at an in-memory `computeGate`
result and never touch the artifact F-005 is about. **Ruling: the export stays
(it leaks no production surface and buys real determinism); the missing end-to-end
regression is recorded as F-004 and should be added.**

### Tree integrity after the `git stash` incident — **the tree is whole**

I verified this four independent ways rather than taking the implementer's word,
and without changing any git state:

1. **No orphaned stash exists for this line of work.** `git stash list` and
   `git log -g refs/stash` both return exactly five entries, and every one is from
   a different branch and a different era: `On main: codex: preserve local graph
   provenance…`, `On docs/sandbox-harness-hardening-package: flow-110-wip`,
   `On feat/p0-sandbox-credential-auto-mask: wip-unrelated-metaproject`,
   `On main: wiki`, `On codex/telegram-harness-docpack: … 2026-07-13`. There is no
   `On codex/agent-first-core` entry, which is what a successful `pop` leaves
   behind (a *failed* or conflicted pop keeps the entry).
2. **The blast radius was narrower than "a file carrying other tasks' work" makes
   it sound, and that narrowness is structural.** `git stash push -- src/health/run.ts`
   is pathspec-scoped, so only that one tracked file was reset, and `git stash push`
   without `-u` does not touch untracked files at all — so the four untracked new
   test files in `src/health/` (`config.test.ts`,
   `dependency-audit-format.test.ts`, `health-truthful-gate.test.ts`,
   `service-gate-exit.test.ts`) were never at risk.
3. **The other tasks' work is demonstrably back in that file.**
   `git diff --stat -- src/health/run.ts` reports **153 insertions, 15 deletions**
   uncommitted, and I read the restored content directly: the
   `execution`/`parse`/`exitCode` fields on `base` (`run.ts:261-263`), the
   `filteredOutcome` helper and its `"excluded by source filter"` constant
   (`:399`), and T69's own `safeErrorCode`/`errorCodeSuffix` (`:219-235`) are all
   present simultaneously. A pop that had dropped either side would show one of
   them missing.
4. **Nothing anywhere in the tree is in a half-restored state.** `ctx rg` for
   conflict markers (`^<<<<<<<`, `^=======$`, `^>>>>>>>`) over `src/` returns
   zero hits; `bun run typecheck` exits 0; `bunx eslint` on every changed file
   exits 0 with empty output; and 380 tests across 45 files pass with 0 failures.

The one residual I cannot rule out by inspection is a race: had the concurrent
worker written to `src/health/run.ts` between the `push` and the `pop`, the pop
could have conflicted. It did not — a conflicted pop leaves the stash entry in
place, and there is none. **Ruling: the working tree is whole; the incident cost
nothing.** It does, however, confirm the standing rule in this flow — `git stash`
in a checkout where every task's work is uncommitted is a destructive operation
even when pathspec-scoped, and the implementer's own switch to `sed` plus a
file-level backup for the remaining RED/GREEN cycles was the right correction.

**Effect on my confidence:** neither process fact lowers it. The stash was
reversed within the same turn and is verifiable as reversed from repository state
alone; the export is inert in production. What *did* affect my confidence is
unrelated to both: the concurrent edits to `src/security/detect/exfil.ts`
mid-review, which I handled by re-running every row-1 matrix against the
post-drift bytes and confirming the two decisive logs are byte-identical to the
pre-drift ones.

## Confirmed clean areas

- **The revert is complete and nothing of value went with it.** All six reviewer
  shapes are findings and masked at every boundary; the six-shape table is pinned
  by `exfil.test.ts:654` and the three previously-suppression-asserting tests are
  inverted rather than deleted (`:617`, `:626`, `:638`). `BASE_REMEDIATION`,
  the remediation-override mechanism, the blast-radius disclosure, the asymmetry
  paragraph, the T53#F-002 sufficiency argument and the T53#F-003 EOF paragraph are
  all present, and the last two are pinned by execution (`exfil.test.ts:731`,
  `:746`), not by prose. The recorded reason is accurate about *why* the approach
  failed (regex-vs-grammar in the releasing direction, with the three missing
  comment terminators and the independent span computation both named) and about
  what would make it revisitable (a real tokenizer plus a real CommonMark pass,
  failing toward flagging on every ambiguity, with hostile payloads in every span
  kind, and the two measurements that must go green).
- **The rank table now expresses exactly the two behavioural classes the code has.**
  Twelve ordered pairs, six within-blocking transitions, and the three
  `→ advisory` transitions all behave as the contract requires, measured on the
  durable incident file.
- **The disabled-policy guard removal is safe for the shape it had to stay silent
  for, by construction and by measurement.** Twelve unusable-payload rows,
  including the adversarial "all five policies already disabled" prior, are silent;
  `configUnreadable` has exactly two producers and one of them passes a literal
  `{}` to `mergeSecurityConfig`.
- **The health gate verdicts did not move.** `incomplete` at all three repaired
  sites and `pass` on the control, identical in memory, on disk, and through the
  real service — and structurally guaranteed, since `computeGate`'s
  `brokenRequired` filter never reads `s.error`.
- **AC5 (AFC-15) holds unchanged**: 48-case corpus 0/0, 240 character-reference
  cases with `absentButUrlSyntax: []` (no field-name or spelling bypass), URL
  secrets masked, and the public Markdown link still `state=none` at both
  `T42-boundary`'s `ctlPublicLink` and `T24-recheck2-boundary`'s `p.public-link`.
- **Sixteen of the eighteen enumerated guidance sites are correctly fixed, and both
  deliberate omissions are genuinely accurate** — `cli-reference.md:2095-2099`
  confirmed by measurement (`A6 CLAIM_HOLDS: true`), `modules.md:766` confirmed by
  reading the qualifier "always-on" against the shipped scope. Both generator
  functions and both of this repository's own checked-in copies of their output
  carry the corrected enumeration.

## Evidence

Raw logs, all under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`,
SHA-256 recorded in `T70-evidence-sha256.txt`:

| Log | SHA-256 |
|---|---|
| `T70-exfil.log` | `abb3fe3220aa0ba638f1983b6facf04ef5ee8a991cc79245994723e5ea1af49a` |
| `T70-boundary.log` | `430bedbe94091477e90f4df5cc512a27299ae3e8c33e73696b18427bbf69c962` |
| `T70-state.log` | `50b7dd2682585c8c336ad514a42d5cac2d25d746fa785d4b5eebe3b2150d62a1` |
| `T70-mode.log` | `370580ee18e364da14f2f1e4312e5516ad574b679cd6bdf1af75015ce91e68f1` |
| `T70-health.log` | `ee63c9298bc92e1b6b632d324a5d7ab18e8c7b5c0a301b823272f2281ee9792a` |
| `T70-flow.log` | `244c9508c37c00c5aeb7f7570d8d5bdde50274d99752d337c0b776b6e253d878` |
| `T70-health-leak.log` | `9bf31aaf424ff2dac1c7f74b7090f1ffcf5b4b5aa3de1d468c57a1bad8468eca` |
| `T70-mode-policy.log` | `07c2ffbd4317b3232c6b60b5842ae31cf68a47037b7210513c5db25bd7fbe701` |
| `T70-guidance.log` | `b0d65a593d8b2dbba78d8b22312eed0877ca9478f31b4cd7b704b164170a1b6c` |
| `T70-tests.log` | `624ab7ea434b5f55831c019165867a0e2fbed63a52bceaec68d838d42aa15f33` |
| `T70-typecheck.log` | `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92` |
| `T70-eslint.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| `T70-post-T62-exfil.log` | `abb3fe3220aa0ba638f1983b6facf04ef5ee8a991cc79245994723e5ea1af49a` (identical to pre-drift) |
| `T70-post-T62-boundary.log` | `430bedbe94091477e90f4df5cc512a27299ae3e8c33e73696b18427bbf69c962` (identical to pre-drift) |
| `T70-post-T53-extract.log` | `ad20286ba1aab3f8e810d3c84f6a8610ba96e6362e810b5caf476f50b80834ad` |
| `T70-post-T53-resolve.log` | `0603791031f8f078bf7481c787fc828859306e62f95cc2109bf253c8b53cb2e4` |
| `T70-post-T53-base.log` | `3416d62e56b7674e1208cd0bcb0aa9b3a3484f7baa50612c2819d56d8872254c` |
| `T70-post-T53-boundary.log` | `398012ceb8654c55f51235fd5548e0576c3369c7cf8159c251ccb2ff69b3768d` |
| `T70-post-T53-corpus.log` | `e38af74896b1a80f01addf0636bf4bfb71da5682582552652dc8d0187b076427` |
| `T70-post-T42-exfil-attack.log` | `0646c50821177132e3e84528af5557b609f244fc13f109224de1496f879222ba` |
| `T70-post-T42-charrefs.log` | `698d88993076fd92aad9b4a4e1f8235a0eac2b7490baa0d34d8d1c65cac1b452` |
| `T70-post-T42-boundary.log` | `7030455d39a56b12e98c75b8a74c699a3d488dbf9d04b4ac060bfe9151f957c8` |
| `T70-post-T24-recheck2-exfil.log` | `8c9bfec0481cd22957d98f5cd17f4ee37eb9a2c2d1d86bd88593d36bf2abf519` |
| `T70-post-T24-recheck2-boundary.log` | `838399622c42414f63dbda91cdd9c61dd0b4f83982c630ec1c34f5abeff3064b` |
| `T70-post-T46-surfaces.log` | `d8348c995f7686e16bac791caa429de427d31e02c4ec1b6c8fe6c48e0f959bf8` |
| `T70-post-T52-base.log` | `a04404db8a1571b102dc21ae85517b3345eb94496553c0fb8bded5811010dff2` |

Supporting `ctx rg` raw logs read directly (not via the compacted summary):
`2026-09-06T18-16-01-571Z_rg.log`, `2026-09-06T18-16-25-013Z_rg.log`,
`2026-09-06T18-16-53-156Z_rg.log`, `2026-09-06T18-19-26-042Z_rg.log`,
`2026-09-06T18-19-34-569Z_rg.log`, `2026-09-06T18-23-19-788Z_rg.log`.

Probe scripts written by this review (new files, nothing else modified):
`T70-health-leak.ts`, `T70-mode-policy.ts`, `T70-guidance.ts`.

## Routing audit

- `graph_used`: **no** — *not-relevant*. The dispatch named every file and every
  probe; the question was behavioural, not structural, and
  `.metaproject/data/gdgraph/.provenance.json` is itself uncommitted-modified, so
  the graph predates this session's tree anyway. No blast-radius question arose
  that reading the four named modules did not answer.
- `wiki_used`: **no** — *not-relevant*. Every claim under recheck is about code and
  about specific shipped sentences; `docs/requirements/keryx-agent-first-core/policies.md`
  and the flow's frozen `acceptance-criteria.md` were read directly and are the
  authoritative sources for the ACs, and the wiki carries no page that adjudicates
  them.
- `ctx_used`: **yes** — every text search went through `bun src/cli.ts ctx rg` and
  every command through `bun src/cli.ts ctx run` where the hook required it.
- `raw_rg_used`: **no** bare `rg`/`grep`/`find` over project code. `grep` was used
  three times, each time over a gdctx raw log this session itself produced (my own
  probe output and my own hash manifests), with a `# keryx:raw` marker and a stated
  reason — never over source.
- **gdctx compaction defect, observed again, three times.** The compacted summary
  silently dropped rows in every one of the following, and I read the raw log
  instead each time: `^#+ .*F-00|^## ` over `T62-review.md` (header said
  `Matches: 14`, rendered 4 — the ten dropped rows were the finding headings, i.e.
  the entire point of the search); `SENSITIVE_URL_VALUE|HTML_START_TAG|readStartTag`
  over `exfil.ts` (header `Matches: 12`, rendered 4 — the dropped rows included the
  definition of the symbol I was checking existed, which briefly looked like a
  dangling cross-reference); and the 98-line mode-prose sweep. This is the fourth
  observation in this phase. Any count in this review that came from a compacted
  header rather than from a raw log is not cited.

## keryx:findings

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T70#F-001",
    "reviewer": "review-security-code+review-logic (T70 independent recheck)",
    "severity": "major",
    "file": "docs/docs/cli-reference.md",
    "line": 2137,
    "symbol": "security command documented exit behaviour",
    "problem": "Three shipped documentation sites still describe security-mode exit behaviour the code does not have. cli-reference.md:2137-2141 and modules.md:784-786 omit `gateway` entirely, claim `ci` exits 1 only on a gate `fail` (it also exits 1 on `needs-approval` and `incomplete`, an asymmetry T38/T39 F-003 closed in this phase) and claim `enforced` exits 1 only on `fail`/`needs-approval` (it also exits 1 on `incomplete`); cli-reference.md:2140-2141 and the modules.md:778 table cell claim `security report` exits 1 ONLY under `ci` and ONLY when the gate is `fail`, while reportExitCode (src/commands/security.ts:683) returns 1 for ci||enforced||gateway on `fail`, `needs-approval`, `incomplete` and any unrecognized stored gate. All three sites are inside T73's declared ownership; the cli-reference.md site is 38 lines below the paragraph T68 fixed. Neither T68's nor T73's enumeration reached them because both searched for the token pairing `enforced/ci`, and these sentences spell the modes out in prose and in a table cell.",
    "impact": "AC8's clause 'no shipped guidance describes behaviour the code does not have' fails. Reachability is higher than T62 F-004's because the false half is about `ci`, the mode CI pipelines actually set: an operator reading the canonical CLI reference concludes that `keryx security report` exits 0 under `enforced` and `gateway` (so a pre-merge script gating on it silently passes) and that a `needs-approval` decision does not stop a `ci` run. Both are the 'a check that did not pass looks like a pass' shape this phase exists to close, one layer out from the code.",
    "suggested_fix": "Rewrite cli-reference.md:2137-2146 and modules.md:784-786 to state the implemented fold - advisory always 0; enforced, ci and gateway exit 1 on fail, needs-approval, incomplete and any unrecognized stored gate - and change the modules.md:778 Exit cell to '1 in enforced/ci/gateway mode on a non-passing gate'. Derive these sentences from isBlockingMode's own doc comment, and add a doc oracle of the shape in T70-guidance.ts section A so a future re-ranking is caught by a test rather than by a review round.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T70-guidance.ts -> .metaproject/data/gdctx/raw/T70-guidance.log (sha256 b0d65a593d8b2dbba78d8b22312eed0877ca9478f31b4cd7b704b164170a1b6c). Section A0 measures 26 exit-code cells through the real securityCommand(...): report|enforced|fail 1, report|gateway|fail 1, report|ci|needs-approval 1, report|ci|incomplete 1, report|enforced|incomplete 1, scan|gateway|fail 1, check-input|gateway|secret 1, advisory 0 everywhere. Claims A2, A3, A4, A5 all CLAIM_HOLDS:false; A6 (the deliberate omission at cli-reference.md:2095-2099) CLAIM_HOLDS:true. Corroborated by .metaproject/data/gdctx/raw/T70-mode.log lines 23-44 (sha256 370580ee18e364da14f2f1e4312e5516ad574b679cd6bdf1af75015ce91e68f1).",
    "confidence": "high",
    "dedupe_key": "shipped-guidance/security-mode-exit-behaviour/cli-reference-2137+modules-778-785",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "docs/docs/cli-reference.md:2137-2139 (scan/check-input/check-output mode enumeration) - DEFECT",
        "docs/docs/cli-reference.md:2140-2141 (report exits 1 only under ci on fail) - DEFECT",
        "docs/docs/modules.md:784-786 (same mode enumeration) - DEFECT",
        "docs/docs/modules.md:778 (security report Exit table cell) - DEFECT",
        "docs/docs/cli-reference.md:2095-2099 - correct (T68), measured accurate",
        "docs/docs/cli-reference.md:330, :754, :912, :993, :1058 - correct (T73)",
        "docs/docs/modules.md:766 - correct, deliberately left ('always-on' qualifier)",
        "docs/docs/modules.md:865, :874, :881 - correct (T73)",
        "docs/docs/architecture.md:547, :563, :634 - correct (T73)",
        "docs/docs/workspace-and-lifecycle.md:339, :350 - correct (T73)",
        ".metaproject/modules/security.md:48 - correct (T73)",
        ".metaproject/core/security/README.md:17 - correct (T73)",
        "src/security/templates.ts:63, :125 - correct (T68), generators verified by rendering",
        "src/commands/init.ts:497 - correct (T73)"
      ],
      "enumeration_method": "Two independent passes, neither inheriting T68's or T73's table. (a) A byte-level line sweep in T70-guidance.ts section B over seven shipped surfaces for lines naming enforced/ci with a behaviour verb (block|suppress|exit|refus|stop the write|fail the gate|never blocks|warns) and no gateway: 5 hits, of which cli-reference.md:1226 is unrelated containment prose and :2096 is the T68-corrected paragraph whose gateway sits on the preceding line, leaving :2139, :2140 and modules.md:785. (b) 'bun src/cli.ts ctx rg' over docs, .metaproject/modules, .metaproject/core, src/security, src/commands, src/flow, src/health for enforced.{0,40}(ci|block)|(ci|advisory).{0,40}enforced|block.{0,40}enforced|gateway.{0,60}(not implemented|pending|unimplemented) - 98 raw lines read directly from .metaproject/data/gdctx/raw/2026-09-06T18-23-19-788Z_rg.log (NOT the compacted summary), then every hit's surrounding paragraph read with Read. Pass (b) found modules.md:778, whose table cell carries no behaviour verb and which pass (a) missed - recorded because it shows a single regex enumeration is not sufficient for this class, the same lesson T68 and T73 each learned once. Every claim was then executed as a predicate against measured exit-code cells rather than judged by reading."
    }
  },
  {
    "id": "F-002",
    "global_id": "T70#F-002",
    "reviewer": "review-security-code+review-logic (T70 independent recheck)",
    "severity": "minor",
    "file": "src/health/run.ts",
    "line": 356,
    "symbol": "runAdapter -> validation?.error -> SourceRunInfo.error -> computeGate -> HealthReport.gate.reasons",
    "problem": "T69 closed the three catch arms (run.ts:279, :314, :336) and its claim that run.ts is the only file in src/health binding a caught error value is true (independently verified: ctx rg 'catch (' over src/health returns four hits, all in run.ts). But SourceRunInfo.error has a fourth producer that is not a catch arm: error: parseFailed ? validation?.error ?? \"source output format was not recognized\" : ... . `validation` is whatever the source adapter's optional validate?() returned (types.ts:224), so this line writes unconstrained adapter-supplied text into the same field the three repaired sites write, and gate.ts:78-79 folds it into 'INCOMPLETE: required source unavailable: <source>: <text>' identically. T69's two enumeration sweeps were over error.message|String(error)|error instanceof Error|\\.message\\b and over `catch`; neither pattern can reach a site that interpolates a return value.",
    "impact": "Latent, not live. Every shipped adapter supplies a constant from a closed vocabulary (two literals in sources/eslint.ts, four in sources/dependency-audit.ts), so no payload reachable through today's code puts a path or credential into a durable record here. It matters because validate?() is an extension point on a public interface: the next adapter that returns 'parse failed: ${err.message}' reopens the exact leak F-005 named, in the exact field F-005 named, past a fix that looks complete. AC8's 'no durable or published record contains raw error text, a path or source bytes' is met today and is not structurally guaranteed.",
    "suggested_fix": "Give this branch a constant category unconditionally and move validation.error to a field the gate does not serialise into reasons; or constrain SourceAdapter.validate()'s error to a closed vocabulary at the type level (a union of the literals the shipped adapters already use) so a future adapter cannot supply free text and tsc enforces the guarantee.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T70-health-leak.ts -> .metaproject/data/gdctx/raw/T70-health-leak.log (sha256 9bf31aaf424ff2dac1c7f74b7090f1ffcf5b4b5aa3de1d468c57a1bad8468eca), row P1: a synthetic adapter whose validate() returns 'synthetic validation failure /Users/attacker/.ssh/id_rsa AKIAIOSFODNN7EXAMPLE', driven through the real runHealth(), yields LEAK_committableArtifactJson {path:true,cred:true}, LEAK_committableArtifactMd {path:true,cred:true} and LEAK_serviceGateReasons {path:true,cred:true} - measured on the on-disk artifact and through createCodeHealthService().gate(). Rows H1-H6 in the same run are the negative controls and are all clean.",
    "confidence": "high",
    "dedupe_key": "health/source-run-info-error/unconstrained-adapter-validation-error",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/health/run.ts:356 (validation?.error interpolated verbatim) - DEFECT",
        "src/health/run.ts:279, :314, :336 - repaired by T69, verified clean",
        "src/health/run.ts:358 (source command exited <exitCode>) - numeric only, safe",
        "src/health/run.ts:399 ('excluded by source filter') - constant, safe",
        "src/health/sources/eslint.ts:122, :124 - constants",
        "src/health/sources/dependency-audit.ts:28, :36, :97, :145 - constants"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg 'error:' src/health --glob '!*.test.ts' read from the raw log .metaproject/data/gdctx/raw/2026-09-06T18-19-34-569Z_rg.log (14 lines, every one read) - an enumeration over the FIELD rather than over the catch keyword, which is the axis T69's two sweeps did not cover. Cross-checked with ctx rg 'catch (' src/health (raw 2026-09-06T18-19-26-042Z_rg.log, 4 hits, all run.ts) to confirm T69's own claim independently."
    }
  },
  {
    "id": "F-003",
    "global_id": "T70#F-003",
    "reviewer": "review-security-code+review-logic (T70 independent recheck)",
    "severity": "minor",
    "file": "src/security/templates.ts",
    "line": 103,
    "symbol": "renderSecurityManifest",
    "problem": "The manifest keryx init/update writes into every user project states 'A configChecksum mismatch or a mode downgrade is always surfaced as a finding plus an incident entry (self-protection, specification.md 14).' Only the checksum arm pushes a SecurityFinding (self-protect.ts:90, the module's only findings.push - one occurrence in the whole file); the mode-downgrade arm (:122-132) and the disabled-policy arm (:160-172) each push a warning and an incident and no finding. analyze() (service.ts:107-111) folds only selfProtection.findings into the decision, so a mode downgrade does not move the gate or any exit code either. The sentence also omits the disabled-policy arm that 14's own invariant (self-protect.ts:13-17) names alongside the other two.",
    "impact": "AC8's 'no shipped guidance describes behaviour the code does not have', on a surface with wider blast radius than the docs site: this text is written into every project that enables the module and is read by agents as the module's own rules. An agent or operator relying on it would expect keryx security scan to fail on a mode downgrade; it exits 0. Pre-existing, introduced by none of the four repairs and outside T62 F-004's mode-blocking enumeration, which is why neither T68 nor T73 looked at it even though both edited this exact function.",
    "suggested_fix": "Rewrite as: 'A configChecksum mismatch is surfaced as a finding plus an incident entry; a mode downgrade or a disabled policy is surfaced as a warning plus an incident entry (self-protection, specification.md 14).' Note in T73's migration terms that an already-scaffolded project keeps the old text until its owner runs keryx update.",
    "evidence": ".metaproject/data/gdctx/raw/T70-guidance.log (sha256 b0d65a593d8b2dbba78d8b22312eed0877ca9478f31b4cd7b704b164170a1b6c), row 'B 14 manifest claim': manifestHasIt true, findingsPushSitesInSelfProtect 1, note 'only ONE findings.push in the whole module (the checksum arm) - the mode-downgrade arm emits warning+incident and NO finding'. Corroborated behaviourally by .metaproject/data/gdctx/raw/T70-mode-policy.log rows M1 gateway->advisory / enforced->advisory / ci->advisory, each recording mode-downgrade plus a warning while the run's decision leaves scan exiting 0.",
    "confidence": "high",
    "dedupe_key": "shipped-guidance/security-manifest/mode-downgrade-claimed-as-finding",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  },
  {
    "id": "F-004",
    "global_id": "T70#F-004",
    "reviewer": "review-security-code+review-logic (T70 independent recheck)",
    "severity": "minor",
    "file": "src/health/health-truthful-gate.test.ts",
    "line": 326,
    "symbol": "runThrowingSource / the three F-005 regressions",
    "problem": "T69-spec.md's regression plan committed to asserting 'at the real runHealth() entry point (not a unit call to a helper)' and to checking that reasons reach neither the committable artifact nor the flow record. The delivered tests call runAdapter(...) and fold the result through computeGate(...) in memory: the mkdtemp workspace is created and never read back, and no test writes or reads .metaproject/data/health/artifacts/latest.json or latest.md, or goes through runHealth's writeOutputs. That covers the first two hops F-005 named and leaves the third (the committable artifact) and fourth (the flow record) unpinned - the same evidence-failure shape this phase has already been bitten by, 'a claim about an artifact must be tested on the artifact'.",
    "impact": "No live defect: my own probe drives the real runHealth() and reads the artifact from disk, and it is clean at all three sites. The cost is future - a change to writeOutputs, to report.ts's markdown rendering, or to computeGate's consumer that reintroduced raw text between runAdapter and the persisted file would leave every shipped F-005 test green.",
    "suggested_fix": "Add one end-to-end regression alongside the three unit ones, driving runHealth() with mock.module on src/health/sources/index.ts and asserting on the bytes of latest.json. The registry hazard T69 hit is a within-one-bun-test-process effect; snapshotting the real module, overriding only FINDING_ADAPTERS and restoring in afterAll (the discipline T47/T49 established), or a separate single-file invocation, both avoid it. T70-health-leak.ts is a working template.",
    "evidence": "src/health/health-truthful-gate.test.ts:283-338 read in full - runThrowingSource's whole body is runAdapter(...) + compute([info]) inside a mkdtemp that is never read back. Contrast .metaproject/data/gdctx/raw/T70-health-leak.log (sha256 9bf31aaf424ff2dac1c7f74b7090f1ffcf5b4b5aa3de1d468c57a1bad8468eca), every row of which carries LEAK_committableArtifactJson, LEAK_committableArtifactMd and LEAK_serviceGateReasons measured from disk and through createCodeHealthService().gate().",
    "confidence": "high",
    "dedupe_key": "health/f-005-regressions/never-reach-runhealth-or-artifact",
    "blocking_merge": false,
    "related_skill": "tests-creator",
    "learning_candidate": true
  },
  {
    "id": "F-005",
    "global_id": "T70#F-005",
    "reviewer": "review-security-code+review-logic (T70 independent recheck)",
    "severity": "info",
    "file": "src/commands/security.ts",
    "line": 801,
    "symbol": "securityCommand (hooks install)",
    "problem": "The operator-facing note printed after a hook install under advisory mode reads 'Set mode to enforced or ci in .metaproject/security.config.json to make it refuse.' Since T61/T65, gateway makes it refuse identically. Unlike init.ts:497, which T73 corrected because its 'mode only' made the sentence false, this one has no 'only' and is incomplete rather than false - but it is a runtime string an operator reads, not a code comment. T73's own enumeration regex (advisory.*enforced) matches this line and its stated scope included src/commands, yet only init.ts:497 was listed.",
    "impact": "None demonstrated: no check is relabeled and nothing is let through; an operator who follows the advice gets a refusing guard. Recorded because it is a residual of the exact class the dispatch asked me to close, on a surface an operator actually reads.",
    "suggested_fix": "Change to 'Set mode to enforced, ci or gateway ...'.",
    "evidence": "src/commands/security.ts:799-803 read directly; behaviour measured in .metaproject/data/gdctx/raw/T70-guidance.log row A0 (check-input|gateway|secret: 1 vs check-input|advisory|secret: 0).",
    "confidence": "high",
    "dedupe_key": "shipped-guidance/security-hooks-install-note/omits-gateway",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  },
  {
    "id": "F-006",
    "global_id": "T70#F-006",
    "reviewer": "review-security-code+review-logic (T70 independent recheck)",
    "severity": "info",
    "file": "src/security/guard.ts",
    "line": 271,
    "symbol": "assorted doc comments",
    "problem": "Seven internal comments still enumerate enforced/ci as the blocking set where gateway behaves identically: src/security/guard.ts:271, :337, :349, :406; src/security/service.ts:373; src/flow/service.ts:647; src/flow/types.ts:214. guard.ts:9, :213, :260-262 and :418 in the same file are correct and name all three, so the file contradicts itself within eleven lines (:260 correct, :271 incomplete). src/security/service.ts:373 is notable because service.ts was inside T68's own declared ownership.",
    "impact": "None at runtime. Developer- and agent-facing only; these are not written into user projects and are not published documentation, which is why this is info and not part of F-001. Recorded so the class is closed rather than rediscovered in a seventh round.",
    "suggested_fix": "One pass adding gateway to each, or replacing the enumeration with a reference to isBlockingMode, whose own comment (guard.ts:212-213) is already correct and is the single source of truth.",
    "evidence": "bun src/cli.ts ctx rg sweep, raw .metaproject/data/gdctx/raw/2026-09-06T18-23-19-788Z_rg.log, lines 1, 3, 7 and 56-59 read directly (the compacted summary is not sufficient - see the routing audit).",
    "confidence": "high",
    "dedupe_key": "internal-comments/blocking-mode-enumeration/omits-gateway",
    "blocking_merge": false,
    "related_skill": "review-style",
    "learning_candidate": false
  },
  {
    "id": "F-007",
    "global_id": "T70#F-007",
    "reviewer": "review-security-code+review-logic (T70 independent recheck)",
    "severity": "info",
    "file": "src/security/self-protect.ts",
    "line": 51,
    "symbol": "MODE_RANK",
    "problem": "The new MODE_RANK comment says the surviving '-> advisory' invariant is 'verified in T62-state.ts's M3 matrix and security.test.ts'. T62-state.ts has no M3 section - its sections are A, B0-B3, C and D; M3 is in T62-mode.ts. A reader following the citation to check the claim finds nothing.",
    "impact": "None on behaviour. The claim itself is true - I re-measured it independently across all twelve ordered pairs - only the pointer is wrong.",
    "suggested_fix": "Cite T62-mode.ts's M3, or cite the section by name rather than by file.",
    "evidence": ".metaproject/data/gdctx/raw/T70-state.log (full output of T62-state.ts, 29 rows, no M3) against .metaproject/data/gdctx/raw/T70-mode.log lines 49-60 (label 'M3 rank').",
    "confidence": "high",
    "dedupe_key": "self-protect/mode-rank-comment/wrong-probe-citation",
    "blocking_merge": false,
    "related_skill": "review-style",
    "learning_candidate": false
  }
]
```
