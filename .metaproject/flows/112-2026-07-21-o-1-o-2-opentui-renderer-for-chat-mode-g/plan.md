# Implementation Plan

Status: ready — **path A (shared core)**

## Approach

Extract the mode-agnostic shell chrome out of `launchTuiAgentShell` into an
explicit module with a real interface, re-land the **agent** shell on it, prove
the extraction with the first headless mount test the closure has ever had, and
only then add a thin chat driver that renders `ShellIO` through the same chrome.

Path A was chosen over C (chat as a tool-free agent) for one decisive reason:
under A both chat surfaces run **the same driver**. TUI chat and readline chat
are then identical in system instruction, budget and turn semantics by
construction, instead of being two engines behind one flag. It is also the only
path that makes the spec's own component diagram true and that can ever unblock
Phase 5's "retire the readline path".

## The four seams

### S1 — `src/tui/shell-chrome.ts` (new): mode-agnostic chrome

Everything in the closure that does not know what a tool is:

- renderer bootstrap, `onDestroy`, copy-on-select OSC-52 (`tui-shell.ts:728-771`)
- layout: rootRow / main / sidebar / header / transcript scrollbox / footer
  (`:787-915`, `:1319-1417`)
- `showToast` (`:868-882`), overlay guard `withOverlay` / `overlayActive`
  (`:1036-1046`)
- `/`-menu `SelectRenderable`, `refilter`, printable-key router
  (`:1049-1066`, `:1424-1444`, `:2206-2249`)
- composer box, `input` adapter, `syncComposerHeight` (`:1070-1138`)
- busy spinner: `paintBusyStatus` / `startBusy` / `stopBusy` / `setBusyPhase`
- session bootstrap, `saveSession` / `startNewSession` /
  `resumeSessionInteractive` (`:1449-1643`)
- `updateModelLabels` / `switchTo` (`:1646-1661`), provider/model/key pickers
  (already extracted: `:457-689`)

Returns a `ShellChrome` object — renderables plus `setBusyPhase`, `showToast`,
`overlayActive`, `focusComposer`, `onSubmit`, session handles. **The five
forward-declared mutable bindings are resolved, not carried over**: `showToast`
(`:755`→`:873`), `clearBusyTimer` (`:756`→`:1412`), `setBusyPhase`
(`:928`→`:1369`), and `createBlockNavController`'s late closure over `menu` /
`input` / `textarea` (`:942-952`). Construction is reordered so nothing is a
placeholder no-op; where a genuine cycle remains it becomes an explicit setter on
the chrome object, not a rebound `let`.

### S2 — agent shell re-landed on the chrome

`launchTuiAgentShell` keeps only what is agent-specific: `attachBlockIo` wiring
(`:987-1004`), `io.requestApproval` (`:1142-1265`), `askUserInteractive`
(`:1268-1316`), worker-fleet sidebar (`:817-866`), side workers (`:1663-1806`),
the wiki-enrich pre-router (`:1994-2157`), block registry + nav (`:931-964`), and
the `runAgentTurn` call site (`:2160-2198`). Behaviour must not change.

### S3 — `src/tui/chat-shell.ts` (new): the chat driver

Mounts the chrome, then bridges the **direction mismatch** that makes `ShellIO`
different from `AgentIO`: `runShell` pulls (`lines: AsyncIterable<string>`) while
the composer pushes. A small queue adapter turns `onSubmit` into an async
iterator with backpressure and a clean end-of-stream on `/exit`.

Rendering reuses flow 109 directly — `createStreamSegmenter` +
`createSegmentView` + `markdownToChunks` — so chat gets fenced-code framing and
diff colouring for free. `onTurnEnd(full)` re-segments once, exactly as
`onAssistantText` does. The `"\n\n"` turn separator (`shell.ts:411`) is swallowed
by the adapter so it cannot open an empty message block.

`deps.selectProviderModel` is injected with the TUI pickers, so `/models` and
`/provider` stop consuming composer submissions as text-menu input.

### S4 — one command registry with modes (O-2)

`AgentSlashCommand` gains `modes: readonly ShellMode[]`; `filterCommands(query,
mode)` and `findAgentCommand(token, mode)` take the mode. `/expand`, `/think`,
`/copy` are agent-only; `/models` and `/provider` become chat-mode aliases of
`/model` and `/connect`. **The readline surfaces consult the registry too** —
otherwise, per the context report, O-2 is only two-thirds met.

## Decisions

- **D-A1 — chrome is a returned object, not a base class.** The closure's coupling
  is data, not behaviour; an object with explicit fields is testable and avoids an
  inheritance hierarchy over renderables.
- **D-A2 — no `onUsage` added to `ShellIO`.** Chat has no usage hook, so the token
  counter would read 0. Rather than change a driver hook surface the package
  promised to leave alone, chat uses the existing `estimateContextTokens`
  (`tui-shell.ts:384-395`, flow 077's local-model estimator) and the header shows
  it as an estimate.
- **D-A3 — assistant replies stay segment views in chat.** Registering them as
  blocks would give chat `Ctrl+O` and `/copy`, but it touches D-3/D-5 and the
  AC11 layout. Deferred, recorded, not silently dropped.
- **D-A4 — sequencing is the risk control.** S1+S2+the chrome test land and are
  verified *before* S3 is written. A single pass that refactors and adds chat at
  once is how the agent TUI gets quietly broken.

## Steps

1. **T2** — headless mount test for the chrome contract, written against the
   interface before it exists (it must fail).
2. **T3** — S1: extract `shell-chrome.ts`, resolving the forward declarations.
3. **T4** — S2: re-land the agent shell on the chrome. Full suite green,
   behaviour unchanged.
4. **T5** — S4: the mode-aware registry, including the readline surfaces.
5. **T6** — S3: the chat driver + the `--chat` launch path in `shell.ts:1094`.
6. **T7** — verification, review, docpack update (O-1/O-2 closed in §10, the
   status line and the §1 diagram corrected), journal.

## Risks

- **R1 — refactoring untested default UI.** `launchTuiAgentShell` has zero tests
  and one caller; every regression lands in the product's default surface.
  Mitigated by D-A4's ordering and by T2 landing a real mount test first. This is
  the dominant risk and it does not go away.
- **R2 — the push/pull adapter.** "Main is busy, defer this command", `/exit`
  teardown and mid-turn overlays currently live in `runLine`, which exists
  *because* the TUI owns the loop. With `runShell` owning it, that logic needs a
  deliberate home — likely the adapter itself, gating what it yields.
- **R3 — behaviour drift during extraction.** Moved code is easy to alter by
  accident. Every existing test stays green, and `bun test src/tui` must not lose
  a single assertion.
- **R4 — `/model` and `/connect` semantics differ per mode.** The registry must
  carry per-mode descriptions, not one flattened entry.
- **R5 — scope creep into path C.** If S1 proves larger than sized, the fallback
  is to stop after T4 (chrome extracted, agent re-landed, chrome tested) and
  ship chat separately. That is a legitimate stopping point, not a failure.
