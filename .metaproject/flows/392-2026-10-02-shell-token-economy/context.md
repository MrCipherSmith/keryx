# Context

Collected deterministically by `keryx flow init` at 2026-10-02T06:02:02.565Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.889] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
2. [1.848] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
3. [1.809] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
4. [1.662] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
5. [1.662] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-10-01T18:31:29.840Z)
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

### Code sites (verified 2026-10-01)

- Whole history sent each round: `src/commands/agent.ts` ~2652 (`messages: [...history]`).
- Auto-compaction guard: `src/harness/provider/context-guard.ts` (`estimateRequestTokens`, `needsCompaction` at 85%; off when window unknown).
- Window lookup: `src/commands/model-limits.ts` `loadSessionLimits` → `providerByName`; codex special-cased in `src/commands/providers.ts:473`; wired in `src/commands/shell.ts:2165`.
- Deterministic compaction: `src/session/compact.ts` (`indexOfKeepFrom`, `keepLastUserTurns: 3`, 160-char clip).
- Anchors appended: `src/commands/agent.ts` ~2423 and ~3439; renderer `src/session/slate.ts` `renderAnchorsBlock`.
- Codex request body: `src/harness/provider/openai/openai-provider.ts` ~577 (`store:false`, no `prompt_cache_key`, full replayed `input`).

### Competitor study (`~/sandbox/forks`, 15 harnesses, 2026-10-02)

- **Window + triggers:** codex reads the window from `/models` (90% compact, 95% hard cap; skip when unknown); grok-build prefires before 85%; pi and kilocode compact-and-retry on an overflow error.
- **Token estimate:** codex, pi, deepseek-harness anchor on the last provider-reported usage and estimate only the delta since.
- **Old tool outputs:** opencode protects the newest ~40K tokens and the last 2 turns, prunes older outputs to `[Old tool result content cleared]` only when it saves >20K; gemini-cli masks past 50K protected/30K buffer and leaves a file path; qwen-code adds idle/time triggers; deepseek-harness prunes, remeasures, and summarises only if still over pressure.
- **Large output:** opencode/pi cap at 2000 lines / 50KB and spill the full text to a file with a retrieval hint; cline and codex middle-truncate (48K chars / 10KB).
- **Summary:** opencode and pi use an incremental anchored summary (prior summary fed back) with a ~20K-token verbatim tail and read/modified file lists; cline keeps a deterministic no-LLM fallback that preserves every typed user prompt; gemini-cli verifies its snapshot with a second probe call.
- **Injected context:** codex `WorldState.render_diff` emits only changes; deepseek-harness re-injects on content-hash change; grok-build rebuilds one replaced reminder; aider never stores the reminder in history.
- **Cache:** codex, opencode and pi send `prompt_cache_key` = session id; codex also continues with `previous_response_id` when the prefix is unchanged; aider/opencode/crush place cache breakpoints on the stable prefix.
