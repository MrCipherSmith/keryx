# Flow 033 — keryx shell agent mode (Flow A of SA-01)

Status: formalized
Source: user request ("дать руки агенту и контекст metaproject") + design RFC
[SA-01](../../../docs/decisions/keryx-harness/SA-01-interactive-shell-agent-mode.md).
This is **Flow A** of SA-01's phasing. Reuses the flow-031/032 rich UI and the
flow 007/009/026 harness primitives.

## Problem

The interactive `keryx shell` is chat-only: it calls `provider.stream()` with **no
`tools`** and a context-free system instruction, so the model cannot touch the
system and *hallucinates* (observed: `pwd` → fabricated `/home/user`). keryx's
whole value — an agent with **hands + metaproject context** — is unrealized in the
interactive surface, even though the tool protocol, tool-calling adapters, policy
engine, and executor primitives already exist (SA-01 §2).

Key constraint discovered (SA-01 §7.2, now resolved): `runOffline` (`run/run.ts`)
is a **single-shot** run (one prompt, hardcoded system instruction, no multi-turn,
no UI streaming). Interactive agent mode therefore needs a **new interactive
driver that composes the same primitives** (registry + policy `decide` + executor +
`tool_call_end` handling), not a call to `runOffline`.

## Expected Outcome

A new **agent mode** for the interactive shell that gives the model real,
read-only hands and project context, without disturbing the deterministic chat
core:

1. **Interactive tool-using driver** — a new driver (`runAgentTurn`/`runAgentShell`)
   that, per user turn, streams `provider.stream(request WITH tools)`, and on each
   `tool_call_end`: `validateToolCall` → policy `decide` → (read → allow) →
   `ToolExecutorPort.invoke` → append the `ToolResult` as a `role:"tool"` message →
   continue until the model finishes with no pending tool call. Multi-turn history
   is kept across turns.
2. **Read-only builtin tools** (all risk `read`, auto-allowed by policy — no
   approval UX needed in Flow A): `get_cwd` (real `process.cwd()` — directly fixes
   the observed hallucination), `list_dir`, and `read_file`. Each is a registered
   `ToolDefinition` (name + input/output JSON Schema + risk) with a real
   `ToolExecutorPort` implementation confined to the project root.
3. **Metaproject context** — a compact orientation block (via `keryx orient`, with
   a safe fallback when unavailable) injected into the trusted `systemInstruction`.
4. **Opt-in, non-breaking** — agent mode is entered via `keryx shell --agent` or an
   in-session `/agent` toggle; the existing chat `runShell` core (flows 021/022/
   031/032) and ALL its tests are unchanged. The flow-031/032 rich UI (roles,
   markdown, status bar) is reused; tool calls/results render via additive UI
   hooks.

## Out of Scope (deferred to later SA-01 flows)

- **`shell_exec` + approval UX** (risk `shell`, needs single-use approval) —
  deferred to a later flow; Flow A is read-only and needs NO approval prompt.
- **Metaproject tools** (`gdgraph`/`gdwiki`/`ctx`/`memory` as tools) — SA-01 Flow B.
- **Token counter in the status bar, parallel tool calls** — SA-01 Flow C.
- No new production dependency (`dependencies` stays `{}`); no full-screen TUI.
- No change to `runOffline`, the durable wire schemas, ADR-0001…0004, or the
  deterministic `runShell` chat core.
