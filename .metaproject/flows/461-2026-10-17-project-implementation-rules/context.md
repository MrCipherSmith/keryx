# Context

Collected deterministically by `keryx flow init` at 2026-10-17T18:22:53.947Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.925] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
2. [1.913] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
3. [1.898] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
4. [1.898] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
5. [1.807] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`

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

Source: design analysis of 2026-10-17 (read-only), re-checked line by line for this flow.

- Import wires only module `review` (`src/gdskills/project-reviewers.ts:17`); other modules are "not auto-injected" (`src/gdskills/import-skills.ts:2128-2133`, `:249-252`); `KNOWN_CATEGORIES` `:694-700` lacks `implementation`/`testing`.
- A rule reaches the project only through a citing skill (`src/gdskills/rule-references.ts`). `resolveRuleReference` already prefers `.metaproject/rules/project/<ref>` over `.metaproject/rules/<ref>`; `keryx init/update` overwrite only `rules/core/`.
- `task-implementer/SKILL.md` Phase 2.4 (`:202-228`) reads `rules/core/` only; Phase 2.0b (`:170-178`) reports `skill_drift` and does not require applying a fresh project skill.
- `tests-creator/SKILL.md` reads no rules (Phase 1.2 reads 2-3 existing tests). `job-orchestrator` dispatches it at Step A/B (`SKILL.md:748-809`) and `flow-orchestrator` at its dispatch contract (`:295-350`) with no project context; `flow-orchestrator` `:221-230` lists `rules/core` files for its own reading only.
- `skills route` ties: `src/commands/skills.ts:879-884` sorts by `source.localeCompare`; `"catalog" < "project"`.
- `task-implementer-output` has `skill_drift` and no applied-rules field; validation is `keryx skills contracts validate` (`task-implementer/SKILL.md:456-462`, `src/gdskills/contracts.ts:369-372`), called from prose.
- Flow 416 (templates in import) is merged: `src/gdskills/import-skills-templates.test.ts` exists. Its security-gate and containment pattern is the model for `--rules`.
- Vantage (`/home/altsay/presight/vantage-ai-assistant`): `rules/core` 29 `.mdc`, 178 KB, none `alwaysApply: true`; `rules/AGENTS.mdc` is `alwaysApply: true`, 38,577 B. Frontend-relevant set about 85 KB (design-system 25.4K, testing-conventions 15.2K, mobx-store-template 11.1K, styling 10.9K, frontend-assistant 10.5K, code-style-patterns 4.5K, playwright-testing 3.9K, storybook-guidelines 3.7K). Its `skills/` copies of Keryx bundled skills must not be imported as overrides.
- TUI: `src/tui` has no skills surface (one `skill` mention in `tui-shell.ts`); the shell reaches skills through `skills_catalog`/`skill_load` in `src/harness/tool/metaproject-operations.ts`, mirrored in `src/mcp/metaproject-tools.ts`.
- Not verified: the `globs` of each Vantage rule, whether `flow task done` can read a task result today (AC18 may need a recorded-result path), where the project config for the enforcement setting lives.
