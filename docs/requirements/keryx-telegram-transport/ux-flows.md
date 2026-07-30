# UX Flows: Telegram Transport
Version: 2.0.0

## Experience principle

Telegram is a low-friction remote surface. The desktop UI is the authoritative
place for setup, policy inspection, revocation, and recovery; Telegram gives
brief, safe, time-bounded interactions — and, from 2.0.0, the ability to start a
turn against the project bound to the chat.

## Connection states

| State | Desktop presentation | Telegram presentation |
|---|---|---|
| Disconnected | Connect action and reason, if known | No assumption of availability. |
| Token validated | Credential check succeeded without exposing token | Not yet paired. |
| Awaiting pairing | QR/deep link with expiry and cancel action | `/start` pairing handoff. |
| Paired | Bound chat and test-message result; revoke action | Safe connected confirmation. |
| Polling active | Last update/checkpoint and stop action | Status/notification capable. |
| Degraded | Cause, retry state, desktop recovery options | Short degraded/final status if delivery remains possible. |

## Initial connect

1. User opens the desktop transport settings and chooses Telegram companion.
2. User pastes a token into the OS-credential-store flow; UI never writes it to
   ordinary configuration.
3. Local process validates it with `getMe` and shows only safe bot identity
   information.
4. UI shows a short-lived QR/deep link. User opens it and presses Telegram
   Start, producing `/start <pairing-code>`.
5. Local adapter validates code, private-chat constraint, allowlist, and policy;
   it binds the chat once and sends a test message.
6. UI presents `paired` and enables desktop revoke/disconnect.

## Paired status check

1. User sends the supported status command or selects a predefined status UI.
2. Transport authenticates the binding, scans the input, and maps it to
   `status.read`.
3. Harness returns a safe status projection; transport redacts and renders a
   short correlated message.
4. Text that is not a supported command is handled per the chat's binding: in a
   project-bound chat it becomes a `task.submit` prompt (see Turn submission
   below); in an unbound chat it receives a constrained help/fallback response
   and starts nothing.

## Turn submission

1. User sends free text in a chat bound to a project.
2. Transport authenticates the binding, bounds the input, and submits it to the
   security boundary as untrusted content. A finding stops here: the reply says
   only that the prompt was rejected.
3. Transport emits `task.submit` with the bound project path declared
   explicitly, and receives a turn id.
4. Progress renders as a single edited message — a placeholder, throttled edits
   while the turn runs, one final formatted edit — with overflow continuing as
   further messages rather than being truncated.
5. Any policy-`ask` raised during the turn appears as an approval card (see
   Approval below). Unanswered, it denies at expiry; undeliverable, it denies at
   once.
6. The terminal outcome is rendered redacted, correlated with the same id the
   local session records.

## Progress and failure notification

1. Harness emits evidence/outcome for an operation already authorized locally.
2. Transport filters notification category, applies policy/redaction and message
   limits, then queues a correlated outbound notification.
3. Telegram shows progress or a concise failure summary with desktop fallback.
4. Local session records the same final delivery/result state without exposing
   raw provider or tool payloads.

## Approval

1. Harness classifies an already requested action as `ask`.
2. Telegram receives an inline approval card: action summary, scope,
   consequence, expiry, and approve/reject controls.
3. Pressing a button produces an opaque callback. Transport checks binding,
   callback nonce, expiry, deduplication, and policy context.
4. Valid response is forwarded once. Expired, replayed, and denied actions show
   a safe final state; a `deny` never appears as an approvable card.

## Cancellation

1. User selects cancel for their own active operation.
2. Transport verifies binding and operation ownership, then requests cancellation
   from Harness with a correlation ID.
3. Telegram and local session show accepted, completed, failed, or timed-out
   cancellation status. Task Manager state is never edited by Telegram.

## Disconnect, revoke, and recovery

- **Disconnect:** desktop stops polling and moves state to `disconnected`.
- **Revoke:** desktop invalidates binding and rejects all later Telegram input.
- **Failed polling:** desktop shows retry/degraded state and an explicit retry or
  disconnect choice; Telegram gets a safe final status only when deliverable.
- **Webhook conflict:** desktop explains that an active webhook blocks polling
  and presents an explicit resolution path. It does not auto-delete a webhook or
  silently change modes.
