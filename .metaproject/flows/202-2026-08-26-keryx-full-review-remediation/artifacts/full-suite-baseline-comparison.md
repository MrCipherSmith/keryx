# Full-Suite Baseline Comparison

Version: 1.0.0
Date: 2026-08-26

## Results

| Run | Passed | Failed | Skipped | Total | Files |
|---|---:|---:|---:|---:|---:|
| Pre-change baseline | 5325 | 49 | 18 | 5392 | — |
| First post-change run | 5370 | 50 | 18 | 5438 | 467 |
| Final post-fix run | 5372 | 48 | 18 | 5438 | 467 |

The first post-change run introduced one new failure identity:
`an external dispatch marks every sidebar upsert with its runtime and agent`.
The production implementation correctly moved fleet events behind an injected
sink; the older test still listened through the removed global TUI bridge. The
test was updated to inject `onFleetEvent`, and its focused suite then passed
14/14.

The final run contains no failure identity added by that fix. Comparing the
normalized failure names from the first and final post-change runs removed:

- the fleet event test above; and
- the pre-existing, timing-sensitive event-log test `an event log past the
  CONFIG bound reads back whole`, which passed in the final run.

No new failure identity appeared in the final run. The remaining 48 failures
are in the same pre-existing project-registry, serve/listener, session export,
and session-fork families recorded by the baseline. The changed-scope focused
suites are green.

## Evidence

- Full final run: `.metaproject/data/gdctx/raw/2026-08-26T05-55-42-425Z_run.log`
- Compact summary: `.metaproject/data/gdctx/artifacts/2026-08-26T05-55-42-425Z_run.md`
- First post-change run: `.metaproject/data/gdctx/raw/2026-08-26T05-49-16-227Z_run.log`
- Focused fleet suite: 14 passed, 0 failed, 40 expectations.
