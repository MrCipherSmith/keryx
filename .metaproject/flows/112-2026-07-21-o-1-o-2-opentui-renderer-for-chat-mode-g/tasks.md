# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Map ShellIO/AgentIO, the closure, and the three command surfaces (DONE — see context.md) |
| T2 | test | Failing headless mount test pinning the ShellChrome contract |
| T3 | implement | S1 — extract `src/tui/shell-chrome.ts`, resolving the forward declarations |
| T4 | implement | S2 — re-land the agent shell on the chrome, behaviour unchanged |
| T5 | implement | S4 — mode-aware shared command registry, readline surfaces included |
| T6 | implement | S3 — chat driver + `--chat` launch path |
| T7 | review | Verify, review, update the docpack and journal |

## T1 — context (kind: context) — DONE

Delivered `context.md`: the `ShellIO`/`AgentIO` direction asymmetry, `runShell`'s
specifics, the three command surfaces, the closure's forward-declared bindings,
the credential bug that makes `--chat` unable to see `auth.json`, and the test
surface.

## T2 — test (kind: test)

Write the headless mount test **first**, against the `ShellChrome` interface
before it exists. This is the safety net for the whole flow — `launchTuiAgentShell`
has never been mounted by a test.

Follow `src/tui/tui-shell.test.ts`: the `loadOpenTui()` skip-when-absent shape
(keep its **sequential** imports), `createTestRenderer({width, height})`,
`captureCharFrame()` / `captureSpans()`, `mockInput.pressKeys`, and
`pressEscapeAndSettle` for a bare `Esc` (20 ms wall clock).

Pin at minimum:
- mounting the chrome produces a frame with header, transcript, composer and
  footer, and the composer holds focus;
- `/` opens the menu, printable keys filter it, `Esc` closes it and returns focus;
- `showToast` renders and auto-clears; `overlayActive()` is true while an overlay
  is open and blocks the menu router;
- `setBusyPhase` is reflected in the footer;
- `resize()` keeps composer and footer visible (the flow-075 guard).

These must fail before T3 and pass after, without being weakened.

## T3 — implement (kind: implement)

Extract `src/tui/shell-chrome.ts` per plan S1. Mode-agnostic only — nothing that
knows about tools, approval, side workers or the wiki router.

Resolve, do not carry over, the forward-declared mutable bindings: `showToast`
(`tui-shell.ts:755`→`:873`), `clearBusyTimer` (`:756`→`:1412`), `setBusyPhase`
(`:928`→`:1369`), and the late closure in `createBlockNavController`
(`:942-952`) over `menu` / `menuNav` / `overlayActive` / `input` / `textarea`.
Reorder construction; where a real cycle remains, expose an explicit setter on
the chrome object rather than rebinding a `let`.

`@opentui/core` stays reachable only via `typeof import(...)`; `otui` is a
parameter. No new dependency.

## T4 — implement (kind: implement)

Re-land `launchTuiAgentShell` on the chrome. It keeps only the agent-specific
regions listed in plan S2. **Behaviour must not change**: the full suite stays
green and `bun test src/tui` loses no assertion. Any deliberate behavioural
change is a finding to report, not to make.

## T5 — implement (kind: implement)

`AgentSlashCommand` gains `modes: readonly ShellMode[]`; `filterCommands` and
`findAgentCommand` take the mode. `/expand`, `/think`, `/copy` → agent-only.
`/models` and `/provider` → chat-mode aliases of `/model` and `/connect`, with
per-mode descriptions (they mean different things in the two surfaces — do not
flatten them).

Wire the readline surfaces to the registry as well: chat's inline branch
(`shell.ts:252-335`, `HELP_TEXT` `:144-158`) and agent's (`:897-958`). Without
this, O-2 stays two-thirds met.

An agent-only command typed directly in chat must fail cleanly, not merely be
hidden from the menu.

## T6 — implement (kind: implement)

Create `src/tui/chat-shell.ts` per plan S3 and open the launch path: the guard at
`src/commands/shell.ts:1094` drops its `modeFlag !== false` clause and dispatches
by mode.

The push→pull adapter turns composer submissions into `ShellIO.lines` with
backpressure and clean end-of-stream on `/exit`; it also swallows the `"\n\n"`
turn separator (`shell.ts:411`) so it cannot open an empty message block, and it
is where "a turn is in progress" gating lives (plan R2). Inject the TUI pickers
as `deps.selectProviderModel` so `/models` and `/provider` do not consume
composer input as text-menu answers.

Chat renders through `createStreamSegmenter` / `createSegmentView` /
`markdownToChunks`. Token display uses `estimateContextTokens` per D-A2 — no
`onUsage` is added to `ShellIO`.

Chat must now reach `loadShellConfig()` / `applySavedApiKeys()`, closing the bug
where a key added via `/connect` was invisible to `--chat`.

## T7 — review (kind: review)

Run the touched-scope tests, then `code-verifier`, `keryx health run`, and
`review-orchestrator` (frontend/logic/clean-code + project conventions), with the
reviewer told that T3/T4 moved untested code and deserve extra scrutiny.

Then update the docpack: close **O-1** and **O-2** in `specification.md` §10,
correct the status line, and make §1's component diagram true now that a real
`ShellIO` implementation exists. Record D-A1..D-A4 in §9. Append the run to
`journal.md`, including anything deferred (D-A3, and O-3/O-4/O-5 which remain
open).
