# Implementation Plan

Status: formalized

## Approach

**Compose a new interactive agent driver from existing primitives** (SA-01 §7.2).
`runOffline` is single-shot and not reusable for a live multi-turn UI, so Flow A
builds a small conversational driver that reuses the SAME building blocks
(`ToolRegistry`, policy `decide`, `ToolExecutorPort`, `validateToolCall`, the
`tool_call_end` handling shape) that `runOffline` uses — keeping the deterministic
chat `runShell` core and its tests untouched.

Resolved SA-01 §7 decisions for Flow A: (1) opt-in `--agent`/`/agent`, parallel to
chat; (4) read-only tools only → policy auto-allow, so NO approval UX this flow;
(5) default profile allows `read`. Provider is provider-agnostic (uses the
`toolCalls` capability); `shell_exec`, approval, and the metaproject tools are
later flows.

## Steps

1. **Builtin read-only tools** (`src/harness/tool/builtin/` + tests): `get_cwd`,
   `list_dir`, `read_file` — each a `ToolDefinition` (input/output JSON Schema,
   risk `read`) plus a real `ToolExecutorPort` that resolves paths **inside the
   project root** (reject `..`/absolute escapes), returning a `ToolResult`. Pure,
   deterministic given a root; unit-tested (happy path + path-escape rejection +
   missing file).
2. **Agent driver** (`src/commands/agent.ts` + tests): `runAgentTurn(io, deps,
   history)` — build a `NormalizedRequest` with `tools = registry snapshot` and the
   trusted system instruction; stream; accumulate assistant text (render via the
   flow-031 hooks); on `tool_call_end` → `validateToolCall` → `decide` → allow →
   `invoke` → push a `role:"tool"` result message → re-request; stop at a
   text-only finish or the `maxToolCalls` guard. Deterministic core (injected
   provider/registry/executor/clock/idSeq), offline-testable with a FakeProvider
   that emits a scripted tool call.
3. **Context injection**: assemble the trusted `systemInstruction` from a compact
   `keryx orient` block (fallback to a minimal static instruction when orient is
   unavailable) — pure builder, unit-tested for both paths.
4. **Wrapper wiring** (`shellCommand`): `--agent` flag + `/agent` toggle select the
   agent driver over the chat core; reuse `createRichIo` for rendering, adding
   `onToolCall`/`onToolResult` hooks (styled, e.g. `⚙ list_dir(...)` + a dim result
   summary). Real executor + a default read-allow policy profile are injected here.
5. **Tests + smoke**: unit tests for tools, driver (scripted tool-call transcript),
   and context builder; `tsc` + full `bun test` green ≥ baseline; manual live smoke
   (`bun src/cli.ts shell --agent`): ask "what's my cwd / list files" and confirm
   the agent calls `get_cwd`/`list_dir` and answers from REAL data (no
   hallucination). Journal it.

## Risks

- **Local model tool-calling reliability** — `gemma4:e4b` may not emit tool calls;
  validate the driver with a FakeProvider transcript (deterministic) and smoke with
  a tool-capable model (note the limitation, don't block the flow on it).
- **Path traversal** — the executor must confine every path to the project root;
  covered by an explicit escape-rejection test.
- **Loop safety** — a `maxToolCalls` guard per turn prevents an infinite
  tool-call loop; mirrored from `runOffline`'s budget guard.
- **Scope creep** — keep strictly read-only; resist adding `shell_exec`/approval
  here (separate flow) so Flow A stays shippable and safe.
