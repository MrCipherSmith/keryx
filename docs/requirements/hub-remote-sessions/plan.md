# Remote agent implementation and verification plan
Version: 0.2.0

Status: planned. The owner requested specification and Flow creation; do not start runtime implementation in this documentation step. Additional execution statistics remain disabled by the owner's previous choice.

## Implementation waves

1. W0 contract/freeze: verify Hub main spec digest, companion hashes, exact twenty-four criteria and chosen completion boundary. Human freeze is mandatory; canonical state is Hub, not a duplicate local Flow.
2. W1 durable authority: RED schema/auth tests; machine pairing/revocation, additive Hub migration and local ledger/explicit mappings. Prove current aggregate/SSO/Flow data preserved and crash/rollback behavior before networking.
3. W2 transport: RED actual WebSocket tests; machine-only handshake, epochs, heartbeat, scoped browser invalidations, bounded buffering/replay, ongoing revocation. Local/SSH first; public Access policy setup is a separate authorized deployment task.
4. W3 shared session host and native execution: source-backed complete command/subcommand inventory, extraction of shared domain handlers from TUI closures, native history/lease/config/queue/finalizer, typed capabilities and headless-vs-terminal parity; then explicit headless coding tool assembly, strict local admission and lease, transactional command/start claims, live progress and native session/turn linkage. Do not wrap existing empty-tool production serve as complete.
5. W4 approvals/cancel: fingerprint-bound broker adapter and applied receipts; actual AbortSignal + owned task/process-tree stop; disconnect pause and crash unknown/reconciliation. RED probes for duplicate start and approval/cancel races before fixes.
6. W5 web session foundation and context: persistent sessions/history, basic follow-up message/queue controls, structured command/config/routing controls (rich chat renderer later), explicit controllers/observers; then RU/EN Machines/Runs/start/detail/approval/cancel with exact versions, Query isolation, mobile/keyboard states; event-driven project context synchronization using existing cache module.
7. W6 results and recovery: restricted run-owned review-bundle upload, exact actual checks/Evidence, partial/spec-drift/quota outcomes, migration/restore/reconcile runbooks. No automatic Git integration or Flow acceptance.
8. W7 verification/review: complete matrix below, independent correctness/security/docs review, package/compiled tests and immutable Hub candidate/Evidence handoff. Owner decides acceptance. No merge/release/deploy/access-policy change is part of this Flow's automatic completion.

Each wave's tests, implementation, verification and independent review is a tracked task/result in the execution journal and exact-subject Evidence. If implementation scope cannot satisfy the native runtime/approval/cancellation contract, stop and re-plan with the owner instead of replacing it with status-only UI. First other-vendor adapter gets its own later Flow.

Session foundation is part of this implementation, not a later optional UI enhancement. W3 must prove multi-turn own-edit continuation and both Flow-work/ad-hoc result semantics; no acceptance while required native domain commands are only stubbed unavailable.

## UI state × event matrix

| State | Launch/action | Disconnect or revocation | Refresh/reconnect | Cancel or approval |
|---|---|---|---|---|
| No machine/setup required | Show enrollment/local setup; no launch | Remain explicit | Refresh actual capability, no inferred ready | Disabled |
| Online clean checkout | Explicit target/pins; idempotent request | No offline queue; show unavailable | Revalidate inventory/version/profile | Only permitted current actions |
| Dirty/busy/stale checkout | Refuse with precise reason; preserve draft | Preserve user selections, not stale authority | Fetch current state; explicit new submit | Never stash/reset/steal lease |
| Starting with uncertain response | Inspect same operation/run; no second launch | Show last observed/unknown, not failed | Replay receipt/reconcile same run | Cancel request can be unconfirmed |
| Running | Live bounded timeline; no duplicate launch | Running/last-known then paused-at-boundary; no instant kill claim | Reconcile and replay; never rerun | Request only; applied confirmation required |
| Waiting approval | Exact question and expiry | No implicit allow; deadline denies | Same waiter only; expired is not applied | Allow once/Deny; show recorded/delivered/applied |
| Cancelling | Disable duplicate destructive actions | Keep requested/unconfirmed state | Query actual executor outcome | Confirm stopped or show too-late/unknown |
| Terminal/partial | Result/revision/Evidence plus actual outcome | Historical result retained under auth | No terminal regression | Acceptance separate; partial changes visible |
| Unknown/orphan | Recovery guidance, no restart button | Keep uncertainty | Prove ownership/absence or local+human resolution | Never kill by PID/force-unlock remotely |
| Session/project changed | Clear private cache/drafts per existing session policy | Close socket; auth required | Only current scoped query keys | Old approvals/actions cannot carry over |

Additional session states: idle owned conversation accepts a versioned message/command; busy changes queue/reject according to catalogue and retain current turn snapshot; lost controller becomes observer and cannot mutate; resumed conversation validates native lease/baseline before acquiring checkout ownership; changed Flow association affects future turns only. Queue edits, route changes, controller transfer and reconnect each need stale-version and duplicate-operation tests.

## Required verification tasks

- V1 enrollment/role matrix: code expiration/single-use/brute-force, wrong principal, scopes and open-socket revocation; migration/startup failure and recovery.
- V2 transport: actual two serve processes/one Hub, distinct machines and checkout IDs, no inbound listeners, TLS/loopback exceptions, duplicate active credentials/old epochs, invalid direction/version/frames, oversize and slow reader.
- V3 launch: native deterministic provider actually invokes allowed read/edit/supervised-shell tools; local models/credentials never sent; dirty/busy/changed HEAD/spec/policy refuse without effects.
- V4 crash matrix: force kill before/after claim/pre-start/spawn/result/ack; count actual executor starts, inspect durable keys/leases and reconcile without duplicate action or stale PID attach.
- V5 approval: legitimate operator versus reviewer/agent/machine, stale call/policy/run/deadline, changed/duplicate answer, disconnect before apply, applied receipt versus recorded answer, orphan restart denial.
- V6 cancel: sleeping tool plus owned descendant, TERM→KILL fallback, missing owner, completion race, pending approval, disconnected request and partial changes; assert no false cancelled result.
- V7 progress: live events before completion, safe redacted text/no reasoning, replay/dedupe/gap, disk/memory quotas, output flood, slow browser/machine and terminal event preservation.
- V8 context: approved wiki change while connected, multiple clones/worktrees, coalescing/out-of-order notifications, lost connection+reconnect; no cache rollback or per-checkout pollers.
- V9 result: changed/new/deleted files within quotas, secret/path/binary errors, cancelled partial run, spec drift, exact ownership/subject/idempotency, review-bundle delivery guards and human-only final acceptance.
- V10 browser: actual RU/EN API workflows,375px/desktop, keyboard, offline/unknown/approval expiry/conflict/auth loss, Back/Forward and stale-response Query isolation.
- V11 compatibility/release: current Hub/SSO/MCP/connector/watch/local serve/Telegram regressions, lint/types/scripts/build, source/standalone package and supported Bun/OS tests; no shared root dependency install.
- V12 owner trial/runbooks: two processes are mandatory automated integration. A real model call on two physical machines and public Cloudflare service-auth smoke require local credentials/explicit deployment authorization; record actually executed scope or pending status, never invent a pass. No credential scraping to run the trial.

- V13 parity inventory: enumerate actual commands/subcommands; required native groups have real shared handlers/typed tests, UI-only and local-security constraints are reasoned, no divergent web catalogue or arbitrary shell fallback.
- V14 multi-turn/session: actual shared host without PTY, follow-up after own edits, queue edit/remove/compaction, session/controller version races, local TUI competing lease, ad-hoc vs Flow-work, reconnect without duplicate turns.
- V15 routing: manual baseline pick with routing enabled, classifier failure, cost/privacy confirmation, busy update ordering, admission-time snapshot, optimistic config version and effective-next-turn receipts.

## Local trial and release boundary

Implementation must provide a disposable trial: start Hub and two independent serve instances with separate protected state, enroll both, locally map clean fixture checkouts, launch/approve/cancel and inspect results through the real web UI. Scripted provider is labeled deterministic. Production model and Cloudflare checks are separate. Migration backup, rollback, revoke/unpair and unknown-run recovery instructions are acceptance deliverables, not permission to modify the current geekom deployment during documentation.

## Dependencies and sources

Preserve current uncommitted context-watch feature. Reuse its safe sync module, existing native harness/policy/approval/supervisor and Hub/React infrastructure. New table/storage authority, WSS machine identity, native coding adapter and all UI are planned work. No new dependency or Bun upgrade is selected merely from reading newer web docs; pin and verify any implementation dependency in an isolated build.
