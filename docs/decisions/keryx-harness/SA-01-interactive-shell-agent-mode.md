# SA-01: Interactive Shell Agent Mode
## Wiring the interactive `keryx shell` onto the agentic run-loop (tools + metaproject context)

**Status**: Implemented / evolving (Flow A/B and the interactive TUI path are live; this RFC records the resolved runtime contract)
**Proposed**: 2026-07-17
**Depends on**: ADR-0003 (D-03 security profiles / containment), ADR-0004 (D-04 provider branch child), the flow-009 run-loop (`src/harness/run/run.ts`), flow-026 subprocess executor
**Reviewer Track**: architecture
**Source of Truth**: `src/commands/agent.ts`, `src/commands/shell.ts`, and `src/tui/tui-shell.ts`; this document explains the contract

---

## 1. Problem

Before agent mode, the interactive `keryx shell` (flows 021/022/031/032) was a
**chat-only REPL**: it called `provider.stream()` directly, sent a request with
**no `tools`**, and used a one-line `systemInstruction` with **no project
context**. The model therefore had no way to inspect the filesystem, run
commands, or read the codebase and could only hallucinate plausible output.

Agent mode resolves that gap by giving the shell **hands (registered tools)**,
bounded Metaproject context, approval gates, and an explicit loop-safety budget.
Chat mode remains available as the tool-free path.

## 2. Implemented engine

The durable harness machinery supplied the provider/tool contracts, but the
interactive product now uses a dedicated deterministic driver,
`runAgentTurn()`, so it can stream UI events and pause for approvals without
changing the chat core.

| Capability | Location | State |
|---|---|---|
| Normalized tool protocol | `provider/types.ts` — `NormalizedRequest.tools`, role `tool`, events `tool_call_start/delta/end`, caps `toolCalls`/`parallelToolCalls` | ✅ |
| ollama tool-calling adapter | `provider/ollama/ollama-provider.ts` + real `fixtures/tool-call-stream.recorded.sse` | ✅ |
| anthropic tool-calling adapter | `provider/anthropic/*` (`toolCalls: true`) | ✅ |
| Interactive agent loop | `commands/agent.ts` → `runAgentTurn`: `stream → tool_call_end → validate/risk budget → execute → role:tool result → re-request` | ✅ |
| Interactive tools | `harness/tool/builtin/*` (`InteractiveTool` definitions), plus `agent.ts` input validation and risk gate | ✅ |
| Real subprocess execution | `harness/tool/builtin/shell-exec-tool.ts` over the injected command runner and sandbox | ✅ |
| Interactive usage | provider `usage_update` events forwarded through `AgentIO.onUsage` | ✅ |

The durable spec constraint remains unchanged: *the model must not receive direct
filesystem or shell access outside registered tools.* Interactive execution is
dependency-injected and testable; it does not reach real stdio or provider I/O
except through its injected ports.

## 3. Implemented architecture

```
CHAT:   shell --chat → provider.stream(request WITHOUT tools) → render text
AGENT:  shell/TUI → runAgentTurn({ provider, interactiveTools, instruction })
                    ↳ provider round → tool calls → validated results → provider round
```

The OpenTUI and readline surfaces are presentation layers over the same agent
driver. `AgentIO` exposes streamed assistant/reasoning text, usage, tool calls,
tool results, system messages, and approval requests.

`runShell` (the deterministic chat core) is **not deleted** — agent mode is a
parallel path (see §7.1), preserving flows 021/022/031/032 tests unchanged.

## 4. The tool set ("hands")

Every system touch is a registered tool (spec constraint). The live set includes:

- **`get_cwd`**, **`read_file`**, **`list_dir`** — confined project-root reads;
  risk **read**, auto-allowed.
- **Metaproject reads** — `search_code`, `graph_affected`, `graph_symbol`,
  `memory_search`, `read_wiki`, and `wiki_ask`; risk **read**.
- **`shell_exec`** — command execution; risk **shell**, explicit approval.
- **`ask_user`** and **`spawn_subagent`** — structured interaction/delegation;
  delegation follows its own approval behavior.

Each tool declares `risk` in its `NormalizedToolDefinition`. Unknown risks fail
closed in execution and are charged to the conservative non-read budget.

## 5. Metaproject context injection

`buildOrientation(cwd)` injects a compact block into `systemInstruction`. When
the shell launch root contains `.metaproject/index.md`, the block begins with a
bounded excerpt of that exact file (at most 60 useful lines; `Data` and `Refresh`
sections omitted), followed by the graph map and wiki index. Keryx does not walk
ancestors: the launch cwd is the project boundary.

The excerpt is precedence guidance, not a hard runtime gate. It explicitly tells
the model to use `read_file` for the complete `.metaproject/index.md` before
project work. Missing index files preserve the previous graph/wiki-only format.

## 5.1 Tool-loop budgets

Interactive agent turns use nested unique-signature pools keyed by normalized
`tool name + JSON input`:

| Pool | Default | Meaning |
|---|---:|---|
| total | 48 | hard ceiling across every risk class |
| read | 40 | read signatures inside the total pool |
| non-read | 8 | shell/delegate/unknown-risk signatures inside the total pool |

An identical signature may run up to three times while occupying one unique
slot. Reaching a pool exactly does not terminate the turn: the model gets a
normal round to answer from the newest tool result. A tool-free wrap-up occurs
only after a new signature is rejected for exceeding a pool, or after a whole
round makes no progress. Explicit `maxToolCalls` overrides remain total hard
ceilings, so the TUI side worker's `maxToolCalls: 4` also limits its read calls.

## 6. Side benefits

- **Token counter in the status bar** — provider `usage_update` events are
  forwarded to the TUI through `AgentIO.onUsage`.
- **Deterministic tests** — provider streams, tools, ids, approvals, and rendering
  callbacks are injected, so multi-round trajectories are tested offline.

## 7. Resolved decisions and remaining work

1. **Parallel mode vs replacement — resolved.** Agent mode is the default TUI;
   `--chat` preserves the deterministic tool-free readline core.
2. **Driver reuse — resolved.** Interactive mode uses `runAgentTurn`, not
   `runOffline`; both remain dependency-injected but serve different lifecycles.
3. **Approval UX — resolved for current scope.** Shell calls are default-deny and
   require explicit approval; read tools auto-allow.
4. **Remaining:** step-based soft/hard trajectory limits and context compaction
   are separate future improvements. They are not replaced by the risk budgets.

## 8. Phasing (one flow each)

- **Flow A — implemented:** interactive agent driver, filesystem/shell tools,
  approval, tool-result feedback, and orientation.
- **Flow B — implemented:** Metaproject graph/wiki/context/memory tools.
- **Flow C — partially implemented:** OpenTUI, usage/reasoning/tool rendering,
  approvals, structured questions, and subagent delegation. Provider-dependent
  parallel tool execution and context compaction remain follow-up work.

## 9. Non-goals

- No direct filesystem or shell access outside registered tools.
- No unbounded Metaproject document injection into every turn.
- No change to the durable wire schemas, ADR-0001…0004, or the deterministic
  `runShell` chat core semantics.
