# Product Requirements Document: Keryx Telegram Transport
Version: 2.2.0

## Status and recommendation

**Specification ready (future).** Build Release 0 as a local long-polling
private-chat transport **on top of
[keryx-remote-entry](../keryx-remote-entry/README.md)**, once that entry exists.
Do not build a separate Telegram agent runtime, and do not reach the harness
directly.

## Problem

A desktop agent is not always visible while it performs a long-running task, and
it cannot be reached at all when the operator is away from the terminal. Users
need a safe channel for progress, failures, time-bounded approvals, **and for
starting small pieces of work**, without granting a chat interface authority
over local project state.

Version 1.0.0 solved only the first half. Observability without the ability to
start anything still requires the operator to be at the keyboard, which is the
actual constraint.

Two further constraints surfaced from studying a working system (see
[brainstorm.md](brainstorm.md)):

- **One project is not enough.** An operator works across several projects. A
  transport that binds one project to one chat is a demonstration, not a tool.
  Reaching several projects needs a routing key that is not "the user".
- **Typing is the wrong input away from the desk.** The situations where remote
  reach matters — walking, driving, away from a keyboard — are exactly the ones
  where typing a prompt is impractical, and where reading a long reply is worse
  than hearing it.

## Goal

Allow explicitly paired users to receive concise, redacted task status, to
perform bounded companion actions — status check, approval of a policy-`ask`
action, cancellation of their own active operation, revocation through the
desktop UI — and to submit a turn to the project bound to their chat, under a
policy profile that is never weaker than the local one.

## Users

| User | Need |
|---|---|
| Solo developer | See a local run and handle an approval while away from the desktop. |
| Maintainer | Observe a long-running maintenance operation and receive clear failure summaries. |
| CI/operator | Receive bounded operational notifications without exposing a remote control plane. |

## Release 0 requirements

1. Pair only private chats explicitly bound to a local installation; a bot token
   does not establish user identity.
2. Provide a desktop-led wizard: paste token, locally call `getMe`, display QR
   code/deep link, process `/start`, atomically bind `chat_id`, then send a test
   notification.
3. Use long polling (`getUpdates`) by default. If an active webhook is detected,
   surface a conflict and require an explicit user choice; never switch modes
   silently.
4. Permit status, notifications, progress, redacted error summaries, approval
   requests, cancellation of the sender's own active operation, and submission
   of a turn from a chat bound to a project. Submission is a prompt to the
   policy-governed run loop, never a tool call.
4a. Support a forum supergroup with one project per topic, routed by topic
   identifier. A topic mapped to no project refuses; it never falls through to
   another chat's or another project's session. Membership of the supergroup
   grants nothing — each member is authorized individually.
4b. Serialize work per project and parallelize across projects: messages for one
   project run in order, different projects run concurrently, and a sender whose
   message is queued is told its position.
4c. Accept an inbound voice message as a prompt, and deliver a qualifying reply
   additionally as speech. Both directions are local-first and off by default;
   any remote transcription or synthesis service is opt-in and passes the egress
   policy.
4d. Provision a topic when a project registers through `keryx init`, reading the
   user-global project registry and keeping no second list of projects. Ordering
   between forum configuration and project registration must not matter.
4e. Offer the project's maintenance commands in its topic, with the menu
   generated from the command registry rather than written into the transport.
   A maintenance command runs the deterministic command; it does not become a
   prompt.
4f. Never accept a secret as a message. Setting a credential is done through a
   one-time, expiring, loopback-bound handoff link requested from Remote Entry.
   Provider and model selection carry no secret and are ordinary commands.
5. Convert every inbound update into a normalized receipt, then validate,
   authorize, scan, redact as needed, and map it to a typed intent. A message is
   never a direct tool call.
6. Show approvals as inline buttons with action summary, scope, expiry, and
   consequences. An approval can confirm only a Harness-policy `ask`; it can
   never override `deny`.
7. Persist enough deduplication state for `update_id`, approval nonce, and
   pairing nonce so restart or replay cannot re-execute a confirmed action.
8. Keep raw bot tokens out of repository files, `.metaproject`, configuration,
   prompts, traces, telemetry, fixtures, schemas, and command output.
9. Support revoke, token rotation, cancellation, timeouts, correlation IDs, and
   a final status visible in Telegram and in the local session.
10. Supply an offline fake Telegram adapter for deterministic integration tests.
11. Treat Task Manager as the sole owner of managed-flow state; Telegram may
    request a permitted action through Harness but never writes `flow.json`.

## Core scenarios

| Scenario | Expected result |
|---|---|
| Initial connect | Wizard validates a locally held credential, issues one-time pairing material, and confirms a private-chat binding. |
| Paired status check | Authorized chat receives a concise status mapped from a typed read-only intent. |
| Progress notification | Local Harness evidence becomes a redacted, correlated outbound notification. |
| Approval | Valid, unexpired callback confirms an already policy-`ask` action once. |
| Cancellation | Authorized sender cancels only their own active cancelable operation. |
| Disconnect/revoke | Desktop invalidates binding and the adapter stops delivery and acceptance for that binding. |
| Failed polling | Adapter exposes degraded state, retries within limits, and gives a final recoverable/terminal status. |
| Webhook conflict | Polling startup detects configuration conflict and waits for explicit desktop resolution. |
| Forum setup | Operator configures a forum supergroup; a topic is created per project and the topic↔project mapping is recorded. |
| Message in a project topic | Routed to that project's session by topic identifier, never by recency or by falling back to another chat. |
| Message in an unmapped topic | Refused with a clear explanation. No session is reached and no turn is created. |
| Concurrent projects | Two topics run turns concurrently; two messages in one topic run in order, and the second sender is told its queue position. |
| Deleted topic | Validation detects the topic is gone and clears the stale mapping. A transient network failure leaves the mapping untouched rather than clearing it. |
| Inbound voice | Voice is transcribed locally, becomes a prompt, and progress is visible while it happens. |
| Untranscribable voice | The audio is handed to the agent as a file rather than the message being lost. |
| Outbound voice | A qualifying reply — long enough, not mostly code, not a diff — is additionally delivered as speech, split so no clip exceeds the cap. |
| New project appears | Operator runs `keryx init` in a new project; it registers and its topic appears without any action in Telegram. |
| Registered before a forum exists | Projects wait as pending; configuring the forum provisions all of them at once. |
| Bringing a project up from the phone | Operator runs the maintenance commands from the topic — build graph, index wiki, enrich, analyze tests, health — with writes asking first and token-spending commands saying so. |
| Setting a provider credential | Operator picks provider and model as ordinary commands, then receives a one-time link and enters the secret locally. The secret never appears in Telegram. |

## UX requirements

- Minimize manual data entry: use QR/deep link rather than asking for a chat ID.
- Display connection state: disconnected, token validated, awaiting pairing,
  paired, polling active, or degraded.
- Use safe defaults and a desktop fallback for all sensitive management tasks.
- Make notifications short, actionable, and redacted; do not reveal absolute
  local paths, raw tool output, or secrets without a separate policy decision.

## Non-goals

Release 0 excludes ordinary group and channel operation, inline mode, Mini Apps,
Telegram Login/OIDC, webhooks, public remote control, and all direct privileged
tool execution.

Forum supergroups are **not** excluded — that is the 2.1.0 scope change, because
without them multi-project reach does not exist. What remains excluded is
treating supergroup membership as authorization: every member is authorized
individually, and an unauthorized member of an authorized supergroup is a
stranger.

Cloud transcription and synthesis are not excluded but are never the default:
they are opt-in per install and pass the egress policy, because sending a user's
voice to a third party is outbound movement of user content.

Free-text submission is no longer excluded — that is the 2.0.0 boundary change —
but it remains bounded: only from a bound chat, only as a prompt to the run loop,
and never as a way to name an action that skips policy classification. The
transport also does not define its own token scope, allowlist, session store, or
approval semantics; those belong to Remote Entry.

## Success criteria

- 100% of Release 0 inbound test cases pass validation, explicit chat binding,
  security scan, and typed-intent mapping before any action is considered.
- 100% of duplicate-update, replayed approval, expired pairing, revoked-token,
  and unauthorized-sender fixtures cause no privileged effect.
- 100% of outbound fixture snapshots contain no bot token, configured secret,
  absolute local path, or unredacted sensitive tool output.
- A paired status request and a valid approval produce a correlated final status
  in both fake Telegram and the local-session evidence fixture.
- Polling/webhook conflict is detectable before polling begins in every test
  fixture; automatic mode switching is absent.

## Risks

| Risk | Mitigation |
|---|---|
| Bot token compromise | OS credential store only, token rotation, desktop revoke, and redaction controls. |
| Prompt injection or spoofed command | Treat all updates as untrusted, scan first, then allow only typed intents. |
| Duplicate delivery/replay | Persist idempotency keys and consume pairing/approval nonces atomically. |
| User over-trusts Telegram control | Restrict scope; desktop remains canonical and `deny` is non-overridable. |
| The 2.0.0 perimeter expansion is treated as routine | The widening is recorded as a decision with named compensating controls in [keryx-remote-entry PRD](../keryx-remote-entry/prd.md) §Decision, and every one of them is an acceptance criterion, not an aspiration. |
| A paired user is treated as a trusted input source | Pairing establishes who may ask, never what may run. A prompt from a paired user is scanned as untrusted content and classified by the same policy engine as a TUI turn. |
| Transport drift from Remote Entry semantics | Approval timeout, allowlist, session addressing, and redaction are delegated, not re-specified; AC-15 asserts the transport defines none of its own. |
| A message reaches the wrong project | Routing is by topic identifier with an explicit refusal when a topic is unmapped. There is no fallback path that could deliver into another project's session, and a scenario test runs ≥4 concurrent sessions across ≥2 projects. |
| Supergroup membership mistaken for authorization | Membership grants nothing. Each member is authorized individually, and the authorization check runs before routing, not after. |
| Voice becomes a silent egress channel | Voice is local-first and off by default; any remote service is opt-in per install, declared in configuration, and passes the egress policy, which is the same boundary that governs every other outbound path. |
| Transcription error loses a message | An untranscribable voice message is handed to the agent as a file, and the failure is visible to the sender. |
| Stale topic mappings accumulate | Mappings are validated; a topic that Telegram reports as gone is cleared, while a transient failure leaves the mapping untouched and records the check as inconclusive. |
| Speech leaks content a text reply would have redacted | Synthesis runs on already-redacted text only. There is no path from raw tool output to audio. |
| A credential ends up in chat history | No route accepts one. The transport renders a handoff link carrying only an opaque identifier and expiry; the secret is entered locally. Direct entry exists only as an explicit private-chat fallback with named constraints and a rotation warning. |
| Maintenance becomes a shell | Only command-registry entries are invocable, arguments are validated against the registry entry, and the menu is generated rather than written. Widening the surface means changing reviewed code, not a bot. |
| Model spend is discovered after the fact | The registry declares which commands are model-backed; those state their cost in the approval before running. |
| The transport becomes a second project registry | It reads the user-global registry and holds no list of its own. A project exists because `keryx init` registered it, never because a topic was created. |
| Single-operator framing erodes the authorization checks | The per-sender checks stay. "The group is mine" stops being true the moment anyone is added, and the checks are nearly free. |
| Polling conflicts with webhook setup | Detect and stop with a clear desktop decision instead of silently changing transport mode. |

## Release 2+ consideration

A Telegram Mini App may later expose complex run lists, approvals, and session
browsing. It is not required to prove the safe companion model in Release 0.
