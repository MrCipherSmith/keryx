# Desktop Telegram module

Keryx Desktop can start a local `keryx serve`, pair a bot with a Telegram account and forum, and share an individual Desktop session in a forum topic. The model and project policy still run in the session's ACP sidecar. For setup and everyday use, see [Use Keryx Desktop from Telegram](guides/desktop-telegram.md). For the terminal workflow and general serve API, see [Drive Keryx remotely](guides/drive-keryx-remotely.md).

This integration is opt-in and currently in preview. The Desktop application, its CLI/ACP sidecar and the listener need compatible preview support. Keryx 0.4.50 and Desktop 0.2.13 support enabling the capability with `KERYX_DESKTOP_TELEGRAM_PREVIEW=1`. The listener must bind to loopback and use the same local Keryx profile as Desktop.

## Component ownership

| Layer | Responsibilities | Entry points in the repository |
| --- | --- | --- |
| Desktop UI | Service status and lifecycle, bot pairing with explicit account and forum confirmation, session attachment and projected decisions | `apps/desktop/src/project/TelegramServeSettings.tsx`, `TelegramBotSettings.tsx`, `apps/desktop/src/session/TelegramSessionDialog.tsx`, `useAcpSession.ts` |
| Native Desktop | Inspect and bootstrap the local service using the selected CLI, supervise its own child, pass a proposed bot credential over stdin | `apps/desktop/src-tauri/src/telegram_serve.rs`, `telegram_channel.rs` |
| Local listener | Verify local callers, manage the revisioned bot connection, own Telegram polling, authenticate dispatch, map topics to session owners and route outbound messages | `src/commands/serve.ts`, `src/lib/serve-server.ts`, `src/remote/service.ts`, `channel-control.ts`, `channel-staging.ts`, `channel-record.ts` |
| ACP sidecar | Hold the session lease, admit Telegram-origin turns, emit Desktop updates, dispatch policy decisions and persist the conversation | `src/acp/server.ts`, `telegram-session.ts`, `telegram-approval.ts`, `telegram-decision.ts`, `src/session/store.ts` |

```text
Desktop Settings → native bridge → local CLI → keryx serve → Telegram Bot API
Desktop session  ↔ ACP sidecar   ↔ local remote protocol ↔ keryx serve
                                                        ↕
                                                 Telegram topic
```

Desktop manages a listener it started. A compatible external listener can serve the same Desktop and terminal clients, and continues running under its original owner. Closing Settings and switching projects leave the listener running. Quitting Desktop stops its owned listener and closes its ACP connections. An external listener alone cannot continue running a closed Desktop session.

## Local configuration and protocol

| Boundary | Contract |
| --- | --- |
| Service bootstrap and inspection | The native bridge uses the selected Keryx CLI. Setup validates the loopback configuration, checks the bind port and issues a profile-local service credential when needed. A listener must prove its identity and advertise the Desktop channel capability before Desktop manages the connection. |
| Bot management | The local channel status and control routes expose an allowlisted status and the `begin`, `status`, `confirm-account`, `confirm`, `cancel`, `test`, `disconnect`, `policy` and `rendering` actions. Desktop calls the operation-status action `operation-status` at its native boundary. Pairing operations use an operation ID and the expected connection revision. |
| Credential staging | Desktop accepts the BotFather token through a password field and passes it to the local CLI via stdin. The CLI writes a short-lived, owner-only staging record for the listener. The control route receives the staging ID. The QR code and manual code contain a pairing nonce. |
| Session control | The negotiated ACP extension `_keryx/telegram/session` supports `status`, `attach` and `detach` for a session owned by the current ACP connection. Its states include `detached`, `attaching`, `active`, `reconnecting` and `unavailable`. Desktop can request projection of an eligible project question with `_keryx/telegram/project-question`. |
| Session transport | The local remote protocol registers and deregisters topic owners and transports inbound events, replies, status and decision results. During a channel handoff an owner can acknowledge revocation via `channel-revoke-ack`. |

The listener configuration and credentials are profile-wide, separate from each project's `.metaproject`. On macOS the normal profile directory is `$XDG_DATA_HOME/keryx` or `~/.local/share/keryx`. Desktop and an externally launched listener must resolve the same profile. The Telegram connection is an atomic, owner-only `remote/channel.json` record with a revision. A disconnected marker prevents legacy credentials from reactivating the bot. Existing `remote/config.json` and `remote/bot-token` supply the legacy connection only while a revisioned record is absent. Treat all of these files as private.

## Pairing and rotation lifecycle

1. The listener consumes the staged token and verifies bot identity. On pairing, the private chat must claim a short-lived, single-use nonce. Desktop asks the operator to confirm the claimed account. The listener observes a forum membership update for that account and checks bot rights. Desktop then asks for forum confirmation.
2. During rotation, the previous connection remains available until the operator confirms the candidate. For a same-bot rotation with an existing forum the service checks that the candidate can manage that forum. A different bot needs fresh account and forum confirmation.
3. Activation checks that Telegram accepts polling with the candidate, and the local record changes only against the expected revision. A concurrent Desktop or terminal operation can win the revision; the stale client must refresh before retrying.
4. Successful same-bot rotation preserves existing bindings. A different bot retires old bindings and sessions must attach again. A failed cutover can restore the old connection if it still has a valid credential. If the old bindings were already revoked, recovery can require fresh attachments.
5. **Test connection** sends a message to General. **Disconnect** removes the connection and reports failed topic deletions separately. **Stop** shuts down the managed listener while keeping its configuration and pairing.

## Session execution and decision boundaries

1. An attachment belongs to the session lease and its current binding generation. The listener creates a topic for that owner. An inbound update must match the configured account, forum and exact topic. ACP also checks the current lease and generation before admitting work. Duplicate update IDs are dropped within the attachment's recent update window.
2. An accepted text message starts a turn in Ask mode. Desktop renders it with **Via Telegram** and shows its busy state. If the session is already working, the service replies that it is busy. The operator can resend after the turn.
3. `/status` reports session availability. `/stop` targets the Telegram-origin turn for the attachment. Other shell slash commands do not run through the Desktop topic.
4. The topic receives final replies and limited progress. The service does not mirror internal reasoning, tool inputs, tool results or old history. The conversation is saved in the normal session store. Mirrored replies are queued in order after the transcript is saved. The ACP turn slot is released while the service accepts the reply. Desktop shows a session notice when queue acceptance cannot be confirmed. An accepted reply is queued for delivery to Telegram.
5. ACP owns the decision and determines eligibility using trusted tool or question metadata. Desktop remains the decision surface for privileged actions. Supported projections use one shared pending decision with deadline, choice validation and a first-valid-answer rule. A stale topic callback cannot settle a new operation.
6. Detaching or losing the ACP session's ownership tears down its binding and stops new input. When the Telegram API accepts the topic closure, previous messages remain readable. An external listener may still serve other sessions.

## Verification

The [Desktop Telegram specification and validation plan](https://github.com/MrCipherSmith/keryx/tree/main/docs/requirements/keryx-desktop-telegram) describe the target behavior and release evidence. The guide's screenshots exercise the Desktop components against simulated native responses. They show the intended controls and states with demonstration data.

| Concern | Focused coverage |
| --- | --- |
| Bootstrap and compatible listener detection | CLI coverage in `src/lib/desktop-serve-bootstrap.test.ts` and `src/remote/desktop-serve-status.test.ts` and owned-child cases in `apps/desktop/src-tauri/src/telegram_serve.rs` |
| Pairing, secrets, concurrent changes and recovery | `src/remote/channel-activation.test.ts`, `channel-control.test.ts`, `channel-staging.test.ts`, `channels-revisioned-client.test.ts`, `poller-readiness.test.ts` |
| Owning session, inbound messages and projected decisions | `src/acp/telegram-session.server.test.ts`, `telegram-approval.test.ts`, `telegram-decision.test.ts`, `src/remote/exact-owner.test.ts` |

For a live acceptance run, use a dedicated test bot and private Topics-enabled group. Start the service from Desktop, confirm the account and forum, and verify the test message in General. Attach two open sessions and verify their topics route independently. Send a prompt, compare the Desktop transcript with the Telegram reply, and exercise `/status`, `/stop`, **Detach**, and a same-bot token rotation. Confirm that Desktop reports a listener started in a terminal as external and leaves it running when Desktop quits.
