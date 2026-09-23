# Context

Collected deterministically by `keryx flow init` at 2026-09-23T05:32:20.793Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.924] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.846] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
3. [1.843] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.696] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown
5. [1.656] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Phase 1 research, 2026-09-23. Written by a research subagent. Line numbers are from `feat/tui-governance-triggers` at 0.2.155 (b5d1a098).

### 1. How the sidebar is built

- The chrome builds `sidebar` (fixed width, `SIDEBAR_WIDTH` from `src/tui/sidebar-metrics.ts`) with three parts: a scroll box whose `.content` is `sidebarTop`, a flexGrow spacer, and the pinned toast. See `src/tui/shell-chrome.ts:628-691`, and `ShellChrome.sidebar/sidebarTop/sidebarScroll` at `:376-394`. Callers add their panels to `sidebarTop`. Anything added to `sidebar` itself would sit beside the toast (`src/tui/tui-shell.ts:3375-3378`).
- There is no section registry. Every panel is added by hand, in order, inside `runTuiShell`'s closure (`src/tui/tui-shell.ts:3378-3629`). The order is: title (`mountTitlePanel`, `:1029`), Model, mode, hold banner, Usage, Balance (`mountBalancePanel`), Directory/Branch/PR (`mountCwdPanel`, `:1058`), Workspace (`sb-workspace`, `:3427`), Review (`sb-review`, `:3476`), Context, Tools, Status, Subagents (`sb-subagents`, `:3525`), Plan (`sb-plan` + `mountExecutionPlanPanel`, `:3532-3554`), and Jobs (`sb-jobs`, `:3558`).
- Every conditional section uses the same idiom. It is a hug-content `BoxRenderable` (`flexDirection: "column", flexShrink: 0`) that stays EMPTY (zero rows) when there is nothing to show, and it is cleared and repainted as a whole (`clearTranscriptChildren`). The reason is recorded at `:3421-3426` and `:3473-3475`: `sidebarTop` is a fixed-height column, so a row that says "nothing" takes rows from Tools/Status. `src/commands/shell-pty-launch.smoke.test.ts:59,290-292` fails when `Model/Context/Tools/Status/Ready` are pushed off an 80x24 pty.
- The best template to copy is `src/tui/execution-plan-panel.ts:80-146`. `mountExecutionPlanPanel(otui, renderer, parent, {…, onOpen})` returns `{refresh, dispose}`. It uses a pure projection (`projectExecutionPlanPanel`, `:43`), generation-guarded async refresh, a subscription, and `onMouseDown` on the header and on every row. `src/tui/balance-panel.ts:71-164` is the async fetch-on-mount / re-fetch-on-click variant. Both are exported and tested without the shell (`execution-plan-panel.test.ts:109-166`, `balance-panel.test.ts`).
- Refresh cadence today: `refreshWorkspaceSidebar` and `refreshReviewSidebar` (`tui-shell.ts:3451,3482`) run on mount and resume (`:4759-4760`), on new session (`:6360-6364`), and after every settled turn (`:7036-7040`). Subagents/Jobs repaint from store subscriptions (`:3627-3637`). Nothing polls the filesystem today.
- Mouse: rows are `TextRenderable`s with their own `onMouseDown` (`tui-shell.ts:3445,3494,3508`; `background-job-inspector.ts:285-318`). The sidebar box itself is display-only and deliberately takes no focus (`shell-chrome.ts:1067-1086`, FR-11). So keyboard access to a sidebar feature today means a slash command that opens the same modal.

### 2. How modals work

- There is one host per renderer: `openModal(otui, chrome, {title, tabs, initialTab, footer, renderTab, onArrowKeys, onClose, contentRows})` in `src/tui/modal-host.ts:36-48,618-671`. Opening a second modal replaces the first instead of stacking (`:633-637`). The host registers an overlay source, blurs the composer, and saves and restores transcript scroll. It is theme-aware through `onThemeChange` (`:579-587`).
- Host keys (`modal-host.ts:504-576`): Esc closes; `x` closes unless focus is in the body; ←/→ and tab/shift+tab switch tabs; 1-9 jump to a tab. With a single tab, the arrows are left to the body (`:536`).
- The body is a `ScrollBoxRenderable` (`:443-468`). Inspectors do NOT rely on it for keyboard scrolling. They window lines themselves. `src/tui/flow-inspector.ts` is the list+detail reference: `clampScroll/windowLines/scrollToReveal` (`:97-118`), `wrapLines` to `ctx.width` (`:135-152`), ↑/↓/j/k, PgUp/PgDn and Enter handled through `inspectorKeys.onKeypress` (`:262-304`), and `modalBodyRows(resolveModalPanelSize(...))` for the page size (`:189-193`). The same scroll keys appear in `mcp-inspector.ts:611-630`, `review-inspector.ts:707-726`, `workspace-inspector.ts:284-317` and `mcp-consumer.ts:591-600`.
- `inspectorKeys` and `inspectorCwd` are defined at `tui-shell.ts:5058-5059`. The modal openers live at `tui-shell.ts:5107-5353` (`showWorkspace`, `showReview`, `showBus`, `showMcpConsumer`, `showTools`). The model/session picker (`pickSessionInTui`, `:2879-2931`) uses `mountFilterList` inside `openModal`.
- Arm-then-confirm for a consequential action already exists in two places. In `mcp-inspector.ts:16-18,46,278,484-512` (`MCP_TAB_KEYS`), `c`/`d` or a click arms and `y` confirms. The `/review` modal's `[a]` then `[y]` accept (`review-inspector.ts`) is the other.
- Long markdown: the TUI deliberately avoids the WASM `MarkdownRenderable`. `markdownToChunks` (`src/tui/transcript-blocks.ts:411-423`) is the worker-free renderer (ATX headings, bold, inline code). The governance markdown (`renderGovernanceMarkdown`, `src/governance/report.ts:113-197`) has headings, `key: value` lines and indented attempt lines, and no fences or tables. So the modal can window `latest.md`'s lines (flow-inspector idiom) and style each visible window through `markdownToChunks`.

### 3. Background work and "done" notification

- The JobRegistry (`src/harness/tool/builtin/background-job-registry.ts:239-305`) is the model's shell-task supervisor. Its `onCompletion` + `drainUndelivered` are flow 265's wake path. A finished background task becomes a `<task-notification>` user message and starts a new agent turn (`src/commands/agent.ts:987-1035,1901-1915`; `tui-shell.ts:6017-6028`). **Routing a governance run or a trigger run-now through `jobRegistry.start` would wake the model and bill a turn for a UI action.** The Jobs sidebar feed is `setBackgroundJobListener` (`src/tui/job-bridge.ts`), which is tied to that registry.
- The only operator-initiated background action the TUI runs today shells out. `/review` accept runs `keryx workspace …` through `makeCommandRunner(cwd)` (`src/tui/review-accept.ts:43-80`, wired at `tui-shell.ts:5138-5144`), and it uses the `keryx` found on PATH. The memory constraint "The keryx on PATH is a stale build" applies. `src/trigger/schedule.ts:63-69` `resolveKeryxInvocation()` (the `process.execPath` + `argv[1]` of THIS process) is the existing way to re-invoke the same build.
- The toast is `chrome.showToast` (`shell-chrome.ts:457`). Async repaint from a promise continuation works: the Review/Workspace refreshes do exactly that. `modal-host.ts:658-669` records that a redraw requested during a keypress can be dropped, and re-requests it on the next tick.

### 4. The features to surface

**Governance** (`src/governance/*`, CLI `src/commands/governance.ts`):
- The public facade is `src/governance/service.ts:19-41`. It exports `buildGovernanceReport`, `writeGovernanceArtifacts`, `readLatestGovernanceReport` and `renderGovernanceMarkdown`, but NOT `readProjectTriggerSpend` (`spend.ts:99`). The import rule (`src/lib/import-policy.ts:156,349`) says a client reaches a core owner only through `service.ts`.
- `keryx governance report` is the whole CLI path: `buildGovernanceReport({cwd, filters, allProjects, now}) → writeGovernanceArtifacts` (`commands/governance.ts:41-59`). It is read-only (async fs, no locks, no model or network; `aggregate.ts:21-25,84-85`). Running it in-process from the TUI calls the identical functions, with no subprocess and no stale-binary risk.
- `readLatestGovernanceReport` (`report.ts:231-249`) already returns `absent | malformed | present`, which maps directly onto the operator's "no report" state. `generatedAt` is the date to show. The stored report can carry filters or `--all-projects` from a CLI run (`report.ts:118-124`), so the modal should show them.

**Triggers** (`src/trigger/*`, CLI `src/commands/trigger.ts`):
- Declared entries: `loadTriggersConfig(root) → {triggers, rejected, fileProblem}` (`config.ts:458`; `absent` ⇒ no config). The ledger is `readTriggerRuns` (`record.ts:252`: `absent | present | unreadable`). A bad line makes the whole ledger unreadable. The CLI helpers are `latestRunByTrigger` (`record.ts:300`) and `openReservations` (`record.ts:193-209`).
- `status`/`list` wording lives in private functions of `commands/trigger.ts` (`describeRecord :715`, `describeFire :720`, `describeAction :724-737`, `describeHookInstalled :650`). `describeAction` is where `NETWORK ON — ${NETWORK_ON_WARNING}` is printed (`:732`; text at `trigger-dispatch.ts:117-119`). The roster text is `UNATTENDED_ROSTER_DESCRIPTION` (`trigger-dispatch.ts:121`). Reuse needs these extracted and exported, not copied.
- Project trigger spend (recorded USD, plus a count of runs whose cost was NOT recorded, never counted as $0) is `readProjectTriggerSpend` (`governance/spend.ts:99-125`).
- `run` (`commands/trigger.ts:153-271`) prints with `console.log/error`, sets `process.exitCode`, and for `reconcile`/`rebuild` calls `syncCommand`/`gdgraphCommand` in-process under `withTriggerRunLock` (the maintenance lock, `waitMs: 0`, `trigger/run.ts:137-174`). `flow-next` with a `dispatch` block runs an unattended agent for up to `maxSeconds` (default 1800, `config.ts:135`). An in-process call from the TUI would write to the terminal behind the renderer, clobber the TUI's exit code, and tie a 30-minute run to the TUI's lifetime. **A child process `<execPath> <script> trigger run <name>` in the project root reproduces the CLI exactly, by construction.** Locks, budget (`evaluateTriggerBudget`, `run.ts:362`), spend reservation, dispatch refusals and the unattended floor (`unattended.ts`) all happen inside that process.
- `firedBy` is recorded as the entry's declared `fire` (`commands/trigger.ts:563`), for a manual CLI run as for a hook. A TUI run-now is therefore indistinguishable in the ledger from `keryx trigger run` typed at a shell, and that is exactly the CLI's behaviour.
- `resolve` needs an operator-stated `--spent <usd>` (`:750-795`). The TUI has no numeric-entry idiom in modals except the wizard text field.

**External agent runs** (`src/harness/external/acp-run.ts:301-344`):
- `persistAcpRun` creates a normal keryx session with `provider: "acp:<agent>"` and title `ACP <agent>: <status>`, and writes `acp-run.json` plus an optional `acp-worktree.patch` beside it.
- **They already appear in the TUI's `/sessions` and `/resume` list.** `listSessions` has no provider filter (`src/session/store.ts:558-580`), and `sessionPickerOptions` (`tui-shell.ts:2836-2854`) shows only title, short id, dates and message count. The provider is not shown or searchable; the title prefix `ACP` is the only marker.
- Choosing one resumes its history as a native session under the TUI's current provider (`openSession` → `loadHandle`, `store.ts:927-936`; `leasedOpen` passes `currentSel.provider`, `tui-shell.ts:4573-4583`). There is no read-only view of `acp-run.json` or the patch.
- Side finding, out of scope: `latestSession` is `listSessions()[0]` (`store.ts:582`), so `keryx shell -c` right after `keryx agents external run` continues the ACP run's session.
- In-TUI `/delegate` runs are a different path: they are live rows in the Subagents section, opened with `openExternalInspector` (`tui-shell.ts:3590-3598`).

### 5. Slash commands

- `AGENT_SLASH_COMMANDS` is at `src/commands/agent-commands.ts:61-260`. TUI-only commands are `modes: AGENT_ONLY` (for example `/workspace` `:141-148`, `/review` `:149-156`, `/mcp` `:178-183`). The readline agent REPL falls back to "not available here".
- The TUI dispatch is an `if`-chain inside `runLine` (`tui-shell.ts:6533-6560`). While busy, `classifyBusyDispatch` (`src/tui/busy-dispatch.ts:60-97`) must also learn any new read-only command, or it is deferred to a side worker (`tui-shell.ts:6048-6062`).
- Tests pin exact lists and must change with a new command: `agent-commands.test.ts:22-55,120-165,247-280` (full ordered lists), `:73` (`filterCommands("/g")` = `["/goal","/game"]`, which `/governance` changes), `shell-slash-registry.test.ts:84-101`, and `src/acp/commands.ts:46` `ACP_TUI_ONLY_COMMANDS` with `acp/commands.test.ts:21-32`. The last one asserts that every agent-mode command is either served over ACP or listed as TUI-only.

### 6. Theming

- Colours go through `roleChunk(otui, role, text)` / `dimChunk` / `boldChunk` (`src/tui/theme-text.ts:26-49`). The roles are `text | muted | accent | attention | ok | error | side` (`theme.ts:75`). The convention is attention (yellow) for "needs you" and error for failure (`tui-shell.ts:3576-3581`, `:3493`). Never use fixed `otui.yellow` hexes: a `/theme` switch recolours only old palette-slot values (memory lesson "theme-switch repaint", `shell-chrome.ts:1408-1446`).
- Layout guard: no `alignSelf` on renderables (`src/capability/tui-layout.test.ts:47`, memory lesson).

### 7. How the TUI is tested

- Headless: `otui.testing.createTestRenderer({width,height})` returns `{renderer, mockInput, mockMouse?, flush, captureCharFrame, resize}`, gated by `otuiTest = test.skipIf(OTUI === undefined)`. Used in `tui-shell.test.ts:183-271,793-867` (`mountBlockHarness`), `modal-host.test.ts:50-52`, `wizard-modal.test.ts`, `shell-chrome.test.ts`, `model-session-picker-modal.test.ts` and others.
- Panel and modal logic without a renderer: fake `TextRenderable` classes that capture `onMouseDown` (`background-job-inspector.test.ts:195-258,331-374`, `mcp-inspector.test.ts:241-422`, `execution-plan-panel.test.ts:109-166`, `subagent-inspector.test.ts:76-117`), plus `presentX(openModalFn, …)` injection (`flow-inspector.ts:175`).
- Real pty: `src/commands/shell-pty-launch.smoke.test.ts` (80x24; sidebar labels must be visible).
- Script: `test:client:terminal` = `bun test src/tui/ src/commands/shell` (`.metaproject/data/testing/context.md:19`).
- `runTuiShell`'s inner closure is not unit-mountable. That is why every tested panel is an exported `mountXPanel` / `openX`.

### 8. The seam with flow 295 (scheduler)

- Flow 295's frozen criteria (`/home/altsay/keryx-sched/.metaproject/flows/295-*/acceptance-criteria.md`) say:
  - AC10: a **Schedules** section in `sidebarTop` "like the Plan and Jobs sections", hidden when empty, clickable rows.
  - AC11: a 4-tab modal whose actions "call the same function as the CLI".
  - AC12: `/schedule` and `/schedules` slash commands.
  - AC13: the section and modal **poll the ledger on an injectable interval** and repaint only on change.
  - AC14: spend flows into `runs.jsonl` and governance.
- Shared surfaces where the two flows collide:
  1. Both read `.metaproject/data/trigger/runs.jsonl` + `triggers.json`, and 295's schedules are trigger entries with `fire.kind === "schedule"`.
  2. Both append to `AGENT_SLASH_COMMANDS`, `busy-dispatch`, `ACP_TUI_ONLY_COMMANDS` and their exact-list tests.
  3. Both add sections after `sb-jobs` in `tui-shell.ts`.
- Proposed seam: one TUI-side module (working name `src/tui/trigger-ledger.ts`) that owns:
  - (a) the projection `loadTriggerView(root)` over config and ledger, with the exported predicate `isScheduledEntry(entry) = entry.fire.kind === "schedule"`;
  - (b) one change-detecting poller (`watchTriggerLedger({interval, onChange})`, keyed on mtime+size of `runs.jsonl`, `triggers.json` and governance `latest.json`).

  Flow 300's Triggers section lists only the non-scheduled entries, plus a single "N scheduled" line. Flow 295's Schedules section lists only the scheduled ones. Mount order is fixed as `sb-jobs → sb-governance → sb-triggers → sb-schedules`, and each is its own `sb-*` box, so neither flow edits the other's section.

