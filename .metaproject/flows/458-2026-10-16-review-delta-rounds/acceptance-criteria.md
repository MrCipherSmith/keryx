# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `review start` finds the previous round of the same target from, in order, the local package, review packages in git history (any branch), the keryx round block on the PR, other PR comments (as prior findings without head), and the flow package; picks the newest reviewed head by ancestry; records the source in `<package>/round.json`; with no gh/offline records "github: not consulted"; with nothing found the round is 1 and the verdict says so. Tests per source and for disagreement. · sensitive: failure-scenario [verify: exec `bun test src/review/prior-round.test.ts`]
- AC2: `review publish` adds a hidden machine-readable round block (round, reviewId, reviewed head, findings with id/file/line/quote hash or symbol/severity/status) holding nothing not already in the posted body; `comments collect` parses it from keryx's own comments without replying to them. [verify: exec `bun test src/review/publish.test.ts src/review/pr-comments.test.ts`]
- AC3: When the previous reviewed head is an ancestor of the current head, the round's diff is prevHead..head split into FIX hunks (overlapping a still-open prior finding relocated by file + quote/symbol, or commits naming a finding id) and NEW hunks; FIX slices get logic, regression, the roles that authored those findings and the verifier, with the prior findings attached; NEW slices get round-1 routing; unchanged code is not re-reviewed and its findings carry over with dispositions; a force-push/rebase falls back to round 1 over merge-base..head with prior findings attached. · sensitive: failure-scenario [verify: exec `bun test src/review/prior-round.test.ts src/review/round-split.test.ts`]
- AC4: Readiness, coverage, ledger and estimate count a split round correctly: a FIX slice is covered when every attached finding has a disposition; carried findings count toward terminal dispositions; each slice kind is checked against its own roster. [verify: exec `bun test src/review/round-split.test.ts src/review/ledger.test.ts src/review/readiness.test.ts`]
- AC5: Ingest merges duplicate findings (same file and located line ±3 or same quote, same mechanism) into one with the highest severity and `reported_by`; the verifier's severity is canonical when present; later waves receive known finding ids/anchors. [verify: exec `bun test src/review/dedupe.test.ts`]
- AC6: Reviewer frontmatter `supersedes`/`overlap_group` collapse overlapping lines: a project overlay removes the bundled reviewers it supersedes (recorded as excluded with the reason) and each overlap group gets one role per slice. [verify: exec `bun test src/review/coverage.test.ts src/review/slice-routing.test.ts`]
- AC7: `ledger build` resolves the project root for flow-bound packages; `ledger build --skip <reviewer> --reason "<why>"` records a deliberate skip shown as Not run with its reason; ingest into an existing package defaults to the package head and refuses when that commit is missing locally. [verify: exec `bun test src/review/ledger.test.ts src/commands/review-ledger.test.ts src/review/managed.test.ts`]
- AC8: `keryx review plan --target … [--head …]` runs start (with round detection), scope, blast-radius, slice, required and estimate and writes plan.json; the skill's round plan is that one command. [verify: exec `bun test src/commands/review-plan.test.ts`]
- AC9: Skills: review-orchestrator takes the delta from `review start` (the "never review the fix commit alone" rule is replaced), reviewers are read-only except the verifier and one testing reviewer with a time budget (reviewer-input schema `allowed_tools`, `exec_budget_s`); flow-orchestrator, flow complete/manage, job-orchestrator, review-pr-feedback and feature-dev call `review start` without their own range or `--all`; flow-orchestrator Phase 1 requires a state×event matrix for UI/store scope, a gate after the first green, operator questions for `behavior_changes`, suggested fixes treated as hypotheses, and one implementer when red probes exist (task-implementer output contract gains `behavior_changes`). Both copies identical, length ceilings kept. [verify: invariant `bun test src/gdskills/`]
- AC10: Evaluation: on a real multi-round keryx PR (#1005 or #992), a live round 2 under the new design (Opus, same prompts) finds the round-2 ground-truth findings at least as well as a whole-branch re-review, with the dispatch counts of both recorded in eval/. [verify: judged]
- AC11: The repository stays green (CI) and a patch release containing this flow is published to npm. [verify: exec `npm view @mrciphersmith/keryx version`]
