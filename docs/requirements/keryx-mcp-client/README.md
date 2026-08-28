# Keryx MCP Client
Version: 0.2.0

## Purpose

Give keryx's own agent loop the ability to **consume** external MCP servers —
today keryx only ever *serves* MCP (`src/mcp/server.ts`); nothing in the
harness can connect out to a third-party MCP server and use its tools.

The first, concrete driver for this package is not "MCP support" in the
abstract — it is `keryx-external-agent-runtime` (flow 176): `codex mcp-server`
propagates its own internal tool-approval requests back to whatever connects
to it as an MCP client, via the standard MCP `elicitation/create` request,
whenever `approval-policy` is `on-request` (its default). That is the
documented, deliberately-deferred design named in
[keryx-external-agent-runtime/decisions.md](../keryx-external-agent-runtime/decisions.md)
D-03 ("kept idea 1") as the credible path to a mutating external worker — and
it requires keryx to act as an MCP client, which does not exist yet.

## Status

**implemented** (AC1–AC9 all confirmed; flow 187, PR #362). `src/mcp-client/`
(`client.ts`, `wire.ts`, `elicitation.ts`, `types.ts`, 6 test files) ships a
stdio MCP client on `@modelcontextprotocol/sdk`, plus a second, MCP-shaped
supervisor for `codex-cli` (`gatedSuperviseCodexMcpRun`,
`src/harness/external/supervise-mcp.ts`) — additive alongside the existing
line-stream `superviseExternalRun` path, which `claude-cli` keeps unchanged
(D-03). Elicitations are decided via `resolveApprovalDecision`
(`src/commands/permission-mode.ts`, D-05) through the existing
`requestApproval`/`AgentIO` prompt path; an escalation classifier
(`classifyElicitationRisk`) derives `destructive`/`credentials` signal from
the elicitation payload feeding it (AC9); the capability gate folds into the
existing `gdskills.external-agents` descriptor rather than adding a second
toggle; a pending elicitation surfaces in the TUI through the same path as an
existing write-risk approval prompt.

Verified against the real, live `codex mcp-server` (codex-cli 0.147.0), not
only fixture replay: `fixtures/mcp-client/codex/` has three genuinely
`captured: true` scenarios (approve, deny, timeout) plus two honestly
`*.SYNTHETIC.jsonl`-caveated ones, and two flag-gated live smoke tests
(`KERYX_ALLOW_REAL_SUBPROCESS=1`, excluded from CI) prove the spawn+handshake
(AC1) and a full approve/decline elicitation round-trip (AC3) against the
real binary. `keryx-external-agent-runtime`'s own D-03 and D-04 were revised,
not silently reinterpreted, to name `resolveApprovalDecision` as the traced
approval-routing layer this package's elicitation responses go through.

One thing this status does not mean: nothing in `dispatch.ts`/`registry.ts`
routes `codex-cli` through the new MCP-shaped supervisor by default —
`gatedSuperviseCodexMcpRun` exists and is fully tested, but D-03's "full
migration of `codex-cli` to `mcp-server`" (making it the default production
path) was not this package's scope. See [decisions.md](decisions.md) for the
full record.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Identity, structure, data contracts, integration points, acceptance criteria. |
| [decisions.md](decisions.md) | Adopted decisions and explicit refusals. |
| [brainstorm.md](brainstorm.md) | Reference designs studied (deepseek-harness, codex, cline, opencode, helyx), confirmed vendor behavior with sources, and the open architecture question. |

## Scope

- An MCP **client** capability: connect to one or more MCP servers (initially:
  a `codex mcp-server` process keryx itself spawns as an external agent child),
  handle the connection lifecycle, and expose discovered tools/requests to the
  rest of the harness.
- Specifically: handle inbound `elicitation/create` requests from a connected
  server and route them to a decision via `resolveApprovalDecision` +
  the existing `requestApproval`/`AgentIO` prompt path (specification.md §9,
  decisions.md D-05).
- Architected generally enough to serve as the real MCP-client foundation
  (transport, tool-registry bridging) — codex's elicitation path is the first
  consumer and proof of use, not the only planned one.

## Non-goals (this version)

- Claude as a write-capable external agent. Confirmed via public documentation
  (see brainstorm.md, sourced): `claude -p`'s `--permission-prompt-tool`
  converts an "allow" to a forced "deny" for flagged tools in non-interactive
  mode. Not something keryx's design can work around; tracked as blocked
  upstream, revisit when/if Anthropic changes this.
- A general-purpose "browse and consume any MCP server" UX (marketplace,
  arbitrary user-added servers). This version is scoped to keryx spawning and
  connecting to a *specific* server it already controls (`codex mcp-server`),
  not consuming arbitrary third-party MCP servers a user configures.
- Widening `keryx-external-agent-runtime`'s vendor registry beyond
  `codex-cli`/`claude-cli`. Tracked separately; see roadmap note.
- Any change to `keryx-provider-auth` D-01's credential boundary. codex's own
  subscription authentication is unaffected — this package only changes how
  keryx *talks to* an already-authenticated codex process, never how codex
  itself authenticates.

## Related modules

- [Keryx External Agent Runtime](../keryx-external-agent-runtime/README.md) —
  the consumer this package exists for. D-03 ("kept idea 1") and D-04
  (read-only release gate) are the decisions this package's write-path work
  revisits.
- [Keryx Project Agent Harness](../keryx-project-agent-harness/README.md) —
  hosts `resolveApprovalDecision`, the decision layer this package's
  elicitation responses route through (decisions.md D-05), and the unrelated
  `src/harness/mutation/` guarded-mutation subsystem this package explicitly
  does not use (it belongs to `src/harness/extension/`, not child dispatch).
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — D-01, the
  credential boundary this package sits beside and must not cross, exactly as
  `keryx-external-agent-runtime` already commits to.
