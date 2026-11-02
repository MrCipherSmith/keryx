# UI live and workflow test gaps

Focused verification: from `apps/hub-web`, `keryx ctx run -- bun run test tests/work-live-updates.case.tsx tests/workflow-pagination.case.tsx tests/work-revision-members.case.tsx` — 18 passed. `keryx ctx run -- bun run typecheck` — pass.

Changed: `apps/hub-web/tests/work-live-updates.case.tsx`; new `apps/hub-web/tests/workflow-pagination.case.tsx` and `apps/hub-web/tests/work-revision-members.case.tsx`. Network requests are mocked at fetch; fixtures use valid demo Work records. No production changes.

| Finding | Evidence |
| --- | --- |
| W1-003 | Initial filtered membership stored in draft and a saved active membership subsequently cancelled before submitting; exact submitted IDs. Both mutants killed. |
| W1-004 | Deferred gap snapshot returns after a separate live feed merges a newer record; overview gap without cached snapshot invalidates observations. Both mutants killed. |
| W1-005 | Receipt occurs while first poll is gated; release must initiate next poll at zero fake time for visible and hidden documents. Hidden and immediate timer mutants killed. `w1-events-inflight-wake` survived and appears behaviorally equivalent (see below). |
| W1-006 | Both candidate and evidence forms independently load a second page using their own control and select the later revision. Both mutants killed. |
| W1-009 | Deferred network responses for event record, gap snapshot, and gap attention resolve after unmount; old cache stays unchanged. All three mutants killed. |

## Mutation evidence

Each mutation was applied independently to a Git archive scratch copy with these tests overlaid; commands use the project Vitest runner. Runner and per-mutant logs are in `ui-live-mutations/`.
- `w1-revision-default-members`: killed (exit 1); `bun run test tests/work-revision-members.case.tsx -t filters cancelled required Intent at initial`.
- `w1-revision-submit-members`: killed (exit 1); `bun run test tests/work-revision-members.case.tsx -t filters cancelled required Intent at submit`.
- `w1-gap-snapshot-merge`: killed (exit 1); `bun run test tests/work-live-updates.case.tsx -t late retention snapshot`.
- `w1-gap-observations-refresh`: killed (exit 1); `bun run test tests/work-live-updates.case.tsx -t overview gap refresh invalidates`.
- `w1-events-inflight-wake`: survived (exit 0); `bun run test tests/work-live-updates.case.tsx -t receipt wakes an in-flight poll`.
- `w1-poll-requested-hidden`: killed (exit 1); `bun run test tests/work-live-updates.case.tsx -t receipt wakes an in-flight poll`.
- `w1-events-poll-wake-immediate`: killed (exit 1); `bun run test tests/work-live-updates.case.tsx -t receipt wakes an in-flight poll`.
- `w1-workflow-submit-more`: killed (exit 1); `bun run test tests/workflow-pagination.case.tsx -t candidate form loads`.
- `w1-workflow-evidence-more`: killed (exit 1); `bun run test tests/workflow-pagination.case.tsx -t evidence form loads`.
- `w1-supplement-abort-event`: killed (exit 1); `bun run test tests/work-live-updates.case.tsx -t late record response`.
- `w1-supplement-abort-gap-snapshot`: killed (exit 1); `bun run test tests/work-live-updates.case.tsx -t late snapshot response`.
- `w1-supplement-abort-gap-attention`: killed (exit 1); `bun run test tests/work-live-updates.case.tsx -t late attention response`.

The surviving mutant removes only `requested = true` inside `if (running)`. Poll callers are: the initial `void poll()` before it can already be running; the timeout callback installed exclusively in `finally` after `running = false`; and the refresh listener, which sets `requested = true` itself and calls `poll()` only when `!running`. A hidden retry timeout is also installed only before setting `running = true`. Thus no enumerated caller reaches that branch while running; the in-flight receipt test exercises the listener and independently kills the hidden and immediate scheduling mutants. This is a static reachability argument, not a proof against all future changes.

Routing: graph_used yes (graph flagged unrelated working-tree changes), wiki_used not-relevant, ctx_used yes, raw_rg_used no.
