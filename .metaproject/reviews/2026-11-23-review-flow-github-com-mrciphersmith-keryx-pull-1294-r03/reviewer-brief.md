# Reviewer brief — round 3 (delta), PR MrCipherSmith/keryx#1294

Shared by every reviewer of this round. Your dispatch prompt names your reviewer role and your driver files.

## Target

- Project root (git worktree): `/Users/tsaitler.aleksandr/work/sandbox/keryx/.worktrees/pr-review-audit`, branch `feat/desktop-review-v2-stage0`.
- Pull request: https://github.com/MrCipherSmith/keryx/pull/1294 (open). CI at dispatch time: 19 checks passed, 8 pending, none failed.
- Merge base `1b994df180fb89c82b6164e516ad3ff27b2453fa`. Previous round reviewed head `33fd9647afea1cb7795ca56dd168405c1db8d21a`. This round's head: `086335a01cc6ccd4c97672215d4db86d5c308dce`. Delta under review: `33fd9647afea..086335a01cc6` (three commits: SQL refactor 47721a089, UI fix cc42698a3, flow journal 086335a01).
- Package: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r03` (below: `<package>`). Previous round's package: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r02` (its `report.md`, `canonical-findings.json`, `raw/`).

## This is a fix round

- `is_fix_round: true`. The 12 findings of round 2 are in `<package>/prior_findings.json` (F-015 … F-018 and F-025 minor; F-019 … F-024 and F-026 info). Full text with quotes: the previous package's `canonical-findings.json`.
- Slice kinds: `slice-01` is the FIX slice; `slice-02` and `slice-03` are NEW code of the delta; `slice-04` … `slice-06` are a SECOND LOOK at code that did not change since round 2 (most of it flow, journal and docs files — context, see Rules).
- For every prior finding whose site is in a slice you read, return a disposition: `closed` (the defect is gone — say what in the code shows it), `open`, `partial` (name what remains), `regressed` (the fix broke something — say what), `withdrawn`. Judge the code at this head, not the commit message. Put them in your result as `prior_dispositions: [{ "id": "F-0NN", "disposition": "…", "evidence": "…" }]`.
- New defects go in `findings`. A defect the fix introduced is a finding with `degradation_class: "behaviour-delta"` and says which fix introduced it.
- Do not re-review unchanged code outside your slices, and do not re-report a prior finding as new: give it a disposition.

## What the fixes claim to do

- F-015 (`apps/desktop/src/review/ReviewBoard.tsx`): the load callback no longer applies `needsViewerAttention`; it only resets `carriedAttention` when the load replaces the set. The `attentionPrs` memo judges the shown snapshot, and a new effect stores the memo's result back into `carriedAttention` when a snapshot is shown and the sets differ. New DOM test: a reply read under the open scope keeps the tab indicator off after a switch to merged-only. This is the change most worth your attention: check render loops, the first render after a scope switch, loads that do and do not replace the set, identity changes (another repository or viewer), access loss, and the unavailable-error path that keeps an old snapshot.
- F-016 (`ReviewResults.tsx`): the list row computes the reason and the note once.
- F-017 (`model.ts`): the local in `laneReason` is renamed `note`.
- F-018 (`src/review/desk-run-store.ts`, `attachBadges`): `active` and `done` are columns of `scoped`; `flagged` computes `live`, `reviewed`, `finished`; a new CTE layer computes `kept` and `supersedes`; `ranked` picks the rows. Claimed: returned rows unchanged. Check NULL handling term by term against the statement at `33fd9647a` (`git show 33fd9647a:src/review/desk-run-store.ts`).
- F-025: the pull request description was rewritten (see `<package>/pr-context.md`); not a code change.
- Not addressed by the delta: the info findings F-019 … F-024, F-026.

## Evidence at this head

- Tests of the round's blast radius, both exit 0: `<package>/research-evidence/verify-tests-to-run-1.txt`, `verify-tests-to-run-2.txt`.
- Orchestrator's own runs at this head: `cd apps/desktop && bun test src` 756 pass; `bunx tsc --noEmit` exit 0; root `bun run typecheck` exit 0; `src/review/board-badges.test.ts` 5 pass.
- The implementing worker reported seeing the new DOM test fail against the component of `33fd9647a`; the orchestrator did not repeat that.
- Not done: the F-015 scenario in a running app; the SQL timing after the refactor.
- Requirements: flow package `.metaproject/flows/516-2026-11-23-desktop-review-v2-stage0/` (`acceptance-criteria.md` AC1–AC8, `plan.md`, `journal.md`).
- Memory: the round's one search returned nothing about this code. Cross-repo contracts: none.

## Your inputs

Your driver files `<package>/drivers/<name>.json` name your slice ids, absolute slice paths (`slicePaths`), your result file (`result`, relative to `<package>`) and your skill (`definition`). Read your skill first and follow it. Read every slice of every driver you were given, in full.

## Rules

- `allowed_tools: read-only`, `exec_budget_s: 0`. Read files and run only: `git log`, `git blame`, `git show`, `keryx ctx rg "<pattern>" [path]`, `keryx ctx read <file>`, `keryx gdgraph affected <file>`, `keryx test related <file>`. Bare `rg`, `grep`, `cat` are blocked by a hook; use the Read tool. No tests, no servers, no edits in the reviewed tree. The only files you write are your result files.
- Severity and finding fields: `## Severity (canonical)` in `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` and `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`. Counterpart rules and round obligations: `SKILL.detail.md` § "Counterpart verification" and § "Round obligations" in the same folder.
- A blocker or major finding carries `class_scope` with `sites` and `enumeration_method`.
- `max_findings: 10`. Report a defect only with a file, a quote and a concrete failure scenario. Flow, journal, resolved-context and docs files are context: report on them only where they are wrong about the code or leak a secret or personal data.
- Agent conduct (mandatory): (1) No AI attribution: no `Co-Authored-By:` trailer or "Generated by/with …" line naming an AI model, agent or tool in commit messages, PR or ticket descriptions, or comments. A human co-author, a code-generator note and a model name as technical provenance are allowed. (2) No commit, push, merge or release without an explicit ask. Invoking an orchestrator is the ask for its own task-boundary commits; merge and release always need their own ask. (3) Never destroy others' work: no `git stash` in a dirty tree, no blanket `git add -A` while parallel lanes share a checkout, no force-push to a shared branch. (4) No secrets or personal data in output, logs or commits. (5) Report honestly: name what failed, what was skipped and what was not verified.

## Output

Write your WHOLE reply, identically, to the `result` path of EVERY driver you were given, before you answer; then return the same text. The reply:

1. starts with a line `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`;
2. carries one fenced `json` block headed `REVIEW_RESULT` that validates against `reviewer-finding.schema.json`, with `status`, `reviewer`, `summary`, `findings`, `stats`, `prior_dispositions`, and `slices` listing exactly the slice ids you read in full;
3. says what you did not verify.

A testing reviewer includes `mutant_candidates` if its skill asks for them.
