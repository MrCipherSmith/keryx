# O-1/O-2: chat reaches the TUI as a tool-free agent + a genuinely shared slash-command registry

Status: formalized
Source: open items O-1 and O-2, `docs/requirements/keryx-opentui-shell/specification.md` §10

## Problem

**O-1.** The `keryx-opentui-shell` package scope is "the interactive shell (chat +
agent)", but only the agent half was built. The launch guard at
`src/commands/shell.ts:1094` is
`if (flags.wantTui && modeFlag !== false && process.stdout.isTTY)`, and `--chat`
sets `modeFlag = false`, so chat unconditionally falls to the readline renderer.
`ShellIO` has zero references under `src/tui/`.

The user-visible consequences are not cosmetic. Because `loadShellConfig()` and
`applySavedApiKeys()` are called only inside the TUI branch
(`src/commands/shell.ts:1149-1150`), **`--chat` cannot reach a provider whose key
lives in `auth.json`** — a key added via `/connect` is invisible to chat. Chat
also has no provider/model picker, no `/resume`, and none of the block, code or
diff rendering delivered by flow 109.

**O-2.** PRD F1 requires the `/` dropdown to reuse a shared registry "so chat and
agent share definitions". Only `AGENT_SLASH_COMMANDS` exists
(`src/commands/agent-commands.ts:15`), with one consumer. There are in fact
**three** divergent command surfaces today: chat readline (inline in `runShell`,
`shell.ts:252-335`), agent readline (inline in `runAgentRepl`, `:897-958`), and
the agent TUI registry. `/model` and `/connect` appear in two of them with
*different semantics* — a naive one-entry-per-name registry would paper over that
and produce a menu that lies in one mode.

## Expected Outcome

Chat becomes a **mode of the existing TUI**, not a second renderer: the same
shell launches with tools disabled. Concretely, `keryx shell --chat` on a TTY
gets the OpenTUI transcript, composer, `/`-menu, provider/model pickers, saved
credentials, session persistence and flow-109 block/code/diff rendering, with
tool calls, approval, side workers and the wiki-enrich router switched off.

The slash-command registry gains per-mode applicability so one source defines
both surfaces, and the readline paths consult it too — otherwise O-2 is only
partly met.

## Why this shape, and what it costs

Three paths were sized against the code before choosing:

- **A — shared core.** Restructure ~900 lines of the 1610-line
  `launchTuiAgentShell` closure into an explicit chrome module, re-land the agent
  shell on it, then add a chat driver. 1300-1800 lines moved. The closure has
  **zero tests** and one caller, so this is a refactor of the product's default,
  manually-validated UI.
- **B — a separate `launchTuiChatShell`.** 900-1200 new lines, and it recreates
  precisely the drift decision D-6 exists to prevent — three shells with
  divergent command surfaces.
- **C — chat as a tool-free agent (chosen).** 150-250 lines, no restructuring.
  `createTuiAgentIo` minus `attachBlockIo` is already ~85% of a chat renderer;
  what chat lacked was the shell around it, which already exists.

**The cost of C, stated plainly:** TUI chat is driven by `runAgentTurn`, not
`runShell`, so the two chat implementations differ in engine. `runShell` carries
its own short `SYSTEM_INSTRUCTION` (`shell.ts:126-129`) and a hardcoded
`budget: {maxOutputTokens: 1024, runReservation: 1024}` (`:351`); tool-free
`runAgentTurn` carries neither. That is a real behavioral difference between TUI
chat and readline chat which must be measured and documented, not hand-waved.

`runShell` does **not** become dead code, contrary to the initial sizing:
readline remains the fallback whenever there is no TTY, the optional dependency
is absent, or the renderer fails to initialise, and `runShell` is that fallback's
chat implementation (`shell.ts:1261`). Its ~600 lines of tests in
`src/commands/shell.test.ts` stay meaningful and must stay green.

## Out of Scope

- Restructuring `launchTuiAgentShell` (path A). Stays recorded as open.
- Retiring `runShell`, `ShellIO`, or the readline chat path.
- Registering assistant replies as addressable blocks so `Ctrl+O` / `/copy` work
  in chat. That is a new design decision touching D-3/D-5 and the AC11 layout,
  not a free carry-over; explicitly deferred.
- O-3 (platform coverage), O-4 (fallback parity test), O-5 (cold-start latency).
- Adding `onUsage` to `ShellIO`.
