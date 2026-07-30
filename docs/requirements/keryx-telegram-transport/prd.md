# Product Requirements Document: Keryx Telegram Transport
Version: 2.0.0

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

## UX requirements

- Minimize manual data entry: use QR/deep link rather than asking for a chat ID.
- Display connection state: disconnected, token validated, awaiting pairing,
  paired, polling active, or degraded.
- Use safe defaults and a desktop fallback for all sensitive management tasks.
- Make notifications short, actionable, and redacted; do not reveal absolute
  local paths, raw tool output, or secrets without a separate policy decision.

## Non-goals

Release 0 excludes group/channel operation, inline mode, Mini Apps, Telegram
Login/OIDC, webhooks, public remote control, and all direct privileged tool
execution.

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
| Polling conflicts with webhook setup | Detect and stop with a clear desktop decision instead of silently changing transport mode. |

## Release 2+ consideration

A Telegram Mini App may later expose complex run lists, approvals, and session
browsing. It is not required to prove the safe companion model in Release 0.
