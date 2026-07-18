# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The interactive shell (`src/commands/shell.ts` `createRichIo`/`shellCommand`/`runAgentRepl`) NO LONGER enters, draws, or exits a DECSTBM scroll-region and reserves NO terminal row; the `enterBar`/`exitBar`/`redrawBar`/scroll-region draw and the SIGWINCH/SIGINT/exit scroll-region handlers are removed. Verifiable: `src/commands/shell.ts` contains no `scrollRegion(`/DECSTBM usage and no `[<n>r` region-set escape is emitted by the shell.
- AC2: The one-time header shows the working directory alongside the provider/model (and `· agent` in agent mode) — e.g. `printHeader` subtitle includes `collapseHome(process.cwd())`. The colored `❯` prompt, the `thinking…` spinner, live token streaming, markdown rendering, and agent tool-call rendering remain present in the wrapper.
- AC3: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1452 pass / 3 skip / 0 fail (adjusting only the flow-032 status-bar tests that pin removed behavior; the deterministic `runShell` chat-core tests and the agent-driver tests stay green) with 0 fail; `dependencies` REMAINS `{}`; the chat core, agent driver, tools, and providers are unchanged. A live manual smoke (`bun src/cli.ts shell --agent`) shows the input prompt NOT colliding with any bottom bar and the assistant reply visible — recorded in the journal; not a CI gate.
