Same-model comparative check (AC9), flow 393 branch, keryx leg re-run on flow 394's task set.

Supersedes the earlier version of this report (mean uncached 6,775, 100% over n=9). That run came from the same runner state as the earlier AC6 numbers, which did not run the working-memory path; the keryx leg has been re-run with the runner fixed (real slate, tools registered, guard on). The codex CLI leg was NOT re-run: its figures are flow 394's, in `../394-2026-10-02-shell-token-economy/comparative-report.md`, unchanged.

Conditions: `bun scripts/benchmark/run-ablation-mutating.ts --provider openai-codex --model gpt-6.1-sol --seeds 1,2,3` (three tasks, three seeds, context-on and context-off), PR #865 code commit `ec89b5c4` (version 0.3.65 then; rebased onto main 0.3.68 and renumbered 0.3.69 afterwards; the benchmarks were not re-run after the rebase). The runner writes a tracked fixture; the new one was kept out of the tree and the tracked fixture was restored, so nothing under `fixtures/` changed.

context-on, uncached input per run (tokens):

| task | seed 1 | seed 2 | seed 3 |
|---|---|---|---|
| atomic-json-write | 5,026 | 5,052 | 6,768 |
| flag-present | 6,102 | 7,121 | 7,125 |
| read-text-file-or | 21,030 | 12,499 | 14,203 |

| harness | model | variant | mean uncached input | success |
|---|---|---|---|---|
| keryx, this branch | gpt-6.1-sol | context-on | 9,436 | 100% (n=9) |
| keryx, this branch | gpt-6.1-sol | context-off | 9,159 | 100% (n=9) |
| keryx, flow 394 | gpt-6.1-sol | context-on | 12,628 | 100% (n=9) |
| codex CLI, flow 394 (not re-run) | gpt-6.1-sol | context-on | 35,199 | 100% (n=9) |

AC9 against the frozen limit (unchanged): the context-on mean of 9,436 is below 12,628 x 1.05 = 13,259, and success is 100%, not below 100%. The numbers satisfy the criterion as written. Whether AC9 is confirmed is the operator's call, not this report's.

Caveats. The uncached figure depends on the provider's prompt cache: on this branch's context-on runs the cache served 1,792 to 20,864 tokens per run (mean 6,713), while flow 394's run recorded 0 cached, so part of the drop from 12,628 to 9,436 is cache state and not an effect of this flow. Context-on is slightly above context-off on this branch (9,436 against 9,159), within the run-to-run spread; `read-text-file-or` seed 1 used 21,030 uncached. The codex CLI leg was not re-run, so the cross-harness comparison rests on flow 394's figure. These tasks are three requests long; whether a working-memory rewrite fired in them was not measured. The long-session path is measured by AC6.
