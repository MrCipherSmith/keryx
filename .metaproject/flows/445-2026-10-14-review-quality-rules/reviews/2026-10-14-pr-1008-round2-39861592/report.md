# PR 1008 — review round 2

**Verdict: no blocker, no major at 39861592.** Every round-1 blocker and major is closed and pinned by a test that fails when the behaviour is removed. Two minors and one info remain, all small: a wrong escape clause the R1-11 fix added to the ingest refusal (R2-01) and two assertions the R1-09 fix claims but does not have (R2-02).

Evidence level: ran — bun test (focused suite of 9 files plus 20 further files that ingest or complete a review, 702 tests green), mutation pass of 26 mutants (19 killed, 7 survived), executed probes of the gate, the evidence-level parser and the citation scanner

## Summary

Head `39861592e37cf40a878157bc60ca9f807607fb94`, merge base `060701ca`, round-1 head `0eba4d30`; the fix commit is `39861592` (10 files, 155 insertions). Review id `2026-10-14-pr-1008-round2-39861592`, mode all, scope A (merge-base..HEAD, 57 files, nothing dropped) and scope B (computed, capped at 40 of 132 candidates; 35 changed files are absent from the code graph, so their radius is unknown, not empty). Flow 445. No reviewer was dispatched: the round is a regression check of the fix commit, run inline with tests, probes and mutants.

Findings: 3 filed: 0 blocker, 0 major, 2 minor (R2-01, R2-02), 1 info (R2-03).

Mutation pass (focused command of 9 test files, baseline green, 4077 ms): 26 mutants, 19 killed, 7 survived. Survivors: r2-lex-guard-off and r2-cite-url-kept (R2-02); r2-gate-unusable-dropped-sayso, r2-ev-fence-char-off, r2-ev-placeholder-narrow, r2-cite-root-lowercase, r2-cli-detect-off (R2-03). Evidence: `research-evidence/mutation-1.json`, `mutation-1.md`, `survivors.md`.

## Round-1 findings, one disposition each

R1-00 closed (fixture carries the line; review-gate.e2e 13 of 13 green). R1-01 closed (child-process `review complete` with a stand-in `gh`; r2-cli-lookup-off and r2-cli-warnings-silent killed). R1-02 closed (null, not-found and rejection pinned; r2-gate-offline-throws and r2-gate-rejection-throws killed). R1-03 deferred on purpose, not re-filed. R1-04 closed (research.json, v1.2.json, i.e.md no longer cited; root documents are). R1-05 closed (a PR word within 40 characters of a move word is required; the probe of "closed loop on the cache" is refused). R1-06 closed (a recorded head that is not 7 to 40 hex characters warns and skips; r2-gate-sha-usable-off and r2-gate-usable-len killed). R1-07 closed (fenced lines are ignored, placeholders are not items). R1-08 closed (r2-loc-external-asked and r2-loc-dismissed-asked killed). R1-09 partial, see R2-02. R1-10 deferred on purpose. R1-11 partial, see R2-01. R1-12 deferred on purpose.

## Regressions the fixes introduced

R2-01 only. The first-line check is narrower than before: "Reviewed X — the branch was force-pushed", "merged upstream" and "rebased onto main" are now refused because no PR word is near the move word, and "stale" and "no longer" no longer count. This is the intended effect of R1-05; the refusal prints a working example and the template and docs use the accepted wording ("the PR has since merged / moved on"), so it is recorded as a question, not a finding.

## Findings by severity

- Blocker: none.
- Major: none.
- Minor: R2-01, R2-02.
- Info: R2-03.

### R2-01 — minor — src/review/managed.ts

**Problem.** The R1-11 fix added "or ingest without --head" to the unlocatable-quote refusal. In a git checkout that escape does not work: resolveTargetHead falls back to the checkout's git HEAD, so the same finding is refused again. The new test pins the sentence, not that it works.

**Impact.** Probed: in a fresh git repo with no declared head and a quote that is not in the file, the ingest is refused with the same message. An operator who follows the advice goes in a circle once; dismissing the finding or re-quoting works.

**Suggested fix.** Drop the clause and its assertion; keep "dismiss the finding with evidence, or re-quote one distinct line".

**Evidence.** managed.ts:131-140 and 1224-1240; ingest-locator-sha.test.ts "the refusal names the possible causes and the way out"; probe in the scratch directory.

### R2-02 — minor — src/review/rebuttal-citation.ts

**Problem.** fixes-round1.md says the R1-09 tests kill r1-cite-url-kept. They do not: `https://example.com/rules/a.md` is rejected by the CITED lookbehind with or without the URL strip, so the test passes either way. The strip matters only after `=` or `#`. The lexical guard in citationExists is tested only as the pure function lexicalRelativePath, not through citationExists as R1-09 asked.

**Impact.** Both mutants (r2-cite-url-kept, r2-lex-guard-off) survive. Without the strip a link with a query path gets a false `citation not found`; without the guard a rebuttal citing `../x.md` that exists outside the tree reads as present. Advisory only.

**Suggested fix.** Use `https://example.com/view?doc=docs/a.md` as the URL-only input; add one citationExists case through createManagedReviewPackage for `../outside.md`.

**Evidence.** mutation-1.json (r2-cite-url-kept, r2-lex-guard-off survived; r2-lex-dotdot-ok, r2-lex-absolute-ok killed); rebuttal-citation.ts:9 and managed.ts:1246-1249.

### R2-03 — info — src/review/complete-head-gate.ts

Unpinned edges in the fixes, none with a demonstrated effect: the not-a-commit-SHA warning is lost when the PR moved and the first line says so; the fence tracker ignores fence length and closes on any fence character; placeholder forms `na`, `nil`, dashes are untested; a bare lowercase `notes.md` is never checked as a citation by design; r2-cli-detect-off is equivalent in effect. Optional: one test for the first.

## Questions

- Should "the branch was force-pushed" count as saying the PR moved? Today it is refused (no PR word); the example in the refusal fixes it in one edit. Not filed.

## Pre-existing

- The gate reads the head through `gh pr checks` and `gh auth status` round trips (R1-12, deferred).
- `narrowed` carries no link to a canonical finding (R1-03, deferred); SKILL.md length (R1-10, deferred).

## Verified clean

- `completeHeadGate`: merged, moved, says-so, non-PR, offline, rejection, unusable head and short-SHA prefix are all pinned; probes of 13 first-line wordings behave as designed.
- `parseEvidenceLevel`: fenced, quoted-in-list, placeholder and static-only forms probe as designed.
- Every test that ingests then completes a review (20 files, 397 tests) is green, so no other unmigrated fixture exists beyond R1-00.
- Docs, template and SKILL.md wording of the first-line rule matches the accepted phrases.

Stage counts: dropped by the pre-filter 0, refuted by the verifier not run (no blocker or major), retained 3. Not run: the full `bun run check` (left to CI), reviewer dispatch (inline regression round).

## Structured findings

```json keryx:findings
[
  {
    "id": "R2-01",
    "reviewer": "review-logic",
    "severity": "minor",
    "confidence": "high",
    "file": "src/review/managed.ts",
    "quote": "Causes: the quote is not in the file at that commit",
    "problem": "The round-1 fix for R1-11 added a way out to the unlocatable-quote refusal: \"or ingest without --head\". In a git checkout that escape does not work. resolveTargetHead falls back to the checkout's own git HEAD when no head is declared, so refuseUnresolvedLocators still has a non-null head and refuses the same finding again. The new test pins the sentence (`expect(message).toContain(\"ingest without --head\")`) but not that it works.",
    "impact": "Trigger: an operator ingests a report whose quote repeats in the file or whose file the PR deleted, reads the refusal, and drops --head as told. Outcome (probed with createManagedReviewPackage in a fresh git repo, no head declared, quote absent): the ingest is refused again with the same message. The only working exits are dismissing the finding with evidence or re-quoting, so the message sends the operator in a circle once. The escape is true only in a directory that is not a git checkout.",
    "suggested_fix": "Drop the clause and keep \"dismiss the finding with evidence, or re-quote one distinct line\". Change the assertion to the two remaining exits.",
    "evidence": "Probe at head: ingest in a git repo with no declared head and a quote that is not in the file gives \"REFUSED Cannot ingest review; 1 finding(s) cite a quote that does not resolve at the rev...\". Source: managed.ts:131-140 (resolveTargetHead falls back to resolveGitHead), managed.ts:1224-1240; test ingest-locator-sha.test.ts \"the refusal names the possible causes and the way out\".",
    "class_scope": {
      "sites": [
        "src/review/managed.ts:1240",
        "src/review/ingest-locator-sha.test.ts:84"
      ],
      "enumeration_method": "Searched the tree for the phrase \"without --head\": the message and its test are the only two sites; the docs and the skill do not repeat it."
    }
  },
  {
    "id": "R2-02",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "confidence": "high",
    "file": "src/review/rebuttal-citation.ts",
    "quote": "text.replace(URL, \" \")",
    "problem": "fixes-round1.md says the R1-09 tests kill r1-cite-url-kept, r1-lex-dotdot-ok and r1-lex-absolute-ok. Two of the three are killed. The URL one is not: the added test cites `https://example.com/rules/a.md`, which the CITED lookbehind already rejects (each candidate is preceded by `/`), so the test passes with the URL stripping deleted. The URL strip matters only where a path follows `=` or `#` (`https://x.io/view?doc=docs/a.md`). Separately, the lexical guard inside citationExists is tested only as the pure function lexicalRelativePath, which R1-09 explicitly asked to be tested through citationExists.",
    "impact": "Trigger: an edit that drops the URL strip, or the `relative === null` guard in citationExists. Outcome (re-run of both mutants at head against the 9 focused files plus the new ones): both survive. Without the strip, a rebuttal quoting a link with a query path gets a false `citation not found`; without the guard, a rebuttal citing `../x.md` that exists outside the tree is accepted as present. The cost is advisory noise or a missed flag, not a wrong refusal, hence minor.",
    "suggested_fix": "Use `https://example.com/view?doc=docs/a.md` as the URL-only input and expect []. Add one citationExists case through createManagedReviewPackage: a rebuttal citing `../outside.md` with that file created beside the temp tree gets `citation not found`.",
    "evidence": "Survivors in mutation-1.json of this round: r2-cite-url-kept and r2-lex-guard-off (judged in research-evidence/survivors.md). Killed for contrast: r2-lex-dotdot-ok, r2-lex-absolute-ok (the pure-function test). Source: rebuttal-citation.ts:9 and managed.ts:1246-1249.",
    "class_scope": {
      "sites": [
        "src/review/rebuttal-citation.ts:12",
        "src/review/managed.ts:1246",
        "src/review/rebuttal-citation.test.ts:36-52"
      ],
      "enumeration_method": "All 8 round-1 survivors were re-run unchanged: 7 are now killed (offline throw, lookup off, warnings silent, external asked, dismissed asked, dotdot, absolute); this one and the guard-through-citationExists mutant remain."
    }
  },
  {
    "id": "R2-03",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "confidence": "medium",
    "file": "src/review/complete-head-gate.ts",
    "quote": "if (names && SAYS_SO.test(first)) return { warnings: unusable };",
    "problem": "Small behaviours added by the round-1 fixes that no assertion pins: the not-a-commit-SHA warning is dropped on the path where the PR moved or merged and the first line says so (the unmoved path is tested); the evidence-level fence tracker closes a fence on any fence character and ignores fence length, so a longer outer fence quoting a shorter one mis-pairs; the placeholder list's `na`, `nil` and dash forms are untested; ROOT_DOCUMENT accepts a lowercase bare `notes.md` only if written in capitals.",
    "impact": "None demonstrated. Each is an edge with a lost advisory warning at worst; the one visible effect is that a bare lowercase document name (`notes.md`) is never checked, a trade-off the fix chose on purpose.",
    "suggested_fix": "Optional: one test for the merged-with-bad-head path; leave the rest.",
    "evidence": "Survivors in mutation-1.json of this round: r2-gate-unusable-dropped-sayso, r2-ev-fence-char-off, r2-ev-placeholder-narrow, r2-cite-root-lowercase, r2-cli-detect-off (judged in research-evidence/survivors.md; the last is equivalent in effect, the adapter's own failure path gives the same warning).",
    "class_scope": {
      "sites": [
        "src/review/complete-head-gate.ts:50",
        "src/review/evidence-level.ts:19-30",
        "src/review/rebuttal-citation.ts:7"
      ],
      "enumeration_method": "Every survivor of the 26-mutant round-2 pass that is not part of R2-01 or R2-02."
    }
  }
]
```
