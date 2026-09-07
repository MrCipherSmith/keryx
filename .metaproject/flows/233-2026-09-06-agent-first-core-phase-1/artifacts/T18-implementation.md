# T18 implementation report

Implemented the owner identity replacement fix in the shared contained/descriptor reader.

`readContainedFile` now pins the owner root identity at authorization and the canonical target identity before the async opening hook. `readDescriptorChain` accepts those identities, rejects a changed owner root before opening, and compares the final descriptor to the pinned target before any bytes are returned. The existing descriptor fd-to-stat checks remain in place, so the SAC entrypoint retains its no-follow descriptor-chain behavior.

The two T18 regressions are in `src/lib/contained-read.test.ts:80` and `src/lib/contained-read.test.ts:98`. The first replaces the owner with a different real directory; the second replaces the resolved regular file at the same path. Both fail closed without exposing replacement content.

## Verification

- Initial RED: 5 passed, 2 failed before the implementation; raw `.metaproject/data/gdctx/raw/2026-09-06T12-15-49-060Z_run.log`.
- Owned combined containment/SAC/interactive suite: 89 passed, 0 failed; raw `.metaproject/data/gdctx/raw/2026-09-06T12-21-10-031Z_run.log`.
- T17 owner replacement integration probe: exit 0 and `{"refused":true,"code":"CONTAINED_READ_RACE"}`; raw `.metaproject/data/gdctx/raw/2026-09-06T12-20-26-413Z_run.log`.
- Owned source build: exit 0; raw `.metaproject/data/gdctx/raw/2026-09-06T12-21-15-287Z_run.log`.
- Full project typecheck: current owned identity errors are fixed, but exit 2 remains because unrelated `src/security/output-validation.test.ts` and `src/security/structural-detection.test.ts` import missing `./output-validation`; raw `.metaproject/data/gdctx/raw/2026-09-06T12-21-02-534Z_run.log`.

No external sockets, model calls, dependency changes, or unrelated source edits were used for T18.

Routing audit: `graph_used: yes` (containment graph context; graph predates uncommitted edits), `wiki_used: yes` (agent-first containment policy context), `ctx_used: yes`, `raw_rg_used: no`.
