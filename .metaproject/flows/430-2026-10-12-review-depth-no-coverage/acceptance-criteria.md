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

- AC1: `retry-plan` reads a result's `slices` whether each entry is an id string or an object with an `id`; a result listing all assigned slices as objects is `accepted`, not `not-run`; a mixed list counts every id once; an entry without a usable id is ignored and named in the plan's `reason`. A test per shape asserts the decision and the `covered` set. [verify: exec `bun test src/review/slice-dispatch.test.ts src/review/ledger.test.ts`]
- AC2: The reviewer output contract defines `slices` (id strings, or objects with an `id` and an optional coverage note) in `reviewer-finding.schema.json`, and the orchestrator skill's dispatch step asks reviewers for that shape; the bundled and the project copy of both files are identical. [verify: exec `bun test src/gdskills src/review/completion-gate.test.ts`]
- AC3: The orchestrator skill documents `drivers/<reviewer>.json` with the top-level `definition` key that `ledger build` reads, and `ledger build` also resolves the rule file from `skill_path` (top level or inside `payload`); a driver file shaped as the live run wrote it resolves, and a missing definition is still a named gap. A test reads drivers of both shapes. [verify: exec `bun test src/commands/review-ledger.test.ts src/review/ledger.test.ts`]
- AC4: A file in the raw directory with no `REVIEW_RESULT` block that no driver names and that is not named after a dispatched reviewer is reported by `ledger build` in `ignored` as `set aside: …` and is never deleted; a file that holds a `REVIEW_RESULT` block, or is named by a driver, still blocks until reconciled. A test asserts both. [verify: exec `bun test src/commands/review-ledger.test.ts`]
- AC5: The CLI reference describes the `slices` shapes, the driver file and the set-aside rule; a CHANGELOG entry under Unreleased names the three fixes; `bun run typecheck` and `bun run lint` pass. [verify: exec `bun run typecheck && bun run lint`]
- AC6: Nothing in this flow changes the tier resolution, the blast-radius cap or a reviewer's tools. The branch touches no file under `src/review/blast-radius.ts` or `src/gdskills/model-tier.ts`. [verify: invariant `git diff origin/main --name-only -- src/review/blast-radius.ts src/gdskills/model-tier.ts | wc -l | grep -qx 0`]
