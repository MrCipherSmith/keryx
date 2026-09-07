# T23 containment/SAC recheck

Verdict: **APPROVE**

The original [T23 review](./T23-review.md) remains unchanged as the record of the pre-fix defect. This recheck evaluates the current code after T25.

## Prior finding disposition

**F-001 — resolved.** `readWorkspaceFileNoFollow` now supplies the shared `DEFAULT_CONTAINED_READ_MAX_BYTES` value and `requireRegularFile: true` at `src/sac/secure-resource-read.ts:16-19`. The SAC wrapper continues to call `readDescriptorChain`, so the existing workspace-relative validation and component-by-component `O_NOFOLLOW` descriptor semantics remain intact.

T25 recorded a real RED-to-GREEN transition:

- RED: 0 passed, 2 failed before the wrapper policy was added; `.metaproject/data/gdctx/raw/2026-09-06T12-44-28-873Z_run.log`.
- GREEN: 2 passed, 0 failed after the fix; `.metaproject/data/gdctx/raw/2026-09-06T12-48-30-270Z_run.log`.

## Stage 1: specification compliance

**Result: PASS**

| Criterion | Result | Evidence |
| --- | --- | --- |
| Internal links remain readable while external/replaced owner or target identities are refused without disclosure | PASS | The shared contained reader still pins root/target identities and the focused suite retains its internal-link and replacement coverage. The existing owner replacement probe again returned `CONTAINED_READ_RACE`. |
| Regular-file, byte-limit, and supported-platform behavior is explicit, including SAC compatibility | PASS | `src/sac/secure-resource-read.ts:16-19` now passes both policies. `src/sac/secure-resource-read.test.ts:8-17` verifies the exact 8 MiB boundary and rejects 8 MiB + 1; lines 19-26 verify a directory is rejected as non-regular. The shared unsupported-backend regression remains green. |
| Focused evidence covers the approved behavior | PASS | Independent combined run: 19 passed, 0 failed across the shared reader, SAC wrapper, MCP containment, and harness containment suites. |

## Stage 2: logic and security quality

**Result: PASS**

No new findings. The fix is centralized at the SAC boundary, reuses the shared byte-limit constant rather than duplicating it, and enables the descriptor reader's pre-read regular-file check. With `requireRegularFile: true`, the final descriptor is opened with `O_NONBLOCK | O_NOFOLLOW`, its identity and type are checked before `readAll`, and the byte bound is enforced both from descriptor size and while reading. Unsupported descriptor capability continues to fail explicitly. The new tests exercise both sides of the size boundary and the non-regular-file error without network, models, private data, or persistent fixtures.

## Independent verification

- Combined focused suites: 19 passed, 0 failed; `.metaproject/data/gdctx/raw/2026-09-06T12-49-08-640Z_run.log`.
- Isolated SAC wrapper suite: 2 passed, 0 failed; `.metaproject/data/gdctx/raw/2026-09-06T12-49-26-972Z_run.log`.
- Existing owner replacement probe: `{"refused":true,"code":"CONTAINED_READ_RACE"}`; `.metaproject/data/gdctx/raw/2026-09-06T12-49-33-517Z_run.log`.

Limit: this was the dispatched bounded containment/SAC review, not a global suite or general repository security audit.

Routing audit: `graph_used: no` (known recheck files were explicit and the graph predates concurrent uncommitted work); `wiki_used: yes` (the previously read approved containment/SAC context remained applicable); `ctx_used: yes`; `raw_rg_used: no`.
