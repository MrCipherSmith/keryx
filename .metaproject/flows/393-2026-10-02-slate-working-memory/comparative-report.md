Same-model comparative check (AC9), flow 393 branch, keryx leg re-run on flow 394's task set.

Conditions: `bun scripts/benchmark/run-ablation-mutating.ts --provider openai-codex --model gpt-6.1-sol --seeds 1,2,3` (three tasks, three seeds, context-on and context-off), branch head of PR #865 (0.3.65). Only the keryx leg was re-run; the codex CLI figures below are flow 394's, in `../394-2026-10-02-shell-token-economy/comparative-report.md`, unchanged. The runner writes a tracked fixture; the new one was kept out of the tree and the tracked fixture was restored, so nothing under `fixtures/` changed. These short tasks do not opt in to `pruneArchive`, so they do not run the working-memory request; what changed for them is the `shell_exec` result shape.

context-on, uncached input per run (tokens):

| task | seed 1 | seed 2 | seed 3 |
|---|---|---|---|
| atomic-json-write | 7,304 | 4,925 | 4,978 |
| flag-present | 4,247 | 4,247 | 4,249 |
| read-text-file-or | 10,019 | 10,984 | 10,020 |

| harness | model | variant | mean uncached input | success |
|---|---|---|---|---|
| keryx, this branch | gpt-6.1-sol | context-on | 6,775 | 100% (n=9) |
| keryx, flow 394 | gpt-6.1-sol | context-on | 12,628 | 100% (n=9) |
| codex CLI, flow 394 | gpt-6.1-sol | context-on | 35,199 | 100% (n=9) |

AC9: met. 6,775 is below 12,628 x 1.05 = 13,259, and the success rate is 100%, not below 100%. Context-off on this branch also succeeded 9 of 9 (flow 394 had 89%).

Caveat: the uncached share depends on the provider's prompt cache. In this run the cache served part of the prefix on eight of the nine context-on runs (`cachedIn` 1,920 to 23,680), while flow 394's run recorded 0 cached, so the drop from 12,628 to 6,775 is mostly cache state and not an effect of this flow. Total input (cached + uncached) per run is the like-for-like figure and is in the console output the fixture was built from; the claim made here is only that the branch does not exceed flow 394's uncached figure by more than 5% and does not lose success.
