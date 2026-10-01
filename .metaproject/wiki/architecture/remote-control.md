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
  - src/lib/serve-server.ts
  - src/commands/serve.ts
  - src/session/store.ts

## Summary

`/remote-control <name>` in a full-screen `keryx shell` opens a topic in a Telegram supergroup and mirrors that session into it. A line sent in the topic runs in the shell as if typed there; replies and approval questions go back to the topic. It is off unless two files exist and validate (`remote/bot-token`, `remote/config.json` in the user-global keryx directory) and a shell has turned it on. Verified against an in-process fake Bot API only; no run against real Telegram has been done.

## Details

### One poller, two principals

`keryx serve` owns the Telegram transport: one long-poll loop (`poller.ts`), one outbound queue (`outbound-queue.ts`, durable, the only path to `sendMessage`), one registry of session topics (`registry.ts`). A shell never talks to Telegram. It registers, heartbeats, posts replies and approvals and reads a server-sent-event stream over `/v1/remote/*` (`protocol.ts` holds the contract, `http-surface.ts` the server side, `client.ts` and `shell-bridge.ts` the shell side).

`keryx serve` has two principals with two route tables. The serve bearer reaches the `/v1/status`, `/v1/projects`, `/v1/turns` and `/v1/approvals` routes and nothing under `/v1/remote/`. The local shell token (a separate secret created by serve, mode 600) reaches only the seven exact `/v1/remote/*` paths, from a loopback connection. Which principal a caller is falls out of which token verified, before the URL is read. A listener without a remote surface cannot authenticate a shell token at all.

A second `keryx serve` on the same bot token receives Telegram's conflict answer and stops polling for good.

### Authorization

`config.json` carries `allowedUserIds`. A message or button press from any other id is dropped; only the id and the time are journaled to `rejected.jsonl`, never the content. Updates from another chat, from the General topic or from an unbound topic are ignored.

### Formatting

`format.ts` is the one place a reply is cut for Telegram. The limit is 4096 UTF-16 code units. A longer reply becomes numbered parts `(1/3)`, split at a line break, then a space, then (only for one unbroken run) at the limit; a fenced code block that crosses a cut is closed and reopened with its info string; a surrogate pair is never cut; blank text produces no message. No `parse_mode` is sent, so nothing is escaped. `OutboundQueue.enqueue` calls it, and the keyboard rides on the last part.

### Limits and orphans

`orphanMs` (default 10 minutes): a session that stops heartbeating is announced in its topic, and the topic is deleted after the window; a heartbeat inside it cancels this. `runTimeoutMs` (default 30 minutes): a run started from Telegram is interrupted by the shell and the topic is told (`run-limits.ts`).

### History

A session driven from a topic records `remote: { name, intervals: [{ on, off? }] }` in its summary (`src/session/store.ts`). `keryx sessions list` prints a `⇄ remote <topic>` line, `--json` carries the field, and the `keryx shell -r` picker marks the row `⇄ remote`.

## Explicitly out of scope

- The serve `/v1/approvals` surface: an approval raised there has no Telegram card. The Allow/Deny buttons here belong to a mirrored shell session and travel over the shell-token routes.
- Telegram verification beyond the fake Bot API (topic creation, permissions, callbacks, the 409 case).
