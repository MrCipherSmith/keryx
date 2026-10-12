# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `/remote-control [name]` creates one forum topic through the fake Bot API, and `/remote-control off` or closing the shell deletes it. [verify: exec `bun test src/remote/lifecycle.test.ts`]
- AC2: The default name is `<project>-<short session id>`, deterministic and unique; a name held by a live session is refused and the first session keeps receiving its messages. [verify: exec `bun test src/remote/naming.test.ts`]
- AC3: A message sent in the topic reaches the session as a user line and the session's reply comes back in the same topic. [verify: exec `bun test src/remote/roundtrip.test.ts`]
- AC4: After `off`, the session is listed by `keryx shell -r` with a remote mark and its on/off intervals; resuming it with `-r` or `-c` does not turn remote control on. [verify: exec `bun test src/remote/history.test.ts`]
- AC5: A second `keryx serve` on the same bot token meets a 409 from Telegram, stops polling for good and says why in its log and in the remote-control status; it keeps serving its other routes, and the first keeps polling (one poller per token; fake API answers 409). [verify: exec `bun test src/remote/single-poller.test.ts`]
- AC6: When the shell is killed with `kill -9`, serve writes a "session unavailable" status in its topic and deletes the topic after the orphan timeout (default 10 minutes, configurable; 2 s in the test); the same name returning before that reuses the topic. [verify: exec `bun test src/remote/orphan.test.ts`]
- AC7: An approval request from the session arrives in the topic as buttons; an "allow" callback grants it, and no callback within the timeout refuses it. [verify: exec `bun test src/remote/approval.test.ts`]
- AC8: A message from a user id outside the allowlist never reaches the agent and is logged with the id and the time only, never the text. [verify: exec `bun test src/remote/allowlist.test.ts`]
- AC9: The bot token and the local shell-to-serve token appear in no command output, no log and no repository file, and their files are mode 600. [verify: invariant `bun test src/remote/token-secrecy.test.ts`]
- AC10: Killing `keryx serve` between receiving an update and its ack, then restarting it, delivers the message to the session exactly once, in the same topic; outgoing messages queued while serve was down are sent after the restart. [verify: exec `bun test src/remote/restart.test.ts`]
- AC11: A run started from Telegram that exceeds the run timeout (default 30 minutes, configurable; short in the test) is interrupted by the shell and a notice is written to the topic; a killed shell does not stop serve. [verify: exec `bun test src/remote/run-limits.test.ts`]
- AC12: TUI: a sidebar row (`Remote: off | <topic name> | offline`), a `/remote-control` modal with status, name, on/off, recent events and last heartbeat, a menu entry, the `/remote-control [name|off|status]` command, the readline-shell equivalent as text, and a "tg" source label on lines that came from Telegram. [verify: exec `bun test src/tui/remote-control-surface.test.ts`]
- AC13: Replies in Telegram are readable: formatting, and splitting at the 4096-character limit without cutting a code block or a word. The operator judges a sample of real replies. [verify: judged]
- AC14: Every route and queue is tested against the fake Bot API only; no test reaches Telegram or runs an external agent. [verify: invariant `bun test src/remote/no-live-network.test.ts`]
- AC15: README, cli-reference, wiki, commands-by-task, docs site and CHANGELOG describe remote control; the version is above 0.3.46 on main. [verify: exec `bun test src/standard/help-groups.test.ts`]
- AC16: After release the package installed from npm only (`bun add -g @mrciphersmith/keryx@X`) starts `keryx serve` with the fake Bot API and a shell client, and `/remote-control` opens and closes a topic. No live Telegram run without the operator's OK. [verify: none — a manual smoke from the published package, recorded in the journal]
