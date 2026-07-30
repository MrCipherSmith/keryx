# Security Policy: Telegram Transport
Version: 2.1.0

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

## Additions in 2.1.0

Forum supergroups and voice both widen the attack surface, each in a specific
way.

### Membership is not authorization

A supergroup has members the operator did not individually choose, and its
membership can change without the transport being told. Therefore:

- every sender is authorized individually, and the check runs **before**
  routing, so an unauthorized member never reaches binding resolution;
- an unauthorized member of an authorized supergroup is treated exactly as a
  stranger: dropped, with no acknowledgement that would confirm the bot's
  presence or the project's existence;
- losing authorization takes effect immediately for new updates; it does not
  wait for a cache to expire.

### Cross-project delivery is a security failure, not a bug class

Routing resolves to exactly one binding or refuses. A topic mapped to no project
is a terminal refusal. There is no fallback to a private-chat binding, to the
only active session, or to the most recent one.

The reason this is stated as a security rule rather than a correctness one: a
wrong guess delivers one project's prompt into another project's session, under
that project's policy profile and filesystem scope, and the operator does not
find out until after the turn has run.

### Voice is an egress channel

Audio is user content. A recording carries the operator's voice and whatever was
said near the microphone; a synthesized reply carries the reply.

| Control | Requirement |
|---|---|
| Default | Both directions disabled. A fresh configuration contacts no voice service. |
| Local first | When enabled, the local engine is attempted before any remote one. |
| Remote opt-in | A remote service requires an explicit per-install acknowledgement. The presence of an API key is **not** an opt-in. |
| Policy | Every remote call passes the egress policy, the same boundary as any other outbound path. A denial means no audio leaves the process. |
| Redaction ordering | Synthesis accepts already-redacted text only. There is no path from raw tool output, raw provider payload, or an unredacted error to audio. What may not be written may not be spoken. |
| Bounds | Inbound audio is bounded by duration and size before download. |
| Retention | Audio and transcripts are retained only as long as the configured retention allows, and transcripts are redacted like any other retained content. |
| Failure | A transcription failure degrades to handing the audio to the agent as a file. It never silently discards the message, and it never falls back to a non-opted-in remote service. |

## Trust model

- Telegram input is untrusted transport content, including commands, text,
  submitted prompts, **transcribed audio**, callback data, sender identifiers,
  and provider errors. A prompt from an authorized user is still untrusted
  content: authorization establishes *who may ask*, never *what may run*.
- A transcript is model output derived from untrusted audio. It is scanned
  before conversion exactly as typed text is, and is never trusted more because
  a transcription engine produced it.
- A bot token authenticates the bot to Telegram; it is not evidence of a user's
  authority in Keryx.
- Authorization requires an explicit per-sender authorization plus a resolved
  binding — a private chat or a forum topic mapped to exactly one project.
  Ordinary group and channel updates remain outside Release 0.
- The desktop UI is the canonical management surface for connection, policy
  visibility, revocation, and emergency disablement.

## Required decision path

1. Bound input size, audio duration, and accepted update type before parsing
   semantics.
2. Authorize the individual sender. This precedes routing.
3. Apply update-id replay protection, then resolve exactly one binding or
   refuse. Never fall back to another binding.
4. For audio: transcribe local-first, remote only when opted in and permitted by
   the egress policy.
5. Submit content — typed text or transcript alike — to the existing
   security/prompt-injection boundary.
6. Convert only approved input forms into a typed intent.
7. Ask Harness policy to classify the intent as `allow`, `ask`, or `deny`.
8. Create an inline approval only for `ask`; never present `deny` as approvable.
9. Redact any retained evidence and outbound summary before persistence or send.
10. Synthesize speech, if at all, only from the text produced by step 9.

Failures in sender authorization, binding resolution, replay protection,
security policy, intent mapping, or approval verification cause no privileged
effect.

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
| Unauthorized sender or unsupported update | Drop privileged processing; record only redacted safe evidence if policy permits. An unauthorized member of an authorized supergroup is handled identically to a stranger, with no acknowledgement. |
| Update in a topic mapped to no project | Terminal refusal. No binding is substituted and no session is reached. |
| Binding validation inconclusive | Leave the binding untouched and record the check as inconclusive. A transient failure must never clear a real mapping, and must never be treated as evidence to route elsewhere. |
| Voice service denied by egress policy | No audio leaves the process. Inbound degrades to delivering the file; outbound simply sends no speech. Neither falls back to a non-opted-in service. |
| Prompt injection finding | Stop typed-intent conversion and return a safe, non-revealing response where appropriate. |
| Replay/duplicate | Return idempotent safe result; never redo approval/action side effects. |
| Token compromise suspicion | Disconnect transport, revoke bindings, rotate credential through desktop, and preserve only redacted incident evidence. |
| Webhook conflict | Stop polling and require an explicit desktop decision. |

## Security validation

Release gates must include offline fixtures for token-like strings, injection
attempts, unbound senders, duplicate callbacks, expired nonces, raw path/tool
output, denied actions, and revoked credentials.

2.1.0 adds: an unauthorized member of an authorized supergroup; an update in an
unmapped topic; concurrent updates across at least four sessions and two
projects asserting no cross-delivery; inconclusive binding validation asserting
the mapping survives; a fresh configuration asserting no voice service is
contacted; a credential present without an opt-in asserting the same; an egress
denial on each voice direction; a transcription failure asserting file
degradation rather than loss; duplicate audio delivery asserting one turn; and
secret-bearing reply fixtures asserting synthesis runs on redacted text only.

No fixture may contain a real Telegram token, call a live Telegram endpoint, or
send audio to a real voice service.
