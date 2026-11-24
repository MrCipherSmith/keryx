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

- AC1: `review-orchestrator/SKILL.detail.md` has a section "Head moved" that covers: a head check at every wave boundary (before each `keryx review next`) and before `review complete` and before publishing; the count of new commits and the rewritten-history case; `on_head_move` with `ask` as the default and its two operator choices (update after the round finishes / stop and start on the new head), plus `follow` and `ignore`; the update round through `keryx review advance`, with what to run while that command is not listed; the D1 rule that an old commit is published "as is" only with `--event COMMENT` and a first line naming the reviewed commit; and the unattended behaviour. A preflight test asserts each of these. [verify: exec `bun test src/gdskills/review-orchestrator-preflight.test.ts`]
- AC2: `review-orchestrator/SKILL.md` no longer carries "If head moved, re-check findings"; it points to the "Head moved" section in place of it and in Round plan step 5, and its line count stays equal to its ceiling. [verify: exec `bun test src/gdskills/review-orchestrator-preflight.test.ts`]
- AC3: The bundled copy and the installed copy of the changed skill files are byte-identical. [verify: invariant `cmp src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md && cmp src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md .metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md`]
- AC4: `divergence-map.md` in this flow folder lists every publish entry point (session `keryx review publish`, Desktop `keryx review desk-publish` via Tauri and the publish dialog) and each point where they diverge (acceptance, receipt, duplicate marker, head check, operator confirmation, body rendering), each with file:line on `origin/main`, and an extraction plan that does not depend on a rounds schema of its own. [verify: judged]
- AC5: `keryx review publish` uses the shared acceptance, receipt and duplicate marker of `desk-publication`; a test publishes the same package twice through the session path and the Desktop path and the second publish is refused as a duplicate. [verify: exec `bun test src/review/publish.test.ts src/review/desk-publication.test.ts`]
- AC6: The session procedure and the Desktop review prompt open the update round with the same command (`keryx review advance` or the name stage 3 gives it); `src/review/autonomous-profile.ts` no longer says "New commits belong to a separate request", and its unattended head-move line (line 200 at a5d1ab236) agrees with the skill's "Head moved" unattended rule (asserted by the preflight test). [verify: exec `bun test src/gdskills/review-orchestrator-preflight.test.ts && ! git grep -q "New commits belong to a separate request" -- src/review`]
- AC7: Real-PR scenario: a review run in a session and published from Desktop. [verify: judged]
- AC8: A diverged PR scopes the merge base to its pinned head, preserves the hosting base identity and retains incremental rounds. [verify: judged]
- AC9: Both entry points associate one review attempt with the actual project session and restore it from the board. [verify: judged]
- AC10: The active review shows the PR, changed file count, file/check rationale and current work in the review UI. [verify: judged]
- AC11: An exact plan needs at most one approval and a finished single-reviewer run exits without full-review nudges. [verify: judged]
- AC12: Both launches are verified against PR 9264 with publication disabled, with evidence of scope and session identity. [verify: judged]
- AC13: Large reviews use higher defaults and a recorded automatic expansion decision within the configured policy. Explicit budgets, changed revisions and manual confirmation are respected. [verify: judged]
- AC14: Each assignment resolves its model tier from the reviewer and its actual scope, honors overrides, and exposes the chosen route and reason. [verify: judged]
