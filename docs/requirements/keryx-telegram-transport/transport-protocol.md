# Telegram Transport Protocol
Version: 2.0.0

## Purpose

This protocol defines the future provider-neutral boundary between Keryx and a
Telegram adapter. It uses Telegram only as a transport and never turns inbound
chat text into a provider SDK call, a direct tool call, or a domain command.

From 2.0.0 a bound chat may submit a *prompt* (`task.submit`). That is not an
exception to the rule above: the prompt reaches the policy-governed run loop
through [keryx-remote-entry](../keryx-remote-entry/README.md), where every action
it attempts is classified exactly as it would be for a turn typed into the TUI.
A message never names an action that skips classification.

## Ports

| Port | Direction | Contract |
|---|---|---|
| `InboundUpdatePort` | Telegram adapter -> transport core | Accept a normalized update receipt after provider parsing. |
| `IntentPort` | transport core -> Harness | Submit a validated, authorized, scanned typed intent with correlation and actor binding. |
| `OutcomePort` | Harness -> transport core | Publish a policy/result/evidence projection that is eligible for notification. |
| `NotificationPort` | transport core -> Telegram adapter | Deliver a bounded, redacted outbound notification. |
| `BindingPort` | desktop setup -> transport core | Create, revoke, and look up explicitly authorized chat bindings. |
| `IdempotencyPort` | transport core -> local store | Atomically record update, pairing, callback, and send receipts. |

## Normalized inbound receipt

The adapter extracts only the data needed for routing and stores it as
`normalized-inbound-update-receipt.schema.json`: `updateId`, update kind,
chat/user identifiers, bounded text or callback data, received timestamp, and a
correlation ID. Raw provider payloads are not a domain contract and must be
redacted before any diagnostic retention.

## Typed intents

| Intent | Preconditions | Effect |
|---|---|---|
| `pairing.start` | Private chat, valid unconsumed pairing nonce | Requests binding creation. |
| `status.read` | Authorized binding | Requests a safe read-only status projection. |
| `approval.respond` | Authorized binding, valid callback nonce | Confirms or rejects a pending policy-`ask` action once. |
| `operation.cancel-own` | Authorized binding and ownership match | Requests cancellation through the Harness. |
| `task.submit` | Authorized binding **bound to a project**, prompt within bounds, security scan clean | Submits the prompt as a turn against the declared project path. |

Unknown commands and unsupported intents are rejected with no privileged effect.
Free text in a **bound** chat maps to `task.submit`; free text in an unbound chat
maps to nothing. The policy response is authoritative: `allow` may proceed, `ask`
may create an approval request, and `deny` stops the flow.

`task.submit` declares the bound project path explicitly. The transport never
lets the entry infer the project, and never derives the path from message
content.

## Approval callbacks

`approval-callback.schema.json` carries an opaque callback ID, decision,
binding ID, expiry, and correlation ID. Callback data must not encode a bot
token, raw action arguments, filesystem paths, or secrets. The transport checks
binding, nonce, expiry, and idempotency before forwarding a response.

## Outbound notifications

`outbound-notification.schema.json` contains structured category, severity,
summary, correlation ID, and optional safe approval view. Rendering applies
message-size limits, policy redaction, per-chat rate limits, and delivery
idempotency. A delivery receipt records safe metadata only.

## Pairing protocol

1. Desktop resolves a local credential reference and validates it with `getMe`.
2. It creates a short-lived, one-time, opaque pairing nonce bound to the local
   installation, not to a bot token or user identity claim.
3. Desktop displays QR/deep link containing that nonce; the private chat sends
   `/start <nonce>`.
4. The transport validates nonce expiry, one-time use, private-chat constraint,
   optional allowlist, and security scan.
5. It atomically records the authorized binding, consumes the nonce, and sends a
   redacted test notification.

## Polling and webhook protocol

Before `getUpdates`, the adapter checks current webhook state. An active webhook
creates a `webhook-conflict` result and no polling begins. Future webhook mode
uses `webhook-configuration.schema.json`, HTTPS, a configured `secret_token`,
allowlisted update types, rate limits, and the same receipt/idempotency flow.

## Error contract

Every failure becomes a structured local result with category, recoverability,
correlation ID, redacted user summary, and terminal/retry state. Retryable
transport failures use bounded backoff; authorization, policy, expiry, and
replay failures are terminal and never retried as new actions.

## Official references

The design relies only on official Telegram documentation for bot updates,
inline keyboards/callbacks, deep links, polling, and webhooks:
[Bot API](https://core.telegram.org/bots/api),
[Bot features](https://core.telegram.org/bots/features), and
[webhooks](https://core.telegram.org/bots/webhooks).
