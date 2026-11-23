# Context

Collected deterministically by `keryx flow init` at 2026-11-23T20:01:55.320Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.94] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
2. [1.887] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
3. [1.783] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.722] SAC: Напиши мне скрипт на питоне цикла от 1 до 10 с промежутка… (task-note/accepted) - task-notes/sac-proposal-d820f7ae5c4b43af.md
   Session fixed /theme perception bug: applyTheme in shell-chrome.ts now repaints already-rendered chrome (transcript frames, tone block headers, dock buttons, sidebar panels) via themeColorToHex/themeColorRemap/recolorThemeTree, because OpenTUI stores colors as RGBA objects. Committed a6dd8dd, pushed to main. Lesson already accepted directly: .metaproject/memory/lessons/theme-switch-repaint.md (created via keryx memory new, bypassing SAC because no slate was open). This proposal records the work for review/audit.
   claimType: task-note | confidence: medium | version: 0.1.0
   scope: unknown
   provenance: source=sac-proposal link=./.metaproject/workspaces/workspace-55936fb9858144ec/session-evidence/6728c7b5-7e93-43a6-9ab4-ea0e9720eaf2.wrap-up.md (sha256 7f281c7cb8399293e9c361fcb0a4f19815108e08a6dfda27db1acdbd29e7f52b) author=unknown confirmedBy=unknown
5. [1.699] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`

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

Orchestrator, 2026-11-24:

- **Contract.** `src/integrations/metaproject-explorer-contract.ts`: v2 requests are parsed by `parseV2` with exact key sets; `METAPROJECT_CAPABILITIES` lists the actions a reader serves; `METAPROJECT_PAGE_SIZE_V2 = 100`, `METAPROJECT_RESPONSE_BYTES_V2 = 1 MiB`; cursors are snapshot-bound (`cursor`/`cursorValue` in `metaproject-explorer-v2.ts`). v1 (`parseExplorerRequestV1`) must stay unchanged.
- **Service.** `src/integrations/metaproject-explorer-v2.ts` serves v2 from the graph model (`loadExplorerGraph` in `metaproject-explorer.ts`) and OpenSpec; nodes carry `path`, `kind` (`file`, `module`, `wiki`, `symbol`, …), `module`, `pageType`.
- **Rust.** `apps/desktop/src-tauri/src/metaproject.rs`: `RequestV2` is a serde enum with `deny_unknown_fields`, validated in `valid_v2`; `ACTIONS` (6 entries) is what the capability probe requires of a CLI. `tree` must be accepted as a request but must NOT join the required set, or an older CLI would fail the handshake. No local cargo on this Mac (memory: no-local-rust-toolchain); Rust is verified in GitHub CI only.
- **Desktop transport.** `apps/desktop/src/platform/metaproject.ts` checks capabilities (a CLI "has to cover every action Desktop sends", ~line 167). The UI needs to know whether `tree` is offered.
- **Dev bridge.** `apps/desktop/dev/bridge.ts` validates with the same `parseExplorerRequest`, so it accepts `tree` once the contract does.
- **UI.** `MetaprojectView.tsx` renders `nav.metaproject-list` (~line 896) as a flat `<ul>` of `results` (search hits, or the catalog when no query). Route/explorer state (mode, query, selection, Back history) survives leaving the view since flow 515 (`useExplorerNavigation.ts`).
- **Prior art.** Flow 515's `plan.md` holds the explorer's state × event matrix; the tree adds rows and columns to it rather than replacing it.
- **Operator decisions (2026-11-24, question card):** Graph tree = folders by path ("Папки по путям"); Wiki tree = pages grouped by page type; criteria verified by tests and CI, native check outside the criteria ("Тесты + CI"); no execution metrics ("Нет").
