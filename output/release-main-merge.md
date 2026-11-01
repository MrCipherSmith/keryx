# Main integration: fixture conflict and focused regression evidence

STATUS: DONE

Resolved only `src/hub/remote-v2/fixture.test-support.ts`: retained main's read-only `hubRun` helper and the managed-work branch's `workManagement` fixture override. No source implementation was discarded. No commit or staging performed by this worker.

The auto-merged native control/result paths retain managed-work admission/reservation and legacy conversion guards while adding main's run-result invalidations. Main's refused-run/lost-run terminal fixes remain present.

Executed with standard Bun preloads and `--no-env-file` through `keryx ctx run`:

```sh
bun --no-env-file test src/hub/remote-v2/run-lifecycle.network.test.ts src/hub/remote-v2/results.network.test.ts src/hub/remote-v2/recovery.network.test.ts src/hub/remote-v2/queue-admission.network.test.ts src/hub/remote-v2/queue-replacement.network.test.ts src/hub/remote-v2/terminal-cessation.network.test.ts src/hub/remote-v2/lifecycle-authority.network.test.ts src/hub/work/execution.test.ts
```

Result: **28 pass, 0 fail, 720 assertions across8files**. The exact observed behaviors include new refused/lost run finalization and browser invalidation, original managed run binding, pending queue reservation, revoked/unknown allocation refusal and delayed queue admission refusal without replacement allocation. `git diff --check` for the resolved fixture passed.

Raw evidence: `.metaproject/data/gdctx/raw/2026-11-01T13-26-57-370Z-75ea60_run.log`.

Scope limit: focused merged-regression evidence, not a final release/full-project gate or production migration result. No server, dependency, release, credentials or other worker-owned changes made.

Routing: index/testing context read; graph_used=yes (affected fixture orientation, explicitly predates merge); wiki_used=not-relevant (bounded fixture resolution, no architecture inference); ctx_used=yes (read/search/run); raw_rg_used=no.
