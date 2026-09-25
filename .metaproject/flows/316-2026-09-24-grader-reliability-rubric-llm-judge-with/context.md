# Context

Collected deterministically by `keryx flow init` at 2026-09-24T18:51:50.283Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.698] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
2. [1.698] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
3. [1.698] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
4. [1.662] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
5. [1.649] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown

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

- Base: feat/agent-platform-expansion at 8c7e50da (contains W1-W8 and batch 1, #692 / flow 314). Worktree /Users/Goodea/goodea/keryx-ape-316-graders, branch flow/316-graders.
- Inputs: the flow 314 journal (follow-up entries 23:10Z-00:30Z), the review reports scratchpad/f314/review-r1.md, review-r2.md (R2-6) and review-r3.md, and scratchpad/f314/fix1-contract.md (integrity rules I1-I5).
- Code:
  - src/gdskills/governance/eval.ts: evalSkill, validateEvalSpec, gradeExpectations, checkStablePackGate, computeSkillEvalDigest.
  - src/commands/model-eval-runner.ts: buildEvalRunner, runModelTurn, fail-closed.
  - src/commands/skills-governance.ts: `skills eval` flags.
  - src/gdskills/governance/catalog-index.ts: loadSkillCatalog; the bundled scope is root-independent.
  - src/gdskills/stack-pack-eval-integrity.test.ts: I1-I5.
- Gate callers: src/agents/verify.ts and src/commands/agents-catalog.ts. The gate fixtures are in src/agents/generate.test.ts, src/agents/verify.test.ts, src/gdskills/stack-packs.test.ts and src/commands/agents-catalog-commands.test.ts.
- Import zones: src/gdskills is core and must never import src/harness (client). The provider adapter for the judge therefore lives in src/commands (adapter), next to model-eval-runner.ts.
- The previous honest DeepSeek run (flow 314, 4f05dd0f) scored 0 on these scenarios:
  - nodejs-build-fix no-ts-ignore-suppression;
  - react-build-fix no-disable-hooks-lint;
  - python-build-fix mypy-error-no-blanket-suppress;
  - nodejs-testing mock-boundary-not-internal;
  - python-testing mock-external-not-internal.
- The old nodejs-build-fix grader was `not-contains "@ts-ignore"` and `not-contains "as any"`. A correct answer that warns against @ts-ignore fails it by construction. That is a hypothesis for AC9, to be proven with recorded outputs.
- Old reports store only pass counts, not outputs, so the AC9 evidence must come from the new run's recorded raw outputs, re-graded under the pre-migration expectations taken from `git show 8c7e50da:<evals.json>`.
- Owner constraints: judge and gate model DeepSeek deepseek-chat (the key is in ~/.local/share/keryx/auth.json and is never printed); floor 0.8; strictness high; trials >= 5; scope bundled; no SKILL.md tuning. Standing merge rule: 0 blocker and 0 major means merge.
- Flow 315 runs in parallel. Avoid src/security/audit-harness, src/learning, src/commands/init.ts, src/assets, src/gdskills/install.ts and src/lib/*.
- Use `bun ./src/cli.ts` for every flow, review and skills command. The global keryx 0.2.154 is stale.
