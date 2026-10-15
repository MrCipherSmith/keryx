# Context

Collected deterministically by `keryx flow init` at 2026-10-15T08:26:51.794Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.949] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
2. [1.716] SAC: Anchors: root: ~/goodea/keryx tre… (task-note/accepted) - task-notes/sac-proposal-b051e66aebd74f37.md
   Flow 188 (count .ts files in src/harness/provider, read-only) completed. Direct child .ts files excluding .test.ts and subfolders: fake-provider.ts, make-provider.ts, provider-port.ts, single-turn.ts, tool-call-linking.ts, types.ts = 6 files. Subfolders (openai/, ollama/, gemini/, anthropic/, compat/, fixtures/) and their contents excluded per the no-subfolders constraint. Task required read-only; rounds T1-T4 (plan/test/PR) are generic placeholders not applicable to this read-only counting task.
   claimType: task-note | confidence: medium | version: 0.1.0
   scope: unknown
   provenance: source=sac-proposal link=./.metaproject/workspaces/workspace-5c74a3f7b3c7414b/session-evidence/4f3b7eb5-a514-476e-8732-6087df8710d6.wrap-up.md (sha256 a12235fc2638f84f9fc1305cc5fff51a0563003ee785b92a1c81a02c961927a3) author=unknown confirmedBy=unknown
3. [1.699] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
4. [1.699] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
5. [1.635] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown

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

_(flow-init skill appends here)_
