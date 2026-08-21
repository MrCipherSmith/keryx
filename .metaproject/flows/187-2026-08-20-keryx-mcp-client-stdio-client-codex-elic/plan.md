# Implementation Plan

Status: formalized from docs/requirements/keryx-mcp-client/ (spec ready,
both blocking design questions §6/§9 already resolved — no brainstorm/
interview needed, this is an implementation plan, not a design search).

## Approach

Build a new `src/mcp-client/` module on top of the existing
`@modelcontextprotocol/sdk` client APIs, wired as a second, MCP-shaped
supervision path for `codex-cli` only (D-03). `claude-cli` keeps using the
existing `superviseExternalRun` line-stream path unchanged. The MCP
supervisor owns the full elicitation exchange as a side channel parallel to
`ExternalEvent` emission — it never touches `ToolRegistry`, `tool-port.ts`,
`bridgeExternalEvent`, or `reduceAgents` (specification.md §6).

Reused, not re-derived: spawn/env hygiene from `src/harness/external/`
(`buildExternalChildEnv`, the `KERYX_` env sweep, the disposable worktree) —
only the transport layer above the spawned process changes for codex.

## Steps

1. **Live probe first** (PRD recommendation): spawn a real `codex mcp-server`
   process locally, trigger a write-requiring action, and capture the actual
   `elicitation/create` request/response shapes it sends — do not author
   fixtures from the spec alone (specification.md §5.1, PRD Requirement 2).
   Confirm/adjust `codex-cli`'s pinned min version (0.147.0) against the
   `codex_call_id` fix (PRD Requirement 5) during this same probe.
2. **`src/mcp-client/` module**: stdio MCP client built on
   `@modelcontextprotocol/sdk`, handling connection lifecycle (spawn,
   handshake, teardown) for one `codex mcp-server` child at a time.
3. **MCP-shaped supervisor for `codex-cli`**: new supervision path
   alongside (not replacing, for other vendors) `superviseExternalRun`,
   wired into `src/harness/external/` vendor dispatch for `codex-cli` per
   D-03. Still terminates in the same `ExternalEvent` vocabulary for
   transcript events; the elicitation exchange itself produces none.
4. **Elicitation handling** (revised per T5's live findings — see
   `context.md` "T5 live probe findings" for the full evidence):
   - Read the inbound `elicitation/create` request off the **raw wire**
     (transport-level tap, or a loosened/custom Zod schema for this one
     method) — the SDK's own `ElicitRequestSchema` strips codex's vendor
     fields (`codex_call_id`, `codex_command`, `codex_cwd`,
     `codex_parsed_cmd`, `codex_elicitation`), so the plain
     `client.setRequestHandler(ElicitRequestSchema, ...)` path cannot
     satisfy AC2 by itself.
   - Correlate the elicitation with its sibling `codex/event` notification
     (`params.msg.type === "exec_approval_request"`, matched by `call_id`)
     to obtain that request's `available_decisions` — NOT a fixed enum,
     varies per request. `requestedSchema` is empty on every real
     elicitation; it carries no usable guidance on its own.
   - Resolve via `resolveApprovalDecision` (`src/commands/permission-mode.ts`)
     — `"auto"` answers immediately, `"ask"` calls the existing
     `requestApproval`/`AgentIO` prompt path.
   - Produce codex's actual expected response shape: `{action, decision}`
     with `decision` chosen from that request's `available_decisions` (a
     confirmed-safe value, e.g. `"approved"` / `"abort"`), **not** the
     standard `ElicitResult.content` shape, which codex's own
     `ExecApprovalResponse` deserializer does not read.
   - When no `codex/event` correlation can be found for a pending
     elicitation (AC5's "malformed/empty content" case), deny safely rather
     than guess a `decision` value.
   - Independently of the elicitation exchange, give the `client.callTool(...)`
     call its own timeout/cancellation handling — a cleanly-declined
     elicitation does not guarantee the outer tool call resolves on its own
     (confirmed: it can outlive a clean decline and hit the SDK's default
     60s client timeout).
5. **Escalation classifier**: a `classifyPatchRisk`-analog for elicitation
   payloads, deriving `destructive`/`credentials` signal, feeding
   `resolveApprovalDecision` per ADR-0010's shape (ties directly to AC9).
6. **Three rough-edge defenses**: timeout -> named refusal event (AC4);
   malformed/empty `content` -> deny, not implicit accept (AC5);
   `codex_call_id` version-skew handling per step 1's finding.
7. **Capability gate**: fold into the existing `gdskills.external-agents`
   capability descriptor (`src/capability/`) rather than adding a second,
   separately-toggleable switch (specification.md §7).
8. **Fixtures**: `fixtures/mcp-client/codex/` — clean approve, clean deny,
   timeout/no-response, malformed/empty content, and (if reproducible)
   missing-`codex_call_id`. Recorded from the live probe (step 1), following
   D-06's existing fixture-per-vendor-behavior precedent.
9. **Update `keryx-external-agent-runtime` docs**: revise its
   specification/decisions to name the approval-routing layer this
   package's elicitation responses actually go through (D-05), not leave it
   silently superseded.
10. **TUI surfacing** (implementation-phase UI decision, named in
    specification.md §8): whatever already renders a pending approval
    prompt for native `write`-risk tools should also surface a pending
    elicitation the same way.

## Risks

- Live codex behavior may diverge from the spec's documented shape
  (`keryx-external-agent-runtime`'s own precedent: three of its spec
  revisions were corrected by live findings) — mitigated by doing the live
  probe (step 1) before writing fixtures or pinning payload types.
- Scope creep toward a general MCP client — mitigated by D-04: architect
  generally, ship exactly one consumer.
- `src/harness/external/supervise.ts`'s existing seam is line-stream shaped
  and cannot be reused directly for the MCP transport (D-03's accepted
  cost) — this is a second supervision path, not a codec swap; do not
  attempt to force-fit the MCP client into `ExternalSpawnPort`.
