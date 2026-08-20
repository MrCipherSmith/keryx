# Keryx MCP Client — PRD
Version: 0.2.0

## Problem

keryx's external-agent runtime (flow 176) can spawn `codex exec` read-only and
fold its output into the harness — real value, shipped. But `worktree-write`
is refused at runtime by design (D-04): the missing piece was never spawn
machinery, it was "a credible audit boundary for writes that keryx's
guarded-mutation path, evidence ledger and completion gate can accept."

Separately, keryx exposes its own tools over MCP (`src/mcp/server.ts`) so
*other* agents can use keryx — but nothing in keryx's own agent loop can
connect *out* to an MCP server. Six of the seven peer coding-agent harnesses
profiled in a prior comparative research pass (Cline, Codex, dsh, Gemini CLI,
Grok-Build, OpenCode) ship a working MCP client; keryx does not.

These two gaps turn out to be the same gap. `codex mcp-server` — confirmed via
independent public sources, not assumed — propagates its own internal
tool-approval requests back to its MCP client via the standard
`elicitation/create` request whenever `approval-policy` is `on-request` (the
default). Building an MCP client is the literal prerequisite for the write
path D-04 deferred.

## Goal

Give keryx's agent loop a working MCP client, scoped initially to one
concrete, provable use: connect to a `codex mcp-server` process keryx itself
spawns as an external-agent child, and correctly handle the
`elicitation/create` requests that process sends when it wants approval for a
risky action.

How that approval question gets answered inside keryx is resolved in
specification.md §9 / decisions.md D-05: elicitation responses route through
`resolveApprovalDecision`, the same function that already gates every
`spawn_subagent` dispatch — not a new decision layer.

## Users

- The keryx operator running `codex` as a delegated external agent locally,
  who today can only get read-only value from that delegation.
- Future consumers of a general MCP client capability inside the harness
  (not scoped or committed in this version, but the architecture must not
  foreclose them).

## Requirements

1. Keryx can start and connect to an MCP server over stdio as a client
   (the transport `codex mcp-server` uses).
2. Keryx correctly parses and responds to `elicitation/create` requests,
   including the request/response shape codex actually sends (verify against
   a real `codex mcp-server` process, not assumed from the spec alone — the
   existing `keryx-external-agent-runtime` package's own experience is that
   the reference implementation's behavior diverged from written
   documentation more than once).
3. A response is returned before codex's own timeout / the operator's
   configured `defaultTimeoutMs`, whichever is shorter; an unanswered or
   internally-erroring elicitation degrades to a named refusal event, never a
   hang (defends against openai/codex#11816).
4. Malformed or incomplete elicitation content (empty `content` object against
   a schema requiring fields — openai/codex#23383) is treated as a parse
   warning with a safe (denying) fallback, never as an implicit approval.
5. Version-skew tolerance: `codex_call_id` was absent from elicitation params
   in codex v0.105.0 (a fixed, cited upstream bug). keryx's registry already
   tracks a `knownGoodRange` per external agent (`registry.ts`); this
   package's implementation must either confirm the pinned `codex-cli` min
   version (`0.147.0`) postdates the fix, or add explicit degraded handling
   if it does not.
6. Tool-registry bridging: discovered/relevant MCP concepts map onto keryx's
   own tool contracts without inventing a second, parallel tool model — the
   specification must name the actual integration point in
   `src/harness/tool/` after verifying it against source, not assume the one
   named in an earlier informal research pass.
7. No new runtime dependency beyond what's already declared
   (`@modelcontextprotocol/sdk` is already a keryx dependency, used by
   `src/mcp/server.ts`) — reuse it, do not add a second MCP library.
8. No change to how codex or any vendor CLI authenticates. keryx never reads,
   stores, or proxies a vendor credential (D-01, unchanged).

## Success Criteria

- A real, live (not fixture-only) `codex mcp-server` process, spawned by
  keryx, can be asked to make a change requiring approval, and keryx's client
  correctly receives and responds to the resulting elicitation — end to end,
  against the actual codex binary, not a recorded transcript.
- The three known upstream rough edges (hang, malformed content, missing
  `codex_call_id`) each have a named, tested defense, not just documentation
  acknowledging they exist.
- `keryx-external-agent-runtime`'s own specification/decisions are revised
  (not silently reinterpreted) to reflect which approval-routing layer this
  package's elicitation responses actually go through, with the reasoning
  recorded the way D-01 through D-06 already are.

## Risks

- **Approval-routing ambiguity — RESOLVED.** keryx has multiple
  decision/approval-shaped modules; tracing every production call site of
  `checkApproval` and `resolveApprovalDecision` settled which one governs
  this case (`resolveApprovalDecision` — it already gates every
  `spawn_subagent` dispatch; `checkApproval`'s one caller is the unrelated
  extension-execution subsystem). See decisions.md D-05. What remains a
  residual risk, not an open question: the escalation classifier this
  decision depends on (mapping an elicitation's payload to
  `destructive`/`credentials`) is only as good as what codex's payload
  actually reveals about the intended action — a live probe (§5.1) will show
  whether that's enough signal to classify well, or too thin.
- **Upstream instability.** codex's elicitation behavior is real and
  documented by the community, but has open, unresolved bugs in the vendor's
  own tracker. keryx's codec-per-CLI precedent (D-06) exists exactly because
  vendor behavior diverges from documentation; expect the same here.
- **Scope creep toward a general MCP client.** The temptation to build "the"
  MCP client instead of "an MCP client that correctly handles codex
  elicitation" risks a large, unvalidated surface. Mitigated by Requirement 1
  above naming a single concrete, testable consumer.
- **Claude asymmetry.** Any design that implicitly assumes both external
  agents get the same write story is wrong today; Claude stays read-only
  until Anthropic's non-interactive permission-prompt-tool restriction
  changes, which is out of keryx's control.

## Recommendation

Proceed to implementation. Both design questions that would have made
`worktree-write` becoming reachable for codex merely *look* like a credible
audit boundary, rather than be one, are now resolved and traced to source
(specification.md §6, §9). The next real risk is empirical, not
architectural: whether a live probe against a real `codex mcp-server`
confirms the payload shapes and escalation signal this specification assumes
(§5.1) — verify before committing fixtures.
