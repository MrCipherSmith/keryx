# Keryx MCP Client — Brainstorm
Version: 0.2.0

Decision history and reference designs studied before writing prd.md /
specification.md. Kept because the reasoning that ruled things out is as
useful as the reasoning that kept things in.

## Origin

This package was scoped from a broader comparative research pass (8 agents,
17-dimension rubric) profiling keryx against 7 peer coding-agent harnesses.
That pass found: (a) keryx has no MCP-client capability at all — server-only —
while 6 of 7 peers do; and, on a later, corrected pass into
`keryx-external-agent-runtime`'s own `decisions.md`, that D-03's "kept idea
1" (forwarding an external agent's permission requests back into keryx's own
decision layer) is exactly the mechanism an MCP client would need to
implement for `codex mcp-server`. The two gaps turned out to be one gap.

## Reference designs studied

### deepseek-harness (`packages/mcp/mcp-client`)

A standalone plugin on `@modelcontextprotocol/sdk`'s `Client`. `connection.ts`
is a per-server connection supervisor that owns "generations" of the SDK
client, reconnects with bounded exponential backoff, and serializes every
tool-list sync through one queue so reconnect/notification races cannot
double-register or leak. `tools.ts` bridges discovered tools into the
harness's own generic tool registry, with collision-safe naming
(`mcp__<server>__<rawName>`) and content-block projection.

Relevance: the closest architectural sibling to keryx among the profiled
projects — a lean, hand-rolled TypeScript agent loop with its own tool
registry, not a VS Code extension or a framework-heavy service. The
generation-swap reconnect supervisor and two-phase tool sync are concurrency
hazards keryx's own registry would hit; worth studying even though this
package's v1 scope (one server, one purpose) does not need the full
multi-server generality deepseek-harness built.

### codex (`rmcp-client`, `codex-mcp`)

Two relevant, DIFFERENT mechanisms, easy to conflate:

1. `rmcp-client/src/elicitation_client_service.rs` — codex acting as an MCP
   **client** of *other* MCP servers, reviewing elicitation requests THOSE
   servers send IT. Not the mechanism this package needs.
2. `codex mcp-server` (the `codex-mcp` crate) — codex acting as an MCP
   **server**, whose own internal tool-approval decisions are exposed
   outward as `elicitation/create` requests to whatever connects as ITS
   client. **This is the mechanism.** Confirmed via independent public
   sources (not merely inferred from source reading), because attributing
   the wrong direction to the wrong crate is exactly the kind of mistake this
   research already made once this session and had to correct.

   Sources (web search, current as of this document's authorship):
   - "When approval-policy is on-request (the default for shell commands),
     the MCP server propagates approval requests back to the client using
     the MCP elicitation protocol." — community knowledge-base coverage of
     `codex mcp-server`.
   - Known rough edges, filed against `openai/codex`: elicitation can hang
     indefinitely if the connecting client never answers (#11816);
     auto-approve can send an empty `content` object even when the requested
     schema requires fields (#23383); a third-party integration report
     (slopus/happy#825) independently hit "3 bugs in MCP tool name,
     permission call_id, and elicitation response format," including codex
     v0.105.0 omitting `codex_call_id` from elicitation params — cited in
     specification.md §4 as a version-compat concern, since keryx's own
     registry already pins `codex-cli` to `knownGoodRange.min: "0.147.0"`.

### cline (MCP client, for context — not a candidate pattern here)

Full standalone OAuth-capable MCP client (`extensions/mcp/client.ts`,
`oauth.ts`) with a dual stdio-framing probe. Relevant as evidence that a
generic multi-server client is a real, buildable thing — not relevant as a
pattern for *this* package's narrow v1 scope, which has one server and no
OAuth (codex's own subscription auth is untouched, per D-01/D-07 boundaries
already established in the parent package).

### opencode (`catalog.ts`'s `convertTool()`)

Converts a raw MCP tool definition into a generic tool object
(schema + async `execute()` wrapping `client.callTool()`), so MCP tools
become indistinguishable from native tools to the rest of the agent loop.
Clean illustration of "how a discovered tool reaches the dispatch loop" in
the abstract — but this package's v1 has no discovered *tools* to bridge in
that sense; codex's elicitation is a side-channel approval request, not a
tool call the model itself makes. Kept as a reference for whichever later
version of this client does add real tool-bridging.

## Reference design: helyx (`/home/altsay/bots/helyx`, not locally available)

Already documented in `keryx-external-agent-runtime/brainstorm.md` from a
prior research pass; restated here with the specific angle this package
needed (human-in-the-loop approval over Telegram).

**Pattern 1 — inverted MCP channel.** A human/tmux supervisor starts Claude
Code interactively (not `-p`); helyx attaches as a stdio MCP server
(`helyx-channel`). Inbound work queues in Postgres, delivered via MCP
notification `notifications/claude/channel`; replies go back through MCP
tools (`reply`/`react`/`edit_message`). **Permission requests are forwarded
outward via a custom `notifications/claude/channel/permission_request`
notification, so a human approves from Telegram** — not a standard MCP
method, an ad-hoc extension built for this one integration.

Why it doesn't transfer directly: it works specifically because Claude Code
is NOT running under `-p`. keryx's push architecture (D-03 in the parent
package, reaffirmed here as D-02) commits to headless spawning, which is
exactly the mode where Claude's own permission-prompt-tool restriction bites
(see D-01). helyx sidesteps the restriction by not being headless at all, not
by finding a `-p`-compatible workaround. The lesson kept: a Telegram-relayed
human approval is a legitimate shape for *codex's* elicitation flow too
(codex has no `-p`-style non-interactive restriction on this path), but it is
an operator-surface decision, not an architectural requirement — recorded
here so a future TUI/Telegram integration doesn't need to rediscover it.

## Open question, elaborated — RESOLVED (see decisions.md D-05, specification.md §9)

Left here as the trace record; the question itself is answered in
decisions.md D-05. What was traced this session:

- `src/commands/permission-mode.ts` (`resolveApprovalDecision`): read in
  full. Session-level ask/trust/auto gate for `executeCall`. Its own header
  comment explicitly places the MCP dispatch path and the "formal
  harness/policy/harness/mutation evidence engine" out of its scope — a
  primary source, not an inference, for treating this as *not* obviously the
  right layer for an elicitation coming from a spawned child's own MCP
  server.
- `src/harness/mutation/approval.ts` (`checkApproval`): read in full.
  Schema-pinned, single-use, fail-closed on: no result, rejected, expired,
  invalidated, consumed, fingerprint-stale, past expiry, AND
  **non-interactive**. The last clause is the crux — this module's
  `interactive` field is a caller-supplied boolean, not computed internally,
  and this session did not trace every call site to learn what sets it, nor
  whether an external-agent dispatch (invoked from inside the interactive
  agent session via `spawn_subagent`, not via `keryx harness run/exec`)
  would honestly produce `true` there.
- `roadmap.md`'s own summary of `keryx-project-agent-harness` lists "guarded
  mutation + approval" as part of that package's shipped `src/harness/`
  runtime, and `structured-file-edit-tools`'s roadmap entry says
  `apply_patch`'s write path was added to `resolveApprovalDecision`
  specifically (ADR-0010) — which reads, on its face, as if (1) and (3) above
  might actually be more connected than permission-mode.ts's own header
  comment suggests, OR as if there are two genuinely separate "write
  approval" stories in this codebase for two different execution modes
  (interactive TUI session vs. `keryx harness run/exec`). Not resolved this
  session.
- `src/mcp/` (MCP dispatch path): named by permission-mode.ts's comment as
  having its own posture, not read in depth this session at all.

**How it was resolved.** Rather than reading `src/harness/run/` and
`src/harness/completion/gate.ts` (the speculative path this section
originally proposed), a cheaper and more direct move settled it:
`rg`-enumerating every production call site of `checkApproval` and
`resolveApprovalDecision` across `src/`. `checkApproval` resolved to exactly
one caller (`src/harness/extension/execute.ts` — extensions, unrelated).
`resolveApprovalDecision` resolved to exactly one caller
(`src/commands/agent.ts`'s `executeCall`) — which turned out to already be
where `spawn_subagent` itself is gated (`risk === "delegate"`,
agent.ts:2078–2095), making (b) from the original plan true and (c)
unnecessary: no new layer needed inventing. Reading `src/harness/run/` was
never required. Full reasoning in decisions.md D-05.

A second, unplanned finding came from reading `src/harness/external/
supervise.ts` to answer a *different* question (where the new MCP
supervisor would live) and turned out to bear on D-03: `superviseExternalRun`
is built around line-based text streaming, not MCP JSON-RPC, so D-03's "full
migration" is a second supervision path, not a codec swap. Surfaced to the
user as a revised cost estimate before proceeding; D-03 was reaffirmed with
the cost known (decisions.md D-03).
