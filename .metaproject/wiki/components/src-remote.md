# Module src/remote

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/remote` groups 132 file(s). Depends on `src/lib`, `src/security`, `src/session`. Exposes 20 public symbol(s).

## Overview

`src/remote` is the serve side of remote control. It connects a running `keryx serve` to a Telegram supergroup and gives each registered shell session its own forum topic, so messages typed in a topic reach the session and its replies, approvals and status lines come back to the topic. The module owns the session registry, the durable inbound and outbound queues, the wire contract the shell speaks to serve, the Bot API types and the hub that ties them together. It runs no turns itself; the shell on the other end does the work.

## How it works

The module has four layers.

- **Contract.** `types.ts` is a leaf module (nothing in `src/remote` is imported from it) holding the Bot API types, the `BotApi` interface and `BotApiError`, whose closed `kind` set (`conflict`, `rate-limited`, `network`, `server`, `rejected`) decides retries through `isRetryable`. `protocol.ts` is the wire contract: route paths under `/v1/remote`, body and id shapes, size limits, the callback-data encodings and the SSE frame encoder and incremental parser. It does no I/O, so the server and the shell client import the same definitions.
- **Hub.** `RemoteHub` in `hub.ts` is the one stateful orchestrator. It composes `SessionRegistry`, `InboundQueues`, `OutboundQueue`, `RenderingState`, `ServiceTopics`, `RejectedJournal`, `PollerState` and `UpdatePoller`. Every external effect is injected: the Bot API, the consumer's `deliver` and `deliverCallback`, the clock and the timers. The mutating entry points (`register`, `deregister`, `heartbeat`, `sweep`, and the poller's `receive`) run one at a time through the `serial` lock. Delivery to the shell runs outside that lock, with one `drain` per topic, so a slow or hung consumer does not hold up polling or session lifecycle.
- **Binding by name.** A topic is bound to a session's name, not to its session id. A returning session with the same name finds its topic and any messages queued while it was away. A different live session asking for a held name is refused with `name-taken`.
- **Support.** `remote.test-helpers.ts` provides `ManualClock`, which is also the `HubTimers` source, plus a temporary directory and a `makeHarness` that wires a hub to the fake. `remote.http.test-helpers.ts` (`makeRig`) runs a real loopback listener and the real `RemoteClient` for socket-level tests. `fake-bot-api.ts` is the in-process Telegram fake; it lives in the production tree because the packaged smoke starts `keryx serve` against it too.

Failure handling is durable rather than in-memory. Inbound and outbound entries sit in queues on disk. A delivery that throws is retried after `deliverRetryMs`, and a line leaves the queue only after `deliver` resolves. An outbound message that Telegram refuses for good is dropped with a recorded reason (`outbound-dropped`). Text goes out through `sendRendered` and `editRendered`, which step down from rich message to HTML to plain text when Telegram refuses a format, and each step is reported as a `format-fallback` event.

## Key concepts

- **Session record** (`RemoteSessionRecord`): the name, the session id, the project, the chat and topic ids, a `live` or `unavailable` status, the last heartbeat and a `closing` flag. Records are keyed by `nameKey(name)`.
- **Topic**: a forum topic in the configured group that holds one session's conversation. **Service topics** (such as "Intake" and the digest) belong to keryx itself and are kept apart in `ServiceTopics`, away from the session registry.
- **Two acknowledgements.** The poller confirms a batch to Telegram only after `receive` has persisted it and recorded its update ids (`PollerState`). Separately, the shell confirms each line it has finished with, and that is what removes it from the inbound queue. Telegram's offset and the shell's acknowledgement are never the same step.
- **Allowlist.** Only the user ids in `allowedUserIds` may speak in a topic. Any other sender is recorded in `RejectedJournal` and dropped, and the event carries the id, never the message text.
- **Bounded queues.** A topic holds at most `MAX_INBOUND_PER_TOPIC` undelivered messages. When it overflows, the oldest are dropped and the topic is told how many.
- **Callback namespaces.** Approvals use `ap:<id>:allow|deny|always`, choice prompts use `pk:<id>:<n>`, and an own-answer button uses `pk:<id>:own`. All of them stay within Telegram's 64-byte `callback_data` limit. The hub reads only the `in:` prefix, which it routes to the intake handler. The shell decodes the others with the helpers in `protocol.ts`, and the hub passes their data through unchanged.
- **Message state.** A message a user sends is shown as one reaction that tracks the shell's progress (`received`, then `reading`, `working`, `done` or `failed`). While a message is `working`, a typing indicator refreshes on an interval. Losing the shell moves any unfinished message to `failed`.
- **Rendering mode.** `auto`, `rich`, `html` or `plain`, read fresh from the remote config before each send, so a change takes effect without a restart. The last fallback is kept for `/channels` to show.

## Main flows

1. **Inbound message.** The poller hands a batch to `receive`. `route` checks the sender against the allowlist, checks the chat, and maps the thread to a record with `byThread`. The text is appended to that topic's inbound queue and the message gets a `received` reaction. The batch's update ids are recorded, then `dispatch(key)` runs `drain`. `drain` calls `consumer.deliver(sessionId, text, meta)` in order. A throw schedules a retry, and success removes the entry from the queue.
2. **Registration.** The shell's `register` call goes through `serial` to `doRegister`. It validates the name with `checkName`, refuses a name held by a live session with another id, and otherwise picks a default name from `defaultNameCandidates`. A returning name reuses its topic and queues "Remote control attached". A new name calls `createForumTopic`, stores a record and queues the welcome line.
3. **Session lost.** `sweep` runs on `sweepIntervalMs`. A live record whose heartbeat is older than `SESSION_LEASE_STALE_MS` becomes `unavailable`, and `endActivity` stops typing and marks unfinished messages `failed`. Once `orphanMs` has passed, `archive` closes the topic with `closeForumTopic`, keeps its history and forgets the record. A heartbeat from a returning session marks it live again and redelivers what is queued.
4. **Intake press.** A callback in the "Intake" service topic whose data starts with `in:` goes to `routeIntakePress`, and then to `runIntakePress` outside the lock. If the handler is still running after `INTAKE_EARLY_ACK_MS`, the button gets an "accepted" toast. If it runs past `INTAKE_HANDLER_TIMEOUT_MS`, the hub stops waiting and posts the late result to the topic when it arrives.

---

<!-- keryx:reference:begin v=1 hash=9d9bec5f2d1bd75ed205f3c6717a5ec20c70344db14b21e51cc91f1bbb27ee4f -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `OWNER_ID`
- `STRANGER_ID`
- `FAKE_CHAT_ID`
- `STALE_MS`
- `ManualClock`
- `settle`
- `until`
- `makeRemoteDir`
- `fileMode`
- `readTree`
- `testConfig`
- `Delivery`
- `HarnessOptions`
- `Harness`
- `makeHarness`
- `writeTokenFile`
- `BotUser`
- `BotMessage`
- `BotChatMemberUpdate`
- `BotIdentity`

### Key files

- `src/remote/remote.test-helpers.ts` - imported by 54, imports 4
- `src/remote/types.ts` - imported by 41, imports 1
- `src/remote/hub.ts` - imported by 21, imports 17
- `src/remote/protocol.ts` - imported by 38, imports 0
- `src/remote/remote.http.test-helpers.ts` - imported by 25, imports 12
- `src/remote/fake-bot-api.ts` - imported by 27, imports 3

### Depends on

- `src/lib` - 22 import(s)
- `src/security` - 11 import(s)
- `src/session` - 5 import(s)
- `src/commands` - 4 import(s)
- `src/harness/provider` - 2 import(s)
- `src/harness/tool/builtin` - 1 import(s)

### Depended on by

- `src/tui` - 20 import(s)
- `src/commands` - 11 import(s)
- `src/intake` - 11 import(s)
- `src/scheduler` - 1 import(s)

### Dependency basis

- Production imports only: 56 import(s) from test file(s) (e.g. `src/commands/approval-cause.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 132
- Cross-module imports: 45
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/security](src-security.md)
- [Module src/session](src-session.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)
- [Module src/tui](src-tui.md)
- [Module src/intake](src-intake.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
