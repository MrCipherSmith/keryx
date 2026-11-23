# Context

Collected deterministically by `keryx flow init` at 2026-11-23T07:14:03.326Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.703] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
2. [1.65] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
3. [1.551] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
4. [1.536] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
5. [1.536] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`

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

Collected on 2026-11-23 by a review of the shipped module: a live pass in the browser dev build
(`bun run dev:browser`, windows 1440×900, 1180×780, 720×480) plus four read-only reviewers
(frontend logic, backend and data, product, UI/UX from code). Only what this flow needs is kept.

### Where the code is

| File | Lines | Holds |
|---|---:|---|
| `apps/desktop/src/metaproject/MetaprojectView.tsx` | 920 | `Graph` (cytoscape, lines 41–140), `RepositoryMarkdown` (142–226), `RelationshipList` (228–276, exported), `Explorer` (288–920): all reads, filters, banners, layout |
| `apps/desktop/src/metaproject/GraphNodePanel.tsx` | 182 | The details panel: Wiki / OpenSpec tabs, linked documents, preview, Find, Draft, resize |
| `apps/desktop/src/metaproject/useExplorerNavigation.ts` | 85 | Route (`graph` / `wiki` / `openspec`), history (`visit`, `back`), scroll restore |
| `apps/desktop/src/metaproject/OpenSpecView.tsx` | 457 | OpenSpec view (not redesigned here) |
| `apps/desktop/src/metaproject/metaproject.css` | 210 | All module styles |
| `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx` | 401 | DOM tests (happy-dom via `apps/desktop/src/test/dom.ts`); the base fixture has `graph: "missing"`, so the cytoscape canvas is never mounted in tests |
| `apps/desktop/src/App.tsx` | — | Mounts the view at line 586 as `{workView === "metaproject" && …}`: it unmounts when the work view changes; `onRebuild={rebuildGraph}` (line 188), `onDraft` opens a session and calls `setView("session")` |
| `src/integrations/metaproject-explorer-contract.ts` | — | Shared types, read-only for this flow: `MetaprojectNode {id, kind, title, path, module?, pageType?, status?, line?}`, `MetaprojectEdge {from, to, kind, evidence?, provenance?, count?}`, `MetaprojectNeighbors {root, nodes, edges, truncated, snapshotId}`, `MetaprojectCatalog {graph, graphReason?, hasWikiLayer, hasSymbolLayer, counts {files, wiki, modules}}`; limits 200 nodes / 400 edges |

### Measured facts (browser dev build, this repository)

- Graph box 440×194 px at 1180×780 with the panel open; cytoscape zoom 0.30–0.50, so the 11 px
  labels paint at 3.3–5.5 px. Layout is `preset` on one ring of radius 180 (`MetaprojectView.tsx:74`).
- A module with 30 neighbours: 31 nodes, 33 edges (18 `contains`, 15 `imports`). Depth 2 from
  `module:apps/desktop/src`: 200 nodes, 269 edges, `truncated: true`.
- Node data sent to cytoscape is `{id, label}` only; edge data carries `label: edge.kind` that no
  style reads. The instance is destroyed and rebuilt on every selection.
- Colours are read once at mount (`getComputedStyle`); after a theme change the labels keep the old
  theme's colour until the next selection.
- Panel: three font sizes (12/13/15 px), two text colours; surface vs page contrast 1.10:1, border vs
  surface 1.36:1; the preview extraction (`GraphNodePanel.tsx:82-84`) strips headings and backticks
  but not `>` or `**`.
- A relationship has direction relative to the root: `edge.to === root` is incoming,
  `edge.from === root` is outgoing. Depth 1 is always a star (only root-adjacent edges).
- `catalog.counts`, `hasSymbolLayer` and `hasWikiLayer` are validated but never read by the UI.
- Window: default 1180×780, minimum 720×480 (`apps/desktop/src-tauri/tauri.conf.json`). The
  `@media (max-width: 700px)` block in `metaproject.css` can never apply.

### Defects this flow fixes (confirmed by code reading; L = also reproduced live)

| # | Defect | Where |
|---|---|---|
| D1 | L — leaving the work view unmounts the explorer: mode, query, selection, filters, Back history are lost | `App.tsx:586` |
| D2 | L — Back records only `visit()`; graph hops use `setRoute` and are not in history | `MetaprojectView.tsx:585`, `useExplorerNavigation.ts:34-40` |
| D3 | L — "Find a Wiki page" → `visit({mode: "wiki", query: path, selection: ""})`; the empty selection falls back to the first wiki page, so "No results" sits beside an unrelated article | `MetaprojectView.tsx:911`, `:318` |
| D4 | L — the neighbours read uses Graph's `depth, direction, kinds` in Wiki mode too (13 → 350 relationships at depth 2) | `MetaprojectView.tsx:485` |
| D5 | `rebuild()` compares `project.current` captured at start; any catalog reload bumps it, so `setRebuilding(false)` and the revision bump are both skipped | `MetaprojectView.tsx:637-649`, `:374`, `:398` |
| D6 | Negotiation failure sets `protocolError` only; `loading` stays `true` and the catalog effect returns while `protocol === null`; the banner has no Retry | `MetaprojectView.tsx:311`, `:344`, `:373`, `:700` |
| D7 | A wiki link resolves only against loaded nodes (≤200 catalog nodes, hits, current projection); otherwise the click does nothing. `href` is compared without `decodeURIComponent`; a leading `/` resolves under the page's folder | `MetaprojectView.tsx:210-219` |

### What the app already has to build with (no new patterns needed)

- Tokens: `apps/desktop/src/styles/tokens.css` (light `:root`, dark `:root[data-theme="dark"]`),
  12 colour palettes in `apps/desktop/src/styles/themes.css` (`data-palette`). Roles used here:
  `--bg-canvas`, `--bg-surface`, `--bg-sunken`, `--bg-selected`, `--bg-hover`, `--fg`, `--fg-muted`,
  `--fg-subtle`, `--accent`, `--accent-text`, `--border`, `--border-strong`, `--ok`, `--warn`,
  `--info`, `--danger` (each with `-soft`), `--sp-1..7` (4/8/12/16/24/32/48), `--fs-xs/sm/md/lg/xl`
  (11/12/13/15/20 × `--text-scale`), `--r-sm/md/lg`, `--dur-fast`, `--dur`, `--shadow-sheet`.
- Patterns: `.info-panel`, `.info-section`, `.info-row` / `.info-key` / `.info-val(.mono)` in
  `apps/desktop/src/styles.css`; `.badge(-ok/-warn/-info/-neutral)`, `.chip-btn`, `.count-label`,
  `.tab-count` in `apps/desktop/src/styles/components.css`; underline `.tabs` / `.tab[aria-selected]`
  in `apps/desktop/src/styles/flows.css`; `.section-title`; `.activity-row`; `EmptyState` and
  `Spinner` in `apps/desktop/src/components/ui.tsx`; `.side-resize`; icons in
  `apps/desktop/src/components/Icon.tsx` (`file`, `folder`, `archive`, `checklist`, `pencil`,
  `branch`, `search`, `x`, `arrowLeft`). No icon exists for "symbol" or "wiki".
- Text contrast of `--fg` and `--fg-muted` passes on every background in all 14 themes
  (computed by the UI/UX reviewer: minimum 4.95:1).

### Constraints from parallel work

- Session `fix-metaproject-explorer` (own worktree) changes `src/integrations/metaproject-explorer*.ts`,
  `apps/desktop/src-tauri/src/metaproject.rs` and `apps/desktop/src/platform/metaproject.ts`.
  This flow must not edit those files.
- Three implementers of the first wave work in this one worktree at the same time on disjoint file
  sets; see `plan.md`, "File ownership".
