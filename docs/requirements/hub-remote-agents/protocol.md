# Remote agent transport, API and recovery protocol
Version: 0.1.1

Status: planned, normative companion to specification.md. Paths below are relative to /hub/v1; every route is new unless explicitly identified as existing. Schemas are in schemas/machine-protocol.schema.json and schemas/control-api.schema.json; their readable copies are in schemas.md.

## Transport and principals

Serve initiates WSS /machines/socket with subprotocol keryx.hub.machine.v1 and a machine Bearer header. Native-client Origin may be absent; an unexpected browser Origin is rejected. Browser events use WS /events/socket with same-origin HttpOnly human session and strict allowed Origin; browser Bearer/query-token access to the machine socket is rejected. Browser sockets send no commands. Authentication, project filtering and size checks occur before upgrade. No secret belongs in Sec-WebSocket-Protocol, URL or payload. Protocol version 1 is an application protocol, independent of MCP and local Telegram SSE.

Every application frame has v, type, messageId, epoch and payload; unknown fields/types are rejected. hello uses epoch 0; welcome establishes the positive epoch for subsequent frames. machineId is taken from authentication, never from a caller's assertion. Validate payload ownership on every frame. Direction is explicit:

| Frame | Direction | Meaning |
|---|---|---|
| hello | serve → Hub | Stable ledger identity, fresh daemonId, supported adapter versions, last durable Hub cursor and per-run event cursors. |
| welcome | Hub → serve | Admitted machine/epoch, heartbeat constants and replay/resync mode. |
| heartbeat / heartbeat-ack | serve → Hub / Hub → serve | Liveness only; neither grants execution nor acknowledges undelivered commands. |
| inventory | serve → Hub | Versioned allowlisted project/checkout/profile readiness projection. No arbitrary paths/env/executable arguments. |
| command | Hub → serve | Closed start-run, cancel-run or answer-approval operation; durable commandId, sequence, exact target, authority and expiry. |
| command-receipt | serve → Hub | Durable received/admitted/rejected/applied/not-applied result. A transport receipt alone is not process start, approval consumption or terminal stop. |
| run-event | serve → Hub | Durable per-run local seq and typed state, safe log, approval question/outcome or result-ready reference. |
| run-event-ack | Hub → serve | Highest contiguous local seq actually durably admitted for that run. Never accept a cursor for unsent events. |
| context-changed | Hub → serve | Project revision invalidation only. Fetch authoritative context via existing REST. |
| error | either | Closed sanitized code plus related message ID when known; no raw exceptions/content. |

Browser event frames are a separate closed invalidation shape (v, type=resource-changed, projectId, resource, resourceId, version). They tell TanStack Query what to refetch. Authoritative run/event data is fetched by scoped HTTP; project selection/auth changes cancel stale requests and close obsolete subscriptions.

## HTTP surface and roles

Human mutation means role operator, current authenticated session, Origin protection and Idempotency-Key. Human reviewer can inspect permitted project data but cannot launch/cancel/answer machine approvals in this feature. Existing Flow acceptance permissions are not changed. Existing agent MCP principals cannot impersonate human actions; adding MCP control tools is a later explicit decision. Machine auth only authorizes self-owned scoped reads, inventory/events/receipts and result uploads.

| Route | Principal | Contract |
|---|---|---|
| POST /machines/pairings | Human operator | PairingCreate; explicit nonempty project scopes; returns pairingId, expiry and secret code once. |
| POST /machines/enroll | One-use pairing capability | EnrollmentRequest; atomically consumes code and creates machineId plus secret once. Rate limited; no human/agent fallback. |
| GET /machines, GET /machines/:id | Scoped human | Metadata, inventory, lastSeen and readiness; no credentials/local absolute paths. |
| POST /machines/:id/revoke | Human operator | Expected machine version; revokes immediately, closes socket and records audit; local downloaded data is not erased. |
| GET /projects/:p/runs, GET /projects/:p/runs/:r | Scoped human | Bounded paginated summaries/details, with exact selected references and separate connection state. |
| POST /projects/:p/runs | Human operator | StartRunRequest; atomically records run, immutable request digest and durable start command, or refuses before dispatch. |
| POST /projects/:p/runs/:r/cancel | Human operator | CancelRequest; expected run version, idempotent cancellation request, no false cancelled response. |
| GET /projects/:p/runs/:r/events?after=N | Scoped human | Up to 500 events/512 KiB; cursor is highest contiguous admitted seq, with explicit retained-range gap metadata. |
| POST /projects/:p/runs/:r/approvals/:a/answer | Human operator | ApprovalAnswer; exact fingerprint/expiry/policy/run version, allow-once or deny. |
| POST /projects/:p/runs/:r/result | Owning machine | ResultUpload with same run/checkout/Flow pins; immutable review-bundle result and actual check reports only. |
| GET /machines/:id/recovery?after=N | Owning machine | RecoveryPage with up to100 known run/request/state projections, next cursor and replay boundary; no operation execution. |
| POST /machines/:id/reconciliations | Owning machine | ReconciliationReport bound to machine, ledger, daemon, project, checkout, run, command digest and expected version; returns a stored reconciliationId. |
| POST /machines/:id/commands/:commandId/authorize | Owning machine | AuthorizeCommand; current authority check and command-bound AuthorizationGrant valid at most5seconds, no execution by Hub. |
| POST /machines/:id/resolve-run | Human operator plus local reconciliation receipt | Expected version and observed local absence/ownership proof; resolution audited; never a remote force-unlock or PID kill. |

All JSON mutations except enrollment require operation keys; changed-payload reuse conflicts. Enumeration, individual resources, browser invalidations and replay are project-scoped. Known bad IDs cannot leak another project's existence/content. Missing/stale versions/digests return visible errors; no unrestricted status setter. Existing context/document/revision/Evidence endpoints retain their current contracts and guards. Machine reads of existing context/spec/Flow-reference routes require the new machine scope gate; do not reclassify machines as agent:connector.

Protocol errors: invalid-frame, unsupported-version, wrong-direction, stale-epoch, unauthorized, forbidden, scope-denied, stale-reference, machine-offline, machine-busy, checkout-dirty, setup-required, command-expired, payload-conflict, approval-expired, approval-not-applied, quota-exceeded, replay-gap, recovery-required and internal-error. HTTP uses existing 400/401/403/404/409/413 conventions; sanitized 429 handles rate limiting. Socket close codes follow RFC semantics (1000 normal, 1008 policy, 1009 size, 1011 internal, 1012 restart); never include private diagnostic data in close reasons.

## Request and state binding

StartRunRequest selects machineId, checkoutId, agentProfileId, flowId, expectedFlowVersion, expectedInventoryVersion, expectedHeadSha, specDigest, criteriaDigest, capabilityDigest, policyDigest and prompt. Hub verifies these against current canonical records; machine independently checks trusted local mapping, current HEAD/policy/profile and exact downloaded Flow/spec. criteriaDigest is SHA256 of the UTF-8 JSON.stringify serialization of the ordered frozen criteria array (no reordering/normalization); use this same algorithm on both sides. IDs/version/project in a stored immutable request are never replaced by later defaults.

Limits come from local profile plus Hub ceilings; browser cannot raise them. Server assigns runId, immutable createdBy/time and initial version. A commandDigest is SHA256 of UTF-8 JSON.stringify of this fixed-order tuple: [1, kind, commandId, hubSequence, runId, projectId, checkoutId, expectedRunVersion, expiresAt, authorizedBy, canonicalBody]. canonicalBody retains exact schema-valid values; object keys are serialized recursively in ascending Unicode code-point order (arrays retain order). Reject duplicate JSON keys before normalization. Transport messageId/epoch and later application authorization grants are excluded; expiresAt, actor, target and body are immutable. Replay never refreshes a command expiry. An expired command requires a separately authorized operation; it does not reuse an old command identity with new contents. Before frame delivery, Hub rechecks target enrollment/scope and current human launch authority, then stamps authorizedBy/expiry. Once a launch is admitted, the bounded local run may execute until completion/cancel/control loss; browser logout does not retroactively erase completed effects. Every new approval/cancel or renewed delivery still requires current authority.

Hub state vs observed runtime:

| Transition | Required evidence |
|---|---|
| dispatching → received | Local command claim durably stored; receipt does not claim execution. |
| received → starting | Validation passed, checkout lease and pre-start marker durably stored. |
| starting → running | Actual executor accepted, with local turn/session identity. |
| running ↔ waiting-approval | Exact broker question/consumption; unresolved question never counts as allow. |
| active → paused | Control disconnect reached a safe boundary; running tool may still be finishing until then. |
| active → cancelling → cancelled | Request, executor stop acknowledgement, then confirmed supervised work cessation. |
| active → succeeded/failed | Durable native result and actual outcome; checks and Flow acceptance remain separate. |
| uncertain → unknown | Lost process ownership or unreconciled crash; do not infer stopped/running. |
| unknown → running/terminal/lost | Authenticated reconciliation with actual local identity/absence, plus explicit human resolution when ownership remains ambiguous. |

reject is terminal for a start refused before execution. All terminal records are monotonic; an incompatible late terminal report is an explicit reconciliation incident, not silent replacement. Native tool side effects and external human filesystem edits cannot be made exactly once by a transport protocol. A running state event must carry nativeIdentity (sessionId, turnId, daemonId, supervisorHandleId); later state events retain it. These are opaque local references, not executable process identifiers or permission to kill.

## Local ledger and crash matrix

Keep unique identities for Hub command, run, native session/turn, daemon generation and supervised task. Do not substitute a vendor session handle or PID for any of these. Local SQLite claims/lease changes and outbox writes must be transactional and cross-process serialized; existing serve turn idempotency alone is only same-process safe.

| Crash boundary | Recovery |
|---|---|
| Before Hub transaction commit | No accepted run; replay HTTP with same key. |
| After Hub commit, before delivery | Durable outbox may redeliver while online, authorized and unexpired. |
| After local claim, before pre-start marker | Revalidate and admit the same run once; no distinct new run. |
| After pre-start marker, before/after spawn | Unknown until proven ownership/absence; never automatic spawn retry. |
| After start, before receipt reaches Hub | Replay stored events/receipts and reconcile existing runtime; never relaunch. |
| After durable approval decision, before local consumption | Re-deliver only while exact waiter/action/policy valid; expired/orphan approvals deny/abandon. |
| After local result, before Hub ack | Idempotently replay exact result/events; checks/revision are not duplicated. |
| After Hub result transaction, before response | Same key returns original exact revision/Evidence receipt. |

Daemon restart makes unresolved in-process executions unknown, not resumable promises. Reconciliation may attach only to a still-provable supervisor identity; otherwise preserve lease and require local recovery. Native session history is context, not proof that a suspended action may be rerun. No autonomous requeue of unknown starts.

## Bounded delivery, retention and reconciliation

Max 64 KiB encoded frame/32 KiB prompt/8 KiB log chunk. Output buffers have a 256 KiB per-connection high-water mark. Retain at most 10 MiB log data per run and seven days after terminal; use explicit dropped range/gap records. Critical receipts, approvals, terminal states and launch tombstones have separate durable storage. Do not acknowledge unpersisted critical events or prune unresolved launches. If a critical quota (1000 pending commands per machine or 100000 retained launch identities locally) is reached, refuse new launches with quota-exceeded; operators retain a recovery/export path. MVP has no automatic launch-identity pruning.

Both peers send/ack contiguous sequence cursors; sequence gaps trigger bounded replay. A log-gap frame at localSeq B+1 may cover the next unacknowledged range A..B only if A equals Hub cursor+1, no known critical event lies in the range and the local ledger retained the discarded records as log-only metadata. Hub transactionally records the explicit gap before advancing the cursor across A..B and then B+1. Overlapping, regressing, fabricated ranges or any range covering critical receipts/state/approvals are rejected; do not advance based on a numeric cursor alone. Log-only discard metadata is replayable until acknowledged. Critical events stay durable and are never represented by gaps. If retained logs cannot satisfy replay, send current state plus an explicit missing log range; do not regenerate or rerun execution. Each Hub command is additionally rechecked for expiry before local admission. Start TTL is 60 seconds; cancel delivery TTL is 60 seconds and an expired unresolved request remains visibly unconfirmed; the operator may issue a new idempotent cancel operation after refreshing state. Approval TTL is the local broker deadline, at most five minutes, and cannot be extended by delivery retries. Application heartbeat is not a durable-event acknowledgement.

On welcome resync-required, fetch every scoped RecoveryPage, compare stable ledger/run/command identities, submit ReconciliationReport for unresolved runs and replay retained critical events plus explicit log gaps. Do not infer executor state from Hub state alone. Reconciliation observations are owned-running, confirmed-stopped or unknown, with optional nativeIdentity; they are authenticated machine assertions, not tamper-proof proof of OS state. Hub stores a receipt bound to machine/ledger/daemon/project/checkout/run/expected version and received time. Human resolve-run must reference a matching receipt received within30seconds. Unknown cannot resolve to running/stopped/lost without additional actual local ownership/absence verification; an operator label alone cannot clear a filesystem lease.

Immediately before start, cancel application or approval consumption, call authorize with commandId/runId/commandDigest and current local policy digest (plus actionFingerprint for an approval). Hub rechecks current machine scope, stored command integrity/expiry, current actor/session/role and applicable run/action state, then returns grantId plus command/run/digest/policy/action/actor and an expiry no more than5seconds away. Verify exact binding, local monotonic elapsed time since authorization request less than5seconds, server deadline and local policy/broker state. Do not persist a grant for restart or apply it after reconnect; failed authorization stops that application. Cancellation is allowed under a tightened policy when it only stops a provably owned run; start/approval require matching pinned policy. Idempotency keys distinguish authorization attempts; lease renewal always performs a fresh authority check. A later role revocation may race with a live grant for at most5seconds; this bounded window is explicit.

Inventory is a versioned complete projection of only locally allowed mappings; missing entries become unavailable, never auto-delete local work. Reconnect first reconciles capabilities/policy/run state and missing events before admitting new starts. Stale epochs cannot update progress or consume approvals. A ledgerId mismatch on an enrolled machine is recovery-required and blocks dispatch; credentials alone do not assert that old execution claims survived.

## Persistence and migration

Add normalized tables in existing hub.sqlite: remote_schema_version, remote_machine, remote_pairing, remote_inventory, remote_run, remote_command (unique machineId/commandId and project/request-key scope), remote_event (unique runId/localSeq), remote_approval_projection, remote_authorization_grant, remote_reconciliation and remote_result_receipt. Store payload hashes alongside keys. Use parameterized SQL, foreign keys/project associations, indexed project/status/run cursors and the existing single mutation authority. The new store API must atomically update remote tables and existing hub_state when a result creates Code Revision/Evidence; two separate connections/cached snapshots are not a transaction.

Local checkout exclusivity additionally uses an atomic owner-nonce lock in the resolved per-worktree Git administration directory, shared across Hub enrollments and serve config roots; it must not be scoped only to a per-Hub database. No timeout-based stealing. Local control.sqlite stores ledger metadata, received commands/payload digests, runs/start markers, checkout leases, event outbox and ack/recovery cursors. Secret file is separate, 0600, parent0700. Real local canonical paths remain local. Hub stores request provenance and actor, last observed state/time, run pins and sanitized events, not local model/provider secrets. Open connections, active abort controllers and process handles are runtime-only and never reconstructed from a numeric PID.

Migration is additive/versioned and backed up consistently, with rollback on failure and explicit rejection of unsupported versions. One-process SQLite remains the scale boundary. Backup/restore reconciles machine local ledgers before dispatch: restored Hub cursors do not authorize replay of old side effects. Compatibility testing must include current JSON aggregate, sessions, SSO identities, Flow pins and integration line remaining unchanged.

## Sources and deployment assumptions

[Bun WebSockets](https://bun.sh/docs/runtime/http/websockets) documents upgrade, per-socket data and backpressure hooks; supported minimum runtime must still be tested directly. [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/) documents proxied connections, upgrade-time filtering and possible disconnects/keepalive. The application must authenticate/authorize frames and handle reconnection itself. These references support transport choices, not claims that this deployment is already configured.
