# Context

Collected by a read-only context worker over `src/commands/`, `src/tui/`,
`src/session/` and the `keryx-opentui-shell` docpack, via gdctx. Branch
`feat/tui-chat-renderer`, stacked on `feat/tui-transcript-blocks` (PR #185)
because `src/tui/transcript-blocks.ts` exists only there.

## The `ShellIO` / `AgentIO` asymmetry — the load-bearing fact

`ShellIO` (`src/commands/shell.ts:73-93`) differs from `AgentIO`
(`src/commands/agent.ts:20-49`) not by having fewer hooks but by **direction**:

| | `ShellIO` | `AgentIO` |
|---|---|---|
| input | **owns it** — `lines: AsyncIterable<string>` | none; the caller reads lines |
| loop | `runShell` owns the `for await` | the caller owns the loop |
| finalized text | `onTurnEnd(full)` per turn | `onAssistantText(text)` per round |
| reasoning / tools / usage / approval | absent | present |

The spec says only "minus the tool/reasoning hooks" (`specification.md:151`); the
`lines` inversion is documented nowhere and is why a literal chat renderer is
expensive. A TUI composer pushes; `runShell` pulls. Path C sidesteps this
entirely by not using `runShell` in the TUI.

`select.ts`'s pickers (`pickAgentMode` `:190-215`, `pickProviderModel`
`:251-335`) are typed against `ShellIO` and use only `lines` + `write` — which is
why `ShellIO` cannot simply be deleted.

## `runShell` (`src/commands/shell.ts:165-413`)

Cleanly port-based: no stdio, provider through the injected port, ids/time
through `deps`. One provider request per line; slash branch at `:252-335`
`continue`s before the provider. Notable specifics that make it *not*
interchangeable with tool-free `runAgentTurn`:

- its own `SYSTEM_INSTRUCTION` (`:126-129`);
- hardcoded `budget: {maxOutputTokens: 1024, runReservation: 1024}` (`:351`);
- no usage hook at all — `ShellIO` has no `onUsage`, so a token counter reads 0;
- `io.write("\n\n")` as the turn separator (`:411`), special-cased by
  `createRichIo` (`:579`, `:583`). A TUI `write` feeding a stream segmenter would
  receive it after the message closed and open an empty block.

## Chat's readline UI today

`createRichIo` (`shell.ts:539-636`) — header (`:621-632`), cyan `❯` prompt
(`:568`), braille spinner on `onTurnStart` (`:588-601`), live token echo
(`:572-586`), and an in-place markdown re-render on `onTurnEnd` that counts rows
and cursor-ups (`:603-619`). No usage line, no tool chrome, no gutter. The REPL
loop *is* `runShell`; chat has no separate REPL function.

## Three command surfaces (drives O-2)

| command | chat readline | agent readline | agent TUI registry |
|---|---|---|---|
| `/help` `/exit` `/quit` `/clear` `/new` `/compact` | ✓ | ✓ | ✓ |
| `/model` | ✓ `<name>` arg, no picker | ✗ | ✓ picker |
| `/models` | ✓ | ✗ | ✗ (subsumed by `/model`) |
| `/provider` | ✓ | ✗ | ✗ (subsumed by `/connect`) |
| `/connect` | ✓ static env guidance | ✗ | ✓ interactive picker + key entry |
| `/resume` | ✗ | ✗ | ✓ |
| `/expand` | ✗ | ✓ | ✓ — meaningless in chat (no tool output) |
| `/think` | ✗ | ✗ | ✓ — meaningless in chat (no reasoning hook) |
| `/copy` | ✗ | ✗ | ✓ — chat-capable only if replies became blocks (deferred) |

Chat readline commands are inline at `shell.ts:252-335` (`HELP_TEXT` `:144-158`);
agent readline at `:897-958`; the registry at `agent-commands.ts:15-27` with
`filterCommands` / `findAgentCommand` (`:40`, `:49-51`).

## What flow 109 gives chat for free

From `src/tui/transcript-blocks.ts`: `createStreamSegmenter` (`:274`),
`createSegmentView` (`:509`), `markdownToChunks` (`:383`), `payloadChunks`
(`:483`), `diffChunks` (`:439`). `createTuiAgentIo` (`tui-shell.ts:148-173`)
already renders exactly this way and uses **no** tool state — it is chat-shaped
already.

Unused in chat: `createBlockRegistry`, `createBlockView`,
`createBlockNavController`, and the eviction/truncation markers. `attachBlockIo`
registers only thought / tool / output as blocks; assistant markdown is never a
block (`specification.md:130-134`). So the `Ctrl+O` machinery is inert in chat
unless replies become blocks — deferred by this flow.

## `launchTuiAgentShell` — why we are not restructuring it

`src/tui/tui-shell.ts:691-2300`, **1610 lines**, one caller
(`shell.ts:42`, `:1174`), **zero tests**. Held together by forward-declared
mutable bindings rewired far later, with load-bearing ordering the code itself
comments on: `showToast` no-op at `:755` → real at `:873`; `clearBusyTimer`
`:756` → `:1412`; `setBusyPhase` no-op at `:928` → `:1369`;
`createBlockNavController` at `:942-952` closes over `menu`, `menuNav`,
`overlayActive`, `input`, `textarea`, all declared 100-400 lines later.

Agent-specific regions this flow must gate for chat: `io.requestApproval`
(`:1142-1265`), `askUserInteractive` (`:1268-1316`), worker-fleet sidebar
(`:817-866`), side workers (`:1663-1806`), the wiki-enrich pre-router
(`:1994-2157`), and the `runAgentTurn` call site (`:2160-2198`).

## Session / credentials — the actual user-visible bug

`loadShellConfig()` + `applySavedApiKeys()` are called **only** at
`shell.ts:1149-1150`, inside the TUI branch. The readline path — all of chat —
never applies saved `auth.json` keys and never reuses the last provider/model.
`saveShellConfig` (`tui-shell.ts:780`, `:1655`), `saveApiKey` /
`promptApiKeyStep` (`:26`, `:457-496`) and the `/resume` picker
(`:1470-1519`, `:1601-1641`) are likewise TUI-only.

Chat *does* have session persistence (`shell.ts:186-228`, `/compact` `:275-297`,
`/new` `:264-274`), but `-r` with no id degrades to `latestSession(...)?.id`
(`:1317-1320`) instead of a picker.

## Test surface

Chat is the **best-tested** interactive surface: `src/commands/shell.test.ts`
(830 lines) drives `runShell` with literal `ShellIO` objects and a wrapped
`FakeProvider` — AC1 streaming/history (`:261-336`), AC2 slash commands and
`provider_error` resilience (`:338-455`), AC3 `/models` / `/provider` /
`/connect` + credential safety (`:462-610`), the flow-031 hook contract including
the byte-identical-without-hooks guarantee (`:612-702`). None of it touches
rendering. **All of it must stay green** — path C does not remove `runShell`.

TUI tests use `@opentui/core/testing`'s `createTestRenderer`; `launchTuiAgentShell`
itself is never invoked by a test, and `mountBlockHarness`
(`tui-shell.test.ts:380-501`) mounts a **replica** layout. Three harness
constraints are load-bearing (`specification.md` §7.1): sequential
`@opentui/core` → `/testing` imports, the 20ms bare-`Esc` timeout
(`pressEscapeAndSettle`), and the pinned `scrollTop === 2` ScrollBox overdraw
defect.

## Risks

1. **Engine divergence.** TUI chat runs `runAgentTurn` with no tools; readline
   chat runs `runShell` with a 1024-token budget and a different system
   instruction. Two chat behaviours under one flag. Must be measured and
   documented; the alternative (align them) is out of scope here.
2. **Gating by omission.** Chat mode is defined by what is switched *off*. If a
   future agent feature is added without a mode check, it leaks into chat. The
   gate must be one explicit mode value threaded from the flags, not scattered
   booleans.
3. **The closure stays untested.** This flow adds a mode to code no test mounts.
   New behaviour must be reachable from the headless harness or it is unverified.
4. **Command semantics.** `/model` and `/connect` mean different things in the
   readline and TUI surfaces; the shared registry must not flatten them.
5. `/expand`, `/think`, `/copy` must not merely be hidden from the menu — typing
   them directly in chat has to fail cleanly.

## Baseline

Branch tip `35f96c1`. `bun run typecheck` clean; `bun test` → **2024 pass /
11 skip / 0 fail**; `bun test src/tui` → 68 pass, **0 skip** (OpenTUI present in
this worktree, so headless tests genuinely execute).
