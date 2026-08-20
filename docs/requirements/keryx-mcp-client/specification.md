# Keryx MCP Client — Specification
Version: 0.2.0

**Status: specification ready (future).** Both blocking questions (§6, §9)
are resolved below, traced to source. Nothing is implemented yet.

## 1. Identity

A new module, `src/mcp-client/` (name provisional — keryx already has
`src/mcp/` for the *server* side; a client-side sibling directory keeps the
existing `src/mcp/server.ts` naming pattern rather than overloading one
directory with both directions).

Built on the SDK already declared as a keryx dependency
(`@modelcontextprotocol/sdk`, used today by `src/mcp/server.ts`) — no second
MCP library, no new runtime dependency.

## 2. Scope of this version

One concrete connection: keryx, as the parent of an external-agent child
running `codex mcp-server` (stdio transport), acting as that process's MCP
client for exactly the elicitation exchange codex needs to ask for approval.
Not a general "connect to any configured MCP server" surface — see
`README.md` non-goals.

## 3. Transport, and why this is not a codec swap

stdio, matching `codex mcp-server`'s own transport (confirmed: `codex
mcp-server` starts a stdio-based JSON-RPC server speaking MCP). No HTTP/SSE
transport is in scope for this version.

**Confirmed by reading `src/harness/external/supervise.ts` in full:**
`superviseExternalRun` and its injected `ExternalSpawnPort`/`SpawnedProcess`
seam are built entirely around line-based text streaming —
`stdout`/`stderr` as `AsyncIterable<string>` yielding *complete lines*,
`writeStdin(text: string)` for steerable input. This is the shape a
transcript-parsing codec (`codex exec`, `claude -p`) needs; it is not the
shape an MCP JSON-RPC client needs (bidirectional structured messages, a
request that must be answered out of band while other messages keep
flowing). **Migrating `codex-cli` onto `mcp-server` (D-03) is therefore not a
drop-in replacement of `codex-cli`'s existing codec inside the existing
supervisor — it requires a second, MCP-shaped supervision path**, decided and
accepted with this cost known (see decisions.md D-03).

## 4. Two supervision paths, one vendor

Per D-03, `codex-cli` moves fully to `mcp-server`, so in steady state there is
only one active path for codex. But the specification records both, because
the migration itself and the shared infrastructure both matter:

- **Existing, unchanged:** `superviseExternalRun` + the line-stream
  `ExternalSpawnPort`, still exactly what `claude-cli` uses (unaffected by
  this package) and what `codex-cli` used before this migration.
- **New:** an MCP-shaped supervisor for `codex-cli`, spawning `codex
  mcp-server` (reusing the existing spawn/env hygiene —
  `buildExternalChildEnv`, the `KERYX_` env sweep, the disposable
  worktree — process isolation is not re-derived, only the transport above
  it changes), performing the MCP client handshake, and owning the
  elicitation exchange end to end:
  - Receive and correctly parse `elicitation/create` requests, including the
    request shape codex actually sends (verify live; do not trust the spec
    alone, per PRD Requirement 2).
  - Resolve a decision via `resolveApprovalDecision` + the existing
    `requestApproval`/`AgentIO` prompt path (see §9 — resolved).
  - Produce the `elicitation/create` **response**.
  - Defend the three named upstream rough edges (PRD Requirements 3–5):
    timeout degrading to a named refusal, malformed/empty content treated as
    a denying parse-warning, and a version-gated fallback for the missing
    `codex_call_id` case.

Both paths still terminate in the same `ExternalEvent` vocabulary
(`child_started`/`child_finished`/`child_failed`/etc.) so
`bridgeExternalEvent` and `reduceAgents` need no change — the elicitation
exchange itself does not produce `ExternalEvent`s at all (see §9); it is a
side channel the new supervisor owns before/around the transcript events it
does emit.

## 5. Data contracts

### 5.1 Inbound: `elicitation/create` (from codex, over MCP)

Shape confirmed present (community-documented, cross-referenced against the
MCP spec's own `elicitation/create` method) but the **exact payload fields
codex populates** must be captured from a live probe before being pinned as a
fixture — this package inherits `keryx-external-agent-runtime`'s own lesson
that written vendor documentation and actual CLI behavior have disagreed
before (three of its spec revisions were corrected by live findings).

### 5.2 Outbound: elicitation response

An MCP `ElicitResult`-shaped response (`action: accept | decline | cancel`,
optional `content`). The mapping from "keryx's own approval decision" to this
three-way action is itself part of what §9 must settle — a plain boolean
allow/deny does not obviously cover `cancel`.

### 5.3 Fixtures

Following D-06's own testing shape: recorded transcripts under
`fixtures/mcp-client/codex/`, covering at minimum: a clean approve round-trip,
a clean deny round-trip, a timeout with no response, an empty/malformed
`content` payload, and (if reproducible) the missing-`codex_call_id` case.

## 6. Tool-registry bridging — RESOLVED: not applicable

**Resolved.** Codex's elicitation is not a model-visible tool call. It never
reaches `ToolRegistry`/`tool-port.ts` (flow 007, W5/P-02 — read in full;
real, well-built, but scoped to tools the *model* can call, gated by
`validateToolCall`'s registration check) and never reaches the
`InteractiveTool`/`AgentDeps` executor list `executeCall` actually dispatches
from. It also does not flow through `bridgeExternalEvent` /
`ExternalEvent` / `reduceAgents` — that bridge is a FROZEN, one-way, pure
translation (the original package's AC5 explicitly forbids widening
`reduceAgents`'s switch or `AgentEvent.type`'s enum), and elicitation's live,
bidirectional, decision-blocking nature does not fit that pure/synchronous
shape regardless. Elicitation is handled entirely inside the new MCP
supervisor (§4) as a side channel parallel to, not integrated into, both the
model's tool-dispatch loop and the transcript-event fold. No registry
touches this version. AC8 is satisfied by this resolution.

## 7. Capability gate

Reuse `src/capability/`'s ceiling pattern, the way
`keryx-external-agent-runtime` did for its own first real descriptor
(`gdskills.external-agents`). This client has no reason to be independently
opt-in-able from the external-agent runtime it exists to serve — it should be
gated by (or folded into) that same capability rather than adding a second,
separately-toggleable switch an operator would need to understand.

## 8. CLI / operator surface

No new top-level command in this version. Elicitation handling is invisible
plumbing inside an already-dispatched `spawn_subagent` call with
`runtime.kind === "external"` and `runtime.agent === "codex-cli"`. Whatever
the TUI already renders for a running external child (per
`keryx-external-agent-runtime`'s operator surface) should surface a pending
elicitation the same way it surfaces the existing approval prompt for native
`write`-risk tools — a UI decision for the implementation phase, named here
so it isn't missed.

## 9. Approval routing — RESOLVED

**Resolved: `resolveApprovalDecision` (`src/commands/permission-mode.ts`),
reusing the existing `requestApproval`/`AgentIO` prompt path.** Not
`src/harness/mutation/`'s guarded-mutation subsystem; not a new fourth layer.

Traced to source, not inferred:

- `checkApproval` (`src/harness/mutation/approval.ts`) has exactly one
  production call site: `src/harness/extension/execute.ts`. That is the
  harness's pluggable-extension execution system — an unrelated subsystem,
  not tool dispatch, not child spawning, not `keryx harness run/exec`.
  D-04's "guarded-mutation path" phrase is the strongest *textual* match, but
  it names the wrong module: this one was built for, and is used
  exclusively by, extensions.
- `resolveApprovalDecision` has exactly one production call site:
  `src/commands/agent.ts`'s `executeCall`. That is also where `spawn_subagent`
  itself is already gated today (`risk === "delegate"`, agent.ts:2078–2095) —
  every external-agent dispatch, including the read-only ones already
  shipped, is already approved (or auto-approved under `trust`/`auto` mode)
  through this exact function before the child even starts.
- The natural, consistent extension: an elicitation's requested write is a
  second, later approval point for an already-approved delegate — the same
  shape ADR-0010 already used for `write` (apply_patch), where a per-action
  escalation classifier (`classifyPatchRisk`) feeds `resolveApprovalDecision`
  rather than a new decision function being invented. This package needs an
  analogous classifier deriving `destructive`/`credentials` from whatever
  detail codex's elicitation payload actually carries about the intended
  action (pinned once §5.1's live probe happens).
- The call site is new — not inside `executeCall`'s switch, since no tool
  call is being dispatched at that moment. It lives in the new MCP
  supervisor (§4): on receiving `elicitation/create`, call
  `resolveApprovalDecision`; if `"auto"`, respond `accept` immediately; if
  `"ask"`, call the same `requestApproval` the TUI already wires up for
  shell/write/delegate, and respond according to the operator's answer.
- Headless safety is inherited for free: `requestApproval === undefined`
  (no approver present) already fails every other gated risk closed today
  (`"...not approved by the user; not executed"`); the same default applies
  here without needing `src/harness/mutation/`'s `interactive` flag at all —
  which is why that flag's exact semantics, unresolved when this section was
  first drafted, turned out not to matter for this decision.

permission-mode.ts's own header comment excludes "the formal
`harness/policy`/`harness/mutation` evidence engine" from its scope — read in
context, that exclusion is about NOT weakening *that* engine's stricter
posture by routing its concerns through the session-level gate, not a
statement that `resolveApprovalDecision` itself is off-limits for a new,
distinct concern like this one. The MCP dispatch path in `src/mcp/`
(candidate 2 in the prior draft of this section) governs inbound calls to
keryx's own MCP *server* — unrelated to an outbound elicitation on a
connection keryx opened as a client — and was correctly not a contender once
traced.

## 10. Acceptance Criteria

- AC1: keryx spawns `codex mcp-server` and completes the MCP handshake.
- AC2: A live `codex mcp-server` run that requires approval produces an
  `elicitation/create` request keryx receives and correctly parses (captured
  as a fixture from the live run, not authored from documentation).
- AC3: keryx answers that elicitation and the corresponding codex tool call
  proceeds (approve case) or is cleanly refused (deny case) — verified
  against the live process, not only the fixture replay.
- AC4: An elicitation left unanswered past the configured timeout resolves to
  a named refusal event, not a hang, verified with a fixture reproducing
  openai/codex#11816's condition.
- AC5: A malformed/empty-content elicitation is handled per PRD Requirement 4
  (deny, not silent accept), verified with a fixture reproducing
  openai/codex#23383's condition.
- AC6: The new MCP supervisor calls `resolveApprovalDecision` for every
  received elicitation, with `"ask"` routed through the existing
  `requestApproval`/`AgentIO` prompt and `"auto"` answered without one —
  verified by a test asserting the call, not just that some response was
  sent.
- AC7: No credential of any kind is read, stored, or forwarded by this
  module (D-01 unchanged) — verified the same way
  `keryx-external-agent-runtime`'s own D-01 compliance is verified.
- AC8: The new MCP supervisor produces no `ExternalEvent` for the
  elicitation exchange itself (per §6's resolution) — `bridgeExternalEvent`
  and `reduceAgents` remain provably untouched, verified by the original
  package's own AC5 test suite continuing to pass unmodified.
- AC9: A per-action escalation classifier (the elicitation-payload analog of
  `classifyPatchRisk`) exists and is exercised by at least one fixture where
  it produces `destructive: true`/`credentials: true`, so `"trust"` mode's
  own escalation path (ADR-0010's shape) is provably reachable, not merely
  declared.
