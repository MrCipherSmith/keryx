# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A new pure module (`src/harness/routing/task-cost.ts`) records one `TaskCostRecord` (provider id, model id, optional routing category, input/output tokens, optional cost in USD, success) per finished task, keyed by `(providerId, modelId, category)`, and exposes a pure aggregation (`statsForKey`/`allStats`/`statsFor`) computing `n`, median tokens per task, median cost per task (when cost is known), and success rate — proven by hermetic unit tests with no fs/network access.
- AC2: The store persists under the keryx per-user data dir (`ensureKeryxSubdir`/`writeOwnerOnlyFileAtomic`, mirroring `src/lib/config-dir.ts`'s existing 0600 convention) as a bounded rolling window per key (oldest records dropped past a fixed cap), and a read of a missing/corrupt file degrades to an empty store rather than throwing.
- AC3: `keryx shell`'s real interactive turn loop (`src/tui/tui-shell.ts`, the production `runAgentTurn` dispatch) records one `TaskCostRecord` per finished turn — provider/model from the live session, summed input/output tokens for that turn only (not the session's cumulative counter), and `success` derived from the same turn-failure signal the shell already computes (the `[error]`/`[budget]`/`[stopped]` system-line detector) — proven by a test that drives a real turn and asserts a record lands in the store.
- AC4: `src/harness/routing/derive-default-table.ts`'s `deriveDefaultTable` gains an optional pure `TaskCostLookup` parameter (stats passed in, never read from disk inside the function). The existing step-down rule (`pickStepDown`) still decides by default; only when BOTH the step-down candidate and the stronger candidate have `n >= 20` measured tasks in that category AND both have a known median cost per task does the comparison apply — and only then, if the step-down (lighter) candidate's median cost per task is NOT strictly lower, the stronger candidate is used instead for that category.
- AC5: The cost-override rule (AC4) is documented inline in `derive-default-table.ts` (why it exists, the evidence bar, what "the stronger one" means) and covered by pure unit tests: below the evidence bar keeps the structural pick, at/above the bar with the lighter model actually cheaper keeps the structural pick, at/above the bar with the lighter model not cheaper flips to the stronger candidate.
- AC6: `keryx routing stats [--json]` (new subcommand in `src/commands/routing.ts`) prints every recorded `(provider, model, category)` key's `n`, median tokens, median cost (or "unknown"), and success rate, sorted deterministically; `--json` emits the same data as structured JSON. Documented in `docs/docs/cli-reference.md`, `src/standard/help-groups.ts` (or its current equivalent), and `docs/docs/commands-by-task.md`.
- AC7: `/routing` (`src/tui/routing-inspector.ts`) shows the per-task median cost next to a category row whose resolution came from the `derived` layer, when a matching stats entry exists — omitted (unchanged row text) when no stats are recorded yet, proven by a test.
- AC8: `bun run typecheck`, the project lint command, `src/harness/routing/task-cost.test.ts`, `src/harness/routing/derive-default-table.test.ts`, the touched `src/tui/tui-shell.test.ts`/`src/commands/routing.test.ts` (or new equivalents), and `bun ./scripts/opentui-tests-no-skips.ts src/tui` all pass.
- AC9: A live check is recorded in the flow journal: either real `keryx shell --print`/harness turns produced at least one on-disk `TaskCostRecord` (inspected without printing any credential/key), or a seed from existing usage/session data plus `keryx routing stats` output is captured — showing the command's real output.
- AC10: The branch merges cleanly with `origin/main` immediately before push (conflicts resolved keeping both sides' intent), touches no files owned by the parallel Jev-triage or Claude-subagent-alias work (`src/review`, `src/commands/review.ts`, orchestrator skills, `src/agents/compile*`), and a PR is opened (not merged) with a description matching the change.
