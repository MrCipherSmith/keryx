# Context

Collected deterministically by `keryx flow init` at 2026-09-25T15:14:46.820Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.573] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
2. [1.573] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
3. [1.573] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
4. [1.537] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
5. [1.501] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
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

- W1-stack-catalog.md target-stack table (line ~247): `csharp-dotnet` language
  full pack; `swift-ios`/`kotlin-android`/`flutter-dart` framework full packs
  each "extends `lang:X`" where X has no authored pack anywhere in the repo —
  treated as standalone (see description.md "Problem").
- Pack fixed shape (W1 §"Stack pack directory shape"): `pack.json`, `rules/`
  (4 files, each `paths:` + `extends: common`), `skills/{implement,test,
  review,build-fix,migrate}/SKILL.md`+`evals.json`, `agent-refs.json`.
- Templates on `main`: `src/gdskills/bundled/stacks/{python,go}/` — both
  standalone "full pack" language packs, `stability: stable`, no `extends`
  key in `pack.json`. `react` (extends `ts-js-node`) is `stability:
  experimental` with `agent-refs.json` `{"agents":[],"note":"..."}` — the
  Phase A shape to copy for these 4 new packs.
- Templates on `origin/flow/318-w4b2` (PR #719, unmerged; read via `git show
  origin/flow/318-w4b2:<path>`): `angular`/`vue`/`nestjs`/`mobx`. `angular`
  extends `ts-js-node` via `pack.json` `"extends": "ts-js-node"` (a single
  string, not an array on this branch) and its `install-manifest.json`
  modules (`angular-rules`/`angular-skills`) carry `"dependencies":
  ["ts-js-node-rules"]`/`["ts-js-node-skills"]`.
- `STACK_EXTENSIONS` lives in `src/gdskills/governance/authoring-lint.ts`
  (not `src/gdskills/authoring-lint.ts`) — current entries: `python: [py,
  pyi]`, `ts-js-node: [ts,tsx,js,jsx,mjs,cjs]`, `react: [tsx,jsx]`,
  `go: [go]`, `rust: [rs]`. Batch 2 (unmerged) adds `nestjs: [ts]`,
  `vue: [vue]`, `angular: [ts,html]`, `nextjs-nuxt: [tsx,jsx,vue]`,
  `mobx: [ts,tsx]`.
- `install-manifest.json` wiring pattern confirmed from `python`/`go`
  (standalone) and `angular` (extends-existing-base): module `kind: rule|
  skill`, `paths`, `targets: [claude, keryx-shell]`, `dependencies`,
  `defaultInstall: true`, `cost: light|medium`, `stability`; component
  `family`, `modules`, `detectionMarkers`, `provenance.origin: authored`;
  profile `modules: [core-common-rules, skill-lifecycle]`, `components:
  [...]`, `stackDetectionAware: true`; `full` profile lists every module and
  component.
- Judge-format eval rules (docs/docs/guides/write-a-rubric-scenario.md): I1-I10
  integrity rules, mandatory `calibration` 4-way (known_right/known_wrong/
  vague/subtle_wrong), 8-answer anti-gaming set, `PACK_MIN_TRIALS=10`,
  `PACK_BEHAVIOR_PASS_FLOOR=0.8`, `STACK_PACK_GATE_POLICY` pins deepseek:
  deepseek-chat for both runner and judge roles — none of this runs in
  Phase A, but skills must be authored to satisfy the integrity checks so
  Phase B's honest gate is a real signal, not a rewrite.
- Batch 1 (flow 314/316/317) and batch 2 (flow 318) journal in W1 doc:
  `nodejs-build-fix`/`react-build-fix`/`python-build-fix` suppression
  scenarios were initially mis-graded by string-matching, fixed by moving to
  judge grading; multiple scenarios failed for being under-specified
  (no-code prompts demanding code-level specifics) — batch 4's build-fix/
  testing scenarios should supply enough prompt detail to avoid the same
  trap, or accept a concrete illustrative example per the guide's final
  section.
