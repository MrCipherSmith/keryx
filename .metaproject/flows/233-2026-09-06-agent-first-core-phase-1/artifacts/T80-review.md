STATUS: DONE_WITH_CONCERNS

# T80 — seventh-pass independent review: shipped security-mode guidance and hints

Reviewer: `review-logic` (independent). I wrote none of the code, none of the
earlier reviews (T62/T68/T70/T73/T75/T76), and none of the T79 repair under
recheck. Root: `/Users/Goodea/goodea/keryx` (`pwd` confirmed before the first
read). No `.claude/worktrees/**` entered. No `git stash` at any point. Read-only
on all production/test/documentation files — every edit this review made is
confined to `T80-review.md`, `T80-result.json`, and two new probe scripts
(`T80-pin-check.ts`, `T80-manifest-drift.ts`) under this flow's artifacts
directory.

## Scope

- Branch: `codex/agent-first-core`. Base commit: `0bc6418` ("feat(metaproject):
  shrink the routing gate..."). All work under review (T79's fixes, the
  orchestrator's F-005 fix) is uncommitted in this checkout.
- File hashes (SHA-256), start → end — **byte-identical** for every production/
  test/doc file this review touched by reading; I made zero edits to any of
  them:

| File | start = end |
|---|---|
| `src/lib/templates.ts` | `a00f00fc…c545eb11` |
| `src/lib/security-pre-push.test.ts` | `bd80ff9b…1382571` |
| `src/security/templates.ts` | `96a0f00d…0783bb82` |
| `src/security/templates.test.ts` | `59efca0d…1e8f51` |
| `src/commands/init.ts` | `59f38967…bedff1924` |
| `src/commands/update.ts` | `bee83129…c6545ae18` |
| `src/commands/security.ts` | `6f72eb71…f450dd304ed` |
| `src/commands/health.ts` | `8ce5d287…37570dcd` |
| `src/health/gate.ts` | `4d31021c…44514faa5` (matches T76's own recorded hash — unchanged since) |
| `docs/docs/modules.md` | `ce0ad102…777bdd982` |
| `docs/docs/cli-reference.md` | `23d22fc2…068b4c58` (matches T76's own recorded hash) |
| `.metaproject/modules/security.md` | `62553126…159f13384fbb8ae5ca` |
| `.metaproject/core/security/README.md` | `9a52969b…5fc3bb5759832f2bd573910e` |
| `.metaproject/flows/.../RESIDUALS.md` | `539afa6b…353a336bb53e99c7d` |

## Summary

| Severity | Count |
|---|---|
| blocker | 0 |
| major | 0 |
| minor | 2 (both new, both documentation-grade) |
| info | 0 |

Every item T79/the orchestrator was dispatched to fix is confirmed fixed and
measured accurate. My own independent re-enumeration, widened past T79's
keyword list to a full byte-level comparison between the two generator
functions and their self-hosted checked-in copies, found **one new,
previously-undiscovered live defect** ([F-001] below) that predates this
entire review chain and evaded every prior sweep because it falls outside the
keyword family (`advisory|enforced|gateway|mode-gated|secret/critical|
needs-approval`) every probe from T70 through T79 used. It is **minor,
documentation-grade, not blocking** — the actual runtime behaviour is correct;
only one self-hosted static file is stale. A second finding ([F-002]) is a
process observation, not a code defect: two of the three "unpinnable"
corrections are merely unpinned, using a pinning idiom this repo already has
and uses elsewhere. Both are recorded for the residual list per RESIDUALS.md's
own rule (documented, not reopened as a fix round), since neither is blocking
and reproduced on a public boundary — the one exception the rule allows.

## Stage 1

| # | Item | Verdict | What I did and found |
|---|---|---|---|
| 1 | The enumeration axis: re-derive it myself, check the "six mechanisms" claim, sweep a seventh if one exists | **PASS, with a caveat** | Re-derived independently: (1) generator functions written to disk by init/update, (2) interactive prompts in init.ts/update.ts, (3) CLI runtime console strings, (4) the docs site, (5) this repo's own checked-in self-hosted copies of generated content, (6) root README. I ran a broad, non-keyword-scoped `ctx rg` for the shape `'enforced'/'ci'` / `enforced/ci` / `mode-gated` / `secret/critical` across the **entire tracked tree** (not restricted to any of the six mechanisms' known files) and found no categorically new (seventh) mechanism — every hit landed inside one of the six, and every hit outside T79's own fixed set was either an internal code/test comment (established non-shipped precedent, RESIDUALS.md's T70#F-005..F-007 entry) or already-correct prose. **The caveat**: the axis's six *mechanisms* are sound, but T79's *execution* within mechanism 5 (self-hosted checked-in copies) was bounded by a fixed keyword list, not a full-content comparison against the generator each copy is supposed to mirror. A full byte-diff of `.metaproject/modules/security.md` against `renderSecurityManifest()`'s live output — a check T79's own probe never performed — surfaces a real, live, previously-undiscovered drift outside that keyword family. See F-001. `.metaproject/core/security/README.md` is confirmed byte-identical to `renderSecurityCoreReadme()` (no drift there). |
| 2 | The six corrections: confirm corrected text matches measured behaviour, check both directions | **PASS** | `src/lib/templates.ts:2062-2065,2166` (`renderSecurityPrePushHook`): both comments now read `'enforced'/'ci'/'gateway' exit non-zero on a failing or needs-approval gate (not only a secret or critical finding)` and `# enforced/ci/gateway mode blocked on this file.` — read directly, matches T79's claim exactly. `src/security/templates.ts:62-66` (`renderSecurityManifest`): Hooks section now reads `enforced/ci/gateway block the push ... on a failing or needs-approval gate (not only a secret or critical finding)` — read directly, matches. `.metaproject/modules/security.md:45-51`: same corrected sentence present (the ONE part of this file T79 edited) — read directly, matches. `src/commands/init.ts:497`: prompt now reads "...block pushes on a failing or needs-approval finding (enforced/ci/gateway mode)?" — read directly, matches. `docs/docs/modules.md:774,782,784-790`: `scan-mcp` Exit cell now "`1` with `--strict`... (independent of mode)"; `hooks install\|uninstall` Exit cell now "`1` on an unknown runtime or a post-install validation error (independent of mode)"; the paragraph below now scopes "mode-gated" explicitly to `scan`, `check-input`, `check-output`, `report` — read directly, matches. I independently re-verified every one of these four rows against the handlers themselves (`handleScan:194-250`, `handleCheck:538-601`, `handleScanMcp:384-536`, `handleReport:621-651`, `handlePolicy:713-743`, `handleHooks:764-817`, `handleEval:824-870`, all read in full) rather than trusting the prior probe's cached claim: `scan`/`check-input`/`check-output`/`report` all call `modeOf(cwd)` on the exit-affecting path; `scan-mcp` gates only on `--strict`; `hooks install\|uninstall` gates only on runtime/validation (its one `modeOf(cwd)` call at `:799` is for an advisory *note*, not the exit code — the corrected sentence's subject is specifically "exit," so this is not a contradiction). Both directions checked on the current (corrected) text: the F-001-class direction (undersold blocking) is fixed — `gateway` is now named everywhere `enforced`/`ci` is; the F-004-class direction (oversold specificity, narrowed to "secret/critical") is fixed without introducing a new overclaim — the new phrasing ("a failing or needs-approval gate") matches `computeGate`'s actual trigger set (`resolve.ts:132-161`, re-read in full: `fail` on any category's `block` action or severity ≥ `failOn`; `needs-approval` on any category's `require-approval` action). No new narrowing or new overclaim found in either direction on any of the six sites. |
| 3 | The pinning claim: verify the two pins would fail if regressed; judge the "three unpinnable" claim | **PASS on the two pins; the "unpinnable" claim is overstated — see F-002** | Ran the two new regression suites directly: `bun test src/lib/security-pre-push.test.ts src/security/templates.test.ts` → **12 pass / 0 fail / 32 expect()**, matching T79's reported GREEN exactly. Read both new tests in full (`security-pre-push.test.ts:109-131`, `templates.test.ts:51-57`): both assert directly on the render functions' live string output (`toContain`/`not.toContain`/`not.toMatch`), not on any intermediate or mocked value. Because I am read-only on production files, I could not literally revert-and-rerun; instead I wrote `T80-pin-check.ts`, which applies the tests' own assertion predicates, verbatim, to the OLD text quoted word-for-word in `T76-review.md`'s F-001 finding and in `T73-implementation.md`'s manifest row — confirming every predicate that must be `true` evaluates `false` against the OLD text (i.e. the tests would fail) and `true` against the current, unmodified production output (matching the real GREEN run). Both pins are load-bearing, not vacuous. For the "three unpinnable" claim: `docs/docs/modules.md` and `.metaproject/modules/security.md` are **not** truly unpinnable — see F-002, which names the cheap pin this repo already uses elsewhere for exactly this shape (`src/cli-reference-coverage.test.ts` reads `docs/docs/*.md` and `src/commands/*.ts` directly via `readFile` and asserts on the text; no `render*` seam is required, only a file read). `src/commands/init.ts:497` is genuinely unpinned but pinnable the same way. None of the three are unpinnable in the sense the implementation report's table implies. |
| 4 | The orchestrator's one-line fix in `src/commands/security.ts`: verify it is right and complete, and nothing else in the file's runtime output has the same defect | **PASS** | `src/commands/security.ts:801` (the `handleHooks` advisory-mode note, printed to the operator during `keryx security hooks install` under `mode: advisory`) now reads: `` advisory mode: ${runtime.id} will report findings and allow the call. Set \`mode\` to \`enforced\`, \`ci\` or \`gateway\` in ... to make it refuse. `` — `gateway` is present; this is the exact, complete fix for T79#F-005. Swept the entire file twice, independently: `ctx rg "advisory\|enforced\|gateway\|mode-gated\|secret/critical\|needs-approval"` (header **28** matches, compacted summary rendered only 4 — read the raw log directly, the documented gdctx undercount reproduced again) and `ctx rg "mode"` (header **37**, summary rendered 4 — same undercount, same discipline). Every one of the other 26/33 matches, read in context, is either an internal code/test comment (not printed to a user — `reportExitCode`'s and `exitCodeFor`'s docstrings at `:639-698,907-965`, `guard.ts`-referencing comments) or a plain gate-value label/echo (`gateLabel`'s `"NEEDS-APPROVAL"` string, `console.log(\`  mode: ${config.mode}\`)` at `:180,632`, which prints the actual live value rather than making a claim about it). `printSecurityHelp` (`:1140-1181`, the `--help` output) carries no mode-blocking claim at all. No second site with the same defect exists in this file. |

## Findings

### [F-001] `.metaproject/modules/security.md` still ships a stale, previously-disproven claim about what counts as a self-protection "finding" — a real, live drift the six-mechanism sweep's keyword list could not see

- **Severity**: minor
- **File**: `.metaproject/modules/security.md:88-89`
- **Symbol**: Lifecycle section, the §14 self-protection sentence
- **Problem**: this repo's own checked-in copy of the manifest (self-hosted; produced by `renderSecurityManifest()` and refreshed by `keryx update` per `update.ts:443`) still reads: *"A `configChecksum` mismatch or a mode downgrade is always surfaced as a finding plus an incident entry (self-protection, specification.md §14)."* This is the exact sentence T70 (F-003) established was false and T75 corrected — **in the generator function only**. `self-protect.ts` (read in full, independently re-confirmed) has exactly one `findings.push(` call in the whole module (the checksum-mismatch arm, `:90`); the mode-downgrade arm (`:122-132`) and the disabled-policy arm (`:160-172`) each push a warning + an incident, never a finding, and `service.ts:107-111`'s `analyze()` folds only `selfProtection.findings` into the decision — so a mode downgrade never moves the gate or an exit code, contrary to what this checked-in file still claims. `renderSecurityManifest()` was fixed (confirmed: its live output now reads the corrected sentence, and `src/security/templates.test.ts` pins it). This on-disk file was never regenerated for that fix. Confirmed pre-existing and untouched by this session's own uncommitted work: `git diff -- .metaproject/modules/security.md` shows the only change in this branch's WIP tree is at lines 45-51 (T79's separate "secret/critical" fix, in the Hooks section, three lines above this one); `git show HEAD:.metaproject/modules/security.md` already contains the stale sentence, so it predates this entire review chain (T70 through T79) and was never noticed because every check pointed at the generator function's return value, never at this file's own committed bytes.
- **Why it evaded every prior sweep**: T76's own probe (`T76-guidance.ts:317-341`, reused unmodified by T79) checks this exact sentence — but against `renderSecurityManifest()`'s live return value (`const manifest = renderSecurityManifest();`), never against the file on disk. T79's mechanism-5 sweep used the keyword family `advisory|enforced|gateway|mode-gated|secret/critical|needs-approval`, none of which appears in "a `configChecksum` mismatch or a mode downgrade is always surfaced as a finding" — a different claim family (what triggers a *finding*, not what a *mode* blocks) that nobody's keyword list this phase ever included.
- **Impact**: AC8's "no artifact reaching a user or an agent describes behaviour the code does not have" fails on this specific site, in the same direction T70 originally flagged (false confidence: a reader believes a mode-downgrade attack is caught as a finding — and therefore visible in the gate-relevant findings list `data/security/artifacts/latest.md` compiles from — when it is not; it is only a warning + an incident entry, which does not move the gate or the exit code). Blast radius is narrower than F-001/F-002 in T76 were: this is a self-hosted, this-repo-only artifact (not shipped into every scaffolded project the way the generator's OTHER output is), so severity stays **minor**, matching T70's original rating for the same underlying claim. Not a working bypass in a mandatory layer: the actual runtime behaviour (`self-protect.ts`, `service.ts`) is correct and unaffected — only this repo's own static, checked-in copy of the documentation is stale.
- **Reproduction**: `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T80-manifest-drift.ts` → `.metaproject/data/gdctx/raw/2026-09-06T20-00-30-104Z_run.log` (sha256 `3926336def17a44723a5c3a3e87f75aee7d25ec5e87e565971c482395e0b8bd8`): `"manifest identical to generator": false`, first diff at line 87 of the rendered string — generator's corrected sentence vs. disk's stale one, shown verbatim in the log; `"manifest still contains the stale pre-T75 §14 sentence": true`; `"generator's own §14 sentence is the corrected one": true`; `"readme identical to generator": true` (confirms `.metaproject/core/security/README.md` has no equivalent drift — this is specific to the manifest file). `git diff -- .metaproject/modules/security.md` (`.metaproject/data/gdctx/raw/2026-09-06T19-57-52-483Z_diff.log`) confirms this session's own WIP touched only lines 45-51, not 88-89. `git show HEAD:.metaproject/modules/security.md` (`.metaproject/data/gdctx/raw/2026-09-06T19-58-00-830Z_run.log`) confirms the staleness predates this session.
- **Suggested fix**: regenerate `.metaproject/modules/security.md` from the corrected `renderSecurityManifest()` (run `keryx update`, or hand-align lines 88-89 to the generator's current §14 sentence: "A `configChecksum` mismatch is surfaced as a finding plus an incident entry; a mode downgrade or a disabled policy is surfaced as a warning plus an incident entry"). Add the pin named in F-002 (an equality/derived-from check between this file and its generator) so this specific class — a self-hosted copy drifting from a generator fix that only touched the function — cannot recur silently a second time.
- **class_scope**:
  - sites: `.metaproject/modules/security.md:88-89` (§14 Lifecycle sentence) — DEFECT (stale); `.metaproject/modules/security.md:45-51` (Hooks section) — correct, T79's own edit this session, verified; `.metaproject/core/security/README.md` (full file) — correct, byte-identical to `renderSecurityCoreReadme()`, no drift; `src/security/templates.ts` (`renderSecurityManifest`, the generator itself) — correct, carries the fixed sentence, pinned by `templates.test.ts`.
  - enumeration_method: full byte-level line-by-line comparison of `.metaproject/modules/security.md`'s on-disk content against `renderSecurityManifest()`'s live return value (and the same for `.metaproject/core/security/README.md` against `renderSecurityCoreReadme()`), via `T80-manifest-drift.ts` — a full-content diff, not a keyword grep, specifically because this claim family ("configChecksum"/"mode downgrade"/"always surfaced as a finding") falls outside every keyword list T70 through T79 used for the "security mode/gate/exit" sweep. Both generator/self-hosted-copy pairs in this module were checked; only the manifest pair drifted.
- **Confidence**: high (measured by direct string comparison against the real, unmodified generator function and the real, unmodified checked-in file; cross-confirmed against `self-protect.ts`'s actual `findings.push` count, read in full).

### [F-002] Two of the "three unpinnable" corrections are merely unpinned — this repo already has a working, precedented pin for exactly this shape

- **Severity**: minor (process/rigor finding, not a runtime defect)
- **File**: `docs/docs/modules.md`, `.metaproject/modules/security.md` (the two static/prose sites T79-implementation.md's pinning table calls unpinnable "because no generator seam exists")
- **Symbol**: T79's pinning-table rationale ("hand-authored prose with no generator seam" / "static checked-in copy, no generator seam")
- **Problem**: "no generator seam" is true but not the relevant condition — a pin does not require a `render*` function to call, only a way to read the shipped text and assert on it. `src/cli-reference-coverage.test.ts` (read in full) already does exactly this, today, for the same class of artifact: it `readFile`s `docs/docs/cli-reference.md`, `docs/docs/index.md`, `mkdocs.yml`, `docs/docs/architecture.md`, and `src/commands/workspace.ts` directly and asserts on their text content with `toContain`/`not.toContain`/regex — no generator involved for any of them, since none of those files is generated either. The same idiom pins `docs/docs/modules.md`'s Exit cells (`readFile` + `toContain`) and `src/commands/init.ts:497`'s prompt string (`readFile` + `toContain`, exactly as the same test file already does for `workspace.ts`'s dispatch strings) at effectively zero cost. For `.metaproject/modules/security.md` specifically, an even stronger and cheaper pin than a substring match is available and would have caught F-001 immediately: an equality (or normalized-equality) assertion between this file's on-disk content and `renderSecurityManifest()`'s live return value — using the render function that ALREADY exists, contradicting "no generator seam" for this file in particular, since the file's whole reason for existing is to mirror that function's output.
- **Impact**: not a code defect and not itself a violation of AC8 — it is a gap in this phase's own verification rigor. F-001 is live proof of the cost: the exact drift this pin would catch immediately has been sitting in the tracked tree, undetected, through six review rounds (T70, T73, T75, T76, T79, and the orchestrator's own pass) specifically because no such pin exists.
- **Suggested fix**: add to `src/cli-reference-coverage.test.ts` (or a new `docs-drift.test.ts` alongside it, matching the existing pattern) — (a) a `readFile` + `toContain`/`not.toContain` pair for `docs/docs/modules.md`'s `scan-mcp`/`hooks install|uninstall` Exit cells; (b) a `readFile` + `toContain` for `src/commands/init.ts:497`'s prompt string; (c) for `.metaproject/modules/security.md` and `.metaproject/core/security/README.md`, an equality test against `renderSecurityManifest()`/`renderSecurityCoreReadme()` (or, if intentional formatting differences are ever introduced between the generator and the checked-in copy, a normalized/whitespace-insensitive equality) — this last one is the highest-value of the three, since it protects the whole file against any future drift, not just the one sentence this round happened to find.
- **Evidence**: `src/cli-reference-coverage.test.ts` read in full (228 lines) — every one of its 7 tests reads a doc or source file directly via `readFile(new URL(..., import.meta.url), "utf8")` and asserts on the returned string; none calls a `render*` function. `bun src/cli.ts ctx rg "modules.md" src --glob '*.test.ts'` → 0 matches (`.metaproject/data/gdctx/raw/2026-09-06T19-55-53-978Z_rg.log`) confirms `docs/docs/modules.md` has no existing test coverage of this kind to build on, so this would be new, not an extension of a broken existing check. `T80-manifest-drift.ts`'s own run (cited under F-001) demonstrates the equality-with-generator pin is mechanically trivial — it is exactly what that probe already does, ad hoc, for this review.
- **Confidence**: high.

## Residual classification

Per `RESIDUALS.md`'s own recorded decision: after T78 and T80, no new round opens on either of the two closed surfaces (autoload-detector markup extraction; shipped hints/docs) — findings are documented, not turned into tasks, with one exception (a blocker, reproduced on a public boundary).

- **F-001** (`.metaproject/modules/security.md`'s stale §14 sentence): **documentation-grade — add to `RESIDUALS.md`, do not open a new round.** It is minor, not reproduced as a working bypass — the actual code (`self-protect.ts`, `service.ts`, the generator) already behaves and describes itself correctly; only this repo's own static checked-in copy of one sentence is stale. It does not meet the rule's one exception (blocker + reproduced on a public boundary). Recommend adding a row to `RESIDUALS.md`'s "Подсказки и документация" table alongside the existing T76#F-004 / T70#F-005..F-007 entries.
- **F-002** (pinning-rigor gap for `docs/docs/modules.md` / `.metaproject/modules/security.md`): **documentation-grade — a suggestion for whoever next touches this test suite, not a fix-now item.** Not a code defect at all; recorded so the next agent does not re-derive "no seam exists" as a fresh justification when a cheap pin is sitting in the same file.
- **T79's own six corrections** (the pre-push hook, the manifest Hooks section, the two `modules.md` Exit cells + paragraph, the interactive prompt): **confirmed closed.** No residual entry needed; verified against measured code and, where pinned, against a from-scratch application of the tests' own predicates to the historically-quoted old text.
- **T79#F-005 / the orchestrator's fix** (`security.ts:801`'s advisory note): **confirmed closed and complete.** No residual entry needed; correctly absent from `RESIDUALS.md` already.

## Confirmed clean areas

- All four corrected `modules.md` CLI-surface rows re-verified against their handlers by direct code read, not by trusting the prior probe's cached result: `scan`, `check-input`, `check-output`, `report` are genuinely mode-gated (`modeOf(cwd)` on the `process.exitCode`-setting path); `scan-mcp` gates only on `--strict`; `hooks install|uninstall` gates only on runtime/validation, with its one `modeOf(cwd)` call feeding an advisory note, not the exit code.
- `resolve.ts:132-161`'s `computeGate` re-read in full: `fail` on any category's `block` action or severity ≥ `failOn`; `needs-approval` on any category's `require-approval` action. The corrected "failing or needs-approval gate" phrasing at all four sites matches this without introducing a new overclaim.
- `src/commands/security.ts` swept twice (28- and 37-match keyword sweeps, both raw logs read directly past the compacted-summary undercount) for any second site carrying the F-005 shape: none found. `printSecurityHelp`'s `--help` output carries no mode-blocking claim.
- `.metaproject/core/security/README.md` confirmed byte-identical to `renderSecurityCoreReadme()`'s live output — no drift, unlike the manifest.
- `update.ts` confirmed to call the same generator functions as `init.ts` (`renderSecurityManifest`, `renderSecurityPrePushHook`) rather than carrying an independent copy of any of this text — no separate stale-prose risk there.
- `src/health/gate.ts` and `src/commands/health.ts` (provided for context/comparison): no user-facing claim narrowing the health gate to "secret or critical" anywhere; `runExitCode`'s behaviour (fail/incomplete block unconditionally, warn blocks only under `--strict`) matches its own docstring, which is an internal comment, not shipped guidance, and is out of this review's scope regardless.
- No bare `rg`/`grep`/`cat`/`find` was run over project code or docs; the project's own hook blocked one habitual `cat`/`grep` attempt before any output was produced, corrected via `ctx rg`/`Read`.
- Full test suite in dispatch scope, run twice independently (direct `bun test` and again through `ctx run`): `bun test src/lib src/commands src/security src/health` → **2147 pass / 6 skip / 0 fail / 8517 expect()** both times. `bun run typecheck` clean. `bunx eslint` on the seven changed files: 0 errors, 2 informational `.md`-file warnings (expected). `src/security/detect/exfil.test.ts` (the other worker's in-flight file) run separately per this dispatch's instruction to exclude it from my findings: **58 pass / 0 fail** at time of measurement — clean right now, but explicitly not part of this review's verdict either way, since that worker may still be mid-edit.

## Evidence

Raw logs, all under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`:

| Log | SHA-256 |
|---|---|
| `2026-09-06T19-49-34-724Z_rg.log` (security.ts advisory/enforced/gateway/... sweep, 28 header vs 4 rendered) | `3d8dba0ac1e405816071c5f4cc1bfa7e989511b42f8a8a86c9811c0dd5eee5b1` |
| `2026-09-06T19-50-00-741Z_rg.log` (security.ts "mode" sweep, 37 header vs 4 rendered) | `910ff44c29da205f47bf849977e1bb39e7a766d787845d3114f9a3f728b9e5cc` |
| `2026-09-06T19-53-24-268Z_rg.log` (repo-wide enforced/ci/secret-critical/mode-gated sweep, 47 header, all read raw) | `056d488b8d044293a7954e0f6566f0e39db06bb4d7967eb869ecb4c41f286378` |
| `2026-09-06T19-52-01-283Z_rg.log` (security.ts exitCode/gateEval sweep) | `a0fb43cd19357a1b4f3b6fd9c362b76392aaf2305bf19e6e950165547af3ca94` |
| `2026-09-06T20-00-13-177Z_run.log` (`T80-pin-check.ts` — the two pins' predicates applied to OLD vs. CURRENT text) | `4a546822a7b8e4576e46654e7faf210279c67d68d1739a355d1f20c83c389177` |
| `2026-09-06T20-00-30-104Z_run.log` (`T80-manifest-drift.ts` — F-001's reproduction) | `3926336def17a44723a5c3a3e87f75aee7d25ec5e87e565971c482395e0b8bd8` |
| `2026-09-06T19-57-52-483Z_diff.log` (`git diff -- .metaproject/modules/security.md`, confirms this session touched only lines 45-51) | see `T80-result.json` artifacts list |
| `2026-09-06T19-58-00-830Z_run.log` (`git show HEAD:.metaproject/modules/security.md`, confirms pre-existing staleness) | see `T80-result.json` artifacts list |
| `2026-09-06T20-01-28-462Z_run.log` (`bun test src/lib src/commands src/security src/health` via ctx run — 2147/0/6) | `4c5dbc56fc5b6828856d1d098e5006120810a71b2aa29f7b14b7bbe6c86d0db0` |
| `2026-09-06T20-01-32-739Z_run.log` (`bun test src/security/detect/exfil.test.ts`, excluded from findings, clean at time of measurement) | `c37aadd228ca5819032bd009ceccfd80c39e29b1b8fa78851297efb38023a369` |
| `2026-09-06T19-55-42-495Z_run.log` (`bun run typecheck`, clean) | `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92` |
| `2026-09-06T20-01-42-789Z_run.log` (`bunx eslint` on the 7 changed files, 0 errors) | `301d27c168f41ea913ec1f6e63e7757f14185f38ea956accb45236c917714d79` |
| `2026-09-06T19-55-53-978Z_rg.log` ("modules.md" in `*.test.ts`, 0 hits — confirms no existing pin) | see `T80-result.json` artifacts list |

Probe scripts written by this review (new files, nothing else modified):
`T80-pin-check.ts`, `T80-manifest-drift.ts`.

`bun test src/lib/security-pre-push.test.ts src/security/templates.test.ts`
→ 12 pass / 0 fail / 32 expect() (matches T79's own reported count exactly).

## Routing audit

- `graph_used`: **no** — *not-relevant*. Every file was named by the dispatch,
  by `T76-review.md`'s/`T79-implementation.md`'s own findings, or found by
  this review's own from-scratch sweeps; the questions are behavioural (what
  does the code do) and textual (what does shipped prose say), not
  structural/blast-radius. `keryx-tooling-caveats` project memory flags
  gdgraph's answers as historically unreliable on this repo, and the graph
  predates this session's uncommitted tree regardless.
- `wiki_used`: **no** — *not-relevant*. The normative source for "what the
  code does" is the code itself, read directly throughout (`resolve.ts`,
  `self-protect.ts`, `service.ts`, `security.ts`, `guard.ts`); the normative
  source for the acceptance criteria and the recorded scope decision is
  `acceptance-criteria.md` and `RESIDUALS.md`, both read directly.
- `ctx_used`: **yes** — every text search went through `bun src/cli.ts ctx
  rg`; every aggregate command went through `bun src/cli.ts ctx run`; every
  raw log cited above by path and hash.
- `raw_rg_used`: **no** bare `rg`/`grep`/`cat`/`find`/`sed` was run over
  project code or docs for search purposes. One habitual `cat`/`grep` attempt
  against `.metaproject/flows/.../artifacts/*.md` was blocked by the
  project's own routing hook before any output was produced; corrected via
  `ctx rg` immediately.
- **gdctx compaction defect, observed independently three more times this
  round** (matching the dispatch's own warning and RESIDUALS.md's "Инструмент,
  а не продукт" entry): the `security.ts` advisory/enforced/gateway sweep
  (header 28, summary rendered 4), the `security.ts` "mode" sweep (header 37,
  rendered 4), and the repo-wide enforced/ci/secret-critical sweep (header 47,
  Top-Files list summed to 39 of them, 8 files' worth of matches present only
  in the raw log). Every count in this review is taken from a raw log read
  directly via the `Read` tool, never from a compacted summary header or its
  rendered list alone.

## keryx:findings

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T80#F-001",
    "reviewer": "review-logic (T80 independent seventh-pass review)",
    "severity": "minor",
    "file": ".metaproject/modules/security.md",
    "line": 88,
    "symbol": "Lifecycle section, §14 self-protection sentence",
    "problem": "This repo's own checked-in copy of the security manifest (mechanism 5 in T79's enumeration; produced by renderSecurityManifest() and refreshed by `keryx update`) still reads 'A `configChecksum` mismatch or a mode downgrade is always surfaced as a finding plus an incident entry (self-protection, specification.md 14).' T70 F-003 established this is false and T75 corrected it -- but only in the generator function's return value. self-protect.ts has exactly one findings.push (the checksum arm); the mode-downgrade and disabled-policy arms each push a warning + an incident, never a finding, so a mode downgrade never moves the gate. This on-disk file was never regenerated for that fix: git show HEAD:.metaproject/modules/security.md already contains the stale sentence (predates this whole review chain), and this session's own WIP diff for the file touches only lines 45-51 (a separate, unrelated fix), not 88-89.",
    "impact": "AC8's 'no artifact reaching a user or an agent describes behaviour the code does not have' fails on this specific site, in the false-confidence direction: a reader believes a mode-downgrade attack is caught as a finding (and therefore visible in the gate-relevant findings list) when it is actually only a warning+incident that does not move the gate or exit code. Blast radius is narrower than a shipped-into-every-project site (this file is self-hosted, this-repo-only), so severity stays minor, matching T70's original rating for the same claim. Not a working bypass: the actual runtime behaviour is correct; only this static checked-in copy is stale.",
    "suggested_fix": "Regenerate .metaproject/modules/security.md from the corrected renderSecurityManifest() (run `keryx update`, or hand-align lines 88-89 to the generator's current sentence). Add the pin named in T80#F-002 -- an equality check between this file and its generator -- so a self-hosted copy drifting from a generator-only fix cannot recur silently again.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T80-manifest-drift.ts -> .metaproject/data/gdctx/raw/2026-09-06T20-00-30-104Z_run.log (sha256 3926336def17a44723a5c3a3e87f75aee7d25ec5e87e565971c482395e0b8bd8): manifest identical to generator: false, first diff at line 87 (generator's corrected sentence vs disk's stale one); manifest still contains the stale pre-T75 14 sentence: true; readme identical to generator: true (no equivalent drift there). git diff -- .metaproject/modules/security.md confirms this session touched only lines 45-51. git show HEAD:.metaproject/modules/security.md confirms pre-existing staleness.",
    "confidence": "high",
    "dedupe_key": "shipped-guidance/security-manifest-self-hosted-copy/stale-section14-drift",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        ".metaproject/modules/security.md:88-89 (14 Lifecycle sentence) - DEFECT (stale)",
        ".metaproject/modules/security.md:45-51 (Hooks section) - correct, this session's own T79 edit, verified",
        ".metaproject/core/security/README.md (full file) - correct, byte-identical to renderSecurityCoreReadme()",
        "src/security/templates.ts (renderSecurityManifest, the generator itself) - correct, pinned by templates.test.ts"
      ],
      "enumeration_method": "Full byte-level line-by-line comparison of .metaproject/modules/security.md's on-disk content against renderSecurityManifest()'s live return value (and the same pairing for core/security/README.md against renderSecurityCoreReadme()), via T80-manifest-drift.ts -- a full-content diff rather than a keyword grep, because this claim family (configChecksum/mode-downgrade/always-surfaced-as-a-finding) falls outside every keyword list T70 through T79 used for the security mode/gate/exit sweep. Both generator/self-hosted-copy pairs in this module were checked; only the manifest pair drifted."
    }
  },
  {
    "id": "F-002",
    "global_id": "T80#F-002",
    "reviewer": "review-logic (T80 independent seventh-pass review)",
    "severity": "minor",
    "file": "docs/docs/modules.md",
    "line": null,
    "symbol": "T79's pinning-table rationale (\"no generator seam\")",
    "problem": "T79-implementation.md's pinning table calls docs/docs/modules.md and .metaproject/modules/security.md unpinnable because 'no generator seam exists.' A pin does not require a render* function -- only a way to read the shipped text and assert on it. src/cli-reference-coverage.test.ts already does exactly this, today, for cli-reference.md, index.md, mkdocs.yml, architecture.md and commands/workspace.ts (readFile + toContain/regex), none of which is generated either. The same idiom pins modules.md's Exit cells and init.ts:497's prompt string at effectively zero cost. For .metaproject/modules/security.md specifically, an even stronger pin exists: an equality check between the on-disk file and renderSecurityManifest()'s live output -- using the generator that already exists for this exact file, contradicting 'no generator seam' for this one in particular.",
    "impact": "Not a code defect; a gap in this phase's own verification rigor. T80#F-001 is live proof of the cost: the exact drift this pin would catch immediately has been sitting in the tracked tree, undetected, through six review rounds specifically because no such pin exists.",
    "suggested_fix": "Add to src/cli-reference-coverage.test.ts (or a sibling docs-drift.test.ts): (a) readFile+toContain/not.toContain for docs/docs/modules.md's scan-mcp/hooks-install Exit cells; (b) readFile+toContain for src/commands/init.ts:497's prompt string; (c) an equality (or normalized-equality) test between .metaproject/modules/security.md and renderSecurityManifest(), and between .metaproject/core/security/README.md and renderSecurityCoreReadme() -- the highest-value of the three, since it protects the whole file against any future drift, not just one sentence.",
    "evidence": "src/cli-reference-coverage.test.ts read in full (228 lines): every one of its 7 tests reads a doc or source file directly via readFile and asserts on the returned string; none calls a render* function. bun src/cli.ts ctx rg \"modules.md\" src --glob '*.test.ts' -> 0 matches, confirming docs/docs/modules.md has no existing test coverage to extend. T80-manifest-drift.ts's own run demonstrates the equality-with-generator pin is mechanically trivial.",
    "confidence": "high",
    "dedupe_key": "process/pinning-rigor/hand-authored-docs-are-not-actually-unpinnable",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true
  }
]
```
