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

- AC1: The review blast radius follows changed exported symbols: importers that do not use a changed symbol are not reached, barrels pass through to real consumers, high fan-in hubs are damped, and a parse failure or non-export change falls back to the file edge. Fixture tests cover barrel, hub, body-edit and fallback cases. [verify: exec `bun test src/gdgraph/symbol-reach.test.ts`]
- AC2: Graph-related files that are not consumers of a changed contract are recorded as reasoned omissions (reason + detail) instead of mandatory chunks; chunks are planned only for cap drops; coverage counts them as omitted and readiness item 2 does not fail on them. · sensitive: revert [verify: exec `bun test src/review/blast-radius.test.ts src/review/chunks.test.ts src/review/readiness.test.ts src/review/coverage-complete.test.ts`]
- AC3: Implicit consumers via string keys, event names, CSS classes and config keys changed in the diff are found by text search and added to the radius; keys with too many hits are recorded as hub omissions. [verify: exec `bun test src/review/text-links.test.ts`]
- AC4: Slices carry roles chosen from their content; review-logic is on every slice; every slice has at least one role; role ownership, the ledger and coverage honour slice roles while every changed line is still read by at least one role. [verify: exec `bun test src/review/slice-routing.test.ts src/review/waves.test.ts`]
- AC5: Slices get depth by risk (deep = full core set on a risk class, high reach or Jev ≥ 0.7; light otherwise); a deterministic 10-15% audit sample of light slices runs deep; a major-or-worse finding on a light slice re-opens it deep. · sensitive: failure-scenario [verify: exec `bun test src/review/slice-routing.test.ts src/review/retry-plan.test.ts`]
- AC6: `review estimate` flags an over-threshold plan; dispatch-check and ledger refuse such a plan until a plan confirmation is recorded, which only the `review_confirm_plan` card (keryx shell) or a TTY command records. · sensitive: failure-scenario [verify: exec `bun test src/review/estimate.test.ts src/review/dispatch-check.test.ts src/commands/operator-confirm-review-tools.test.ts`]
- AC7: Fixed: wave bytes are never NaN (a manifest without sizes is refused); chunk halves record real sizes; blast-radius changed files come from base...pinned head; layers base comes from the PR base with a stated fallback. [verify: exec `bun test src/review/slice.test.ts src/review/chunks.test.ts src/commands/review-blast-radius-base.test.ts`]
- AC8: Harness robustness: results and drivers live per package; wave bytes per host; the autonomous prompt passes scope/package and runs one round unless the head moved; attended is derived from mode, and `chunks estimate --mode automatic` / `publish --yes` cannot bypass the operator; mutation waiver, reviewer-set override and `comments reply --final` need a card or TTY; item 10 says "not observable" outside keryx shell; trigger reviews route to the autonomous runner; verification commands can run in the parent and reach the verifier as context; installed host skill copies older than bundled are warned about. [verify: exec `bun test src/review/harness-robustness.test.ts`]
- AC9: The review-orchestrator skill (both copies, ≤ 1615 lines) has a host table, persistence and ledger rules for every host, a Codex/other-host path that does not end BLOCKED, the new planning steps, verifier-commands-via-parent, review_wave/timeout guidance, and none of the stale lines found by the audit. [verify: invariant `bun test src/gdskills/`]
- AC10: `keryx review plan-eval` compares old and new plans offline: on review-418 and the four eval PRs every ground-truth blocker/major lands in a slice assigned to its reviewer or a deep slice under the new plan, and the new plan needs at least 50% fewer dispatches plus chunks on the two largest diffs. [verify: exec `bun test src/review/plan-eval.test.ts`]
- AC11: Live evaluation: new-plan review rounds with subagents on keryx #424, #939, #940 and #1005, scored against their ground truth, find at least as many known blocker/major defects as the old rounds (target: more), with dispatches, time and new confirmed findings recorded in this flow's eval report. [verify: judged]
- AC12: The repository stays green: typecheck, lint and the core test suite pass on the PR head (CI). [verify: invariant `bun run typecheck && bun run lint && bun run test:core`]
- AC13: Patch release 0.3.119 with this flow is published to npm and recorded in journal.md. [verify: exec `npm view @mrciphersmith/keryx version`]
- AC14: Owner's next large-PR review on the release plans tens, not hundreds, of dispatches, needs no mandatory graph chunks for unaffected files, and completes. [verify: judged]
