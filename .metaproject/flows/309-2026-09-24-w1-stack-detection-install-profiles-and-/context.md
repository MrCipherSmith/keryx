# Context

Collected deterministically by `keryx flow init` at 2026-09-24T04:09:00.798Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.588] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.583] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 304 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
3. [1.583] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 304 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
4. [1.583] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 304 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
5. [1.583] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 304 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing

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

- Base branch: `feat/agent-platform-expansion`; worktree
  `/Users/Goodea/goodea/keryx-ape-309-w1`, branch `flow/309-w1`.
- Existing detection: `src/review/stack.ts` (`detectProjectStack`,
  `STACK_TAGS`, fail-open "uncertain always means included", workspaces →
  uncertain). Consumed by `src/commands/review.ts`; keep unchanged.
- Legacy install: `src/commands/skills.ts` `install` branch (lines ~103-142)
  → `installGdskills(metaprojectRoot, profile)` in `src/gdskills/install.ts`;
  profiles `minimal|recommended|full|custom` in `src/gdskills/catalog.ts`.
- Frontmatter parser: `src/gdskills/skill-frontmatter.ts`
  (`parseSkillFrontmatter`, `SkillFrontmatter`); length ceilings in
  `src/gdskills/skill-length-ceilings.ts`; guard tests
  `src/gdskills/bundled-eval.test.ts`, `bundled-eval.ts`
  (`evaluateBundledTree`), `agent-catalogue-xref.test.ts`,
  `enforcement-claims.test.ts`, `skill-name-matches-directory.test.ts`.
- Export: `src/gdskills/export.ts` (`exportProjectSkill`,
  `HARNESS_SKILL_RUNTIMES`).
- W5-b precedent for install-state: `src/integrations/install-state.ts`
  (`installStatePath`, `sha256OfFile`, `readInstallState`,
  `recordSurfaceInstalled`); capability matrix
  `src/integrations/matrix.ts` (`generateCapabilityMatrix`,
  `MatrixSurfaceState` = native|adapter|instruction-only|unsupported; per
  harness `state`), artifact `docs/integrations/harness-capability-matrix.json`.
- W8 audit facade: `src/security/service.ts` `runHarnessAudit`.
- Harness child caps: `src/harness/child/orchestrate.ts`
  (`DEFAULT_MAX_TREE_DEPTH`, `DEFAULT_MAX_CHILDREN`).
- CLI registry: `src/cli.ts` command map (e.g. `integrations:
  integrationsCommand`) + help text; import zones `src/lib/import-zones.ts`.
- Flow 310 (W2 agents) runs in parallel: do not edit `src/agents/` or
  agent-definition code.
- Tooling caveat (memory): installed `keryx` may lag; exercise new code with
  `bun ./src/cli.ts`.
