# Implementation Plan

Status: approved (operator, polls 248 and 249, 2026-10-22)

## Approach

One tabbed ModalHost step in `src/tui/tui-shell.ts` replaces both `pickConnectedProviderStep` (as the host) and the `/provider` wizard entry. The step resolves to one action; the caller closes the modal, runs the existing wizard step, then re-opens the modal on the right tab. Wizard steps (base URL, key, device login) stay separate dialogs, as today.

- Tab "Connected" is today's rows and buttons unchanged, plus an [Add provider] button.
- Tab "Add provider" lists every provider from `detectProviders` plus "Add custom provider", each row with [Connect] and [Test].
- The per-provider connect sequence (custom wizard, base URL, credential, `/models` check with the rejected-key and endpoint retries) is extracted so the wizard loop and tab 2 [Connect] share it. [Connect] stops after the `/models` check: no model pick, no session switch.
- `modal-host.ts` gets an optional `footerFor(tabId)` so the footer lists the keys of the active tab.
- `/provider` is removed from the agent registry, handlers, help groups, `CONNECT_GUIDANCE`, init hint, README and docs. `/connect` is the only entry. The non-`onlyConnected` wizard path stays for first-run startup.
- Telegram: `RemoteCommandHost` gets `listAddableProviders`, `testProvider` and `connectProviderDeviceLogin`. The router shows connected providers as buttons plus "Add provider"; the add list has a [Test] per row; [Connect] runs the device login (code and link posted to the chat) where the auth catalog says `device-code`, and answers "key is entered in the shell" otherwise. No key, URL or Disconnect step in chat (flow 387 AC4).

## State x event matrix (modal)

| State | Event | Result |
|---|---|---|
| Connected, rows > 0 | Enter on label | pick provider then model, switch session (unchanged) |
| Connected | [Test] / [Disconnect] | unchanged (flow 304, 309) |
| Connected | [Add provider], key `a`, Tab, digit 2, click tab | same modal switches to Add provider |
| Connected, last row disconnected | Disconnect confirmed | switches to Add provider, modal stays open |
| Add provider, no credential | [Test] | "no credential, Connect first", no network call |
| Add provider, credential | [Test] | "ok - N model(s)" or the failure reason |
| Add provider | [Connect] | modal closes, wizard steps run, `/models` checked, modal re-opens on Connected with the provider listed; session unchanged |
| Add provider, wizard | Esc at any step | modal re-opens on Add provider; nothing from that step saved |
| Add provider, rejected key | `/models` rejects | reason shown, key asked again |
| Any tab | Esc, `x` | modal closes, focus restored |
| Opened, nothing connected | `/connect` | opens on Add provider (no "No connected providers" toast) |
| Any tab | theme change | active tab re-rendered |
| 80x24 terminal | open | both tab labels and active-tab footer visible, rows scroll |

## Tasks

- T1 context (this file).
- T2 implement the modal, the shared connect step, the removal, the Telegram hooks.
- T3 tests: new `src/tui/connect-modal.test.ts`; update agent-commands, help-groups, shell, remote command-connect; the line-565 source anchor in `connect-provider-buttons.test.ts` (a necessary deviation from "unchanged", noted in the journal).
- T4 self-review, `keryx review budget`, review through `vantage-review`, draft PR.
- Verification: AC10 invariant, AC12 live run in a real `keryx shell` with an empty config dir.

## Risks

- `connect-provider-buttons.test.ts` drives the real wizard and asserts handler source text; the handler rewrite must keep the asserted strings.
- A key must never reach transcript, toast, journal or logs; the live run checks this and the config file mode (0600).
- Device login in chat posts a user code and a verification URL; both are public by design, neither is a secret.
