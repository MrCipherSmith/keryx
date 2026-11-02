# Delivery regression tests: RED

Command: `keryx ctx run -- bun test src/hub/delivery-queue.test.ts src/hub/git-delivery.test.ts` (configured Bun preload). Exit 1: 27 pass, 2 fail, 188 assertions. Both failures are the expected R03-L6-001 reviewer 403 before the adapter begins. Raw run: `.metaproject/data/gdctx/raw/2026-11-02T12-43-33-526Z-db4989_run.log`.

Files changed: `src/hub/delivery-queue.test.ts`, `src/hub/git-delivery.test.ts`. No production code changed. Tests run against 7e7179a8.

| Finding | Test / assertion |
|---|---|
| R03-L6-001 | `reviewer may publish while recovery routes remain operator-only and publication reauthorizes after Git`; `reviewer authority is rechecked after publication and its result remains recoverable`. Both RED at reviewer rejected before adapter. |
| testing-practices-w5:F-002 | `settle waits for an external Git delivery to persist its result before shutdown`: gated adapter, subprocess exit before release, completed durable job after settle. |
| W2-002 | `at most two independent publication inspections may run concurrently`: two gated inspections and third rejected 503. |
| W2-003 | `operator archives completed jobs at the audit cap without losing exact reads replay or external facts`: malformed fresh key gives exact 400 and unchanged job. |
| W2-004 | `inspection refuses a managed branch that changes between remote observation and fetch`: different fetched SHA, no Git writes. |
| W2-006 | `external Git delivery never holds the global mutation queue and same-key retry never starts it twice`: pending retry 202 and one adapter call before gate release. |
| W2-008 | `delivery list retains old active jobs ahead of more than fifty completed jobs`. |
| W2-009 | `reconciliation advances the exact job version and rejects stale archive CAS`. |

The seven named mutant anchors and replacements were inspected in the supplied `mutants.json`; mutants were not executed because this phase forbids production edits. The test designs target each exact replacement; mutation kill remains unverified. The reviewer role tests require both initial and post-effect authorization fixes before they can exercise their remaining assertions.

Routing: graph_used yes (reported stale due to untracked node_modules; no code changes before graph call), wiki_used not-relevant (targeted behavioral regression), ctx_used yes, raw_rg_used no.
