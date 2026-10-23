# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `/provider` is not a registered slash command in agent or chat mode, is absent from the `/` menu, `/help` and the help-groups catalog, and typing it answers "Unknown command" with a hint to use `/connect`. [verify: exec `bun test src/commands/agent-commands.test.ts src/standard/help-groups.test.ts`]
- AC2: `/connect` opens one ModalHost dialog titled "Providers" with exactly two tabs, "Connected" and "Add provider". It opens on "Connected", or on "Add provider" when no provider is connected (replacing today's "No connected providers" toast). [verify: exec `bun test src/tui/connect-modal.test.ts`]
- AC3: The "Connected" tab keeps today's behaviour: one row per connected provider with catalog status, balance and age, [Test], [Disconnect] with the confirmation and shared-env-var warning, Enter on the label picks the provider then its model and switches the session. The existing flow 304 and 309 tests stay green unchanged. [verify: exec `bun test src/tui/connect-provider-buttons.test.ts`]
- AC4: The "Connected" tab has an [Add provider] button, reachable by mouse and by keyboard, that switches the same open modal to "Add provider" without closing it. [verify: exec `bun test src/tui/connect-modal.test.ts`]
- AC5: The "Add provider" tab lists every known provider (built-in, catalog and custom) plus "Add custom provider". Each row shows whether it is connected and has [Connect] and [Test]. [Test] uses the same probe as the "Connected" tab and prints "ok — N model(s)" or the failure reason; a provider with no credential answers "no credential, Connect first" without a network call. [verify: exec `bun test src/tui/connect-modal.test.ts`]
- AC6: [Connect] runs today's base-URL, key or device-login steps, then checks `/models`. On success it returns to the "Connected" tab with the provider listed, and the session's provider and model are unchanged. On a rejected key it shows the reason and re-asks for the key. Esc at any step returns to "Add provider" and saves nothing from that step. [verify: exec `bun test src/tui/connect-modal.test.ts`]
- AC7: A key typed in [Connect] is saved exactly as before (user-global store, mode 0600) and appears nowhere else: not in the transcript, toasts, journal, test output or the flow log. [verify: exec `bun test src/tui/connect-modal.test.ts`]
- AC8: In Telegram `/connect` shows the connected providers as buttons (pick provider, then model, as today) and an "Add provider" button that shows the provider list with a [Test] button per row. [Connect] in chat runs the device login (code and link sent to the chat, nothing secret typed) for providers that offer it; a provider that needs a key answers that the key is entered in the shell, never in chat; there is still no Disconnect, key or URL step in chat. [verify: exec `bun test src/remote/command-connect.test.ts`]
- AC9: The chat shell with the TUI opens the same modal for `/connect`; the shell without a TUI prints guidance that names only `/connect`, never `/provider`. [verify: exec `bun test src/commands/shell.test.ts src/tui/main-queue-drain.test.ts src/tui/busy-dispatch.test.ts`]
- AC10: README, the docs site, the CLI hint after `keryx init`, and the "Connect a model provider" help group describe the single `/connect` command and its two tabs, and no user-facing text outside `docs/decisions` mentions `/provider`. [verify: invariant `! rg -n "/provider\b" README.md docs/docs src/standard src/commands/init.ts`]
- AC11: The modal fits an 80x24 terminal: both tab labels and the footer keys are visible, rows scroll, and the footer lists the keys for the active tab. [verify: exec `bun test src/tui/connect-modal.test.ts`]
- AC12: A live run in a real `keryx shell` with an empty config directory adds a local OpenAI-compatible provider on "Add provider", tests it, and finds it on "Connected"; the evidence (frames and the config file mode) is recorded in the flow journal. [verify: judged]

Not applicable: a sidebar card. The sidebar has no provider card today and this flow adds none; the modal is reached by `/connect`, the `/` menu and the help modal.
