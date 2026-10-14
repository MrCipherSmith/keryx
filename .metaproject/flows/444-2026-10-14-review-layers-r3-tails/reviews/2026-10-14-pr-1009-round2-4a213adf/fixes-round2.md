# Round 2 fixes — PR 1009 (head 4a213adf)

| Id | Severity | Disposition | What changed |
|----|----------|-------------|--------------|
| R2-00 | minor | fixed | `makeLayersRefreshRunner` treats a maxBuffer error as its own case (`killed` is not set for it under Bun) and only calls a kill a timeout when `killed` is true and the wall clock agrees. New test floods stdout past 16 MiB and expects the "more output than the limit" message. Kills r2-maxbuffer-misreported-as-timeout (checked by manual mutation). |
| R2-01 | minor | fixed | `layers-signal.test.ts`: SIGTERM while the checkout removal hangs still ends the process by the signal and frees the lock. Kills r2-signal-bound-removed (checked by manual mutation). |
| R2-02 | minor | fixed | New `layers-view.test.ts` pins the retry hint on a failed graph and its absence on other statuses. |
| R2-03 | minor | fixed | `--force` added to the `layers block` line of the main usage text. |

Question not filed (AC1 "recover" phase): the existing phase "the sweep that follows the lock" is kept as the nearest point; no code change.

Verification: the three touched test files pass (24 tests); the full check is left to CI.
