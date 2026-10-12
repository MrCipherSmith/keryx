## Token economy, context-on arm

Mean tokens per task run and success rate, per harness and model

| harness | model | variant | mean uncached input | mean cached input | mean output | mean requests | success |
|---|---|---|---|---|---|---|---|
| keryx | gpt-6.1-sol | context-on | 12628 | 0 | 942 | 3 | 100% (n=9) |
| codex | gpt-6.1-sol | context-on | 35199 | 139079 | 490 | n/a | 100% (n=9) |

Gaps (reported as n/a, never estimated):
- codex/gpt-6.1-sol: request count not reported by the harness for every run

AC10: met — keryx lowest or within 5% of lowest on mean uncached input tokens per task: keryx/gpt-6.1-sol 12628 vs lowest 12628 (keryx/gpt-6.1-sol), +0.0%
AC11: met — success 100% vs baseline 100%; repeated identical reads after compaction/prune 0 vs baseline 0 (all repeats 0 vs 0)

## Token economy, context-off arm

Mean tokens per task run and success rate, per harness and model

| harness | model | variant | mean uncached input | mean cached input | mean output | mean requests | success |
|---|---|---|---|---|---|---|---|
| keryx | gpt-6.1-sol | context-off | 11419 | 0 | 794 | 3 | 89% (n=9) |
| codex | gpt-6.1-sol | context-off | 23657 | 101447 | 482 | n/a | 100% (n=9) |

Gaps (reported as n/a, never estimated):
- codex/gpt-6.1-sol: request count not reported by the harness for every run

AC10: met — keryx lowest or within 5% of lowest on mean uncached input tokens per task: keryx/gpt-6.1-sol 11419 vs lowest 11419 (keryx/gpt-6.1-sol), +0.0%
AC11: not met — success 89% vs baseline 100%; repeated identical reads after compaction/prune 0 vs baseline 0 (all repeats 0 vs 0)
