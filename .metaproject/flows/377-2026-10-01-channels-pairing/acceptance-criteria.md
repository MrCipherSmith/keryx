# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `/channels` opens a modal listing Telegram; an unconfigured channel shows only Connect, a configured one shows Test and Disconnect. [verify: exec `bun test src/tui/channels-surface.test.ts`]
- AC2: Connect asks for the bot token only (hidden entry, paste works); the operator's user id and the group id are found from Telegram events, and no id, path, name or timeout is typed or hard-coded. [verify: exec `bun test src/remote/pairing.test.ts`]
- AC3: Pairing uses a one-time code shown in the modal; the first private message carrying that code adds its sender to the allowlist, a message without it from anyone else does not, and the code expires after 10 minutes and works once. [verify: exec `bun test src/remote/pairing.test.ts`]
- AC4: Adding the bot to a group gives the group id from the event; serve checks the group is a forum and the bot may manage topics, and the modal names what is missing otherwise. [verify: exec `bun test src/remote/pairing-group.test.ts`]
- AC5: The shell writes `remote/bot-token` and `remote/config.json` itself, atomically, mode 600; the bot token is on no route, in no request body, command output, log, history or journal. [verify: invariant `bun test src/remote/channels-secrecy.test.ts`]
- AC6: With serve running, Connect enables Telegram without restarting serve; invalid data leaves nothing on disk and the modal shows the reason. [verify: exec `bun test src/remote/channels-connect.test.ts`]
- AC7: Test sends one message to the General topic and shows delivered or the reason; with serve not running it says so instead of failing silently. [verify: exec `bun test src/remote/channels-test.test.ts`]
- AC8: Disconnect asks serve to delete every topic and stop polling, then erases the token and the config; afterwards `/channels` shows only Connect. With serve down it erases the files and says the existing topics stay in the group. [verify: exec `bun test src/remote/channels-disconnect.test.ts`]
- AC9: Several machines each hold their own bot; the machine name comes from the host name and appears in the Test message and in topic names, with no per-machine configuration. [verify: exec `bun test src/remote/channels-machine.test.ts`]
- AC10: TUI: the `/channels` command, the modal with the step-by-step pairing view, a menu entry, a sidebar row with the channel state, and the readline-shell equivalent as text. [verify: exec `bun test src/tui/channels-surface.test.ts`]
- AC11: Every route and the pairing are tested against the fake Bot API only; no test reaches Telegram. [verify: invariant `bun test src/remote/no-live-network.test.ts`]
- AC12: README, cli-reference, wiki, commands-by-task, docs site and CHANGELOG describe `/channels`; the version is above 0.3.48 on main. [verify: exec `bun test src/standard/help-groups.test.ts`]
- AC13: After release the package installed from npm only starts serve with the fake Bot API and a shell client, and `/channels` connects, tests and disconnects. No live Telegram run without the operator's OK. [verify: none — a manual smoke from the published package, recorded in the journal]
