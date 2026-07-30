# Specification: Keryx Telegram Transport
Version: 2.2.0

## Identity and status

`keryx-telegram-transport` is a future optional adapter that reaches the Project
Agent Harness **through [keryx-remote-entry](../keryx-remote-entry/README.md)**.
It provides a Telegram-specific transport port and owns neither domain state,
Harness policy decisions, nor Task Manager state. No runtime module, CLI
command, bot, or provider SDK is introduced by this specification.

## Delegated concerns

The following are specified once in Remote Entry and must not be re-specified,
varied, or locally configured here:

| Concern | Defined in |
|---|---|
| Caller authentication and token handling | [remote-entry security-policy](../keryx-remote-entry/security-policy.md) |
| Session addressing (identity-first, exact project match) | [remote-entry specification](../keryx-remote-entry/specification.md) |
| Asynchronous approval lifecycle, expiry, one-time semantics, deny-on-undeliverable | [remote-entry specification](../keryx-remote-entry/specification.md) |
| Remote policy profile, non-weakening invariant, containment requirement | [remote-entry security-policy](../keryx-remote-entry/security-policy.md) |
| Origin stamping | [remote-entry specification](../keryx-remote-entry/specification.md) |
| Redaction of every outbound payload | [remote-entry security-policy](../keryx-remote-entry/security-policy.md) |

Telegram owns: pairing, chat binding, update normalization and idempotency,
rendering, delivery, rate-limit behaviour, and the mapping between a bound chat
and a Remote Entry caller identity.

## Architecture and ownership

| Concern | Owner | Telegram transport responsibility |
|---|---|---|
| Local agent lifecycle, typed intents, policy classification, evidence | Future Harness | Submit normalized typed intents and consume permitted outcomes. |
| Managed-flow state, retries, review/fix, completion | Task Manager / `src/flow` | Read a safe projection only; never write `flow.json`. |
| Security scan, redaction, policy boundary | `src/security` / Security-Policy | Submit untrusted inbound content and outbound candidates to the existing boundary. |
| Project graph, wiki, memory, skills, testing, health, evidence | `.metaproject` | Reference authoritative local services; never shadow their state. |
| Telegram updates, message rendering, pairing, delivery receipts | Telegram adapter/transport port | Normalize provider data, maintain transport-local idempotency, and render safe notifications. |

The adapter depends inward on provider-neutral ports. A provider SDK, if added in
the future, must be behind the adapter boundary and must not leak Telegram
objects into Harness domain contracts.

## Configuration and credential model

`telegram-transport-config.schema.json` stores mode and safe references only.
The actual token is resolved through an OS credential store using
`credential-reference.schema.json`. A raw token is forbidden in config,
repository files, prompts, trace output, telemetry, schema fixtures, and
`.metaproject` artifacts.

## State machine

```text
disconnected -> token-validated -> awaiting-pairing -> paired -> polling-active
                                                  \-> disconnected
polling-active -> degraded -> polling-active | disconnected
any non-terminal state -> disconnected
```

- `disconnected`: no active transport session or a locally revoked credential.
- `token-validated`: credential reference resolved and `getMe` succeeds locally;
  validation result must be redacted in evidence.
- `awaiting-pairing`: an unconsumed, expiring pairing code exists.
- `paired`: an explicitly authorized private `chat_id` binding exists.
- `polling-active`: polling is running with the allowed update types and a
  persisted `update_id` checkpoint.
- `degraded`: delivery/polling cannot meet its current retry policy; the local
  UI presents recovery state and a final status is emitted when possible.

Polling startup must inspect active webhook state. A detected webhook is a
blocking `webhook-conflict` condition, not an implicit migration to webhook or
a destructive webhook deletion.

## Inbound lifecycle

```text
Telegram update
  -> size/type validation
  -> update_id idempotency and ordering check
  -> explicit private-chat authorization
  -> security and prompt-injection scan
  -> typed intent mapping
  -> Harness policy (allow | ask | deny)
  -> optional one-time approval
  -> Harness evidence/result
  -> redaction and outbound notification
```

Only these Release 0 typed intents may be emitted: `status.read`,
`operation.cancel-own`, `approval.respond`, `pairing.start`, and `task.submit`.
Unknown commands, unsupported update types, group/channel updates, or security
failures yield no privileged action. A policy `deny` is final; Telegram cannot
turn it into an approval.

`task.submit` carries a prompt to `POST /v1/turns` on Remote Entry against the
project bound to this chat. It is not a tool call. The prompt is untrusted
content: it is scanned before conversion, and every action the resulting turn
attempts is classified by the harness policy engine exactly as it would be for a
turn typed into the TUI. Free text in a bound chat maps to `task.submit`; free
text in an unbound chat maps to nothing.

### Chat-to-project binding

A bound chat resolves to exactly one project path, and `task.submit` declares
that path explicitly to Remote Entry. The transport never lets Remote Entry
infer the project, and never submits with the project field derived from message
content. A chat bound to no project can observe and approve but cannot submit.

A private chat binds one project. A forum supergroup binds one project per
topic; see below.

## Multi-project routing

Reaching several projects from one place is a Release 0 requirement, not a later
convenience. The routing key is the **topic**, not the user.

### Topic provisioning follows project registration

The forum is configured once. After that, **topics follow `keryx init`**: a
project that registers in the user-global project registry gets a topic, and the
mapping is recorded as [topic-binding.schema.json](schemas/topic-binding.schema.json)
with its lifecycle in [topic-provisioning.schema.json](schemas/topic-provisioning.schema.json).

Setup requires the supergroup to have topics enabled and the bot to hold the
permission to manage them. Both are checked before any topic is created, and a
missing permission is reported as exactly that rather than as a generic failure.

Ordering must not matter, because it will vary in practice:

| Situation | Behaviour |
|---|---|
| Forum configured, then a project registers | The topic is created at registration. |
| Projects registered before any forum exists | Each is recorded `pending`. Configuring the forum provisions every pending project. |
| Project re-registered (init re-run) | Idempotent. The existing topic is reused; a second topic is never created for one project. |
| Registered project's path disappears | The registry marks it `missing`. The topic is **closed, not deleted** — it holds the conversation — and reopening is an explicit operator action. |
| Topic deleted in Telegram | Binding validation clears the mapping and the project returns to `pending`, so re-provisioning is possible. |

The transport reads the project registry and never keeps a second list of
projects. A project's presence is decided by `keryx init`, not by Telegram.

### Resolution

```text
update arrives
  -> sender authorized individually?        no  -> drop, no privileged effect
  -> forum topic id present and not General?
       yes -> project bound to this topic?
                yes -> that project's session
                no  -> REFUSE with an explanation
       no  -> the project bound to this private chat
                none -> constrained help response
```

The refusal on an unmapped topic is a hard requirement. There is no fallback
path — not to a private-chat binding, not to the only active session, not to the
most recent one. A transport that guesses here delivers one project's prompt
into another project's session, and the guess is invisible to the operator until
after the turn has run.

Supergroup membership authorizes nothing. Every member is authorized
individually, and the check runs **before** routing.

### Binding validation

A topic can be deleted in Telegram without the transport being told. Bindings
are therefore validated, and validation has three outcomes:

| Outcome | Action |
|---|---|
| Topic confirmed present | Binding retained. |
| Telegram reports the topic does not exist | Binding cleared, recorded, and reported. |
| Validation inconclusive — rate limit, network failure, unknown error | Binding **left untouched** and the check recorded as inconclusive. A transient failure must never clear a real mapping. |

The Bot API offers no way to enumerate a forum's topics. Synchronization can
therefore create missing topics but cannot discover topics that belong to no
project. This is a platform limitation, stated here so it is designed around
rather than discovered during implementation.

### Concurrency

Work is serialized per binding and parallel across bindings. The queue key is
the topic binding — private chat or forum topic — so two projects progress
concurrently while two messages for one project run in order.

A sender whose message is queued behind others is told its position at the
moment of queueing, not after the wait. Queue depth is bounded; exceeding the
bound is an explicit refusal, never a silent drop.

## Operating a project from its topic

A topic is where a project is operated, not only where it is discussed. Two
distinct things can be asked for in it, and conflating them would be expensive:

| | `task.submit` | `maintenance.run` |
|---|---|---|
| Input | Free text or a transcript | A command chosen from the registry |
| Executes | A model turn | A deterministic command |
| Cost | Tokens, always | Tokens only if the registry says so |
| Source of truth | — | `src/standard/command-registry.ts` |

Asking a model to decide to rebuild a graph is paying for a decision that was
already made, and inserting a nondeterministic step into an operation that had
none. So maintenance is its own intent.

### The menu is generated, not written

The transport renders its command menu from the registry projection Remote Entry
exposes. It maintains no list of its own. A command added to the command
registry appears in the topic with no transport change; a command absent from
the registry is not invocable, and there is no free-form command path.

The registry's per-command flags drive presentation as well as policy:

- read-only operations are offered directly;
- operations that write to the project are marked as such, and are `ask`;
- model-backed operations are marked as costing tokens, and the approval says so
  — spending should be a decision, not a discovery.

### Setup without a web UI

Everything needed to bring a project up is reachable from its topic: register
what is there, build the graph, index and enrich the wiki, analyze tests, run
health, choose a provider, choose a model.

**Secrets are the exception.** The transport never accepts a secret as a
message. It requests a credential handoff from Remote Entry and renders the
resulting one-time, expiring, loopback-bound link. The operator opens it and
enters the value locally, and it goes straight to the credential store. Nothing
secret is ever in a Telegram message, in its history, or in the bot's update
stream.

Provider and model *selection* carry no secret and are ordinary commands.

If the operator is away from the machine the loopback link is unreachable; that
needs the non-loopback bind, which already requires an explicit flag and
acknowledgement. Direct entry in a private chat exists only as the explicit,
constrained fallback described in [security-policy.md](security-policy.md).

## Voice

Voice is Release 0 in both directions. Both directions are **local-first and off
by default**, configured through
[voice-config.schema.json](schemas/voice-config.schema.json).

### Inbound

```text
voice message
  -> sender authorized, binding resolved (routing rules above)
  -> bounded duration and size
  -> transcription: local engine first; a remote service only when explicitly
     enabled for this install and permitted by the egress policy
  -> transcript is untrusted content -> security scan
  -> task.submit
```

Progress is visible while it happens: one status message, edited through its
phases — queued with position, downloading, transcribing — rather than silence
followed by a result. Duplicate delivery of the same message identifier produces
no second transcription and no second turn.

**Failure degrades, it does not discard.** When transcription cannot produce a
transcript, the audio is handed to the agent as a file with an explicit
"not transcribed" marker, and the sender is told. Losing the message is not an
acceptable outcome.

### Outbound

A reply is additionally delivered as speech only when it is worth hearing.
Qualification is deterministic and testable:

| Rule | Reason |
|---|---|
| Below a minimum length → no speech | A one-line answer is faster read than heard. |
| Code exceeds a share of the text → no speech | Spoken code is unusable. |
| The text is a diff → no speech | Same. Markdown bullets must not be mistaken for diff lines. |

Qualifying text is stripped of markup, then split so that no single clip exceeds
the duration cap. Splitting prefers paragraph, then sentence, then line, then
word boundaries, and never cuts mid-word.

An optional normalization pass may rewrite the text so it reads naturally aloud
— path to filename, identifier to words, call syntax removed. It is optional
because it costs a model call per reply. When normalization is enabled it must
be verified not to have changed the language of the text; if it has, the
un-normalized text is used instead.

### Voice is a redaction boundary, not a bypass

Synthesis runs on **already-redacted** reply text. There is no path from raw
tool output, raw provider payload, or an unredacted error to audio. Everything
that may not be written may not be spoken.

Remote transcription or synthesis moves user content — a recording of the
operator's voice, or the content of a redacted reply — to a third party. It is
therefore treated as egress: opt-in per install, declared in configuration, and
subject to the same policy boundary as any other outbound path. It is never
enabled implicitly by the presence of an API key.

## Transport protocol and data contracts

The provider-neutral contract is defined in [transport-protocol.md](transport-protocol.md).
All JSON contracts use Draft 2020-12 and are versioned:

- [Telegram transport configuration](schemas/telegram-transport-config.schema.json)
- [Credential reference](schemas/credential-reference.schema.json)
- [Pairing request](schemas/pairing-request.schema.json)
- [Pairing result](schemas/pairing-result.schema.json)
- [Authorized chat binding](schemas/authorized-chat-binding.schema.json)
- [Normalized inbound update receipt](schemas/normalized-inbound-update-receipt.schema.json)
- [Outbound notification](schemas/outbound-notification.schema.json)
- [Approval callback](schemas/approval-callback.schema.json)
- [Webhook configuration](schemas/webhook-configuration.schema.json)

Every async transport operation carries `correlationId`, supports cancellation
where applicable, has an explicit timeout, and produces a final local and
Telegram-facing status. Notification text is bounded in size and rendered from
structured summary fields; raw provider/tool payloads are not forwarded.

## Reliability and lifecycle rules

- **Idempotency/order:** use Telegram `update_id` as the deduplication and
  ordering key. Persist a checkpoint only after the update reaches a terminal
  safe outcome. Pairing and approval nonces are one-time and atomically
  consumed.
- **Retries/rate limits:** retry only transient polling or send failures with
  bounded exponential backoff and jitter. Do not retry non-idempotent policy or
  approval effects without their idempotency key. Apply per-chat and global
  outbound limits before send.
- **Cancellation:** cancellation requires the binding owner and an operation
  ownership match. It requests cancellation through a future Harness port; it
  never edits Task Manager records directly.
- **Rotation/revoke:** token rotation invalidates the old credential reference
  and forces a fresh local validation. Desktop revoke disables binding, removes
  future authorization, and stops dispatch for that chat.
- **Retention/redaction:** retain only minimal redacted transport evidence and
  idempotency metadata for an explicitly configured period. Never retain raw
  token material; redact secret/PII/prompt-injection findings before persistence
  or notification.

## Local polling versus server webhook

Release 0 runs locally through long polling and requires no public endpoint.
Future headless/server mode is a separate release and requires HTTPS, Telegram
webhook `secret_token`, explicit allowed update types, rate limiting,
idempotency persistence, observability, and an operator-owned credential store.
It must not reuse the local mode's assumptions about user presence or storage.

## Testability

An offline fake Telegram adapter is required. It must inject updates,
simulate duplicate/reordered delivery, webhook conflict, send failures, callback
presses, and restart checkpoints without any network call or token. Contract
tests validate all schemas; scenario tests validate the lifecycle against fake
Harness, policy, security, evidence, and Task Manager projection ports.

## Acceptance criteria

| ID | Given / when / then |
|---|---|
| AC-01 Happy path | Given a valid credential reference and an unpaired local install, when `/start` carries an unexpired one-time pairing code, then one private `chat_id` binding is created and a redacted test notification is sent. |
| AC-02 Unauthorized sender | Given an unbound or non-allowlisted chat, when it sends any update, then no Harness intent, approval, cancellation, or notification side effect is produced. |
| AC-03 Duplicate update | Given a terminally processed `update_id`, when it is delivered again, then it creates no second action, approval, or dangerous notification. |
| AC-04 Expired pairing | Given an expired or consumed pairing code, when `/start` presents it, then pairing fails without binding a chat. |
| AC-05 Denied action | Given policy returns `deny`, when a Telegram request is normalized, then no inline approval is rendered and the response is a safe denial summary. |
| AC-06 Approval expiry | Given an expired or consumed approval callback, when pressed, then it cannot confirm the action and reports expiry safely. |
| AC-07 Restart/replay | Given a persisted update checkpoint or approval receipt, when the adapter restarts and receives replayed input, then no confirmed action is re-executed. |
| AC-08 Revoked token | Given desktop token revoke or rotation, when a later poll/send is attempted, then the adapter enters `disconnected`, performs no dispatch, and requires fresh setup. |
| AC-09 Webhook conflict | Given an active webhook, when local polling starts, then polling does not start and the desktop presents an explicit resolution requirement. |
| AC-10 Secret-leak prevention | Given token-like, secret, absolute-path, or sensitive tool-output fixtures, when evidence or notification is rendered, then raw values never appear in config, trace, telemetry, schema fixtures, or Telegram text. |
| AC-11 Submit requires a binding | Given a chat bound to no project, when free text arrives, then no `task.submit` is emitted and no turn is created. |
| AC-12 Declared project | Given a bound chat, when `task.submit` is emitted, then it declares the bound project path explicitly, and the path is never taken from message content. |
| AC-13 Submit is not a tool call | Given a submitted prompt that names a shell command, when the turn runs, then the command is classified by the harness policy engine exactly as for an equivalent TUI turn, and is never executed on the strength of the message. |
| AC-14 Injected prompt | Given a prompt containing a prompt-injection fixture, when it is scanned, then no turn is created and the reply states only that it was rejected. |
| AC-15 No local approval semantics | Given an approval prompt, when it is rendered and answered, then expiry, single-use, ownership, and deny-on-undeliverable behaviour come from Remote Entry, and the transport defines no allowlist, no auto-approve, and no alternative timeout. |
| AC-16 Rate-limit safety | Given a provider rate-limit response during delivery, when the transport retries, then it honours the provider's stated retry interval, and an approval that still cannot be delivered resolves as a denial rather than an indefinite wait. |
| AC-17 Topic routing | Given a supergroup with topics bound to two different projects, when a message arrives in one topic, then it reaches that project's session and never the other, regardless of which session is more recent, more idle, or currently active. |
| AC-18 Unmapped topic refuses | Given a topic bound to no project, when any message arrives in it, then the transport refuses with an explanation and no session is reached — in particular it does not fall back to a private-chat binding or to the only active session. |
| AC-19 Membership is not authorization | Given an authorized supergroup, when an unauthorized member posts in a bound topic, then the update is dropped with no privileged effect, exactly as for a stranger. |
| AC-20 Per-binding serialization | Given two messages in one topic and one message in another, when all three arrive together, then the two share a queue and run in order while the third runs concurrently. |
| AC-21 Queue position | Given a message that must wait, when it is queued, then its sender is told its position at the moment of queueing rather than after the wait; and given the queue bound is exceeded, then the message is explicitly refused, never silently dropped. |
| AC-22 Deleted topic | Given a topic Telegram reports as non-existent, when bindings are validated, then that binding is cleared and reported. |
| AC-23 Inconclusive validation | Given a rate-limit or network failure during validation, when the check completes, then the binding is left untouched and the result is recorded as inconclusive — never cleared. |
| AC-24 Voice off by default | Given a fresh configuration, when a voice message arrives, then no transcription is attempted and no remote service is contacted; and given only an API key is present without an explicit opt-in, then a remote service is still not contacted. |
| AC-25 Local-first transcription | Given voice enabled with both a local engine and an opted-in remote service, when a voice message arrives, then the local engine is attempted first. |
| AC-26 Voice egress is policy-governed | Given a remote transcription or synthesis service, when it is invoked, then the call passes the egress policy; and when the policy denies it, then no audio leaves the process. |
| AC-27 Transcription failure degrades | Given transcription that produces no transcript, when the handler completes, then the audio reaches the agent as a file marked not transcribed, the sender is told, and the message is not discarded. |
| AC-28 Voice idempotency | Given the same voice message delivered twice, when both are handled, then exactly one transcription and one turn occur. |
| AC-29 Speech qualification | Given a reply that is short, is mostly code, or is a diff, when delivery runs, then no speech is produced; and given a markdown bullet list, then it is not mistaken for a diff. |
| AC-30 Clip cap | Given a reply whose spoken length exceeds the cap, when speech is produced, then it is split into clips each within the cap, split at a paragraph, sentence, line or word boundary, and never mid-word. |
| AC-31 Speech redaction | Given a reply containing secret, path or PII fixtures before redaction, when speech is produced, then it is synthesized from the redacted text only, and no raw value is audible. |
| AC-32 Normalization language guard | Given normalization enabled and a pass that returns text in a different language than the input, when speech is produced, then the un-normalized text is used. |
| AC-33 Topic on registration | Given a configured forum, when a project registers through `keryx init`, then exactly one topic is created and bound to it. |
| AC-34 Pending provisioning | Given projects registered before any forum exists, when the forum is configured, then every pending project is provisioned, and none is skipped or duplicated. |
| AC-35 Idempotent provisioning | Given a project whose init is re-run, when registration repeats, then the existing topic is reused and no second topic is created. |
| AC-36 Missing project | Given a registered project whose path disappears, when the transport reconciles, then its topic is closed rather than deleted, and reopening requires an explicit operator action. |
| AC-37 Deleted topic re-provisions | Given a topic deleted in Telegram, when validation clears the binding, then the project returns to pending and can be provisioned again. |
| AC-38 One project list | Given any transport state, when projects are enumerated, then they come from the user-global project registry and the transport holds no second list. |
| AC-39 Generated menu | Given a command added to the command registry, when the topic menu is rendered, then it appears with no change to the transport; and given a command absent from the registry, then it is not invocable and no free-form command path exists. |
| AC-40 Maintenance is not a turn | Given a maintenance command the registry marks `model: false`, when it runs, then no prompt is constructed and no provider call is made. |
| AC-41 Cost disclosure | Given a maintenance command the registry marks `model: true`, when approval is presented, then it states that the operation spends tokens. |
| AC-42 Write operations ask | Given a maintenance command the registry marks `read: false`, when it is invoked, then it is classified `ask` and does not run unapproved. |
| AC-43 No secret in a message | Given any message containing credential-like material, when it is handled, then it is never stored as a credential, and the transport offers a handoff link instead. |
| AC-44 Handoff rendering | Given a credential handoff, when the link is rendered, then it carries only the opaque identifier and expiry, and the message contains no credential material. |
| AC-45 Handoff is one-time | Given a consumed or expired handoff link, when it is opened again, then it fails and reports expiry, and no credential is set. |
| AC-46 Selection needs no handoff | Given a provider or model selection command, when it runs from a topic, then it completes without any handoff, because it carries no secret. |
| AC-47 Fallback is constrained | Given direct secret entry is used as the explicit fallback, when it occurs, then it is refused in a supergroup, accepted only in a private chat, the carrying message is deleted immediately, the value is excluded from logs, evidence and retained history, and the operator is told the value transited the provider's infrastructure. |

## Rendering and delivery

Streaming progress from Remote Entry is rendered into Telegram as a single
edited message rather than a message per event: an initial placeholder, throttled
edits while the turn runs, and one final formatted edit. Text that exceeds the
provider's message limit continues as additional messages rather than being
truncated.

Formatting is applied only on the final edit — partial markup mid-stream is not
valid markup — and a formatting failure falls back to plain text rather than
dropping the message. Rate-limit responses are honoured using the interval the
provider states.

These rules are Telegram-specific delivery behaviour. They must not leak upward:
Remote Entry emits events at the rate the turn produces them and makes no
assumption about the channel.
