# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `/connect` shows the connected providers as rows drawn like the queue dock - a label plus `[Test]` and `[Disconnect]` buttons built the way `mainQueueButton` builds Force/Edit/Delete, coloured from the theme - while Enter or a click on a row's label still selects that provider as today; `/provider` keeps its current wizard; a TUI test asserts both buttons on every row.
- AC2: `[Test]` runs the provider's live model-list probe (`fetchOpenAiCompatModelsDetailed` with the provider's resolved key) and shows on that row either `ok - N models` or the humanized failure reason (`modelsFailureLine`), without leaving `/connect`; a mouse-driven test covers success and failure.
- AC3: The rows and both buttons are reachable without a mouse - up and down select a row, left and right select Label, Test or Disconnect, Enter fires, Esc leaves - using pure, unit-tested steppers beside `queue-nav.ts` and registered as an overlay source like queue navigation; a keypress-driven test proves each key.
- AC4: `[Disconnect]` asks for confirmation before touching anything, and declining leaves every credential and config file byte-for-byte unchanged; a test asserts no write on decline.
- AC5: A confirmed disconnect removes exactly that provider's saved credential in the per-user config dir - a saved API key (new `removeApiKey`), an OAuth grant (`logoutProvider`), or a custom provider's `llm-providers.json` entry (new `removeCustomCompatProvider`) together with its saved base URL and model params - and a hermetic test per kind reads the files back and shows the entry gone and its siblings intact.
- AC6: A provider whose only credential is an environment variable the operator exported is not removable: `[Disconnect]` says so, names the exact variable to unset, and writes nothing; a test covers it with an injected env and a temp config dir.
- AC7: Disconnecting the provider the session is using neither switches provider nor interrupts a turn; the shell prints one line naming the provider and saying the session keeps its loaded credential until `/connect` or restart, and a keryx-saved key is removed from this process's environment so a later `/connect` no longer lists it; tests cover both.
- AC8: `keryx providers test <name> [--json]` and `keryx providers remove <name> [--yes]` behave as the two buttons do (remove asks for confirmation on a terminal and refuses without one unless `--yes`), with CLI tests, and `keryx providers list` stays network-free.
- AC9: The docs say plainly that disconnecting removes keryx's local copy of a credential and does not revoke it at the vendor unless the OAuth logout path does so (check and state which); `docs/docs/cli-reference.md` documents `providers test` and `providers remove`, and the onboarding page and the `/help` table describe the buttons and keys.
- AC10: All new UI and CLI text is in English, and button, row and result colours come from the active theme, proven by a test under two themes.
- AC11: `HELP_GROUPS`, the command registry and the CLI reference coverage include the new subcommands, and their tests pass.
- AC12: CI is green on the pull request and `keryx health run` passes before merge.
