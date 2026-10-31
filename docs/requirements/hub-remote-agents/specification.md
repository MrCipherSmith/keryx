# Control local Keryx agents on multiple machines from Team Hub
Version: 0.1.2

Status: planned, pending human freeze. Hub path: specs/hub-remote-agents.md. Scope is specification and Flow creation now; runtime implementation requires a subsequent owner-frozen Flow.

## 1. Outcome and scope

From the existing RU/EN React Hub, an authenticated human operator chooses an online enrolled machine, explicit checkout and native Keryx agent profile, starts work for an exact in-progress Flow, receives live progress, answers a tool approval, requests cancellation and receives code/Evidence for human review. Application environments, Docker dependencies, provider credentials and execution stay local. Hub coordinates; it does not execute repository code.

MVP supports macOS and Linux, one Hub process/SQLite database, multiple machines and registered checkouts. Native Keryx is the first tool-enabled executor. Other provider APIs may be used through locally configured native model profiles; externally spawning Codex/Claude/OpenCode is outside this Flow. Do not advertise installed binaries as authenticated or supported remote adapters. No browser terminal or arbitrary remote shell endpoint.

## 2. Existing behavior and required work

Reuse the local project registry, native harness, hooks/policy/containment, durable turn/event storage, approval broker and supervised shell-task mechanisms. Existing production serve assembly has an empty tool registry/denying fallback, finite post-run event replay and no live cancellation seam. Implementation must assemble a real bounded native coding runtime, publish progress during execution, and propagate cancellation to active tools/children. Preserve Telegram and shell-token boundaries. [Reuse evidence](reuse.md) names actual source seams.

## 3. Ownership and identity

| Entity | Owner and invariant |
|---|---|
| Project/wiki/spec/Flow | Hub is canonical; existing human freeze/acceptance and exact digests remain authoritative. |
| Machine | Hub assigns machineId at explicit enrollment; one local serve installation retains its own credential and ledgerId. No auto-enrollment by hostname or Git remote. |
| Checkout | Local owner maps a Hub project/checkoutId to an exact canonical path. Hub sees a display label and opaque localBindingId, not a caller-selected path. Separate worktrees/copies remain distinct. |
| Agent profile | Local owner defines provider/model, allowed tools, policy/containment and budgets. Hub selects a published profileId and its capability/policy digests; it cannot send executable paths, environment overrides or tool registries. |
| Run | Hub owns immutable request/actor/pinned references and delivery journal. Local serve owns observed execution, approval consumption, local process handles and durable event sequence. A run is an execution attempt, not a replacement for the existing Code Revision or a new complete Intent/Attempt model. |
| Approval | Local broker owns the exact pending action and one-time consumption. Hub authenticates the answering human and records delivery; an answer is not applied until serve confirms consumption. |
| Result | Hub owns immutable Code Revision/Evidence and human review. Execution success never implies Flow acceptance. |

Machine credentials are a separate principal class; existing agent MCP keys, human browser credentials, serve bearer and local shell token are not reused. A machine may only connect/update its own inventory and run records and access its enrolled project context/spec/Flow references; it cannot launch work on another machine, answer approvals, freeze/accept Flow, administer credentials, select integration or deliver Git.

## 4. Enrollment and local policy

An operator creates a one-use enrollment code in Hub for an explicit nonempty project allowlist and display name. Code lifetime is 10 minutes, at least 128 random bits, digest-only server storage, bounded attempts and single atomic consumption. It is displayed once with no cache/storage persistence in the browser. A local user deliberately supplies the trusted Hub URL and code through a named environment variable to the planned command `keryx hub machine pair --url <https-url> --code-env KERYX_HUB_PAIR_CODE`. Codes/tokens never appear in command arguments, URLs, logs or chat. Optional Cloudflare service headers come from paired environment references, not Hub Bearer replacement.

Enrollment returns a distinct random machine secret once; Hub stores its digest. Local secret/config live outside Git under the owner-only Keryx user directory. Preserve any existing local serve secrets and unrelated configuration. No project is remotely executable until the local owner has added an explicit mapping using the planned local-only command `keryx hub machine allow --project <hub-project-id> --checkout <checkout-id> --path <local-path> --profile <local-profile-id>`. Remote commands cannot create/change mappings. Pairing alone grants no local execution path.

Effective permission is the intersection of Hub project scope, current human operator authority, machine enrollment, local checkout/profile allowlists and existing local tool/containment policy. Local policy changes invalidate prior inventory policy digests and pending starts. Default maximum is two active runs per machine and one per checkout; stricter local limits win. No supported capability means setup-required, not an invisible fallback.

## 5. Connection and availability

An opted-in existing keryx serve opens one outgoing connection per enrolled Hub to `/hub/v1/machines/socket`, using subprotocol `keryx.hub.machine.v1`, machine Authorization header and WSS; loopback WS is permitted for local/SSH trials. Reject URL userinfo/query/fragment and redirects. No inbound port or public exposure of local serve is needed. Feature is disabled when no machine enrollment/policy exists; existing serve startup opt-in/security prerequisites remain in force.

Heartbeat is every 20 seconds, offline after 60 seconds without a valid response. These small liveness frames do not fetch wiki or count as progress. Reconnect uses jittered exponential delay from 1 to 60 seconds. Unsupported protocol closes visibly. Each admitted connection receives a monotonic epoch. A second live connection for the same machine is rejected; it does not silently take over. A new epoch after disconnect fences old messages and never authorizes rerunning old work.

Cloudflare/edge must preserve WebSocket upgrades and independently preserve Access authentication. Service Auth for machines requires separate operator configuration and a real external smoke test; do not bypass existing tunnel audience/JWT/edge guards. Initial loopback/SSH tests are sufficient for implementation testing, not a public-access claim.

## 6. Start and execution admission

The browser sends an idempotent POST with expected Flow/machine inventory versions, exact machine/checkout/profile, expected HEAD, spec digest, criteria digest, policy/capability digests and bounded task text. Server-derived actor/time cannot be overridden. Flow must already be in-progress and still reference the same specification; users use the existing lifecycle to start ready Flows. Hub refuses offline/revoked/unready/busy targets rather than queueing a start for later unexpected execution. Prompt is untrusted input constrained by local policy.

Serve independently rechecks all pinned references, current local mappings and HEAD, supported adapter, budgets, clean working tree/index (including untracked files), no active Git operation and no Keryx checkout lease. Missing ignored environment files/dependencies are local setup errors, not permission to copy secrets or auto-install. Existing credential-free Hub routing hints/backups may be excluded only by the connector's explicit documented rules; no broad ignored/untracked-file exemption. The checkout must be a Git working copy. Acquire an owner-nonce filesystem lease in its resolved per-worktree Git administration directory, shared across all Hub enrollments and serve processes/config roots; the per-Hub SQLite lease is only a projection of that ownership. Another Hub cannot launch into the same canonical checkout. A checkout lease prevents Keryx launches, not a human editor: externally observed edits during execution mark the run as interfered/reconciliation-required and block automatic result publication; there is no claim of OS-exclusive filesystem ownership.

MVP refuses dirty starts; users can explicitly register a dedicated clean copy/worktree with its local environment. It does not stash, reset, create or migrate working copies automatically. A start command expires after 60 seconds if not admitted. Validation happens before side effects. The native adapter runs a coding turn with locally permitted read/search/edit/supervised-shell tools, bounded at 30 minutes and local tool-call/spend limits. Local provider/model credentials never leave the machine. No automatic vendor setup/consent or permission-mode changes.

## 7. Durable delivery and execution states

Hub durably records the run and command before sending. Serve durably claims `(hubId, commandId)` and runId with a payload digest before acknowledging. Identical duplicates replay the existing receipt/state; a changed payload for the same identity conflicts. Before invoking the executor, persist a start-attempt marker and acquire the local checkout lease. A launch claim is never released merely because the connection or response was lost.

Delivery receipt means received/admitted/rejected, not started. Observed states are dispatching, received, starting, running, waiting-approval, paused, cancelling, succeeded, failed, cancelled, rejected, unknown and lost. Connection online/offline is a separate dimension. A confirmed terminal run cannot regress due to late frames. Apply strict expected-version and per-run sequence checks. Multiple start submissions with different request keys are still refused while the checkout/run association is active.

Crash before a durable claim can be redelivered; crash after a start-attempt marker is uncertain until reconciliation. Reattach only to a provably owned live runtime; never kill/attach by PID alone or automatically restart a spawning/running record after a daemon crash. If ownership cannot be established, show unknown and require explicit local recovery plus an audited human resolution. Marking lost in Hub does not unlock a locally uncertain checkout. Protocol acknowledgements are at-least-once delivery accounting, not exactly-once side-effect guarantees.

## 8. Progress, disconnects and logs

Live native progress is produced during execution, not reconstructed solely from final text. Persist state/approval/terminal events and bounded redacted log chunks locally before streaming; Hub persists admitted events before acknowledging. Each run has a monotonic local seq, distinct from Hub command sequence and project contextRevision. Reconnect sends cursors and replays missing events or an explicit snapshot/gap marker; duplicates are ignored after payload agreement, never execute work again. Logs may be dropped with an explicit gap under quota pressure; approvals, terminal states and command receipts must not be silently dropped.

Only operator-facing assistant text, progress, tool summaries and safe diagnostics are transmitted. No hidden reasoning, provider credentials, raw environment, unrestricted terminal byte stream or arbitrary local files. Limits: 64 KiB per encoded frame, 8 KiB log chunks, 256 KiB buffered output per connection, 10 MiB persisted log data per run, 32 KiB task text. Apply backpressure and drop/coalesce logs first; disconnect a persistently slow consumer rather than grow memory unbounded. Redact before local outbox persistence and again at Hub ingestion.

On loss of the authenticated control channel, stop admitting new commands and approvals. A currently executing tool may finish within its timeout; then pause before the next tool/model action. Expiring pending approvals deny. Budget/containment continue locally. Reconnect reconciles actual run state and the same execution can continue at a safe boundary; a duplicate start cannot resume it. No guarantee of instant stop during an already running side effect is made.

## 9. Human approvals and cancellation

Only a currently authorized human operator may answer a local tool approval. Question binds machine, daemon/run/checkout, approvalId, action fingerprint, local policy digest and expiry. UI offers Allow once or Deny, with redacted action details. No approve-all/trust-mode/standing grant. Immediately before starting work, applying a cancel or consuming an approval, serve obtains a command-bound authorization lease from the machine-only Hub authorization endpoint. Hub rechecks current actor/role/session/scope and returns a maximum five-second application window; local policy and broker state are checked again during that window. Revocation may race with an already issued lease for at most five seconds; no instantaneous distributed revocation is claimed. Local broker revalidates and consumes once for that exact action; changed parameters, expired/revoked actor, ended run, missing waiter or changed policy fail closed. Browser status distinguishes answer recorded, delivered and applied/not applied. Disconnect never fabricates approval. Native confirmations that require a local-only TTY or cannot be safely represented remain local-required/denied; the web cannot impersonate them.

Cancel is an idempotent command, allowed for queued/active/approval-paused runs. First show cancel requested; only a live executor acknowledgement changes to cancelling, and only verified cessation of the run's supervised work changes to cancelled. Deny pending approvals, stop future actions, propagate AbortSignal, terminate only owned process groups with TERM then KILL after 5 seconds, and record partial file changes. Failure to establish process ownership or stop all owned children yields unknown, not cancelled. A natural terminal result racing with cancel wins if durably observed first; UI reports cancel-too-late. Cancellation does not roll back files or send a Git reset.

## 10. Result, review and context

An owned run may upload one immutable result per operation key through a restricted result endpoint. Capture a review-only package of changed tracked files/explicit newly created agent files, deletions and Git-base patch, with existing path/secret/quota protections. Never upload an entire large checkout or ignored files automatically. Existing snapshot quotas remain; quota or secret-screening failure is visible and retains the local result. Cancelled/failed runs may expose a labeled partial result; they do not claim completion. Local checks use only configured commands and report actual exit codes/output; never invent passing checks.

Hub creates a Code Revision with purpose review-bundle and exact-subject self-reported machine Evidence; actor is machine:<id>, never an impersonated human/operator/connector. Run completion/result upload does not select Git, accept a Flow or silently rewrite its criteria/spec. Requesting Flow review remains a separate existing authorized action with exact candidate and successful Evidence guards; owner acceptance remains human-only. A changed spec during execution is visible and blocks automatic review submission; preserve the run's original pinned snapshot.

Context-changed frames carry projectId and contextRevision only. Serve coalesces notifications and uses the existing safe incremental sync module under its per-project lock. Sync once on connect/reconnect and on notification; duplicate/out-of-order invalidations cannot regress the cache. Overflow or replay gap triggers revision reconciliation. Existing standalone polling watch remains available as an explicit fallback; this Flow does not change its frozen contract or silently run one poller per checkout.

## 11. Web interface

Add Machines and Runs navigation plus a Run action on eligible Flow details. Machine cards show last seen, connectivity, locally advertised checkouts/profile readiness and precise setup-required reasons. Start form explicitly selects machine/checkout/profile; never chooses the first online machine silently. Show HEAD, clean/busy status, effective limits and pinned Flow/spec. Unsupported/dirty/offline choices cannot launch.

Run detail shows actual vs last-known state, machine/checkout/profile, actor, pins, live redacted timeline/log gap notices, pending approval, cancellation delivery/confirmation, local session/turn links, result revision and Evidence. Unknown/offline never looks like stopped/succeeded. Browser uses current human session and same-origin HTTP mutations; a separate authenticated project-scoped `/hub/v1/events/socket` only sends invalidations and is not a command execution channel. Revalidate human session/role and machine credentials before every privileged action and at most every 20 seconds for open sockets; close revoked/expired sessions. No tokens in URL or localStorage.

Retain existing TanStack Query project/session isolation, draft preservation on conflicts and unsafe-retry restrictions. Add RU/EN messages, keyboard access, 375px layout, clear retry/conflict/empty/loading states and Back/Forward/deep-link support. State × event matrix is in the implementation plan.

## 12. Persistence, protocol and implementation boundaries

Use the existing hub.sqlite for additive versioned remote-control tables (machines, pairings, local inventory projections, runs, commands/outbox, events, approval projections, result receipts). Keep current hub_state unchanged until an explicit backward-compatible store API extension is tested; operations touching remote tables plus Code Revision/Evidence must commit in one SQLite transaction through one serialized authority. Do not add a second independent in-memory source of truth or overwrite concurrent state snapshots. Migration failure rolls back and startup fails safely; unsupported DB version refuses startup. Old runtime rollback requires a compatible additive schema or an explicitly verified backup procedure.

Serve owns a separate protected local control.sqlite under its user-global hub-machines/<hub-id>/ directory: stable ledgerId, command payload hashes/receipts, run/start markers, local checkout leases, event outbox/cursors and recovery records. Credentials are protected files outside this DB, never embedded in events. Keep terminal run metadata and command tombstones for reconciliation; MVP does not automatically prune launch identities. Log retention is seven days after terminal status; reaching bounded storage limits blocks new launches rather than losing unresolved identity/approval records. Authenticated machine reconciliation reports and scoped recovery snapshots, including native session/turn identity, are required before uncertain runtime state may be resolved. Detailed tables, API and transport are in [protocol](protocol.md); policy is in [security](security.md).

Closed JSON schemas: [machine protocol](schemas/machine-protocol.schema.json), [HTTP/policy contract](schemas/control-api.schema.json), with [readable copies](schemas.md). Every handler must validate size, schema, direction, epoch, principal/project/run association and state; JSON Schema alone is not authorization. No arbitrary route/tool/shell invocation frame. Authenticate before upgrade; Bun runtime compatibility is verified against the supported runtime, not assumed from newer documentation. Single-process Hub scope remains; no multi-instance/multi-tenant SLA claim.

## 13. Acceptance criteria

1. Explicit expiring one-use enrollment provisions distinct revocable machine identities and nonempty project scopes; owner-only local secrets and mappings survive restart without reusing human/agent/serve/shell credentials or leaking them. [verify: judged]
2. Machine/checkout/profile inventory is truthful and project-scoped; only an implemented ready native Keryx adapter is selectable, unsupported vendors and missing local setup are visible, and existing local policy/containment cannot be relaxed remotely. [verify: judged]
3. RU/EN web launch selects an exact online machine, explicit clean checkout, allowed profile and in-progress Flow; expected versions, HEAD, specification/criteria and policy/capability digests are rechecked on Hub and machine; offline, dirty, busy, stale or unauthorized requests have no execution side effects. [verify: judged]
4. Durable command/run identities, payload hashes and local pre-start claims prevent duplicate automatic launches across HTTP retries, duplicate frames, reconnect and crash windows; ambiguous starts remain unknown and require explicit reconciliation without PID-only attachment or kill. [verify: judged]
5. A real native coding runtime executes allowed tools and streams bounded redacted progress while running; replay/gap handling, backpressure and quotas preserve critical state without exposing hidden reasoning, credentials or unrestricted local files. [verify: judged]
6. Human-only Allow once/Deny is exact-action/run/checkout/policy-bound, expires, is consumed once locally and displays recorded/delivered/applied distinctions; stale, duplicate, revoked, unsupported or disconnected approvals fail closed without standing grants. [verify: judged]
7. Idempotent cancellation stops future actions and only owned supervised work, resolves pending approvals and reports requested/confirmed/too-late/unknown truthfully; descendant-stop, completion races and partial files are tested, with no automatic rollback of developer changes. [verify: judged]
8. Outbound authenticated WebSockets, heartbeat/epochs and reconnection work across two machines; second live connections and old epochs are rejected, offline is separate from execution status, reconnect replays/reconciles without restarting work and local disconnected behavior pauses at a safe boundary. [verify: judged]
9. Human session/role and machine credential/scope revocation apply to open sockets within 20 seconds and before every privileged action; Origin, TLS/loopback exceptions, malformed/oversized frames, replay and cross-project/machine attacks are rejected without weakening Cloudflare or existing auth gates. [verify: judged]
10. Shared context updates use project revision invalidations plus existing validated incremental sync on connect/reconnect/change, with coalescing, no stale-cache rollback or one poller per checkout; standalone sync/watch remains compatible. [verify: judged]
11. Exact run-owned result uploads create immutable review-only Code Revisions and honestly attributed self-reported Evidence, preserve failed/cancelled partial outcomes and spec drift, enforce quotas/path/secret protections, and cannot accept Flow, select integration or publish Git. [verify: judged]
12. Closed versioned HTTP/local-policy/WebSocket schemas, direction/state rules, error codes, replay/resync and storage/migration contracts are implemented and tested consistently; unsupported versions and partial migrations fail visibly without corrupting existing Hub data. [verify: judged]
13. Existing Hub browser SSO/token recovery, MCP scopes, connector/watch, local shell/serve and Telegram principal boundaries remain functional; native headless tool assembly and cancellation are implemented explicitly rather than inferred from existing result enums or finite replay. [verify: judged]
14. Automated tests use actual HTTP/WebSockets, two local serve processes, real supervised child cancellation and deterministic native provider/tool execution; crash/restart/duplicate/authorization/approval races and 375px RU/EN browser journeys pass alongside relevant type/lint/build/regression gates. [verify: judged]
15. Setup, local enrollment, capability diagnosis, stale/unknown recovery, backup/migration/rollback and transport verification instructions are provided; actual two-process and packaged-client checks are evidenced, and unexecuted real-model/public Cloudflare checks are explicitly pending rather than claimed passed. [verify: judged]
16. Implementation is delivered through an immutable Hub review-only Code Revision with exact-candidate Evidence and submitted for owner review; no self-acceptance, automatic Git/npm publication, runtime deployment or external access expansion occurs. [verify: judged]

## 14. Normative companion manifest

The following companion bytes are normative. The implementation agent must verify them against this pinned main specification; a changed normative companion requires a new specification decision, not a silent interpretation change. Hub readable-schema documents include exact JSON copies whose extracted schema bytes must match the JSON hashes below.

| Companion | SHA256 | Hub document |
|---|---|---|
| protocol.md | `73ab2306dff887acb844e5a9fb64f8cb86aae67468f1c62aac56c929df0849da` | specs/hub-remote-agents/protocol.md |
| security.md | `485a4b5d906066dbee0184edeef637d2b4af1d98738ec4d2d4def3be87f4655e` | specs/hub-remote-agents/security.md |
| schemas/machine-protocol.schema.json | `1b12794a19e71b5c094246657d6a31793bae982db6ebacb68bc4fe3716f7c3a6` | Exact JSON block in specs/hub-remote-agents/schemas.md |
| schemas/control-api.schema.json | `21db39728e2fd0ac2c6af3c6642e86f38267d46753dd939542648815e1b22112` | Exact JSON block in specs/hub-remote-agents/schemas.md |
| schemas.md | `45ef4cde11f64b3f68e5902a253d60cbdf09c0cae3d11416081330be0c979139` | specs/hub-remote-agents/schemas.md |
