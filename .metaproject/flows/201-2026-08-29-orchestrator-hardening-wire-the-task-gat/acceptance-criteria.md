# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `complete()` in `src/flow/service.ts` runs a fifth gate that calls the existing `taskGateStatus()` and fails when any task is non-terminal. Proven by a test that drives a flow to completion with one open task and asserts the gate fails — not by inspection of the code.
- AC2: The gate is opt-in for existing packages (via `schemaVersion` or a config key), so the 24 historically-completed flows carrying an unfinished task (34 tasks between them) are not retroactively invalidated by a version bump. Proven by a test over a pre-existing package.
- AC3: The treatment of a `skipped` task disposition is decided explicitly, implemented, and the decision recorded in `journal.md` with its reason. A `skipped` task without a recorded reason does not pass the gate.
- AC4: The claim in `flow-orchestrator/SKILL.md` that `flow complete` gates on tasks is removed or corrected in the **same commit** that lands AC1. Verified by `git show` on that commit touching both files.
- AC5: `findings.json` written by a review round validates against `review-finding.schema.json`, carrying `confidence`, `evidence`, `impact`, `suggested_fix` and the real originating `reviewer`. Proven by schema validation in a test, not by reading the emitted file.
- AC6: A round-2 `reviewer-input` with `is_fix_round: true` can be constructed from a round-1 artifact and validates against `reviewer-input.schema.json`. This is the operation that is impossible today; the test must perform it end to end.
- AC7: The Markdown parsing path still reads a pre-existing legacy review report without error, so existing artifacts are not stranded. Covered by a test using a real artifact.
- AC8: `keryx flow task attempt <id> <Tn> --outcome started|failed|blocked` increments the existing `attempts.count` and appends to `attempts.log` in `flow.json`, through the CLI only.
- AC9: The attempt count survives a simulated session restart: a counter read after re-loading the flow package returns the persisted value, not zero.
- AC10: `flow-orchestrator/SKILL.md` Phase 0 contains a State Resumption Check equivalent to `job-orchestrator` §0.0, and the orchestrator reads `attempts.count` from flow state rather than from its own context.
- AC11: Three dead-surface items are removed and one is corrected: the `--greptile` flag and its routing are gone; the `src/**/*.ts` → `review-frontend-conventions` auto-detect rule is narrowed to genuine frontend signals; the unconditional legacy-profile prompt is gone. The `FAILED` status is NOT removed — it is reachable via `src/harness/child/contract.ts`/`parseChildResult` and covered by `spawn.test.ts:505`; instead `subagent-status-protocol.md` is corrected to describe five statuses and to name which worker family can emit `FAILED`. Verified by search returning no remaining references to the removed items outside changelog history.
- AC12: Every skill-file edit in this flow lands in **both** `src/gdskills/bundled/skills/` and `.metaproject/skills/gdskills/`, verified by a diff showing the two copies agree.
- AC13: `bun run typecheck` is clean, `bun test` has no new failures against the pre-flow baseline, and `bun run check:doc-links` reports 0 broken.
