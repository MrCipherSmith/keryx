# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `review-context.schema.json` types `pr` with at least `number`, `url`, `title`, `body` and `state` properties; a `review_context` whose `pr.body` is a non-string fails `validateJson`, where before the change it passed.
- AC2: `review-context.schema.json` declares `cross_repo` as an array whose items require `repo`, `reason` and `facts`, and carry `state`, `pr`, `branch` and `merge_order`; an item missing `repo` fails `validateJson`.
- AC3: A `cross_repo` item with `state: "merged"` and no `sha` fails validation, and one with `state: "open"` and neither `pr` nor `branch` fails validation; both shapes with their required field present pass.
- AC4: Every JSON-schema keyword used by `review-context.schema.json` and `reviewer-finding.schema.json` is in the set the validator in `src/gdskills/contracts.ts` implements, asserted by a test that scrapes the validator source rather than hand-listing the set.
- AC5: `reviewer-finding.schema.json` accepts a `repo` on a finding, and a finding carrying `repo` validates clean.
- AC6: The Step 1 checklist line in `review-orchestrator/SKILL.md` names the PR description, memory, and cross-repo contracts.
- AC7: `review-orchestrator/SKILL.md` states that a change whose producer is recorded `state: open` with `merge_order: producer_first` is a `blocker` when it can merge first, and that this is distinct from the existing `minor` for a missing deploy note.
- AC8: `review-orchestrator/SKILL.md` requires `cross_repo` entries with `state: "open"` to be re-read each round rather than pinned once.
- AC9: The Stage 1 gate section states that when no `issue_url` or task doc is available the PR body is the spec source, and names the gate as the owner of the description-vs-diff comparison.
- AC10: The installed copy under `.metaproject/skills/gdskills/review/review-orchestrator/` is byte-identical to `src/gdskills/bundled/skills/review/review-orchestrator/` for every file this flow changes.
- AC11: `bun test --timeout 30000` passes on the branch, and `bun run typecheck` (or the repo's declared type gate) reports no new errors.
