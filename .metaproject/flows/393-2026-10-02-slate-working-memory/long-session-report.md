Long-session quality check (AC6), flow 393 branch on `registry-recall`, next to flow 394's result (`../394-2026-10-02-shell-token-economy/long-session-report.md`: 0/22, 150-call cap hit, 96 repeated reads).

Supersedes the earlier version of this report. The earlier numbers (22/22 in three seeds, 71/147/71 calls, 4/19/4 repeated reads) were measured with a runner that did not run the working-memory path: it had no real slate and did not register the working-memory tools, so those runs measured a degraded mode. The runner now opens a real slate (`ensureSlateOpened`) and fails the run if the frame messages are empty or if `slate_note`, `slate_trail`, `recall_step` or `history_search` are not registered (`assertWorkingMemoryPath` in `scripts/benchmark/long-runner-shared.ts`, covered by `long-runner-turn.test.ts`). The numbers below are from the real path.

Conditions: `bun scripts/benchmark/run-ablation-long.ts --tasks registry-recall --provider openai-codex --model gpt-6.1-sol --seeds <n> --context-window 128000 --only context-on --debug-dir <dir>`, PR #865 code commit `ec89b5c4` (version 0.3.65 then; rebased onto main 0.3.66 and renumbered 0.3.69 afterwards; the benchmarks were not re-run after the rebase), one run per seed, the three seeds started in parallel. The runner refuses to write a fixture for `--only`, so the numbers are the console lines of the three runs; nothing was tuned between them. Each run printed the guard line: frame messages in the final history 2, tools present.

| metric | seed 1 | seed 2 | seed 3 | flow 394 (1 seed) |
|---|---|---|---|---|
| oracle score | 1.00 (22/22) | 1.00 (22/22) | 1.00 (22/22) | 0/22 |
| success | yes | yes | yes | no |
| requests / tool calls | 111 / 110 | 115 / 114 | 105 / 104 | 150 / 150 |
| 150-call cap hit | no | no | no | yes |
| repeated reads after a frame or prune event | 0 | 0 | 0 | 96 |
| distinct files read (of 22), volume check | 22, ok | 22, ok | 22, ok | 22, ok |
| prune / rewrite events | 18 | 20 | 18 | 20 |
| compaction | 0 | 0 | 0 | 0 |
| Trail entries / Notes in the final slate | 110 / 5 | 114 / 2 | 104 / 6 | n/a |
| `slate_note` / `recall_step` / `history_search` calls | 10 / 60 / 9 | 8 / 68 / 7 | 10 / 59 / 3 | n/a |
| uncached input tokens | 1,170,031 | 1,293,446 | 1,104,589 | 2,013,312 |
| total tokens as printed | 2,884,273 | 2,936,069 | 2,574,273 | 11,885,646 |
| output tokens | 5,058 | 5,119 | 4,852 | 7,630 |
| duration | 468 s | 489 s | 442 s | 892 s |

AC6 against the frozen limits (unchanged): oracle at least 0.8 in 3 of 3 seeds (needs 2 of 3); the 150-call cap is never hit (104 to 114 calls); repeated reads average 0.0 per run (limit 10). All three conditions hold on these three runs. Whether AC6 is confirmed is the operator's call, not this report's.

Caveats. Three seeds, one model, one task. The tool-call count is not a measure of savings: the model now recalls through `recall_step` (59 to 68 calls per run). Against the earlier degraded-mode runs, seeds 1 and 3 used more calls (110 and 104 against 71 each) and seed 2 fewer (114 against 147); the cause was not investigated. The "prune / rewrite events" row counts the `onContextCompaction` prune hook, which the working-memory rewrite also fires; it is not comparable one to one with flow 394's prune count. Flow 394's row is its single published run.
