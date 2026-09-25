# Flow Journal

- 2026-09-25T19:41:15.605Z - flow created
- 2026-09-25T19:47:04.291Z - frozen: 10 criteria; checksum recorded
- 2026-09-25T19:47:07.439Z - started
- 2026-09-25T20:01:00.000Z - AC9 live check: seeded 3 real `TaskCostRecord`s
  through `appendTaskCostRecord` into the REAL per-user data dir
  (`~/.local/share/keryx/routing/task-cost.json`, no test seam), then ran
  `bun src/cli.ts routing stats` and `--json` against it. Text output:
  `anthropic/claude-haiku-4.5  [default]  n=1  median 5900 tok/task  unknown/task  0% success`
  `anthropic/claude-sonnet-5  [subagents]  n=2  median 13250 tok/task  $0.07/task  100% success`
  `--json` gave the matching structured rows (medianCostUsd 0.0747 for the
  sonnet/subagents key, no `medianCostUsd` key at all for the haiku/default
  key — cost genuinely unknown, never fabricated). Verified the file was
  written 0600 (`stat -c "%a %n"`). No credential/key anywhere in the store
  or the output (it holds only ids, token counts, a derived cost, and a
  boolean). Seed data removed afterward — the operator's real data dir is
  clean again (verified with a follow-up `routing stats` reading "no
  measured tasks recorded yet").
- 2026-09-25T20:03:10.814Z - task-done: T1: Collect remaining context
- 2026-09-25T20:03:11.139Z - task-done: T2: Implement per plan
- 2026-09-25T20:03:11.450Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-25T20:03:21.865Z - ac-confirmed: AC1: src/harness/routing/task-cost.ts: TaskCostRecord + statsForKey/allStats/statsFor, keyed by (providerId,modelId,category); 26 hermetic pure-function tests in task-cost.test.ts, no fs/network (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T20:03:22.193Z - ac-confirmed: AC2: readTaskCostStore/writeTaskCostStore/appendTaskCostRecord via ensureKeryxSubdir(['routing'])+writeOwnerOnlyFileAtomic (0600), MAX_SAMPLES_PER_KEY=200 rolling window; missing/malformed file degrades to {} (tested) (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T20:03:22.522Z - ac-confirmed: AC3: tui-shell.ts wraps io.onUsage per turn to sum THIS turn's tokens, calls recordTurnTaskCostBestEffort in the .finally() with success=!turnFailed; behavioral test in tui-shell.test.ts + wiring pin in task-cost-shell-wiring.test.ts (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T20:03:22.849Z - ac-confirmed: AC4: deriveDefaultTable gains optional taskCostLookup; preferByMeasuredCost applies only when n>=MIN_MEASURED_TASKS(20) on both sides and both medianCostUsd known, and only flips to the stronger candidate when the lighter one is NOT strictly cheaper (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T20:03:23.202Z - ac-confirmed: AC5: rule documented inline in derive-default-table.ts (preferByMeasuredCost doc comment); 6 dedicated tests: below-bar, at-bar-cheaper, at-bar-not-cheaper, equal-cost, unknown-cost, no-lookup (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T20:03:31.308Z - ac-confirmed: AC6: keryx routing stats [--json] added to src/commands/routing.ts; docs updated in cli-reference.md, help-groups.ts, commands-by-task.md (regenerated); 4 CLI tests in routing.test.ts (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T20:03:31.652Z - ac-confirmed: AC7: describeTaskCostSuffix + formatRoutingListLines threading in routing-inspector.ts; shown only for source==='derived' with known stats; 5 tests in routing-inspector.test.ts (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T20:03:31.995Z - ac-confirmed: AC8: bun run typecheck clean, bun run lint clean, task-cost.test.ts (26 pass), derive-default-table.test.ts (35 pass), tui-shell.test.ts (159 pass), routing.test.ts (32 pass), routing-inspector.test.ts + task-cost-shell-wiring.test.ts (20 pass), scripts/opentui-tests-no-skips.ts src/tui (1320 pass, 0 skipped) (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T20:03:36.320Z - ac-confirmed: AC9: live check recorded in flow journal 2026-09-25T20:01: real appendTaskCostRecord seed into the real per-user data dir, keryx routing stats + --json against it, verified 0600, then cleaned up (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
