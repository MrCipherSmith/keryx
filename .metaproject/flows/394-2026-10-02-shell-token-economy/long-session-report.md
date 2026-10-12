Long-session quality check (AC11), branch vs main on `registry-recall`: NOT MET on the oracle, and not a win for the branch. Both sides scored 0/22, so there is no quality loss relative to main, but also no demonstrated quality.

Conditions: `bun scripts/benchmark/run-ablation-long.ts --tasks registry-recall --provider openai-codex --model gpt-6.1-sol --seeds 1 --context-window 128000 --only context-on`, one run per side. The main run used `--label baseline-main`, a temporary worktree of origin/main (47be3121) with this branch's `scripts/benchmark/` copied in. Main's `AgentDeps` honours `contextWindow` (src/commands/agent.ts), and the runner passes the same 128000 to both sides, so main compacted on the same trigger (85% of 128K). The runner refuses to write a fixture for fewer than 3 seeds and `--only` writes none, so all numbers below come from console output and the per-run debug files.

One adaptation on the main side: the copied `long-runner-shared.ts` imports `exceedsSpillThreshold` from `src/harness/tool/output-spill`, which does not exist on main. It was replaced in the temp copy by a stub returning false, so main's spill count of 0 is by construction (main has no spill).

| metric | branch (HEAD, T24) | main |
|---|---|---|
| oracle score / success | 0/22, false | 0/22, false |
| oracle failure | answer.json missing (22 missing) | answer.json missing (22 missing) |
| requests / tool calls | 150 / 150 | 50 / 49 |
| tool-call cap (150) hit | yes | no |
| how the turn ended | cap, final text empty | model replied DONE with no answer.json |
| distinct files read (of 22) / volume check | 22 / ok | 10 / not ok |
| repeated reads, total after prune or compaction | 96 | 1 |
| refused calls (repeat guard) | not recorded by the runner | not recorded by the runner |
| uncached input tokens | 2,013,312 | 2,225,574 |
| total tokens (cached + uncached, as printed) | 11,885,646 | 2,488,207 |
| output tokens | 7,630 | 3,177 |
| tool output tokens (est.) | ~522,565 | ~124,431 |
| prune / compaction | 20 / 0 | 0 / 1 |
| collapsed / cleared / spill | 133 / 0 / 1 | 0 / 0 / 0 (no such mechanisms) |
| reasoning-replay trims | 4 | 17 (counter as printed) |
| duration | 892 s | 329 s |
| context window | 128000 | 128000 |

Earlier T22c branch runs on this task, for context (before the T24 repeat-guard fix): at 96K and at 128K each scored 0/22, hit the cap, and showed 84 repeated reads. The T24 build at 128K is the first row above: still 0/22, still capped, and repeated reads rose from 84 to 96.

Reading. The task did not discriminate quality in this configuration. Main stopped early: it read 10 of 22 files, compacted once, and declared DONE without writing answer.json, so it scored 0 by giving up rather than by losing information. The branch read all 22 files (volume check passed) but kept re-reading them after each prune (96 repeated reads, 20 prunes, 133 collapsed results), burned all 150 tool calls and never produced answer.json either. The T24 repeat-guard fix did not change that outcome. The branch's behaviour is the more expensive failure: roughly 5x the total tokens, about 2.7x the wall time, and 3x the requests of main, for the same 0/22. Uncached input is similar on both sides (2.0M vs 2.2M), so the extra volume on the branch is cached re-sends. This single seed does not show the branch losing quality against main, but it also does not show the long-session machinery helping: pruned results are re-read in a loop on this model instead of the answer being assembled, and AC11 should not be claimed as satisfied on this evidence. Single seed, single model, one run per side; no thresholds or task were tuned.
