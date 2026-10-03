---
Title: Remote Control (Telegram)
Version: 1.0.0
Type: architecture
Status: accepted
Summary: "Remote control mirrors a `keryx shell` session into a Telegram topic through the single poller inside `keryx serve`. Off by default; shells reach it with a local shell token, never with the serve bearer."
---
# Remote Control (Telegram)

Describes:
  - src/remote/**
  - src/tui/remote-control-surface.ts
  - src/tui/channels-surface.ts
  - src/lib/serve-server.ts
  - src/commands/serve.ts
  - src/session/store.ts

## Summary

`/remote-control <name>` in a full-screen `keryx shell` opens a topic in a Telegram supergroup and mirrors that session into it. A line sent in the topic runs in the shell as if typed there; replies and approval questions go back to the topic. It is off unless two files exist and validate (`remote/bot-token`, `remote/config.json` in the user-global keryx directory) and a shell has turned it on. Verified against an in-process fake Bot API only; no run against real Telegram has been done.

## Details

### One poller, two principals

`keryx serve` owns the Telegram transport: one long-poll loop (`poller.ts`), one outbound queue (`outbound-queue.ts`, durable, the only path to `sendMessage`), one registry of session topics (`registry.ts`). A shell never talks to Telegram. It registers, heartbeats, posts replies and approvals and reads a server-sent-event stream over `/v1/remote/*` (`protocol.ts` holds the contract, `http-surface.ts` the server side, `client.ts` and `shell-bridge.ts` the shell side).

`keryx serve` has two principals with two route tables. The serve bearer reaches the `/v1/status`, `/v1/projects`, `/v1/turns` and `/v1/approvals` routes and nothing under `/v1/remote/`. The local shell token (a separate secret created by serve, mode 600) reaches only the eight exact `/v1/remote/*` paths, from a loopback connection. Which principal a caller is falls out of which token verified, before the URL is read. A listener without a remote surface cannot authenticate a shell token at all.

A second `keryx serve` on the same bot token receives Telegram's conflict answer and stops polling for good.

The shell token is minted fresh on every serve start (`shell-token.ts`, `mintShellToken`), after the poller lock (`poll-lock.ts`, created whole by link, so no reader sees a half-written lock) is held; a serve refused the lock mints none and answers 401 on its remote routes. `client.ts` re-reads the token on every request and refuses to send it to an `endpoint.json` whose recorded pid is not alive.

### Delivery

No `getUpdates` offset is persisted. `poller.ts` sends none on the first call, then confirms `max+1` after the sink accepted a batch. `RemoteHub.receive` dedupes by exact update id over a bounded recent set (`inbound.ts`, 1000 ids); an unseen id below the highest seen is a numbering reset, which clears the set and emits a `poller-status` event. Each topic keeps at most 500 undelivered lines (`MAX_INBOUND_PER_TOPIC`); a dropped line is counted into one status line. `answerCallbackQuery` is fire-and-forget with a 5 s bound. On the surface side (`http-surface.ts`) an ack or `Last-Event-ID` is honoured only for an id that was actually sent.

### Shell side

`shell-bridge.ts` sends a reply only from the round that ended without tool calls (`toolCall()` clears narration). `disable()` is single-flight: a second call waits for the close in progress, and `enable()` waits as well. On disable the queued Telegram lines are dropped from the shell queue and named to the shell and, best effort, to the topic; removing one queued line does the same for that line.

### Approval answers and their ack

A button press on an approval makes the surface (`http-surface.ts`, `pressApproval`) write the `approval` frame to the shell's stream and wait `approvalAckMs` (default 5000, `DEFAULT_APPROVAL_ACK_MS`) for `POST /v1/remote/approval-ack`. The ack body is `{sessionId, approvalId, applied?}`: `applied` true (or absent, an older shell whose ack only ever meant received) ends the message "Allowed by user N at ..." or "Denied by ..."; `applied: false` ends it "Not applied at <time>: the shell was no longer waiting for this question ...", and a non-boolean `applied` is a 400; no ack ends it "Sent to the shell at <time>, not confirmed; the shell denies by itself if it did not receive it." with a matching short reply (the sentence is true of an answer the shell never got, whose own question times out as a denial; an Allow received after the wait is still applied and the topic keeps saying not confirmed). The surface keeps an `awaiting` map and a bounded `decided` map: a repeated press during the wait does nothing, a stream end gives up on the wait at once, a late ack is a 200 with no change, and an unknown id or another session's id is a 404. On the shell side `client.ts` decides `applied` in `handleApprovalFrame`: a frame with a waiter in `waiters` is applied; one with none is parked in `earlyDecisions` for at most `earlyDecisionMs` (default 2 s, only because a frame can beat the response naming its id) and acked applied only when `requestApproval` consumes it, otherwise (timeout, stream end via `failApprovals`) as not applied. It acks every approval frame (a repeat is acked again with the recorded outcome, not resolved again), calls `onApprovalFrame({approvalId, decision, applied})` once per id before the ack (the bridge says "allowed from Telegram" only for an applied one), and counts frames whose ack has not returned ok (in flight, or failed in the last 60 seconds) as `unconfirmedApprovals`; the bridge reports it in `status()` and the TUI shows "Approvals not confirmed: N" and "<topic> · N unconfirmed". The shell's own wiring between its queue, session switches and turn stream and the bridge is `src/tui/remote-queue-wiring.ts`, tested in `remote-queue-wiring.test.ts`.

### Authorization

`config.json` carries `allowedUserIds`. A message or button press from any other id is dropped; only the id and the time are journaled to `rejected.jsonl`, never the content. Updates from another chat, from the General topic or from an unbound topic are ignored.

### Formatting

`format.ts` is the one place a reply is cut for Telegram. The limit is 4096 UTF-16 code units. A longer reply becomes numbered parts `(1/3)`, split at a line break, then a space, then (only for one unbroken run) at the limit; a fenced code block that crosses a cut is closed and reopened with its info string; a surrogate pair is never cut; blank text produces no message. No `parse_mode` is sent, so nothing is escaped. `OutboundQueue.enqueue` calls it, and the keyboard rides on the last part.

### Limits and orphans

`orphanMs` (default 10 minutes): a session that stops heartbeating is announced in its topic, and the topic is deleted after the window; a heartbeat inside it cancels this. `runTimeoutMs` (default 30 minutes): a run started from Telegram is interrupted by the shell and the topic is told (`run-limits.ts`).

### Session record (`remote` in the summary)

A session driven from a topic records `remote: { name, intervals: [{ on, off? }] }` in its summary (`src/session/store.ts`). `keryx sessions list` prints a `⇄ remote <topic>` line, `--json` carries the field, and the `keryx shell -r` picker marks the row `⇄ remote`.

### Restoring the conversation into a topic (`/history`)

A topic is deleted when the shell exits, and a resumed session gets a new, empty one. `history.ts` is the pure side: `qualifyingHistory` keeps the operator turns (`isOperatorMessage`) and the final assistant text of each turn (narration before a tool call, tool output and reasoning are dropped), `selectHistory` takes the last N (default 10, at most 20), and `formatHistoryItem` labels it `You:` or `Agent:`, cuts it at 1,500 characters and, before anything else, replaces a turn that looks like a credential (a Telegram bot token shape or a bare 32-character mixed-case-and-digit run, both of which the shared redactor misses) with a fixed placeholder; the shared redactor is left as it is. `shell-bridge.ts` (`postHistory`) sends each message through `client.reply` with `historyPaceMs` (2 s) between them, because the outbound queue does no pacing of its own and a 429 only holds the queue; a run is bound to the client it started on, stops at the next step when remote control goes off, and a second post to the same client is refused while one runs. While a turn is running (`host.turnRunning`) the newest assistant text is half written, since the agent loop appends to that message in place, so it is left out until the turn ends. `enable()` restores on its own only when this is the first enable of the process, `client.start()` reports a created topic (`reused: false`, the first registration's answer, never changed by a reconnect) and the session was resumed; turning remote control off and on again, a reconnect and a reused topic restore nothing, and a restore that does not happen says why in the transcript. `/history [N]` is the same code from the shell (a router `builtin`) and from the topic. The panel's `h` key runs it and the modal and the sidebar show the last post.

### Connecting from the shell (`/channels`)

`channels.ts` and `pairing.ts` in `src/remote/` are the serve side; `channels-client.ts` is the shell side and `src/tui/channels-surface.ts` the modal, sidebar row and readline text, all drawn from one snapshot. `serve` always mints the shell token on a loopback listener and answers seven `/v1/remote/channels-*` routes (`status`, `pair`, `pairing`, `cancel`, `reload`, `test`, `disconnect`), even with no config. The bot token never travels over HTTP: the shell writes `remote/bot-token` and `remote/config.json` itself (atomic, mode 600), then asks `serve` to reload without a restart. Pairing runs inside the single poller: a one-time code (10 minutes, single use) in a private message adds the sender to the allowlist, and the `my_chat_member` event of the bot being added to a group gives the group id, after which `serve` checks that it is a forum and the bot may manage topics. Test posts to General naming the host; Disconnect has `serve` delete every topic and stop, then the shell erases the files, or erases them alone and reports that topics remain when `serve` is down. One bot per machine.

## Explicitly out of scope

- The serve `/v1/approvals` surface: an approval raised there has no Telegram card. The Allow/Deny buttons here belong to a mirrored shell session and travel over the shell-token routes.
- Telegram verification beyond the fake Bot API (topic creation, permissions, callbacks, the 409 case).
