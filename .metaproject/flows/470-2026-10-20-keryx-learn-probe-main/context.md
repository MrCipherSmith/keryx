# Context

Collected deterministically by `keryx flow init` at 2026-10-20T20:47:33.381Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.854] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
2. [1.822] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
3. [1.77] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
4. [1.77] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
5. [1.752] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-09-09T04:08:01.388Z)
- refresh: `keryx health run`

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

## Inherited findings and migration

Historical bullets below describe flow 469 initialization; they are not current migration approval. Current status is recorded in the final migration bullets.



- Durable owner answers: [operator-decisions.md](operator-decisions.md), including the comparison-publication drift cut-off clarification.
- Source package: docs/requirements/keryx-learn-probe/; read README, PRD, specification, lifecycle, metrics, schemas and historical review. Correct in place before freeze.
- agent-1 read-only findings: apply Partial map/domain fallback intentional (historical F-001 not a confirmed defect); identity needs text digest/snapshot; durable checkpoints and recoverable evidence finalization required.
- agent-2 read-only findings: reuse ablation worktree and context-on toolset, but base-ref gold existence check and signal/resume are new work.
- Memory query learning/probe/evidence/resume returned no matches; deletion tag trail-absent, not proof that guidance never existed. Wiki matches were tangential. Graph output explicitly stale/moved/new paths.
- Existing baseline: 461 pass, 0 fail across 29 learning/metrics test files; not probe implementation verification. See plan.md for exact command and coverage caveat.
- Shared lane ownership and task matrix recorded in tasks.md; 24 draft verifiable ACs, not frozen/confirmed.
- Runtime estimate/pricing technical details under read-only investigation by agent-2. Source docpack editing assigned only to agent-1; independent verification waits for handoff.

- Flow 470 replaces 469 by explicit operator decision to target main. T5/T6 are inherited evidence, not newly executed. Fresh independent migration review is required.
- Delivery target selected by operator: draft PR to main → review → merge → release → operator manual testing. Publish, merge and release require separate approvals.
- AC11 now explicitly preserves failed/interrupted audit as well as completed runs. Runtime is prohibited before explicit freeze.
- project_context_applied: .metaproject/rules/core/tdd-workflow.mdc; .metaproject/rules/core/error-handling.mdc; .metaproject/rules/core/solid-principles.mdc; .metaproject/rules/core/git-concurrency.mdc; .metaproject/rules/core/requirements-management.mdc; .metaproject/rules/core/implementation-plans.mdc; .metaproject/skills/flow/init.md. Full documents read before migration.

## Prefreeze reconciliation

Independent review omissions are explicit in AC14/T9 (every write boundary and concurrency), AC18/T10 (owned stale-worktree reconciliation), AC19/T12 (managed-ignore entry and guard). Current src/commands/init.test.ts enforces info/exclude and forbids tracked .gitignore changes; operator chose that contract, and source specification/PRD/lifecycle wording reflects it. T7/T8 require T1 and inherited T6; CLI dependency repair is complete and independently verified. These are planned obligations, not passing runtime evidence; explicit freeze remains pending.
