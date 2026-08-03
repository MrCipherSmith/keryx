# Telegram Transport Protocol
Version: 2.2.0

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
| `BindingPort` | desktop setup -> transport core | Create, revoke, validate, and look up explicitly authorized chat and topic bindings. |
| `IdempotencyPort` | transport core -> local store | Atomically record update, pairing, callback, and send receipts. |
| `RoutingPort` | transport core -> binding store | Resolve an update to exactly one binding, or refuse. Never returns a best guess. |
| `QueuePort` | transport core -> local scheduler | Serialize per binding, parallelize across bindings, report queue position, refuse beyond the depth bound. |
| `TranscriptionPort` | transport core -> voice engine | Produce a transcript from bounded audio. Local implementation first; a remote implementation is opt-in and egress-governed. |
| `SynthesisPort` | transport core -> voice engine | Produce speech from **already-redacted** text. Same opt-in and egress rules. |
| `ProjectRegistryPort` | transport core -> Remote Entry | Read the user-global project registry. The transport keeps no second list of projects. |
| `CommandCatalogPort` | transport core -> Remote Entry | Read the command-registry projection used to generate the topic menu. The transport keeps no second list of commands. |
| `ProvisioningPort` | transport core -> Telegram adapter | Create, close, and reconcile topics for registered projects. |

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
| `maintenance.run` | Authorized binding bound to a project, operation present in the command registry, arguments valid for that entry | Runs the deterministic command. Not a prompt; no model unless the registry declares the operation model-backed. |
| `credential.request-handoff` | Authorized binding | Asks Remote Entry for a one-time, expiring, loopback-bound link. Never carries a secret. |

Unknown commands and unsupported intents are rejected with no privileged effect.
Free text in a **bound** chat maps to `task.submit`; free text in an unbound chat
maps to nothing. The policy response is authoritative: `allow` may proceed, `ask`
may create an approval request, and `deny` stops the flow.

`task.submit` declares the bound project path explicitly. The transport never
lets the entry infer the project, and never derives the path from message
content.

A voice message that transcribes successfully produces `task.submit` with the
transcript as its prompt. The transcript is untrusted content and is scanned
before conversion, exactly like typed text.

## Routing and refusal

`RoutingPort` resolves an update to exactly one binding
([topic-binding.schema.json](schemas/topic-binding.schema.json)) or refuses.
There is no result meaning "probably this one". A forum topic mapped to no
project is a terminal refusal, not a reason to consult the private-chat binding
or the only active session.

Authorization of the individual sender happens **before** routing. Membership of
an authorized supergroup is not authorization.

## Queueing

`QueuePort` keys on the binding. Work for one binding runs in order; different
bindings run concurrently. Position is reported at the moment of queueing.
Exceeding the depth bound is an explicit refusal with a safe message, never a
silent drop.

## Voice contracts

Voice is configured by [voice-config.schema.json](schemas/voice-config.schema.json)
and is disabled by default in both directions.

- Inbound audio is bounded by duration and size before download.
- `TranscriptionPort` attempts the local engine first. A remote implementation
  runs only when explicitly opted in for the install and permitted by the egress
  policy; the presence of a credential is not an opt-in.
- A failed transcription degrades to delivering the audio as a file marked not
  transcribed. The message is never discarded.
- `SynthesisPort` accepts only already-redacted text. There is no path from raw
  tool output or an unredacted error to audio.
- Duplicate delivery of one audio message produces one transcription and one
  turn.

## Provisioning protocol

Topics follow project registration, and ordering between forum configuration and
project registration must not matter. Provisioning state is recorded per
[topic-provisioning.schema.json](schemas/topic-provisioning.schema.json).

1. A project registers in the user-global registry through `keryx init`.
2. If a forum is configured, its preconditions — topics enabled, manage-topics
   permission — are checked *before* any topic is created. A missing permission
   is reported as exactly that.
3. The topic is created and bound. Re-registration is idempotent and reuses the
   existing topic.
4. Without a forum the project is recorded `pending`; configuring the forum
   provisions every pending project.
5. A project whose path disappears has its topic **closed, not deleted**, and
   reopening is an explicit operator action.
6. A topic deleted in Telegram clears its binding and returns the project to
   `pending`.

## Maintenance protocol

`CommandCatalogPort` supplies the invocable set. It is a projection of
`src/standard/command-registry.ts`; the transport maintains no list of its own,
so a command added to the registry appears without a transport change and a
command absent from it is not invocable.

Arguments are validated against the registry entry before anything runs. There
is no free-form command path and no passthrough. Registry flags drive both
presentation and classification: read-only operations are offered directly,
write operations are marked and classified `ask`, and model-backed operations
are marked as spending tokens with that cost stated in the approval.

## Credential handoff protocol

The transport never accepts a secret as a message. `credential.request-handoff`
asks Remote Entry for a link; the transport renders the opaque identifier and
expiry it receives. It never receives, stores, logs, or echoes credential
material, and the rendered message contains none.

Provider and model selection carry no secret and are ordinary maintenance
operations.

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
