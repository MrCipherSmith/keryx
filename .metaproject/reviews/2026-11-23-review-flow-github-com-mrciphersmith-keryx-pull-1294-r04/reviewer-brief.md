# Reviewer brief — round 4 (delta), PR MrCipherSmith/keryx#1294

Shared by every reviewer of this round. Your dispatch prompt names your reviewer role and your driver files.

## Target

- Project root (git worktree): `/Users/tsaitler.aleksandr/work/sandbox/keryx/.worktrees/pr-review-audit`, branch `feat/desktop-review-v2-stage0`.
- Pull request: https://github.com/MrCipherSmith/keryx/pull/1294 (open). The commits of this round after `622c914b7` are local and not pushed yet; no CI has run on them.
- Merge base `1b994df180fb89c82b6164e516ad3ff27b2453fa`. This round's head: `be26765ae0deaaae0dc379eb5befde79d6fe41ed`.
- Package: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r04` (below: `<package>`).

## What is actually new — read this before your slices

The planner cut the slices against `33fd9647a` (the head of round 2), because round 3's package did not pass the completion gate. So the slices contain two layers:

1. Already reviewed in round 3 (head `086335a01`): commits `47721a089` (badge SQL refactor, F-018) and `cc42698a3` (attention set write-back, F-015; list row locals, F-016; rename, F-017). Round 3's report and findings: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r03/report.md` and `canonical-findings.json` (F-027 minor, F-028 and F-029 info). Do not re-report what round 3 reported.
2. NEW in this round, never reviewed — this is your subject:
   - `20b535531` fix(desktop-review): seed the tab signal from a replacing load — the fix of round 3's F-027 in `apps/desktop/src/review/ReviewBoard.tsx` (load callback: `if (replaceAttention) setCarriedAttention(new Set(loaded.cards.filter(…needsViewerAttention…).map(card => card.number)))`), a new DOM test for saved historical filters, and the handled-request DOM test strengthened with a second pull request.
   - `251d494ac` docs: F-019 (a third stage 0 deviation about the toolbar) and F-026 ("awaiting merge" removed).
   - `f72f23f73` UI: F-023 — the two portaled dialogs carry `data-review-board-dialog`, matched by `inBoardOverlay()`; two DOM tests for the outdated-review note (F-022c).
   - `be26765ae` backend: F-021 — `attachBadges` reads a publication only for a row whose reviewed range equals the card's range, via a `cardByPr` lookup; one store test with a fixture per term of the outdated lookup (F-009, F-022, F-029).
   - `622c914b7` is a flow journal commit (context).
   Use `git show <hash>` to see each new commit on its own.

## This is a fix round

- `is_fix_round: true`. `<package>/prior_findings.json` holds round 2's findings (F-015 … F-026). Add to them round 3's F-027, F-028, F-029 from the path above. For every prior finding whose site is in what you read, return a disposition: `closed` (say what in the code shows it), `open`, `partial`, `regressed`, `withdrawn`. Put them in your result as `prior_dispositions: [{ "id": "F-0NN", "disposition": "…", "evidence": "…" }]`.
- New defects go in `findings`. A defect a fix introduced is a finding with `degradation_class: "behaviour-delta"` and names the fix.
- The attention-set code in `ReviewBoard.tsx` was fixed three times and two of those fixes introduced a regression (F-015 from F-008, F-027 from F-015). Treat the third fix with that history in mind: look for the next case the current shape gets wrong, not for confirmation that the reported case is closed.

## Evidence at this head

- Tests, both exit 0: `<package>/research-evidence/verify-tests-to-run-1.txt`, `verify-tests-to-run-2.txt`.
- Orchestrator's own runs: `cd apps/desktop && bun test src` 759 pass; `bunx tsc --noEmit` exit 0; root `bun run typecheck` exit 0; `desk-run-store.test.ts` 37 pass; `board-badges.test.ts` 5 pass; `desk-publication.test.ts` 10 pass.
- Orchestrator mutation runs on `ReviewBoard.dom.test.tsx`, each restored afterwards: write-back effect removed → 1 fail; seeding removed → 1 fail; seeding on every load (no replace condition) → 3 fail; dialog marker removed from the PR watcher → 1 fail. The backend worker reported four SQL mutations each failing the new store test; the orchestrator did not repeat those.
- Not done: no scenario was reproduced in a running app; the SQL timing was not re-measured; "reset on replace dropped entirely" was not run as a mutation.
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
