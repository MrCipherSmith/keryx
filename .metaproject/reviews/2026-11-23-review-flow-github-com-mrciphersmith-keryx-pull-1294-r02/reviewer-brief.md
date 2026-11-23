# Reviewer brief — round 2 (delta), PR MrCipherSmith/keryx#1294

Shared by every reviewer of this round. Your dispatch prompt names your reviewer role and your driver files.

## Target

- Project root (git worktree): `/Users/tsaitler.aleksandr/work/sandbox/keryx/.worktrees/pr-review-audit`, branch `feat/desktop-review-v2-stage0`.
- Pull request: https://github.com/MrCipherSmith/keryx/pull/1294 (open). CI at dispatch time: one check failed — `client matrix (cancel-resume)`, in `src/rewind/shadow-isolation.test.ts`, a file this pull request does not touch; the rest passed or were pending.
- Merge base `1b994df180fb89c82b6164e516ad3ff27b2453fa`. Previous round reviewed head `53c96b8af161a9aa7550f6d8f7c2ed739baaf110`. This round's head: `33fd9647afea1cb7795ca56dd168405c1db8d21a`. Delta under review: `53c96b8af161..33fd9647afea` (four commits: docs 626bf776d, UI 964047588, SQL e08743ab4, flow journal 33fd9647a).
- Package: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r02` (below: `<package>`). Previous round's package: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294` (its `report.md`, `raw/`, `research-evidence/`).

## This is a fix round

- `is_fix_round: true`. The 14 findings of round 1 are in `<package>/prior_findings.json` (F-001 major; F-002 … F-008 minor; F-009 … F-014 info). Their full text with quotes: the previous package's `canonical-findings.json`.
- Slice kinds: `slice-01` is the FIX slice (hunks that touch code a prior finding points at); `slice-02` and `slice-03` are NEW code of the delta; `slice-04` … `slice-06` are a SECOND LOOK at code that did not change since round 1.
- For every prior finding whose site is in a slice you read, return a disposition: `closed` (the defect is gone — say what in the code shows it), `open` (still there), `partial` (name what remains), `regressed` (the fix broke something — say what), `withdrawn` (the finding was wrong). Judge the code at this head, not the commit message. Put them in your result as `prior_dispositions: [{ "id": "F-00N", "disposition": "…", "evidence": "…" }]`.
- New defects go in `findings` as usual. A defect the fix introduced is a finding with `degradation_class: "behaviour-delta"` and says which fix introduced it.
- Do not re-review unchanged code outside your slices, and do not re-report a prior finding as new: give it a disposition.

## What the fixes claim to do

- F-001: `apps/desktop/src/styles/review.css` — the toolbar wraps again (no `nowrap` override); search field `flex: 1 1 96px; max-width: 260px`; labels hidden under a 1100px container; count label and watcher status hidden under 760px.
- F-002: `ReviewBoard.tsx` — `clearPrivateView` also detects focus inside the two portaled dialogs (by their content class).
- F-003 (operator: uphold): `model.ts` — `laneReason` ranks the outdated text after `attentionReason`; new `reviewNote(card)`; `ReviewResults.tsx` shows it as a secondary line. Operator decision: the line is shown on every card with an outdated badge, merged and closed ones included.
- F-004: requirements docs and roadmap — stage 0 marked implemented, two deviations recorded.
- F-005: Review rules uses the `shieldCheck` icon; the active-filter count is a separate element that stays visible.
- F-006 (and F-010): `src/review/desk-run-store.ts` `attachBadges` — one materialized CTE parses each run once; window functions keep the newest finished run per card only when no run of that card supersedes it; an outdated candidate needs both reviewed SHAs.
- F-007: `model.test.ts` uses a neutral card. F-008: the attention set is derived with `useMemo`; only cross-scope retention stays as state.

## Evidence at this head

- Tests of the round's blast radius, both exit 0: `<package>/research-evidence/verify-tests-to-run-1.txt`, `verify-tests-to-run-2.txt`.
- Toolbar measurements after the fix (Chromium, Vite dev build, board without data, stand-ins for the Review rules button and the count label): previous package `research-evidence/layout-measurements.md`, section "After the fix" — one row with no overflow at toolbar widths 560, 700, 820, 1101, 1380px; wrapped to two rows with nothing clipped at 340px. Not measured: real board data, the detail panel actually open.
- SQL measurement by the implementing worker (not re-run by the orchestrator): previous package `research-evidence/outdated-lookup-measurement.md` — 200 pull requests x 30 runs with 200 KB reports, 200-card batch: base about 405 ms, round-1 head about 770 ms, this head about 395 ms; badge output identical to round-1 head.
- Orchestrator's own runs at this head: `cd apps/desktop && bun test src` 755 pass; `bunx tsc --noEmit` exit 0; root `bun run typecheck` exit 0; the 8 `src/review/board*` and `desk-run*` test files each pass alone. Running eleven test files in one invocation twice failed several `desk-run-executor.test.ts` tests with 6–8 s durations; that file passes alone and does not call `attachBadges` — not investigated.
- Requirements: flow package `.metaproject/flows/516-2026-11-23-desktop-review-v2-stage0/` (`acceptance-criteria.md` AC1–AC8, `plan.md`, `journal.md`).
- PR context: `<package>/pr-context.md`. The PR description was not updated after the fixes.
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
