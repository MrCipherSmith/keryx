# Security Policy: Telegram Transport
Version: 2.0.0

## Status

This is a future integration policy. It constrains a future adapter to the
existing Keryx Security/Policy boundary; it does not claim that the adapter
exists today.

## Relationship to Remote Entry

Caller authentication, the remote policy profile and its non-weakening
invariant, containment requirements, approval expiry and single-use semantics,
deny-on-undeliverable, origin stamping, and outbound redaction are defined in
[keryx-remote-entry/security-policy.md](../keryx-remote-entry/security-policy.md).
This document adds only Telegram-specific obligations. Where the two could be
read as conflicting, Remote Entry governs, and the transport may not relax it.

## Boundary change in 2.0.0

`task.submit` is permitted from a bound chat. A Telegram message can therefore
start agent execution, which version 1.0.0 excluded. The controls that pay for
this live in Remote Entry; the transport's obligations are:

- never emit `task.submit` from an unbound chat;
- always declare the bound project path explicitly, never derive it from message
  content;
- submit the prompt as untrusted content and abandon conversion on a security
  finding;
- never present a submitted prompt as pre-authorized, and never carry a hint,
  flag, or field that could influence policy classification.

## Trust model

- Telegram input is untrusted transport content, including commands, text,
  submitted prompts, callback data, sender identifiers, and provider errors.
  A prompt from a paired user is still untrusted content: pairing establishes
  *who may ask*, never *what may run*.
- A bot token authenticates the bot to Telegram; it is not evidence of a user's
  authority in Keryx.
- Authorization requires an explicit private-chat binding and optional local
  allowlist. Group/channel updates are outside Release 0.
- The desktop UI is the canonical management surface for connection, policy
  visibility, revocation, and emergency disablement.

## Required decision path

1. Bound input size and accepted update type before parsing semantics.
2. Apply update-id replay protection and explicit binding lookup.
3. Submit content to the existing security/prompt-injection boundary.
4. Convert only approved input forms into a typed intent.
5. Ask Harness policy to classify the intent as `allow`, `ask`, or `deny`.
6. Create an inline approval only for `ask`; never present `deny` as approvable.
7. Redact any retained evidence and outbound summary before persistence or send.

Failures in binding, replay protection, security policy, intent mapping, or
approval verification cause no privileged effect.

## Credential and secret controls

| Control | Requirement |
|---|---|
| Storage | Bot token is stored only by an OS credential store and referenced by opaque ID. |
| Prohibited locations | Git, config files, `.metaproject`, prompts, logs, ctx raw output, telemetry, fixtures, schemas, and notification text. |
| Access | Resolve credential only in the local adapter process at use time; never pass it through Harness intents. |
| Rotation | Desktop creates a new secret reference, validates it locally, invalidates the old reference, and requires re-establishment as configured. |
| Revocation | Desktop disables binding and transport immediately; subsequent input is unauthorized. |

## Approval containment

An approval view must state a concise action summary, scope, consequence,
expiry, and correlation ID. Its callback carries an opaque reference only.
Approval may confirm exactly one pending policy-`ask` action once. It cannot
broaden scope, change arguments, override a `deny`, revive expiry, or bypass
ownership checks.

## Data minimization, redaction, and retention

- Render concise summaries instead of raw local tool output.
- Do not disclose absolute local paths, secrets, PII, stack traces, or sensitive
  evidence unless a separate policy explicitly allows a redacted projection.
- Persist minimal redacted receipts, update checkpoints, nonce hashes, and safe
  delivery metadata only for an explicit retention period.
- Store nonce values and identifiers as protected hashes where lookup permits;
  never record raw token material.
- Correlate local and Telegram status using opaque correlation IDs, not secret
  or filesystem-derived values.

## Abuse and incident response

| Event | Required response |
|---|---|
| Unauthorized sender or unsupported update | Drop privileged processing; record only redacted safe evidence if policy permits. |
| Prompt injection finding | Stop typed-intent conversion and return a safe, non-revealing response where appropriate. |
| Replay/duplicate | Return idempotent safe result; never redo approval/action side effects. |
| Token compromise suspicion | Disconnect transport, revoke bindings, rotate credential through desktop, and preserve only redacted incident evidence. |
| Webhook conflict | Stop polling and require an explicit desktop decision. |

## Security validation

Release gates must include offline fixtures for token-like strings, injection
attempts, unbound senders, duplicate callbacks, expired nonces, raw path/tool
output, denied actions, and revoked credentials. No fixture may contain a real
Telegram token or call a live Telegram endpoint.
