# Implementation Plan

Status: ready for freeze. Operator decisions (2026-10-20, Claude Code question tool):

- The `/setup` Run button uses an **external agent**: Claude Code or Codex CLI, through the `/delegate` path. It falls back to the session's main agent when no external agent is configured.
- The sidebar becomes **seven themed cards**: Session, Workspace, Work, Reviews, Ops, Policy, Remote.
- **Three PRs in sequence**, one flow: A routing → B setup → C sidebar. The flow closes with PR C.
- ~~Manual checks on the branch first~~ — superseded the same day: **the operator checks each phase only after its release and an npm install** (no branch-build checks). Each phase's check is a verify task after its merge (T20, T21, T23); the 80×24 pty smoke stays a pre-merge agent check (T22).

Evidence for every claim below is in `context.md`.

## Approach

### Phase A — `/routing` (PR 1, smallest, ships first)

Fix the source of truth, then make every failure visible.

1. **Startup catalog.**
   - At `tui-shell.ts:4179`, when `opts.detected` is empty (saved provider, or `--provider/--model`), refresh the catalog from a real detection instead of the empty list. Reuse `opts.redetect` so ollama is not probed twice.
   - Never derive a catalog from an empty `detected`.
2. **Cache hygiene** in `loadOrRefreshProviderCatalog*` (`src/harness/provider-catalog.ts`): a zero-provider catalog is neither served as fresh nor saved as fresh. `isCatalogFresh` stays age-only; the emptiness rule sits beside it.
3. **The session's own provider is always pickable.**
   - The provider/model the session runs on is a row in the picker, labelled `(current session)`, even when the catalog lacks it.
   - Routing resolution treats it as connected.
4. **Opening `/routing`** passes a provider loader that falls back to the live `redetect` (the path `/model` already uses) when the cache is empty.
5. **Visible states in `routing-inspector.ts`.**
   - `reload()` gets try/catch and a timeout, so it can no longer stick on "Reading routing table…".
   - The Model tab shows a status row for each case: no providers connected (`/connect` hint), catalog unavailable (reason), and per provider "0 models" / "auth failed — /connect".
   - The Categories tab says *why* an assignment falls back: "provider list unavailable", "provider not connected" or "model not in <provider>'s list".
6. Replace the source-text assertion in `provider-catalog-startup.test.ts:39` with a behavioural one.

### Phase B — `/setup` (PR 2)

1. **Step model** (`src/commands/setup-guide.ts`).
   - `SetupStep { id, title, cli (exactly one command), required, why, note, condition? }`. Every `&&` chain becomes separate steps.
   - `cli` and `note` stay, so the CLI renderer and its tests survive.
2. **Step lists.** Each step is marked R (required) or O (optional) with its reason. They come from the investigation; each is re-checked against `keryx <cmd> --help` while implementing.
   - **Init**:
     - R `init --yes`
     - R `gdgraph build`
     - R `standard validate`
     - R `security policy validate`
     - O `test analyze` (init already ran it)
     - O `wiki collect --force`
     - O `wiki index`
     - O `wiki check-links`
     - O `wiki validate`
     - O `memory index`
     - O `memory check`
     - O `health run --strict`
     - O `flow check`
     - O `integrate <editor>`
     - O `sync install-hooks`
   - **Refresh**:
     - O `update --preview`
     - R `update --skip-runtime --yes`
     - O `update` (with runtime)
     - R `sync --apply`
     - R `wiki index`
     - R `wiki check-links`
     - R `wiki validate`
     - R `standard validate`
     - O `memory check`
     - O `health run`
     - O `update --hooks`
   - **Repair**:
     - R `standard doctor`
     - R `status`
     - R `modules status`
     - O `doctor`
     - O `modules enable <name>`
     - O `security hooks install --runtime claude`
     - O `sync install-hooks`
     - R `update --skip-runtime --yes`
     - R `sync --apply`
     - R gates as separate steps: `wiki check-links`, `wiki validate`, `memory check`, `flow check`, `standard validate`, `security policy validate`
3. **`detectSetupScenario(root)`**:
   - no `.metaproject/index.md` → init;
   - index plus manifest and module directories → refresh;
   - anything partial → repair.
4. **`buildSetupAgentPrompt(scenario, {projectRoot, includeOptional})`**, generated from the steps so it cannot drift.
   - Content: goal; root; "read `.metaproject/index.md` first"; REQUIRED and OPTIONAL lists as `command — reason`.
   - Rules:
     - run in order and stop at the first failed required step, then report;
     - on a `keryx update` divergence, stop and ask instead of choosing `--accept-version` or `--keep-existing`;
     - never delete `.metaproject`, accepted wiki, memory, flows or project skills;
     - do not enrich wiki prose;
     - no `--force` beyond the listed steps;
     - do not commit or push.
   - Keeps the substrings the current tests assert.
5. **Modal** (`src/tui/setup-modal.ts`).
   - Opens on the detected tab when no argument is given.
   - Readable: titles bold, commands accent, `[required]` ok, `[optional]` muted, notes text. Nothing wraps the whole body in `dimChunk`.
   - The body is the modal's own ScrollBox: no 24-row cap, it uses `renderTab`'s `ctx.width`, and the keys hint is no longer duplicated.
   - Layout is a row: plan and prompt on the left; on the right a button column with `[Run]`, `[Copy prompt]` and `[Optional: off/on]`, built with `smallActionButton`.
   - Keys: `c` copies, `r` runs, `o` toggles optional. No bare `x`.
6. **Run.**
   - `confirmOperatorCard` names the scenario, the steps to run (required, plus optional if on) and the agent. When several external agents are configured, the card offers each as an option.
   - On yes: `external.delegate({agentId, task: prompt})` in the project root. It runs in the fleet and the Workers panel, the composer stays free, and the report is printed to the transcript.
   - No external agent configured or allowed: the card says so and offers the main agent turn (`runLine(prompt)`) instead.
   - On no: nothing runs.
7. **CLI.** `keryx setup` prints the same `[required]`/`[optional]` marks, reasons and the prompt. The line "This guide only prints the steps" stays CLI-only.

### Phase C — sidebar (PR 3, largest)

1. **Card model** (new `src/tui/sidebar-cards.ts`):
   ```
   SidebarCard {
     id, order, icon, title, severity,
     visible(),
     lines(textWidth, mode) // 3–5 lines, hard cap, pre-fit to width
     rail() → { glyph, badge? }
     open()                 // detail modal
   }
   ```
   A `SidebarHost` owns one slot Box per card in fixed order and toggles `visible`, never removing or re-adding. Cards patch text in place, because remove-and-re-add painters destroy a Text mid-click.
2. **Seven cards.** Each card's detail modal has one tab per former section and reuses the existing `showX` / `openX` inspectors.
   - Session: Model, mode, Usage, Context, Balance. Actions `/model`, `/settings`.
   - Workspace: Directory, Branch, PR, Workspace.
   - Work: Status/fleet, Plan, Subagents, Jobs.
   - Reviews: catch-up, open findings, auto review, external diff. The long layer/parity/readiness paragraphs move into the modal.
   - Ops: Governance, Triggers, Schedules, Intake, Decisions, Research sync.
   - Policy: Route (opens `/routing`, which closes today's Route click gap), Guard, EditGuard, Rewind, ProjectCtx, External.
   - Remote: Remote, Telegram, approvals pending, hold banner.
3. **Attention never hides.** A pending approval, a hold, a version update or a not-ready review raises the card's severity and shows a badge in every mode.
4. **Geometry store**: `{ mode, width }` with subscribers.
   - default: 34 columns (today).
   - wide: 68 columns, capped at half the terminal; below the threshold it falls back to default and keeps the preference.
   - rail: about 5 columns, one glyph and badge per card.
   - All ~20 frozen-width call sites (`tui-shell.ts` mount calls, `shortenCwd`, default params in `subagent-session.ts`, `background-job-session.ts`, `subagent-inspector.ts`, `background-job-inspector.ts`) read the current text width or re-fit on notify.
   - Add a resize subscription.
5. **Pinned header** above `sb-top` (keeps id `sb-title`): `◆ keryx vX.Y.Z` and three single-cell icon buttons for default, wide and rail. The active button is accented; buttons have an ASCII fallback and a `displayWidth` assertion. In rail mode it collapses to `◆` and an expand button. A keyboard shortcut cycles modes, gated by `keyboardOwnedElsewhere()` and the modal overlay. The version-update notice stays a pinned row.
6. **Persistence.** `~/.keryx/tui.json` becomes read-merge-write for `{theme, sidebar}`. `persistThemeId` stops overwriting the file. An unknown value falls back to default.
7. **Modals with a wide sidebar.** The detail modal must not be squeezed to the `main` width (on a 100-column terminal, `main` is about 32 columns). Size it against the terminal, or mount the backdrop at the root, so it keeps at least 72 columns. This is a `modal-host.ts` change.
8. **Theme.** `applyTheme` also recolours the pinned header and the rail; cards use `guardedThemeRepaint`.
9. **Layout rules.** No `alignSelf` (capability test); hug with `maxWidth`; `flexShrink: 0` on cards; no top-level `@opentui/core` import in new files. Keep the 80×24 pty smoke green.

### Delivery

- Each phase is its own branch from `main`, with its own PR and review rounds. Each is merged into `main`, and every merge releases.
- The flow folder is committed with PR A and updated in B and C.
- `flow implemented` uses PR C. PRs A and B are recorded in `journal.md`.
- Manual checks run only after each phase's release: `npm i -g @mrciphersmith/keryx@<ver>`, `keryx --version`, then `keryx update` in the project (vantage-frontend). A problem found there is a fix PR and another release. Pre-merge confidence comes from the `exec` criteria, the review rounds and, for PR C, the locally run 80×24 pty smoke.

## State × event matrices

### `/routing`

States are rows and events are columns:
- **open:** open `/routing`
- **Enter:** Enter on a model
- **refresh:** a catalog refresh lands while the modal is open
- **/connect:** a provider is added through `/connect`, then the modal is reopened

| state \ event | open | Enter | refresh | /connect |
|---|---|---|---|---|
| loading | "refreshing model list…" row; times out to "unavailable" | — | list fills in place | — |
| loaded | providers + models; session row `(current session)` | user-layer write; category shows the pick | rows update; cursor kept | new provider listed |
| no provider connected | "no providers connected — /connect" + session row | session default or current session only | — | list fills |
| fetch failed / timeout | per-provider "model list unavailable (<reason>)" + offline list | offline-list pick allowed, tagged | recovers on success | — |
| provider auth-failed / 0 models | provider shown with "auth failed — /connect" / "0 models" | not selectable | — | recovers |
| assigned model missing | category: "model not in <provider>'s list → session default" | re-pick fixes it | — | — |

### `/setup`

Events are columns:
- **open:** open (no arg)
- **tab:** ←/→ tab
- **copy:** `c` / Copy
- **opt:** `o` / Optional
- **Run:** `r` / Run
- **Esc:** Esc
- **theme:** theme / resize

| state \ event | open | tab | copy | opt | Run | Esc | theme |
|---|---|---|---|---|---|---|---|
| no `.metaproject` | Init tab | other tab | prompt copied, toast | prompt + list update | confirm card | close | repaint, re-wrap |
| healthy | Refresh tab | " | " | " | " | " | " |
| partial | Repair tab | " | " | " | " | " | " |
| confirm card shown | — | — | — | — | yes → delegate; no → nothing | dismiss = no | repaint |
| run in progress | modal may close; fleet row live | — | — | — | Run disabled / "running" | close modal; run continues | — |
| run failed (required step) | report in transcript names the step | — | — | — | Run again allowed | — | — |
| no external agent | card offers main agent turn | — | — | — | main turn on yes | — | — |

### Sidebar

The modal-open state overlays the others.

| state \ event | resize | click card | click mode btn | shortcut | modal close | theme | card appears/disappears |
|---|---|---|---|---|---|---|---|
| default | re-clamp; transcript reflows | detail modal | switch + persist | cycle | focus → composer | cards + header recoloured | slot toggles; others stay |
| wide | cap at half; < threshold → default, preference kept | detail modal (≥72 cols) | switch + persist | cycle | " | " | " |
| rail | stays ~5 cols | detail modal | expand + persist | cycle | " | glyphs recoloured | rail row toggles, no shift |
| modal open | modal keeps size until reopened | replaces modal | switch; modal intact | ignored (modal owns keys) | — | modal + cards repaint | repaint behind backdrop |

A mode switch while a card's async refresh is in flight must not paint stale text into the re-fit card (generation guard).

## Risks

- **Wide mode squeezes modals:** solved in C.7, needs a `modal-host.ts` change and a test.
- **Frozen widths:** about 20 call sites. Missing one leaves truncated text in wide mode; a test renders every card in every mode.
- **`persistThemeId` overwrite:** a `/theme` would wipe the new key without C.6.
- **Run executes mutating commands in the operator's project:** the confirm card is mandatory, and the prompt forbids deletion, `--force` beyond the list, and commit/push.
- **External agent availability:** the fallback to the main agent turn is explicit and visible, never silent.
- **Routing writes the operator's global routing** (`auth.json`) during manual checks: expected, and stated in the check task.
- **Ambiguous-width glyphs:** a `displayWidth` assertion plus an ASCII fallback.
- **The 80×24 pty smoke is gated** (darwin, real subprocess): run it locally for PR C.
- **Graph freshness:** the local graph DB is polluted by `.worktrees/` (gdgraph `IGNORE_DIRS` lacks it; follow-up proposed as a separate session). Don't trust `gdgraph affected` output that lists `.worktrees/` paths.
