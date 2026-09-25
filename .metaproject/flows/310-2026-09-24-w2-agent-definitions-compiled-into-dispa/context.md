# Context

Collected deterministically by `keryx flow init` at 2026-09-24T04:09:02.645Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.73] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
2. [1.73] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
3. [1.73] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
4. [1.632] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
5. [1.576] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`

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

## Agent Findings (flow-orchestrator, T1)

- Spec: `docs/requirements/keryx-agent-platform-expansion/workstreams/W2-agent-catalog.md`, schema `schemas/agent-definition.schema.json`, implementation-plan Wave 2, brainstorm D-2.
- Wave interfaces: scratchpad `wave0-interfaces.md` / `wave1-interfaces.md` (W5-a registry, W5-b matrix + installer, W8 audit-harness).
- `spawn_subagent` inputSchema: `src/harness/tool/builtin/spawn-subagent-tool.ts` ~L390 (task, mode, label, max_tool_calls, max_rounds, model_tier, runtime; `additionalProperties:false`). `createSpawnSubagentTool(deps)` is instantiable with stub deps (see `spawn-subagent-model-tier.test.ts`).
- Tier module: `src/gdskills/model-tier.ts` (`MODEL_TIERS`, `isModelTier`, `parseModelTier`, `concreteModelDeclarations`, `MODEL_RANK_HINTS`).
- Policy profiles: `src/harness/policy/profiles.ts` (`shellChildReadOnlyProfile`, `shellParentProfile`), child inheritance `src/harness/child/isolation.ts` (`inheritPolicy`).
- Builtin tool names: read_file, list_dir, get_cwd (interactive-tools.ts); search_code, graph_affected, memory_search (metaproject-tools.ts); shell_exec; apply_patch; web_fetch; web_search; ask_user; plan_*; slate_*; workspace_*; spawn_subagent.
- Existing CLI: `src/commands/agents.ts` (bootstrap/external/monitor); regression `agent-commands.test.ts`.
- W8 audit: `src/security/audit-harness/surfaces.ts` `discoverAgentDefinitions` scans `.metaproject/agents/*.md` and `.claude/agents/*.md`; checks `agent-unrestricted-tools` (frontmatter `tools` key present) and `agent-missing-model-tier` (`model_tier` or `model`). Facade `runHarnessAudit` in `src/security/service.ts`.
- W5 registry: `src/integrations/{types,registry,surfaces,surfaces-w5b,matrix,installer}.ts`; `SurfaceFlag` already includes `agents`; matrix state: instructions subsystem → instruction-only; host-hook+verified+installs → native; else adapter. `resolveSurfaceSelection` with no selectors selects every surface (hence opt-in flag needed).
- Bundled content ships from `src/gdskills/bundled/` (package.json files). W1 packs will live at `src/gdskills/bundled/stacks/<id>/` (W1 spec L197) — W2 must not edit W1 code.
- Skill catalogue: `BUNDLED_GDSKILLS` in `src/gdskills/catalog.ts`; xref lint `src/gdskills/agent-catalogue-xref.test.ts`.
- Multi-agent-engine non-goal: `docs/requirements/keryx-multi-agent-engine/README.md` ~L162.
## Host agent-file formats (first-party docs check, 2026-09-24)

- Claude Code — https://code.claude.com/docs/en/sub-agents — `.claude/agents/<name>.md`, YAML frontmatter (`name`, `description` required; `tools` comma string or list; `model` accepts `inherit`; `permissionMode` e.g. `plan`/`default`); unknown keys ignored; body = system prompt; HTML comment in body safe. Tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch. Confidence: verified.
- Codex — https://developers.openai.com/codex/subagents — `.codex/agents/<name>.toml`, required `name`, `description`, `developer_instructions`; optional `model` (omit = inherit parent), `model_reasoning_effort`, `sandbox_mode` (`read-only` | `workspace-write`). NO per-tool allowlist (access governed by sandbox_mode only). `#` comments are standard TOML. Confidence: fields verified; register surface as experimental (tool allowlist cannot be expressed) → matrix `adapter`.
- Kiro (IDE 1.0 / CLI 3.0) — https://kiro.dev/docs/custom-agents/configuration-reference/ — `.kiro/agents/<name>.json`: `name`, `description`, `prompt`, optional `model`, `tools` (tags `read`, `write`, `shell`, `web`, or builtin names `fs_read`, `fs_write`, `execute_bash`), `allowedTools`. Unknown-key tolerance NOT documented → do not add `_keryxManaged`; put the managed sentinel as the first line of `prompt`. Omit `model`. Kiro adapter is experimental → `adapter`.
- OpenCode — https://opencode.ai/docs/agents/ — `.opencode/agents/<name>.md` (plural), frontmatter `description` (required), `mode: subagent`, `permission` map (`edit`, `bash`, `webfetch`, `websearch`... values allow|ask|deny; read-only = edit: deny, bash: deny); `tools` boolean map deprecated; omit `model` = inherit. Tool names: read, write, edit, apply_patch, glob, grep, list, bash, webfetch, websearch. OpenCode adapter experimental → `adapter`.
- Research subagent output tripped the harness's "bypass-permissions" pattern detector only because it listed Claude Code's documented `permissionMode` enum values; no instruction was acted on. Exporters must NOT emit that value.
