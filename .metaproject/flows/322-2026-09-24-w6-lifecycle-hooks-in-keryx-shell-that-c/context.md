# Context

Collected deterministically by `keryx flow init` at 2026-09-24T00:56:52.721Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [2.115] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
2. [1.923] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
3. [1.901] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
4. [1.885] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
5. [1.885] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`

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

- Choke point: `src/harness/run/run.ts:374` `decide()`; run.ts is deterministic/offline (injected clock/idSeq) and replay-hashed, so hooks must be an optional dep.
- `keryx shell`'s real loop is `runAgentTurn` in `src/commands/agent.ts` (`executeCall` ~3413, approval via `resolveApprovalDecision`, unattended floor `deps.hardDeny`); used by tui-shell, shell.ts, acp/server.ts, trigger-dispatch.ts, trigger-agent-task.ts, spawn-subagent-tool (children), goal-command.
- `spawnChild()` (src/harness/child/spawn.ts:119) is SYNC; called from `spawnSubagent()` in child/orchestrate.ts:107/143, which spawn-subagent-tool uses; external path `deps.runExternal` at spawn-subagent-tool.ts:645.
- Sandbox: `ProcessAdapter.spawn` is sync spawnSync with no stdin/stdout → reuse `wrapWithSandbox` + `detectSandboxLauncher` (src/harness/process/sandbox/{wrap,detect,profile}.ts) inside an async hook runner.
- Session entry types: src/harness/session/types.ts `SessionEntryPayload`; schema docs/requirements/keryx-project-agent-harness/schemas/session-entry.schema.json.
- Built-in commands used by host installs (src/integrations/surfaces.ts): `keryx ctx hook <id>`, `keryx security check-input --source untrusted-external`, `keryx security check-output`; all read Claude-format stdin and block with exit 2.
- Compaction: src/session/compact.ts, triggered from tui-shell/shell.ts.
- W5-a registry (src/integrations) is the host-install side; W6 adds nothing there.
