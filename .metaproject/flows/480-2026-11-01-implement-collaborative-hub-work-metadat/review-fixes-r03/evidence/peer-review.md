STATUS: DONE

Focused review against `7e7179a8`: no actionable blocker, major, or minor found. Tests and network were not run.

- Publication checks writable human and project scope both before and after the Git effect; recovery remains operator-only. The new tests cover reviewer publication, revoked authority and recoverable result, and operator-only recovery.
- Admission enforces the global cap across both classes, limits public slots, cancels refused bodies, and classifies the decoded public routes. With a limit of one, a public request occupies the only global slot; the test explicitly expects protected admission to fail until it releases. Nested MCP admission shares its root slot.
- Incident support batches attempts, deduplicates criterion lookup by ID while retaining all matching waiver decisions, and retrieves original acceptance decisions. The tests cover multiple attempts and exact accepted waiver support. Public HTTP validates the closed work command schema before `commandState`, so its internal `attemptIds` seed is not accepted as extra public payload.
- UI revision selection delays exact lookup until the list succeeds and excludes stale exact errors when the selected revision is listed.

`w1-events-inflight-wake` is equivalent. Complete poll caller enumeration: initial call starts with `running=false`; the hidden timer is scheduled only after passing the running guard and before setting `running=true`; the completion timer is scheduled after `running=false` in `finally`; and the refresh listener sets `requested=true` before invoking `poll` only when `!running`. Therefore no caller can reach the guard with `running=true`. The new receipt test exercises the actual in-flight refresh, including hidden visibility, and verifies immediate subsequent polling.

Reviewed files: `src/hub/{delivery-service,mutation-queue,server}.ts`, `src/hub/work/{storage,http,validation,openapi}.ts`, `src/hub/{admission-regression,delivery-queue}.test.ts`, `src/hub/work/storage.incidents.test.ts`, `apps/hub-web/src/features/{context,revisions-query}.tsx`, `apps/hub-web/src/features/managed-work/updates.tsx`, and `apps/hub-web/tests/work-live-updates.case.tsx`.

Routing audit: graph_used: yes (advisory graph predates concurrent changes); wiki_used: yes (index); ctx_used: yes; raw_rg_used: no.
