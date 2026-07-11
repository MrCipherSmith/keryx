# Keryx Project Agent Harness Best Practices and Research
Version: 0.2.0

## Research Scope

This document records design input from open-source harnesses and primary
protocol/API documentation. It does not imply that Keryx uses or depends on
any of these projects.

## Reproducible Research Ledger

The managed review checked these sources on 2026-07-10. Mutable documentation
is treated as evidence to refresh before the corresponding capability starts;
it is never copied as a runtime contract without an explicit Keryx decision.

| Source | URL | Checked / revision | Observed fact | Keryx inference and rejected tradeoff | Affected decision | Refresh |
|---|---|---|---|---|---|---|
| Pi security | https://pi.dev/docs/latest/security | 2026-07-10 / latest docs | In-process prompts are not a containment boundary for untrusted work | Require real isolation for unattended mutation; reject prompt-only sandboxing | D3 | before Release 1 |
| Pi compaction/RPC | https://pi.dev/docs/latest/compaction | 2026-07-10 / latest docs | Sessions use append-only tree and typed compaction; JSONL/RPC is a transport | Adopt typed derived compaction and transport parity; reject destructive truncation | D5 | before session implementation |
| OpenCode permissions | https://opencode.ai/docs/permissions/ | 2026-07-10 / latest docs | Tool access supports allow/ask/deny and pattern rules | Adopt typed decisions; reject provider-owned authorization | D3 | before policy implementation |
| OpenCode repository | https://github.com/anomalyco/opencode | 2026-07-10 / repository state | Plugins/tools are executable and need explicit trust | Defer executable extensions and require capability grants later | D3 | before Release 2 |
| oh-my-claude | https://github.com/X0x888/oh-my-claude | 2026-07-10 / repository state | Hard completion gates and bounded review loops are emphasized | Keep completion evidence typed; reject prose-only success | D2 | before completion gate |
| oh-my-claudecode | https://github.com/yeachan-heo/oh-my-claudecode | 2026-07-10 / repository state | Parallel work needs one loop owner and durable artifacts | Task Manager remains sole coordinator; reject nested loops | D2 | before child agents |
| MCP basic | https://modelcontextprotocol.io/specification/2024-11-05/basic | 2026-07-10 / 2024-11-05 | JSON-RPC lifecycle/capabilities are protocol primitives; auth is not implied | Treat MCP as an adapter, not internal authorization | D2/D3 | before MCP exposure |
| Anthropic streaming | https://platform.claude.com/docs/en/build-with-claude/streaming | 2026-07-10 / current docs | Streams include deltas, partial tool JSON, usage, ping, and errors | Preserve attempt boundaries and unknown extensions; reject closed lossy enums | D4 | before real provider |
| OpenAI Responses | https://platform.openai.com/docs/api-reference/responses | 2026-07-10 / current docs | Storage, continuation, streaming, tools, and cancellation are capabilities | Keep provider storage/continuation off by default; reject implicit remote state | D4 | before real provider |
| OpenAI Agents tracing | https://openai.github.io/openai-agents-python/tracing/ | 2026-07-10 / current docs | Traces may capture sensitive generation and function data | Default to metadata/hashes/redacted previews; reject raw trace persistence | D3/D4 | before provider traces |

## Pi

Primary sources:

- [Pi documentation](https://pi.dev/docs/latest)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi packages](https://pi.dev/docs/latest/packages)
- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi RPC mode](https://pi.dev/docs/latest/rpc)
- [Pi compaction](https://pi.dev/docs/latest/compaction)
- [Pi security](https://pi.dev/docs/latest/security)

Useful patterns:

- Keep the core small and make extensions explicit.
- Treat sessions as append-only trees with stable ids and a current leaf.
- Make compaction a typed session entry, not destructive log truncation.
- Track files read and modified cumulatively across compaction and branches.
- Offer both in-process SDK and process-isolated JSONL/RPC integration.
- Stream lifecycle and tool events to transports.
- Treat packages/extensions as privileged code requiring trust.
- Do not assume a built-in sandbox; define the security boundary explicitly.

Keryx application:

- Use append-only session events and stable cursors.
- Preserve project evidence across compaction.
- Use JSONL/RPC as the first headless transport.
- Keep runtime extensions behind explicit registration and capability policy.
- Make project trust and package trust separate from model reasoning.

## OpenCode

Primary sources:

- [OpenCode repository](https://github.com/anomalyco/opencode)
- [Agents](https://opencode.ai/docs/agents/)
- [Tools](https://opencode.ai/docs/tools/)
- [Custom tools](https://opencode.ai/docs/custom-tools/)
- [Plugins](https://dev.opencode.ai/docs/plugins/)
- [MCP servers](https://opencode.ai/docs/mcp-servers)
- [Permissions](https://opencode.ai/docs/permissions/)

Useful patterns:

- Separate primary agents from subagents.
- Treat tool access as a permissioned surface.
- Use `allow`, `ask`, and `deny` instead of a boolean enabled flag.
- Apply wildcard/pattern rules while preserving specific overrides.
- Allow custom tools to expose structured schemas and session context.
- Use plugins for lifecycle hooks, but keep tool policy outside plugin code.
- Enable MCP servers per agent when the tool surface is large.

Keryx application:

- Define roles and child tasks as separate concepts.
- Make policy decisions typed and recorded before tool execution.
- Keep tool names stable and namespaced.
- Add per-role and per-tool policy, but enforce hard security denies centrally.

## oh-my-claude

Primary sources:

- [oh-my-claude repository](https://github.com/X0x888/oh-my-claude)
- [oh-my-claude site](https://www.ohmyclaude.dev/)

Useful patterns:

- Classify user intent before selecting an execution workflow.
- Route work to specialists by domain and risk.
- Require a fresh planning or shaping step before mutation for high-risk work.
- Use hard completion gates for tests, review, verification, and explicit user
  obligations.
- Add bounded gate caps to prevent quality loops from becoming infinite.
- Preserve continuity across compaction through explicit hook/state entries.
- Make uncertainty visible instead of hiding it in a confident completion.

Keryx application:

- Implement intent and risk classification as structured metadata.
- Keep “done” as a typed gate result.
- Use explicit follow-up tasks for discovered scope instead of silently
  narrowing the task.
- Make skip/defer/pause different dispositions with different evidence.

## oh-my-claudecode

Primary sources:

- [oh-my-claudecode repository](https://github.com/yeachan-heo/oh-my-claudecode)

Useful patterns:

- Staged pipelines make complex multi-agent work observable.
- Parallel workers must be bounded and budgeted before dispatch.
- Persistent loops need an explicit max-runtime and stop authority.
- Replay logs and session summaries are essential for diagnosing autonomous
  behavior.
- Provider-advisor calls should produce durable artifacts, not disappear into
  terminal output.
- One primary loop authority must own completion for a run.

Keryx application:

- Add a parent run coordinator and child run records.
- Reserve aggregate budget before launching a wave.
- Persist each child dispatch and result before advancing task state.
- Prohibit nested competing loops.

## Model and Tool Protocols

### Anthropic

The [Messages streaming documentation](https://platform.claude.com/docs/en/build-with-claude/streaming)
documents SSE streaming of text, tool-use, and other deltas. Keryx should
normalize these events into provider-neutral `model_event` records and retain
provider-specific fields only under an explicitly namespaced extension object.

### OpenAI

The [Responses streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal)
documents streamed response items and tool definitions. Keryx should treat
tool calls as structured items and never parse natural-language commands as a
substitute for a tool contract.

### MCP

The [MCP specification](https://modelcontextprotocol.io/specification/2024-11-05/basic)
defines tools, resources, and prompts as protocol primitives. Keryx should
reuse the conceptual separation but keep its internal tool registry richer:
policy metadata, provenance, budgets, cancellation, and evidence are Keryx
concerns that must survive MCP translation.

### OpenAI Agents SDK

The [tracing guide](https://openai.github.io/openai-agents-python/tracing/)
shows the value of recording LLM generations, tool calls, handoffs,
guardrails, and custom events. Keryx should implement provider-neutral tracing
and local redacted event records without requiring the OpenAI SDK.

## General Rules Extracted

### Do

- Use typed event and tool contracts.
- Persist decisions before side effects where possible.
- Enforce budgets before dispatch.
- Keep context references hash-addressed and scoped.
- Make retries typed and bounded.
- Record unknown metrics as unknown.
- Separate trusted policy from untrusted repository content.
- Test replay and resume in temporary project workspaces.

### Do Not

- Let prompt text grant permissions.
- Give every agent every tool.
- Treat a final model message as completion evidence.
- Copy whole repository context into every child task.
- Store raw prompts, secrets, hidden chain-of-thought, or unrestricted env.
- Allow multiple loop engines to compete for the same task.
- hide a retry, fallback, or skipped phase in prose.
