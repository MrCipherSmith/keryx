Long-session quality check (AC6), flow 393 branch on `registry-recall`, next to flow 394's result (`../394-2026-10-02-shell-token-economy/long-session-report.md`: 0/22, 150-call cap hit, 96 repeated reads).

Conditions: `bun scripts/benchmark/run-ablation-long.ts --tasks registry-recall --provider openai-codex --model gpt-6.1-sol --seeds <n> --context-window 128000 --only context-on --debug-dir <dir>`, branch head of PR #865 (0.3.65), one run per seed. Seed 1 was the first run of the command (labelled `probe-393`, same flags, seed 1 only); seeds 2 and 3 were one invocation. The runner refuses to write a fixture for `--only`, so the numbers are the console lines of the three runs and nothing was tuned between them. The runner opts in with `longTurnOptions` (`pruneArchive`, live session directory), which makes it a working-memory host.

| metric | seed 1 | seed 2 | seed 3 | flow 394 (1 seed) |
|---|---|---|---|---|
| oracle score | 1.00 (22/22) | 1.00 (22/22) | 1.00 (22/22) | 0/22 |
| success | yes | yes | yes | no |
| requests / tool calls | 72 / 71 | 148 / 147 | 72 / 71 | 150 / 150 |
| 150-call cap hit | no | no (3 calls under) | no | yes |
| repeated reads after a frame or prune event | 4 | 19 | 4 | 96 |
| distinct files read (of 22), volume check | 22, ok | 22, ok | 22, ok | 22, ok |
| prune / rewrite events | 14 | 29 | 14 | 20 |
| compaction | 0 | 0 | 0 | 0 |
| uncached input tokens | 1,018,605 | 2,124,816 | 1,068,474 | 2,013,312 |
| total tokens as printed | 1,242,856 | 2,854,455 | 1,303,544 | 11,885,646 |
| output tokens | 6,779 | 16,167 | 6,590 | 7,630 |
| duration | 457 s | 957 s | 425 s | 892 s |

AC6 reading: oracle at least 0.8 in 3 of 3 seeds (needs 2 of 3), the cap is never hit, repeated reads average (4 + 19 + 4) / 3 = 9.0 per run (limit 10). All three conditions hold.

Caveats. Seed 2 is the weak run: it needed 147 of 150 calls and 19 repeated reads, so the margin on the cap and on the repeated-read average rests on seeds 1 and 3 (71 calls, 4 repeats each). Three seeds, one model, one task; the average of 9.0 is under the limit by one read, and a fourth seed like seed 2 would take it over. Flow 394's row is its single published run. The "prune / rewrite events" row counts the `onContextCompaction` prune hook, which the working-memory rewrite also fires; it is not comparable one to one with flow 394's prune count.
