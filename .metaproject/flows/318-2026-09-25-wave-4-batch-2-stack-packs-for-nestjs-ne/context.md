# Context

Collected deterministically by `keryx flow init` at 2026-09-25T06:09:18.106Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.588] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 304 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
2. [1.588] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 304 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
3. [1.588] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 304 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
4. [1.552] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
5. [1.516] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
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

- Precedent: flows 314 (batch 1 authoring), 316 (judge grading + gate
  hardening), 317 (PACK_MIN_TRIALS 5→10, follow-up fixes). Current stable
  packs: `python`, `go`. `ts-js-node` demoted (nodejs-build-fix
  no-ts-ignore-suppression, 6/10 at trials=10). `react` stays experimental
  (react-build-fix no-disable-hooks-lint, 3/10 at trials=10).
- Judge-based eval format confirmed live in
  `src/gdskills/bundled/stacks/ts-js-node/skills/nodejs-build-fix/evals.json`:
  `expected_behavior[].grader: "judge"` with `rubric`/`pass_criteria`/
  `fail_criteria`, plus a sibling `calibration` object
  (`known_right`/`known_wrong`/`vague`/`subtle_wrong`) and optional
  `anti_patterns`. Deterministic `contains`/`regex` may accompany a judge
  expectation for one unambiguous fact only; `not-contains` is banned on a
  judge scenario (I8).
- Integrity rules I1-I10 + AG live in
  `src/gdskills/stack-pack-eval-integrity.test.ts`; full guide at
  `docs/docs/guides/write-a-rubric-scenario.md`.
- `src/stack/detect.ts`'s `STACK_DETECT_TAGS` already has `nestjs`, `react`,
  `vue`, `angular`, `nextjs`, `nuxt`, `mobx` — no detection code changes
  needed for this flow.
- `STACK_EXTENSIONS` (`src/gdskills/governance/authoring-lint.ts`) extended
  by this flow's first commit: `nestjs: ["ts"]`, `vue: ["vue"]`,
  `angular: ["ts", "html"]`, `"nextjs-nuxt": ["tsx", "jsx", "vue"]`,
  `mobx: ["ts", "tsx"]`.
- `install-manifest.json` already has a `nestjs` profile and a pre-existing
  `framework:nestjs` component (`nestjs-review-skill` = `review-backend`,
  `nestjs-dto-rule` = `nestjs-dto.mdc`) and a pre-existing `capability:mobx`
  component (`mobx-review-skill` = `code-mobx-store-review`,
  `mobx-store-template-rule` = `mobx-store-template.mdc`) from before this
  wave. This flow ADDS new `<id>-rules`/`<id>-skills` modules for the new
  stack-pack content and extends those two components' module lists rather
  than creating parallel components — avoids duplicate review-skill coverage
  the W1 spec explicitly warns against ("cross-reference, don't duplicate").
  New standalone components needed: `framework:vue`, `framework:angular`,
  `framework:nextjs-nuxt`.
- `gate-policy.ts` pins `STACK_PACK_GATE_POLICY` to DeepSeek `deepseek-chat`
  for both runner and judge roles — required by the runner brief's fixed
  parameters.
- The pack-worker-brief from flow 314
  (`/private/tmp/claude-502/-Users-Goodea-goodea-keryx/e4ee6e6a-388e-4015-b287-e00b261e73d6/scratchpad/f314/pack-worker-brief.md`)
  is reused as a skeleton for this flow's own worker brief, updated for the
  judge eval format per the guide above (its own §evals.json section is
  pre-judge-migration and superseded).
