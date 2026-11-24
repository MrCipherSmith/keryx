Reviewed `2e01447f96161913880e02db4394be6ad15e1335` against `a5d1ab236fe85dee62a758a19390049dde4eb7f9` · round 1 · 14 files · CI pending.

Evidence level: static only — did not run: mutation pass, verifier (Wave C), premise judge (Wave D); ran — `bun test src/gdskills/review-orchestrator-preflight.test.ts` (research-evidence/verify-tests-to-run-1.txt).

### Major

**R1. Stop-and-start and answer carry-over promise stage-3 prior-round rules that do not exist yet.** The procedure states stage-3 carry-over behaviour as current. The `keryx review plan` fallback in step 4 cannot take a stopped or partial round as the prior round. A package that is not eligible is dropped (prior-round.ts:414; round-record.ts:207, 'a draft or partial package is never a previous round'). An eligible but uncompleted package is untrusted: it is used only when no trusted round exists, and then as fallback-first with findings as context only (prior-round.ts:880-886); otherwise it is ignored. Nothing adds the uncovered area as unchecked. Step 5.1's 'answers per finding carry over by finding id' has the same problem. Spec 'Раунд обновления' item 1 lists these rule changes as stage-3 work.
**R2. Unattended head-move rule contradicts the autonomous prompt's 'one more round on the new head'.** The change adds a 'Head moved' section to review-orchestrator SKILL.detail.md (both copies). Its Unattended bullet says: 'Finish the round on its pinned head, open no update round unless `on_head_move` is `follow`'. SKILL.md Round plan step 5 (line 64) now sends the agent there after every batch. `on_head_move` has no source anywhere in code: `keryx ctx rg on_head_move src` finds only the new test. So for an unattended run the rule always resolves to 'no update round'. The existing autonomous review prompt, built in code at src/review/autonomous-profile.ts:200 for a run with no fixedBase and pinned by harness-robustness.test.ts:179, tells the same agent: 'Open one more round only if the head moved while you worked, and review the new head.' Line 206 of the same prompt tells the agent to read `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md`, so the agent now holds two opposite instructions for the same event. The flow's plan.md step 3 and AC6 track only the fixed-range line 199 for a later fix (T8, blocked on stage 3). Line 200 is not tracked.

### Minor

**R3. Per-wave `gh pr view` conflicts with 'make a gh call once' in trust/auto sessions.** The per-wave head check is a `gh pr view` call. SKILL.md 'Shell calls in a trust or auto session' says 'A `gh` call still asks: that is expected, so make it once and reuse what it printed.' The new procedure requires a fresh gh call at every wave boundary.
**R4. 'Desktop runs the same command' is stated as current; it is stage-3/T8 work.** Head moved step 4 says 'Desktop runs the same command'. The PR body lists that as pending (Item 3, T8, stage 3), and src/review/autonomous-profile.ts:199 still tells Desktop 'New commits belong to a separate request.' The same text is in the installed copy.
**R5. The ask question repeats at every wave boundary after the operator answered.** The check compares the PR head with the round's pinned head before every `keryx review next`. After the operator answers 'Update after this round finishes', the head still differs at the next boundary, so step 3 asks again and the stop list stops the round again. Nothing says to remember the answer.
**R6. Completing a round on a moved head needs the reviewed-SHA first line; the procedure says so only for publish.** For update-after, follow and ignore, the round completes on a moved head. completeHeadGate throws unless report.md's first line names the reviewed SHA and says the PR moved (complete-head-gate.ts:52-61). The section names that line only for step 5 publish-as-is.
**R7. D1 COMMENT-only rule skipped for a head that moved during the round.** Step 1 checks 'before publishing' and then flows into step 3 (on_head_move). Step 5, which holds the D1 COMMENT-only rule, applies only when the head moved after completion. A head that moved during a round under `ignore` and is then published falls under neither step, and the session publish path does not enforce COMMENT (readiness item 7 only warns). Latent today, because no stored on_head_move exists in a session.
**R8. merge-base --is-ancestor exit 128 is not handled.** Only exits 0 and 1 are mapped. If the fetch failed or the reviewed SHA is missing locally, `git merge-base --is-ancestor` exits 128, and an agent may report it as rewritten history.
**R9. Divergence map row 4 refuses a moved head, contradicting D1 publish-as-is.** Row 4 of the extraction plan sends the session publish through Desktop's head check and refuses a moved head. The 'Head moved' procedure in this same PR prescribes `keryx review publish <package> --event COMMENT` for a moved head (option 2, D1). The journal's T6 note already corrects this ('T7 must add the COMMENT restriction to the session path rather than refusing outright'), but the map, which T7 executes, was not updated. Section 5's last bullet describes the breakage without resolving it.
**R10. Preflight assertions do not pin first-line position, unattended negation, ask option order or the ask-only stop.** AC1's D1 rule says an old commit is published as is only with a FIRST line naming the reviewed commit. The test pins the sentence text but not its position: neither 'first line' nor 'The body's first line is' is asserted. The clause 'the body names the commits it did not check (`<reviewed sha>..<new sha>`)' is not asserted either.
**R14. review-orchestrator frontmatter version not bumped.** The skill changed behaviour but its frontmatter version stayed 1.17.0; skill-drift.ts compares versions only, so installed copies with the removed wording are not flagged stale.

### Info

**R11. Source of on_head_move is not stated (only the stored Review, else ask).** The text does not say where 'the Review's own value' is read from. No store exists before stage 3, so an agent could take follow/ignore from PR-supplied content.
**R12. New copy-parity assertion duplicates review-orchestrator-skill-parity.test.ts.** The new copy-parity assertion repeats `src/gdskills/review-orchestrator-skill-parity.test.ts`, which already asserts both review-orchestrator files are byte-identical across the two copies and that SKILL.md equals its ceiling. The flow's AC3 uses `cmp` anyway.
**R13. SKILL.detail.md grows by about 850 tokens (on-demand file).** The new section adds context to SKILL.detail.md.

### How this review was run

review-orchestrator, round 1 of 5, diff mode, one slice. Reviewers (all on the session model claude-opus-5-5, tier standard; security via `keryx review tier --security`): review-architecture, review-degradation, review-highload, review-logic, review-performance, review-pr-contract, review-regression, review-security-code, review-testing-practices. Start questions took defaults (dispatched session, no operator at the keyboard). Not run: Wave C verifier and Wave D premise judge (both majors were confirmed by recorded code reads instead: research-evidence/verify-F-001-1.txt, verify-REG-F-001-1.txt), mutation pass.

```json keryx:findings
[
  {
    "severity": "major",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "- **Stop and start on the new head**: dispatch nothing more, ingest what finished as a partial round, then step 4; the area it did not cover enters the new plan as unchecked.",
    "problem": "The procedure states stage-3 carry-over behaviour as current. The `keryx review plan` fallback in step 4 cannot take a stopped or partial round as the prior round. A package that is not eligible is dropped (prior-round.ts:414; round-record.ts:207, 'a draft or partial package is never a previous round'). An eligible but uncompleted package is untrusted: it is used only when no trusted round exists, and then as fallback-first with findings as context only (prior-round.ts:880-886); otherwise it is ignored. Nothing adds the uncovered area as unchecked. Step 5.1's 'answers per finding carry over by finding id' has the same problem. Spec 'Раунд обновления' item 1 lists these rule changes as stage-3 work.",
    "impact": "Silent wrong result. With on_head_move=ask, the operator picks 'Stop and start'. The agent says the work and uncovered area carry over, but the new round starts from an older round or from round 1, and the stopped round's findings are never rechecked or closed. Nothing reports this.",
    "suggested_fix": "Until `keryx review --help` lists `advance`, either recommend only 'Update after this round finishes' (it reaches `complete`, which gives a trusted prior round), or keep 'Stop and start' with an explicit caveat: the stopped round's findings reach the new round only as context, its uncovered slices must be named in the new report, and per-finding answers do not carry over yet.",
    "evidence": "SKILL.detail.md:604, :608, :610 (both copies); src/review/round-record.ts:207-209; src/review/prior-round.ts:410-420, :880-890; docs/requirements/keryx-desktop-review-v2/specification.md:108; journal.md T5 entry acknowledges it, PR body does not.",
    "confidence": "high",
    "reviewer": "review-logic",
    "class_scope": {
      "sites": [
        ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md:604",
        ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md:608",
        ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md:610",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md:604",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md:608",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md:610"
      ],
      "enumeration_method": "Read every sentence of the `## Head moved` section (lines 595-616, both copies), keeping each that claims stage-3 carry-over behaviour (partial round as prior, uncovered area as unchecked, answers carried by finding id). Checked each against prior-round.ts candidate selection (:410-420, :872-890) and round-record.ts:207."
    },
    "id": "R1",
    "title": "Stop-and-start and answer carry-over promise stage-3 prior-round rules that do not exist yet",
    "merged_from": [
      "review-logic-w1:F-001",
      "review-architecture-w1:F-002",
      "review-degradation-w1:DEG-S1",
      "review-pr-contract-w1:PC-002"
    ]
  },
  {
    "severity": "major",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md",
    "line": 607,
    "problem": "The change adds a 'Head moved' section to review-orchestrator SKILL.detail.md (both copies). Its Unattended bullet says: 'Finish the round on its pinned head, open no update round unless `on_head_move` is `follow`'. SKILL.md Round plan step 5 (line 64) now sends the agent there after every batch. `on_head_move` has no source anywhere in code: `keryx ctx rg on_head_move src` finds only the new test. So for an unattended run the rule always resolves to 'no update round'. The existing autonomous review prompt, built in code at src/review/autonomous-profile.ts:200 for a run with no fixedBase and pinned by harness-robustness.test.ts:179, tells the same agent: 'Open one more round only if the head moved while you worked, and review the new head.' Line 206 of the same prompt tells the agent to read `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md`, so the agent now holds two opposite instructions for the same event. The flow's plan.md step 3 and AC6 track only the fixed-range line 199 for a later fix (T8, blocked on stage 3). Line 200 is not tracked.",
    "evidence": "SKILL.detail.md:607 (bundled and .metaproject copies, identical; slice-01 lines 340 and 987); SKILL.md:64; src/review/autonomous-profile.ts:199, :200, :206; src/review/harness-robustness.test.ts:179; flow 521 plan.md step 3 and acceptance-criteria AC6 name only line 199 (slice-01 lines 23, 252); `keryx ctx rg on_head_move src` -> only src/gdskills/review-orchestrator-preflight.test.ts:406,408,438.",
    "class_scope": {
      "sites": [
        "src/review/autonomous-profile.ts:200",
        "src/review/autonomous-profile.ts:199",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md:607",
        ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md:607"
      ],
      "enumeration_method": "`keryx ctx rg 'head moved|Re-read head|If head moved|unchecked commits' src` and `keryx ctx rg on_head_move src`, then reading every code-built prompt that tells an agent to run review-orchestrator (buildAutonomousPrompt, the only caller being autonomous-run.ts:346). Two prompt branches state a head-move policy. Line 200 (no fixedBase, unattended) contradicts the new rule directly and is untracked. Line 199 (fixedBase, Desktop) says 'Keep this range throughout'; under the skill's `ask` path an operator can pick 'Stop and start on the new head', which conflicts with it. That conflict is already tracked by AC6/T8. The skill-text sites are the two identical copies of the changed line."
    },
    "title": "Unattended head-move rule contradicts the autonomous prompt's 'one more round on the new head'",
    "impact": "If the agent follows the changed skill text, it finishes on the old head and opens no round on the new head. The run then reviews a stale commit, where before this change the prompt's instruction to review the new head stood alone. Which instruction wins is up to the model, so the behaviour varies between runs. The prompt test pins only the prompt string, and per the flow journal it did not even load locally, so nothing catches the change.",
    "suggested_fix": "Make the two agree in one place. Either have the unattended bullet in SKILL.detail.md § 'Head moved' defer to a caller-supplied policy (the autonomous prompt counts as `follow`), or change autonomous-profile.ts:200 to the skill's rule and update harness-robustness.test.ts:179 with it. Add a test that reads both texts and asserts they agree, and add line 200 to T8/AC6 next to line 199.",
    "confidence": "high",
    "reviewer": "review-regression",
    "id": "R2",
    "merged_from": [
      "review-regression-w1:F-001",
      "review-logic-w1:F-006"
    ]
  },
  {
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "1. **Check.** Read the head with `gh pr view <n> --json headRefOid --jq .headRefOid` at every wave boundary (before each `keryx review next`), before `keryx review complete`, and before publishing.",
    "problem": "The per-wave head check is a `gh pr view` call. SKILL.md 'Shell calls in a trust or auto session' says 'A `gh` call still asks: that is expected, so make it once and reuse what it printed.' The new procedure requires a fresh gh call at every wave boundary.",
    "impact": "In trust/auto sessions, each wave boundary becomes an operator permission prompt (about 3-6 per round). That adds operator latency to a round that 'Between waves' rule 2 says must not pause while the plan is authorized. The API cost itself is negligible.",
    "suggested_fix": "Either state that the per-wave head read is an expected exception to 'make it once', or use a routine read-only git probe (e.g. `git ls-remote origin refs/pull/<n>/head`) at wave boundaries and keep `gh pr view` for the pre-complete and pre-publish checks.",
    "evidence": "slice-01: SKILL.detail.md § Head moved step 1 (new); SKILL.md Round plan step 5 (new text 'After each batch, read the pull request's head'); SKILL.md 'Shell calls in a trust or auto session' (unchanged context line, 'A `gh` call still asks ... make it once and reuse what it printed'); SKILL.detail.md 'Between waves' rule 2.",
    "confidence": "medium",
    "reviewer": "review-performance",
    "id": "R3",
    "title": "Per-wave `gh pr view` conflicts with 'make a gh call once' in trust/auto sessions",
    "merged_from": [
      "review-performance-w1:F-001",
      "review-security-code-w1:F-001",
      "review-architecture-w1:F-001",
      "review-degradation-w1:DEG-1",
      "review-highload-w1:F-002"
    ]
  },
  {
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "4. **Update round.** `keryx review advance` opens the next round of the same Review on the current head; Desktop runs the same command.",
    "problem": "Head moved step 4 says 'Desktop runs the same command'. The PR body lists that as pending (Item 3, T8, stage 3), and src/review/autonomous-profile.ts:199 still tells Desktop 'New commits belong to a separate request.' The same text is in the installed copy.",
    "impact": "A reader of the skill takes session/Desktop parity on the update command as true today; the PR body and the code say it is not.",
    "suggested_fix": "Word it as the target (\"Desktop will run the same command once stage 3 lands\") or drop the clause until T8.",
    "evidence": "slice-01.diff SKILL.detail.md hunk (both copies); keryx ctx rg 'New commits belong to a separate request' src -> src/review/autonomous-profile.ts:199; pr-context.md 'Waiting on stages 2 and 3' item 3.",
    "confidence": "high",
    "reviewer": "review-pr-contract",
    "id": "R4",
    "title": "'Desktop runs the same command' is stated as current; it is stage-3/T8 work",
    "merged_from": [
      "review-pr-contract-w1:PC-001"
    ]
  },
  {
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "The same SHA as the round's `head`: carry on.",
    "problem": "The check compares the PR head with the round's pinned head before every `keryx review next`. After the operator answers 'Update after this round finishes', the head still differs at the next boundary, so step 3 asks again and the stop list stops the round again. Nothing says to remember the answer.",
    "impact": "Literal execution re-asks the same question at every wave boundary: a repeated pace-style stop, and a fresh Telegram poll each time.",
    "suggested_fix": "Compare with the last head the operator answered for (or the round's head before any answer); ask again only when the PR moved past it.",
    "evidence": "SKILL.detail.md:599-605 and the stop-list entry at :587 (both copies).",
    "confidence": "medium",
    "reviewer": "review-logic",
    "id": "R5",
    "title": "The ask question repeats at every wave boundary after the operator answered",
    "merged_from": [
      "review-logic-w1:F-002"
    ]
  },
  {
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "- **Update after this round finishes**: the round runs to `complete`, then step 4.",
    "problem": "For update-after, follow and ignore, the round completes on a moved head. completeHeadGate throws unless report.md's first line names the reviewed SHA and says the PR moved (complete-head-gate.ts:52-61). The section names that line only for step 5 publish-as-is.",
    "impact": "`keryx review complete` refuses. The error says how to fix it, so the cost is an extra round-trip.",
    "suggested_fix": "In step 3 or in step 1's 'before `keryx review complete`', say that the report's first line must be the templates/review-report.md moved-head line before `complete` (as SKILL.md:235 already says).",
    "evidence": "src/review/complete-head-gate.ts:52-61; templates/review-report.md:37.",
    "confidence": "high",
    "reviewer": "review-logic",
    "id": "R6",
    "title": "Completing a round on a moved head needs the reviewed-SHA first line; the procedure says so only for publish",
    "merged_from": [
      "review-logic-w1:F-003"
    ]
  },
  {
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "5. **Before publishing, when the head moved after the round completed.** Offer these options, in this order, with the host question tool:",
    "problem": "Step 1 checks 'before publishing' and then flows into step 3 (on_head_move). Step 5, which holds the D1 COMMENT-only rule, applies only when the head moved after completion. A head that moved during a round under `ignore` and is then published falls under neither step, and the session publish path does not enforce COMMENT (readiness item 7 only warns). Latent today, because no stored on_head_move exists in a session.",
    "impact": "Once `ignore` is stored (stage 3), REQUEST_CHANGES or APPROVE can be posted for an outdated commit, against D1.",
    "suggested_fix": "State that step 3 governs a running round, and that any publish of a package whose head differs from the PR head goes through step 5 regardless of on_head_move.",
    "evidence": "SKILL.detail.md:599-609; implementation-plan.md:81 (D1); divergence-map.md section 2 'head moved' row.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "id": "R7",
    "title": "D1 COMMENT-only rule skipped for a head that moved during the round",
    "merged_from": [
      "review-logic-w1:F-004",
      "review-degradation-w1:DEG-S2"
    ]
  },
  {
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "Exit 1: history was rewritten (force-push or rebase), N is unknown, and the update round will be `fallback-first`.",
    "problem": "Only exits 0 and 1 are mapped. If the fetch failed or the reviewed SHA is missing locally, `git merge-base --is-ancestor` exits 128, and an agent may report it as rewritten history.",
    "impact": "A false force-push report goes to the operator; no data is lost.",
    "suggested_fix": "Add: any other exit means the count is unavailable (fetch or object missing); report 'head moved, count unavailable', not a rewrite.",
    "evidence": "SKILL.detail.md:600; git merge-base --is-ancestor exits 128 on a bad object (standard git behaviour).",
    "confidence": "medium",
    "reviewer": "review-logic",
    "id": "R8",
    "title": "merge-base --is-ancestor exit 128 is not handled",
    "merged_from": [
      "review-logic-w1:F-005"
    ]
  },
  {
    "severity": "minor",
    "file": ".metaproject/flows/521-2026-11-24-desktop-review-v2-stage4/divergence-map.md",
    "line": null,
    "quote": "Keep D1 out: moved head refuses for now.",
    "problem": "Row 4 of the extraction plan sends the session publish through Desktop's head check and refuses a moved head. The 'Head moved' procedure in this same PR prescribes `keryx review publish <package> --event COMMENT` for a moved head (option 2, D1). The journal's T6 note already corrects this ('T7 must add the COMMENT restriction to the session path rather than refusing outright'), but the map, which T7 executes, was not updated. Section 5's last bullet describes the breakage without resolving it.",
    "impact": "If T7 follows the map, the skill's 'Publish as is for <reviewed sha>' option fails at the CLI. The plan and the procedure shipped in the same PR then disagree on the D1 path.",
    "suggested_fix": "Change row 4 to: moved head allowed only with `--event COMMENT` and the first line naming the reviewed SHA (D1), refused otherwise; closed PR refused. Change its tests to: moved head + REQUEST_CHANGES/APPROVE refused, moved head + COMMENT with reviewed-SHA first line accepted. Drop or resolve section 5's last bullet.",
    "evidence": "slice-01 line 177 (row 4) vs lines 991 (procedure option 2) and 221 (journal T6 note).",
    "confidence": "high",
    "reviewer": "review-architecture",
    "id": "R9",
    "title": "Divergence map row 4 refuses a moved head, contradicting D1 publish-as-is",
    "merged_from": [
      "review-architecture-w1:F-003"
    ]
  },
  {
    "severity": "minor",
    "file": "src/gdskills/review-orchestrator-preflight.test.ts",
    "line": null,
    "quote": "expect(text).toContain(\"Reviewed `<reviewed sha>` — the PR has since moved on to `<new sha>`.\");",
    "problem": "AC1's D1 rule says an old commit is published as is only with a FIRST line naming the reviewed commit. The test pins the sentence text but not its position: neither 'first line' nor 'The body's first line is' is asserted. The clause 'the body names the commits it did not check (`<reviewed sha>..<new sha>`)' is not asserted either.",
    "impact": "If the procedure is rewritten to put the sentence anywhere else in the body ('last line', 'a line'), or the unchecked-commit range is dropped, the suite stays green. readiness item 7 (completeHeadGate) only accepts the moved-head report when the first line names the SHA, so a misplaced line would fail at publish time with no test catching the skill text. This is predicted, not run.",
    "suggested_fix": "Assert the position as well: expect(text).toContain(\"The body's first line is \\\"Reviewed `<reviewed sha>`\") and expect(text).toContain(\"names the commits it did not check (`<reviewed sha>..<new sha>`)\").",
    "evidence": "Read the D1 test in the new block (diff lines 1155-1163 of slice-01): none of its 6 assertions contains 'first line'. The template src/gdskills/bundled/skills/review/review-orchestrator/templates/review-report.md:37 requires the line 'as the very first line'. Mutants M01 and M02 are not run.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "id": "R10",
    "title": "Preflight assertions do not pin first-line position, unattended negation, ask option order or the ask-only stop",
    "merged_from": [
      "review-testing-practices-w1:F-001",
      "review-testing-practices-w1:F-002",
      "review-testing-practices-w1:F-003",
      "review-testing-practices-w1:F-004"
    ]
  },
  {
    "severity": "info",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "3. **Decide by `on_head_move`:** the Review's own value when it has one, otherwise `ask` (the default for a manual review).",
    "problem": "The text does not say where 'the Review's own value' is read from. No store exists before stage 3, so an agent could take follow/ignore from PR-supplied content.",
    "impact": "Untrusted content could suppress the operator's head-move question. Bounded: neither follow nor ignore publishes, and no GitHub write path was found.",
    "suggested_fix": "State that on_head_move is read only from the keryx-stored Review record (stage 3), never from PR body, branch files or comments, and is 'ask' until that store exists.",
    "evidence": "slice-01 SKILL.detail.md § Head moved step 3; description.md Out of Scope: on_head_move storage belongs to stage 3.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "id": "R11",
    "title": "Source of on_head_move is not stated (only the stored Review, else ask)",
    "merged_from": [
      "review-security-code-w1:F-003"
    ]
  },
  {
    "severity": "info",
    "file": "src/gdskills/review-orchestrator-preflight.test.ts",
    "line": null,
    "quote": "test.each([\"SKILL.md\", \"SKILL.detail.md\"])(\"the bundled and installed %s are identical\", (file) => {",
    "problem": "The new copy-parity assertion repeats `src/gdskills/review-orchestrator-skill-parity.test.ts`, which already asserts both review-orchestrator files are byte-identical across the two copies and that SKILL.md equals its ceiling. The flow's AC3 uses `cmp` anyway.",
    "impact": "Two guards for one invariant; harmless. Duplication belongs to review-clean-code's lane, noted here only for the two-copy layout question.",
    "suggested_fix": "Optional: drop the test.each and point AC3 at review-orchestrator-skill-parity.test.ts.",
    "evidence": "review-orchestrator-skill-parity.test.ts:30-45 read at head.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "id": "R12",
    "title": "New copy-parity assertion duplicates review-orchestrator-skill-parity.test.ts",
    "merged_from": [
      "review-architecture-w1:F-005"
    ]
  },
  {
    "severity": "info",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "## Head moved",
    "problem": "The new section adds context to SKILL.detail.md.",
    "impact": "+23 lines / +3,448 bytes (about 850 tokens, ~7% of the file) on an on-demand file. SKILL.md's line count is unchanged at its 918 ceiling. No action needed.",
    "suggested_fix": "None.",
    "evidence": "wc on head: 685 lines / 53,470 bytes; on base a5d1ab236: 662 lines / 50,022 bytes.",
    "confidence": "high",
    "reviewer": "review-performance",
    "id": "R13",
    "title": "SKILL.detail.md grows by about 850 tokens (on-demand file)",
    "merged_from": [
      "review-performance-w1:F-002"
    ]
  },
  {
    "id": "R14",
    "title": "review-orchestrator frontmatter version not bumped",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md",
    "line": null,
    "quote": "  version: \"1.17.0\"",
    "problem": "The skill changed behaviour but its frontmatter version stayed 1.17.0; skill-drift.ts compares versions only, so installed copies with the removed wording are not flagged stale.",
    "impact": "Hosts keep running the old head-move text without a drift warning.",
    "suggested_fix": "Bump metadata.version in both copies.",
    "evidence": "review-regression-w1 follow-up; src/gdskills skill-drift.ts",
    "confidence": "medium",
    "reviewer": "review-regression",
    "merged_from": []
  }
]
```
