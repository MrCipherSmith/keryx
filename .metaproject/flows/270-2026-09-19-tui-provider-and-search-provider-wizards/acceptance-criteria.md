# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Inside the running agent shell, every step of the `/provider` and `/connect` wizard (provider list, auth method, base URL, API key, device login, custom provider fields, model) renders in ModalHost: the shell header and sidebar stay visible, and no step mounts a full-screen `overlayBox` on the renderer root. A headless test drives the wizard through at least provider → key → model and asserts this at each step.
- AC2: Inside the running agent shell, every step of the `/search-provider` wizard (provider, field, credential, active provider, connection test) renders in ModalHost under the same rule as AC1, verified by a headless test.
- AC3: The startup picker (before the chrome exists) and the chat shell keep working through the full-screen overlay; the existing wizard tests that drive them with a bare renderer pass unchanged.
- AC4: In a wizard step rendered in ModalHost, Esc goes back one step (or cancels on the first step) exactly as the overlay version does, Enter confirms, and ←/→ move the cursor inside a text field instead of being swallowed by a tab switch; a single-tab modal never consumes ←/→.
- AC5: `/tools` renders each tool as an aligned row whose continuation lines are indented under the description column, and `/mcp` server rows wrap the same way; home-directory paths are shown with `~`. Verified by tests on the row formatters at a fixed width.
- AC6: The `/tools` footer lists only keys that act on that tab; connect/disconnect/confirm hints appear only on the tab where they work.
- AC7: The risk column in `/tools` is labelled so that `read` on `shell_task_kill`/`shell_task_wait` reads as "no approval needed", not as a claim about what the tool does.
- AC8: A Grok `config.toml` containing an array-of-tables header outside `mcp_servers` (e.g. `[[marketplace.sources]]`) yields no config problem and still reads the `[mcp_servers.*]` tables around it; a `[[mcp_servers...]]` header is still reported as a problem and does not leak keys into the previous server.
- AC9: The sidebar shows a "Mode" row with the current permission mode, and ` · read-only` (highlighted) while `/plan on` is active; it updates immediately on `/mode`, `/plan on`, `/plan off`.
- AC10: A new session shows the KERYX wordmark centred in the empty transcript until the first operator message is submitted, then it is removed; a resumed session with prior messages does not show it. The boot animation no longer displays loading steps that do no work.
- AC11: `bun run typecheck`, `bun run lint` and `bun test src/tui src/mcp-servers src/commands/agent-commands.test.ts` pass, and the CI `typecheck-and-tests` job is green on the PR head.
