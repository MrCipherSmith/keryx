# PRD: Keryx Remote Entry
Version: 1.0.0

## Problem

The keryx agent is reachable only from the terminal that started it. `keryx
shell` binds the run loop to a TTY: it owns stdin, renders through OpenTUI, and
dies with the terminal. Everything below that renderer — the append-only
session, the allow/ask/deny policy engine, the approval gate, the OS sandbox,
budgets, resume — is already transport-neutral, but there is no second door.

Three concrete consequences:

1. **No reach.** A long local run cannot be observed or steered from a phone.
   The operator has to be physically at the machine.
2. **No embedding.** Another product cannot ask a keryx agent anything. The MCP
   server exposes read-only module services to *agents*, not a way for a
   *system* to submit work.
3. **Duplicated effort.** Telegram, a browser workspace, and third-party
   embedding are three separate integrations today. They are three clients of
   one missing surface.

## Goal

Add one transport-neutral entry point — `keryx serve` — so that reach,
embedding, and a future browser workspace are clients of a single, auditable,
policy-governed surface rather than three parallel paths into the agent.

## Non-goals

- Replacing the TUI.
- A public listener or hosted service.
- A second session store, policy engine, or provider adapter.
- Writing managed-flow state from outside Task Manager.

## Users and scenarios

| User | Scenario | Outcome |
|---|---|---|
| Operator away from the machine | A long local run hits a policy-`ask` mutation | Receives a bounded, redacted approval prompt on a paired client and answers it; the turn continues or is denied. |
| Operator on a phone | Wants to submit a small task to a project agent | Submits a turn; it runs under the remote policy profile with the sandbox required; result is streamed back redacted. |
| Integrating system | Wants a keryx answer inside another product | Authenticates with a bearer token, submits a turn against a stable `sessionId`, receives a typed result. |
| Security reviewer | Needs to know what a remote caller could do | Reads one policy profile and one origin marker, not per-transport rules. |

## Requirements

### Functional

| ID | Requirement |
|---|---|
| FR-01 | `keryx serve` starts a loopback-bound HTTP listener; binding to any non-loopback interface requires an explicit flag and an explicit configuration acknowledgement. |
| FR-02 | A turn submission reuses the existing harness run loop and the existing append-only session store. No new persistence layer is introduced. |
| FR-03 | `sessionId` continuity survives process restart, because the underlying session store already does. |
| FR-04 | Policy-`ask` actions raised during a remote turn become asynchronous pending approvals with an explicit expiry, delivered to the caller's transport. |
| FR-05 | Approval outcomes are one-time and idempotent: a replayed or duplicated response never re-executes the action. |
| FR-06 | Turn progress is streamable; a client that disconnects can re-attach to the same turn without duplicating side effects. |
| FR-07 | Every outbound payload passes the existing `src/security` redaction seam before it leaves the process. |
| FR-08 | Every turn records its origin (`local-tty` or `remote:<transport>`) in evidence. Origin is assigned by the server, never taken from request content. |
| FR-09 | Remote turns run under a named remote policy profile resolved from the existing policy source, never from a transport-local config. |
| FR-10 | Task Manager state is exposed read-only. No route writes `flow.json`. |

### Non-functional

| ID | Requirement |
|---|---|
| NFR-01 | Zero new runtime dependencies. The listener is built on the runtime's own HTTP server. |
| NFR-02 | Fail closed. Approval timeout, delivery failure, unresolvable policy, missing sandbox, or unavailable redaction all resolve to deny, never to allow. |
| NFR-03 | Off by default. A fresh install has no listener, no token, and no open port. |
| NFR-04 | An offline fake transport must be able to exercise the whole lifecycle with no network and no real token. |

## Decision: widening the Telegram boundary

`keryx-telegram-transport` v1.0.0 scoped Release 0 to a **companion**: the only
permitted intents were `status.read`, `operation.cancel-own`,
`approval.respond`, and `pairing.start`. Submitting work was an explicit
non-goal, on the reasoning that a chat message is untrusted content and should
never become agent execution.

**The decision recorded here is to widen that boundary** and permit
`task.submit` from an authorized remote caller. The reasoning is that the
companion boundary solves the wrong half of the problem: it makes the agent
observable but still requires the operator to be at the keyboard to start
anything, which is the actual constraint.

The original concern is not dismissed; it is paid for:

| Concern | Compensating control |
|---|---|
| A chat message becomes execution | The prompt is untrusted content and is scanned by `src/security` before it can become a turn. A finding stops intent conversion. |
| Remote reach means remote blast radius | Remote turns run under a remote policy profile that is **never weaker** than the local profile, and defaults to stricter: OS sandbox required, network off or restricted, every mutation an `ask`. |
| A remote caller escalates itself | A remote turn cannot widen its own policy, cannot approve its own `ask`, and cannot change its recorded origin. |
| Approvals become rubber stamps at distance | Approval views are bounded, state scope and consequence, expire, and are one-time. Timeout is deny. |
| Origin laundering | Origin is stamped by the server from the authenticated connection, not parsed from the payload. |

This widening is a real perimeter expansion. It is recorded here so that a later
reader sees a decision, not a drift.

## Success criteria

| ID | Criterion |
|---|---|
| SC-01 | A turn submitted over HTTP and the same turn typed into the TUI produce the same policy decisions and the same evidence shape, differing only in the recorded origin. |
| SC-02 | With the listener enabled and no valid token presented, no route produces any agent side effect. |
| SC-03 | An approval that is never answered denies at expiry, and the denial is visible in evidence. |
| SC-04 | Killing and restarting the server mid-turn does not re-execute a confirmed action on replay. |
| SC-05 | A secret-bearing fixture in tool output never appears in a streamed event, a turn result, or a transport notification. |
| SC-06 | A fresh `keryx init` opens no port and creates no token. |

## Risks

| Risk | Mitigation |
|---|---|
| The entry becomes a second owner of session state | It is an adapter over the existing store; the specification forbids a parallel store, and a contract test asserts a single writer. |
| Loopback-only is quietly relaxed by users | Non-loopback binding requires an explicit flag *and* config acknowledgement, and is reported in status output. |
| Approval fatigue drives blanket auto-approve | Auto-approve is read from the existing policy source only; the transport cannot define its own allowlist. |
| Streaming leaks raw tool output | Stream events are rendered from structured summary fields through the redaction seam, not from raw payloads. |
| Scope creep into a hosted product | Public/headless mode is explicitly a separate future release with its own operator-owned credential story. |

## Recommendation

Build Release 0 as a loopback-bound, token-authenticated, off-by-default entry
with asynchronous fail-closed approvals, and land the Telegram transport on top
of it rather than beside it.
