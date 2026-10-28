# Existing code and reuse assessment
Version: 0.1.0

Status: source investigation completed2026-10-27; new Hub control plane is planned. Read-only agents inspected current source using graph navigation and ctx. Graph predates uncommitted context-watch files and was used only as navigation; source is the basis of claims.

| Existing source | Reuse | Missing or limited |
|---|---|---|
| src/lib/project-registry.ts: ProjectEntry/registerProject/projectIdentity | Explicit local project paths/identities and registrations. | Hub machine/checkout mapping is new; existing serve resolves exact paths, not Hub IDs. |
| src/lib/serve-turn.ts: TurnRequest/createSubmitTurn/runRemoteTurn | Native turn/session IDs, project admission, hooks/policy, result lifecycle. | Existing request lacks machine/profile/Flow pins; production no-tools path awaits run and emits assistant deltas after runOffline returns. |
| src/lib/serve-runner.ts: assembleSubmitTurn | Local provider/model/credential assembly. | No supplied toolRegistry/toolExecutor: empty ToolRegistry and denyingExecutor fallback. Real coding tool assembly is required. |
| src/lib/serve-turn-store.ts | Durable turn.json/events.jsonl, monotonic sequence, terminal result and key claims. | Current cross-process idempotency is not atomic; remote command ledger needs stronger transactional ownership. |
| src/lib/serve-server.ts | Auth-before-routing, separate serve/shell principals, endpoint scaffolding. | Existing events endpoint is finite replay SSE, not a live subscription. No remote cancellation endpoint/active handle. |
| src/lib/serve-approvals-broker.ts and serve-approvals-store.ts | Durable questions, timeout/fail-closed, action fingerprint, one-time consumption and orphan reconciliation. | HTTP answeredBy currently remote-token; Hub needs actual human attribution, connection liveness and applied receipts. Records do not make a paused executor restartable. |
| src/harness/tool/builtin/background-job-registry.ts | Owned shell supervision, process-group TERM→KILL and session cleanup concepts. | Registry is in-memory/session-bound; do not claim restart-safe process ownership. |
| src/remote/* | Telegram queue/replay/approval applied-ack lessons, independent local shell-token routing. | Keep Telegram intact; do not forward its credentials, reuse its principal or claim it already controls headless native serve approvals. |
| src/hub/context-sync.ts,context-watch.ts,connector.ts | Verified shared incremental cache validation/serialization/retry and explicit checkout bindings in current working tree. | Event-triggered serve integration remains new. Prior standalone watch keeps its existing contract. |
| src/hub/store.ts,domain.ts,server.ts | Existing Hub JSON aggregate in hub.sqlite, canonical Flow/revision/Evidence guards and serialized domain mutations. | Machine identity, remote tables/run model and atomic integration with existing aggregate are new. |
| apps/hub-web | RU/EN React, Query isolation, role-aware actions and human review UX. | Machines, launch, live run timeline/approval/cancel UI are new. |

## External agents: future adapters

src/harness/external/registry.ts registers codex-cli, claude-cli, antigravity-cli and gemini-acp. Availability proves binary/version, not provider login; not-probed is distinct. agents-external CLI applies capability/vendor gates and local recorded consent; headless cannot manufacture first TTY consent. runtime.ts/write-run.ts/write-land.ts provide separate run/write-review seams, not native serve support.

External supervisor kill handles are in-memory, SpawnedProcess has no durable PID/start identity, and the Bun spawn port kills a direct child rather than proving process-tree termination. ACP cancellation is adapter-specific. Vendor sessionRef is not native sessionId/turnId and does not grant control over an existing desktop chat. OpenCode export/bootstrap exists but OpenCode is absent from the external execution registry/codec. None is silently included in this first remote-native Flow.

## Verification implications

Before implementation, map the supported native shell tool assembly into a headless typed adapter without exposing generic shell commands from Hub. Prove asynchronous progress and cancellation through actual runtime tests. Add new local durable ledger/leases, then reuse approval/state primitives conservatively. Keep unknown/recovery-required when process ownership cannot be established; recorded session history alone never authorizes replay of prior side effects.

Routing: graph_used (find/affected, stale orientation); wiki_used (index, remote-control, background-jobs, permission-modes); memory_used (no relevant match); ctx_used; raw_rg_used:no. No credentials, runtime execution, Hub mutation or implementation was performed for this source assessment.
