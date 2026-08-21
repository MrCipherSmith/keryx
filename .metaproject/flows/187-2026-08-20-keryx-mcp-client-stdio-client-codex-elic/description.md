# Keryx MCP Client: stdio client, codex elicitation handling, tool-registry bridge

Status: formalized
Source: docs/requirements/keryx-mcp-client/ (specification ready, v0.2.0)

## Problem

Keryx only ever *serves* MCP (`src/mcp/server.ts`); nothing in the harness can
connect out to a third-party MCP server. `codex mcp-server` propagates its own
internal tool-approval requests to whatever connects to it as an MCP client,
via the standard `elicitation/create` request, whenever `approval-policy` is
`on-request` (its default). Building an MCP client is the literal prerequisite
for reaching the write path that `keryx-external-agent-runtime` (flow 176)
deferred at D-04 (worktree-write refused at runtime).

## Expected Outcome

- Keryx spawns `codex mcp-server` over stdio and completes the MCP handshake
  (new module `src/mcp-client/`, reusing the already-declared
  `@modelcontextprotocol/sdk` dependency — no new runtime dependency).
- A second, MCP-shaped supervision path for `codex-cli` (alongside the
  existing line-stream `superviseExternalRun` path, which `claude-cli` keeps
  unchanged) receives and correctly parses `elicitation/create` requests,
  resolves a decision via `resolveApprovalDecision`
  (`src/commands/permission-mode.ts`) + the existing `requestApproval`/
  `AgentIO` prompt path, and returns an `ElicitResult`-shaped response.
- Three named upstream rough edges are each defended with a fixture-backed
  test: unanswered elicitation past timeout -> named refusal event, not a
  hang (openai/codex#11816); malformed/empty `content` -> deny, never
  implicit accept (openai/codex#23383); missing `codex_call_id` in older
  codex builds -> confirmed safe against the pinned min version or explicit
  degraded handling.
- A per-action escalation classifier (the elicitation-payload analog of
  `classifyPatchRisk`) derives `destructive`/`credentials` signal from the
  elicitation payload and feeds `resolveApprovalDecision`, so `"trust"`
  mode's escalation path is provably reachable.
- `keryx-external-agent-runtime`'s own specification/decisions are revised
  (not silently reinterpreted) to record which approval-routing layer this
  package's elicitation responses go through.
- Full acceptance criteria: `docs/requirements/keryx-mcp-client/specification.md`
  §10 (AC1-AC9), carried into `acceptance-criteria.md` of this flow verbatim.

## Out of Scope

- Claude as a write-capable external agent (blocked upstream by
  `--permission-prompt-tool` behavior in non-interactive mode; D-01).
- A general-purpose "browse and consume any MCP server" UX. Scoped to keryx
  spawning and connecting to the specific `codex mcp-server` process it
  already controls (D-04).
- Widening the `keryx-external-agent-runtime` vendor registry beyond
  `codex-cli`/`claude-cli`.
- Any change to `keryx-provider-auth` D-01's credential boundary — codex's
  own subscription authentication is unaffected.
- HTTP/SSE MCP transport (stdio only, matching `codex mcp-server`).
- Touching `ToolRegistry`/`tool-port.ts` or `bridgeExternalEvent`/
  `reduceAgents` (specification.md §6: elicitation is not a model-visible
  tool call and does not produce `ExternalEvent`s; both stay untouched, and
  the original package's AC5 test suite must keep passing unmodified).
