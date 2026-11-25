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

- AC1: docs/requirements/keryx-desktop-review-v3/ holds README.md, prd.md, specification.md and implementation-plan.md in Russian covering the review.json schema and its migration from v2 runs.sqlite, the CLI verbs the skill calls, the session-to-card status mapping, the stages, what v3 supersedes in the v2 plan, and the owner decisions recorded as decisions. [verify: judged]
- AC2: `keryx review state open` applies the round rule: the first call opens round 1; the same base, head and settings key from another session keeps the same round and records both sessions; a new head or a different settings key opens round N+1 with previousRound N. [verify: exec `bun test src/review/review-state.test.ts`]
- AC3: every `keryx review state` write appends one line to journal.md next to review.json, writes atomically under a file lock, refuses invalid round transitions and writes to a ready round other than verdict/findings/usage with a non-zero exit, and never modifies a review.json of another schema or version. [verify: exec `bun test src/review/review-state.test.ts src/commands/review-state.test.ts`]
- AC4: `keryx review state open|round|publish|mark|note|show|list` exist, print `--json` as `{ version: 1, review, ... }`, are listed in `keryx review --help`, and `open` takes `--session` from KERYX_REVIEW_SESSION_ID when not given. [verify: exec `bun test src/commands/review-state.test.ts`]
- AC5: "Run review" from the Pull requests board and the Reviews tab sends no `review_run start`; it opens the newest session bound to the PR (or a new session bound via subject) and sends a review turn there that names the review-orchestrator skill, the PR URL, the reviewed base and head, and the `keryx review state open` command. [verify: exec `cd apps/desktop && bun test src/shell/ProjectNavigation.dom.test.tsx src/review/reviewTurn.test.ts`]
- AC6: Apply in the session `/review` launch dialog sends the review turn into that same session and sends no `review_run start`. [verify: exec `cd apps/desktop && bun test src/shell/ProjectNavigation.dom.test.tsx`]
- AC7: "Continue review" in the session review card sends a continue turn (naming the review id and `keryx review state show`) into the shown session and sends no `review_run continue`. [verify: exec `cd apps/desktop && bun test src/review/SessionReviewActivity.dom.test.tsx src/review/reviewTurn.test.ts`]
- AC8: Failure scenario: when the target session is already running a turn, Start and Continue send no turn, start no detached worker, and show the user why. [verify: exec `cd apps/desktop && bun test src/review/SessionReviewActivity.dom.test.tsx src/shell/ProjectNavigation.dom.test.tsx`]
- AC9: v2 Reviews, rounds and attempts from runs.sqlite keep displaying on the board slot, the Reviews tab and the session review card (read-only compatibility). [verify: exec `cd apps/desktop && bun test src/shell/ProjectNavigation.dom.test.tsx src/reviews`]
- AC10: Both copies of the review-orchestrator SKILL.md carry the same "Desktop review state" section naming the `keryx review state` call at each step (open before start, package after start, dispatching, wave end, reconciling, ready, paused, continue, publish). [verify: invariant `diff .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md`]
- AC11: A Draft PR against main carries the docs and stage 1, CI is green or each failure is explained, and the report names what was not verified in the live app. [verify: judged]
