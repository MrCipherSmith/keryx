# Reviewer brief — round 5 (delta), PR MrCipherSmith/keryx#1294

Shared by every reviewer of this round. Your dispatch prompt names your reviewer role and your driver files.

## Target

- Project root (git worktree): `/Users/tsaitler.aleksandr/work/sandbox/keryx/.worktrees/pr-review-audit`, branch `feat/desktop-review-v2-stage0`.
- Pull request: https://github.com/MrCipherSmith/keryx/pull/1294 (open). The commits of this round are local and not pushed; no CI has run on them.
- Merge base `1b994df180fb89c82b6164e516ad3ff27b2453fa`. This round's head: `8e6ecf1aa3da` (full sha: `git rev-parse 8e6ecf1aa`).
- Package: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r05` (below: `<package>`).

## What is actually new — read this before your slices

The planner cut the slices against `33fd9647a` because the packages of rounds 3 and 4 did not pass the completion gate, so the slices also contain code reviewed in rounds 3 and 4. Do not re-report what those rounds reported (`.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r03/` and `-r04/`, files `report.md`, `canonical-findings.json`).

NEW in this round, never reviewed — your subject (`git show <hash>` for each):
- `91c37c81b` — fix of round 4's F-030 and F-031 in `apps/desktop/src/review/ReviewBoard.tsx`: only an open or all load without a period replaces the carried attention set; any other load for an unseeded identity empties the set on an identity change and requests one open "seed" load (`seedFor` state, `seeded` ref, a seed effect) whose result is applied only if it answers for the current, still unseeded identity; `accessLost` resets the seed state; a cached snapshot shown after an `unavailable:` error is marked `stale` and does not write back into the carried set. Four new DOM tests.
- `85bd13a03` — the operator's answers to three product questions: F-012 a toolbar button "N waiting on you hidden by filters" (numbers in `attentionPrs` not among `visible`) that calls the existing `reset` (clears filters, including the saved ones, and the search); F-013 the outdated-review action is labelled "Review again" (`ReviewResults.tsx`, `ReviewRuns.tsx`); F-020 the pull request count stays as a bare number under the 760px container query (`.count-word` hidden) and, added by the orchestrator, the search field may shrink to 80px there (`review.css`); docs deviation (c) and new item (d) in `implementation-plan.md`. Three new DOM tests.
- `8e6ecf1aa` — flow journal and a measurement file (context).

## This is a fix round

- `is_fix_round: true`. Round 4's findings are F-030 (minor), F-031, F-032, F-033 (info) in `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r04/canonical-findings.json`; round 2's open questions F-012, F-013, F-020 are in `-r02/canonical-findings.json`. For each whose site you read, return a disposition (`closed`, `open`, `partial`, `regressed`, `withdrawn`) in `prior_dispositions`.
- New defects go in `findings`; a defect a fix introduced has `degradation_class: "behaviour-delta"` and names the fix.
- History you must weigh: the attention-set code was changed in T13 (F-008), T16 (F-015), T18 (F-027) and now T22 (F-030/F-031). Two of the three earlier fixes introduced a regression that only the next round found. The T22 change adds a second request path and new state. Look for the case it gets wrong — races between the main load, the seed and user actions; request count when GitHub fails; whether the seed's card-only snapshot misses reply-based attention; whether `stale` is cleared on every path that should clear it — not for confirmation that the reported scenario is closed.

## Evidence at this head

- `<package>/research-evidence/verify-tests-to-run-1.txt` (`bun test src` in `apps/desktop`, exit 0).
- Orchestrator's own runs: `bun test src` 766 pass; `bunx tsc --noEmit` exit 0.
- Mutation runs by the orchestrator on `ReviewBoard.dom.test.tsx` at `91c37c81b`, file restored after each: seed request removed → 2 fail; `stale` guard removed → 1 fail; old replace rule (identity change counts as a full load) → 2 fail; seed identity guard reduced to `if (!current) return;` → 1 fail (after a test was added for it); write-back removed → 2 fail.
- Toolbar layout after T23: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r04/research-evidence/layout-measurements-t23.md` (real stylesheets, rebuilt markup with stand-ins; not the app with real data).
- Requirements: flow package `.metaproject/flows/516-2026-11-23-desktop-review-v2-stage0/`.

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
