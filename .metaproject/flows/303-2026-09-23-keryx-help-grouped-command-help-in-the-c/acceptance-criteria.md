# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A single `HELP_GROUPS` table (under `src/standard/`, beside the command registry) orders the onboarding groups - Start here; Connect a model provider; Look and feel; Working in keryx shell; Project knowledge; Managed work; Automation; External agents, ACP and MCP; Maintenance and diagnostics - and places every `CLI_ROUTES` verb and every `AGENT_SLASH_COMMANDS` entry in exactly one group; a test fails on any unplaced, double-placed or unknown entry.
- AC2: Every CLI verb and slash command in `HELP_GROUPS` has a one-line description from the command registry, the slash-command table or a new summary field, and a test fails when one is missing; nothing is left undescribed.
- AC3: `keryx help` prints every group in onboarding order with each command and its one-line description, within 80 columns, proven by a width test over the real table.
- AC4: `keryx help <group>` prints one group and `keryx help <command>` prints that command's full usage (the existing rich group help where one exists); an unknown name exits non-zero and names the closest matches.
- AC5: `keryx --help`, `keryx -h` and a bare `keryx` keep printing the same flat usage block as before, changed only by the lines that name `keryx help`, and the four rich group helps (flow, trigger, serve-mcp, governance) are unchanged; a test pins the flat block against the pre-flow text plus exactly those lines, and the rich helps against their pre-flow output.
- AC6: In the OpenTUI shell, `/help` opens a modal built on `modal-host.ts` with one tab per group in onboarding order; left and right switch tabs, up and down move within a tab, Enter shows the selected command's detail (usage, whether it needs a model, whether it only reads), and Esc closes; a keypress-driven test proves each key.
- AC7: The readline shell, `--no-tui` and the ACP host keep a text `/help`, now grouped the same way, because a modal cannot render there.
- AC8: On the first `keryx shell` run with no model provider configured, the help modal opens on the "Connect a model provider" tab, once, and never again after a provider is saved; a test covers both.
- AC9: `docs/docs/commands-by-task.md` is generated from `HELP_GROUPS` and linked in the mkdocs nav, and a test fails when the checked-in page differs from what the table generates.
- AC10: `keryx help` itself is in `CLI_ROUTES`, the CLI reference, the command registry coverage and `HELP_GROUPS`.
- AC11: The CLI reference and the README document `keryx help` and the `/help` modal.
- AC12: CI is green on the pull request and `keryx health run` passes before merge.
- AC13: The keryx shell start screen shows a short line for a new user naming `/help` and what it opens (commands grouped by the steps to get started), in theme colours, within the start screen width, and a TUI test pins it.
- AC14: From launch until the shell can take input, keryx shell never shows a blank screen: the splash, or a spinner with a short label of the current startup step, stays visible until the composer is ready, and a test proves the loading indicator is on screen while startup is still pending and gone once it completes.
