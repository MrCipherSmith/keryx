# Delivery fixes: green

Authorized writable humans can publish. Recovery routes continue requiring an operator; post-effect authority and identity are rechecked before finalization.

Command: `keryx ctx run -- bun test src/hub/delivery-queue.test.ts src/hub/git-delivery.test.ts` — 29 pass, 0 fail, 196 assertions. Run log: `.metaproject/data/gdctx/raw/2026-11-02T12-48-20-774Z-b2728f_run.log`.

Mutants were applied individually to a Git archive scratch copy with current owned changes overlaid; each targeted Bun command exited 1 with the named assertion failure. `delivery-mutation/run-mutations.py` records the exact commands and replacements come from the supplied immutable `mutants.json`. Logs are in `delivery-mutation/`.

- `w2-settle-event-loop`: killed; `bun test src/hub/delivery-queue.test.ts --test-name-pattern settle waits for an external` — error: expect(received).toBe(expected); (fail) settle waits for an external Git delivery to persist its result before shutdown [92.62ms]
- `w2-guard-20`: killed; `bun test src/hub/delivery-queue.test.ts --test-name-pattern at most two independent` — error: expect(received).toMatchObject(expected); (fail) at most two independent publication inspections may run concurrently [49.48ms]
- `w2-guard-25`: killed; `bun test src/hub/delivery-queue.test.ts --test-name-pattern operator archives completed` — error: expect(received).toBe(expected); (fail) operator archives completed jobs at the audit cap without losing exact reads replay or external facts [136.44ms]
- `w2-additional-guard-02`: killed; `bun test src/hub/git-delivery.test.ts --test-name-pattern inspection refuses a managed branch` — error: expect(received).toMatchObject(expected); (fail) inspection refuses a managed branch that changes between remote observation and fetch [614.65ms]
- `w2-supplement-05`: killed; `bun test src/hub/delivery-queue.test.ts --test-name-pattern external Git delivery never` — error: expect(received).toBe(expected); (fail) external Git delivery never holds the global mutation queue and same-key retry never starts it twice [40.43ms]
- `w2-supplement-active-list-order`: killed; `bun test src/hub/delivery-queue.test.ts --test-name-pattern delivery list retains old active` — error: expect(received).toMatchObject(expected); (fail) delivery list retains old active jobs ahead of more than fifty completed jobs [42.98ms]
- `w2-supplement-version-increment`: killed; `bun test src/hub/delivery-queue.test.ts --test-name-pattern reconciliation advances the exact` — error: expect(received).toBe(expected); (fail) reconciliation advances the exact job version and rejects stale archive CAS [43.36ms]

Changed this phase: `src/hub/delivery-service.ts`, `src/hub/delivery-queue.test.ts`. The test change prevents the quota mutant hanging by using an explicit third-inspection gate. No commits. Full lint and typecheck delegated to parent.

Routing: graph_used yes (previous phase; graph flagged unrelated untracked node_modules), wiki_used not-relevant, ctx_used yes, raw_rg_used no.
