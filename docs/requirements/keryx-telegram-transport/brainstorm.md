# Brainstorm: Telegram Transport Options
Version: 2.2.0

## Decision question

Which Telegram surface best meets the need for safe companion visibility while
the Project Agent Harness remains local-first and Task Manager stays the sole
managed-flow owner?

## Options

| Option | Benefits | Costs and risks | Fit |
|---|---|---|---|
| Local long-polling companion bot | No public endpoint; aligns with desktop/local process; simple private-chat pairing; smallest Release 0 attack surface. | Requires local process availability and careful polling/restart idempotency. | **Selected for Release 0.** |
| Server webhook companion bot | Always-on server delivery and centralized operations. | Requires public HTTPS, webhook secret verification, rate limiting, durable idempotency, observability, credential operations, and clearer remote-control threat model. | Deferred to separate headless/server release. |
| Telegram Mini App/control surface | Rich list/run/approval UI and session browsing potential. | Larger UX/auth/data-exposure surface; does not reduce core transport/policy work; risks becoming a second control plane. | Release 2+ exploration only. |

## Evaluation criteria

- Keeps Harness and Task Manager as the only lifecycle/state owners.
- Avoids a public control plane in the first release.
- Supports explicit user pairing and bounded approvals.
- Minimizes secret and sensitive-output exposure.
- Is testable offline through a fake provider adapter.
- Leaves a clear path to future server/webhook and Mini App modes without
  contaminating the provider-neutral transport port.

## Selected decision

Use a private-chat, local long-polling companion adapter. It sends status and
notifications and accepts only typed, policy-constrained status, approval, and
own-operation cancellation intents. The desktop UI remains canonical; Telegram
is never a second Harness runtime or Task Manager writer.

## Deferred decisions

- Exact credential-store implementations and supported platforms.
- Numeric limits for retries, send rate, message size, TTL, and retention.
- Precise Harness port names and evidence payload versioning.
- Server/headless ownership model and multi-tenant webhook operations.
- Mini App authentication and session-browsing policy.

## 2.1.0: multi-project and voice

### Evidence

`helyx` (`/home/altsay/bots/helyx`) runs this exact surface in production against
Claude Code sessions and was studied directly. Its Telegram layer settled two
questions this package had left open.

**Multi-project.** It uses a forum supergroup with one topic per project.
Routing resolves the project from the topic identifier. The decisive detail is
in `sessions/router.ts`: when a topic maps to no project it returns
`disconnected` rather than falling through to chat-based routing, with the
comment that the fallback "could accidentally deliver the message to another
project's session". Work is queued per `chatId:topicId`
(`bot/topic-queue.ts`), so projects run in parallel while one project's messages
run in order, and a queued sender is told its position immediately.

Two further details are worth copying: topic liveness is probed with a no-op
chat action and only a definite "thread not found" clears the mapping — any
other error leaves it alone (`services/forum-service.ts`); and the Bot API
cannot list a forum's topics, so synchronization can create but not reconcile.

**Voice.** Inbound is transcription with a fallback chain, a status message
edited through its phases, deduplication by message identifier, and — the part
worth copying most — degradation to delivering the audio as a file rather than
losing the message. Outbound qualifies before speaking: a minimum length, a cap
on how much of the text may be code, and a diff check that deliberately does not
mistake markdown bullets for diff lines (`utils/tts.ts`). Long replies are split
at paragraph, sentence, line, then word boundaries under a duration cap, markup
is stripped, and an optional model pass rewrites paths and identifiers so they
read naturally aloud — with a guard that discards the rewrite if it changed the
language of the text.

### What is adopted, and what is changed

| helyx behaviour | Decision here |
|---|---|
| Topic-per-project routing; unmapped topic refuses instead of falling back | **Adopted, and promoted to a security rule.** A wrong guess runs one project's prompt under another project's profile and scope, and the operator only finds out afterwards. AC-17 and AC-18. |
| Per-topic queue with position reporting | **Adopted**, plus a depth bound whose breach is an explicit refusal rather than a silent drop. AC-20, AC-21. |
| Topic validation that only clears on a definite "not found" | **Adopted** as a three-state result — confirmed, absent, inconclusive — so the fail-safe behaviour is a contract rather than an implementation detail. AC-22, AC-23. |
| Supergroup membership is effectively authorization | **Rejected.** Every sender is authorized individually and the check precedes routing. A supergroup has members the operator did not choose, and its membership changes without the transport being told. AC-19. |
| Transcription failure degrades to a file | **Adopted.** AC-27. |
| Speech qualification and boundary-aware splitting | **Adopted** essentially as designed. AC-29, AC-30. |
| Model normalization before synthesis, with a language guard | **Adopted as optional**, because it costs a model call per reply. AC-32. |
| Cloud transcription tried first, enabled by the presence of an API key | **Inverted.** Local first, remote opt-in per install, and every remote call passes the egress policy. A recording of the operator's voice is user content leaving the machine; keryx already has a boundary for that and it must not be walked around for convenience. AC-24, AC-25, AC-26. |
| Synthesis from reply text | **Constrained.** Synthesis accepts post-redaction text only: what may not be written may not be spoken. AC-31. |

### Alternatives rejected for multi-project

| Option | Why not |
|---|---|
| One private chat per project | Requires a separate bot or a separate chat per project; nothing groups them; approvals from several projects interleave in one conversation with no reliable way to tell which is which. |
| One chat, a `/switch` command holding current project | A mode that is invisible in the message itself. Sending to the wrong project becomes a one-keystroke mistake with no visible cue, and it serializes everything through a single conversation. Useful as a private-chat convenience, unsafe as the primary mechanism. |
| Project named in each message | Puts routing into untrusted content, which is exactly what the specification forbids for `task.submit`. |

## 2.2.0: the deployment model made explicit

The target is one operator running one keryx install across many projects,
reached from a supergroup they own. Naming it settled three things that had been
left implicit, and reopened one that had been decided wrongly.

### Topics follow `keryx init`, not a bulk setup

helyx enumerates projects from its database and creates topics in a batch. That
works because it has a central project table. keryx does not: `keryx init`
writes a `.metaproject/` into a directory and nothing on the machine knows the
set of projects.

So the dependency runs the other way. Remote Entry gains a user-global project
registry, `keryx init` registers, and the transport provisions a topic per
registered project. The transport reads that registry and holds no list of its
own — a project exists because it was initialized, never because a topic was
created.

Ordering had to stop mattering, because in practice it will vary: projects
registered before a forum exists wait as pending and are provisioned when it
appears.

### Maintenance is not a prompt

Bringing a project up remotely means building a graph, indexing and enriching a
wiki, analyzing tests, running health. Sending those through the model means
paying for a decision that was already made, and adding a nondeterministic step
to an operation that had none.

keryx already had the right source for this and it was not being used:
`src/standard/command-registry.ts` carries, per command, its argument shape,
whether it is read-only, and whether it costs a model call — sixteen commands
today, five of them model-backed. That is exactly a permission and cost model,
already written.

So the menu is generated from the registry rather than written into the
transport: a command added to keryx appears in Telegram with no bot change, a
command absent from the registry is not invocable, read-only commands are
offered directly, write commands ask, and model-backed commands disclose their
cost.

The registry does not yet cover everything the menu needs — `gdgraph build` is a
refresh command outside the curated set — so extending it is recorded as a
dependency rather than worked around in the transport.

### Rejected: entering an API key in the chat

The obvious way to authorize a provider without a web UI is to paste the key
into the chat, and helyx-style deployments do keep secrets in ordinary
configuration.

**Rejected.** A key sent as a message traverses Telegram's servers, persists in
conversation history, enters the bot's update stream, and may reach logs. Bot-side
deletion removes it from view, not from that infrastructure. keryx keeps
credentials at mode 0600 and ships a secret detector; a channel that walks around
both to save one screen of UI is a bad trade.

| Option | Verdict |
|---|---|
| Paste the key in chat, bot deletes the message | Rejected as a default. The value has already left the machine by the time it is deleted. |
| Model-driven setup — ask the agent to configure the provider | Rejected. It puts a secret into a prompt and therefore into a session, which is worse. |
| Full web UI for settings | Rejected as scope. The operator explicitly wanted no web application. |
| **One-time, expiring, loopback-bound handoff link** | **Selected.** Telegram carries a link, never a value. The secret is entered locally and written straight to the credential store. It is "no web UI" in the sense that matters: no application, just one page for one operation. |
| Direct entry in a private chat | Retained as an explicit fallback with named constraints — never in a supergroup, message deleted at once, excluded from logs, evidence and history, and the operator told it transited Telegram and can be rotated. |

Away from the machine the loopback link is unreachable and a non-loopback bind
is needed. That is the trade-off already recorded for the entry itself, not a
new one introduced here.

### Kept despite the single-operator model

Per-sender authorization stays. It is nearly free, and "the group is mine" stops
being true the moment anyone is added. A single-operator deployment is a reason
to keep cheap checks, not to drop them.

## External basis

Official Telegram documentation supports the relevant primitives: bot deep links,
inline keyboards/callbacks, long polling, webhooks, and Mini Apps. See
[Bots](https://core.telegram.org/bots),
[features](https://core.telegram.org/bots/features),
[Bot API](https://core.telegram.org/bots/api), and
[webhooks](https://core.telegram.org/bots/webhooks).
