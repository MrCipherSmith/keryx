# Keryx MCP Client — Decisions
Version: 0.2.0

Numbering is local to this package, independent of
`keryx-external-agent-runtime`'s own D-01…D-06.

## D-01: Codex first; Claude stays read-only, blocked upstream

**Decision.** This package targets `codex mcp-server`'s elicitation path only.
Claude is explicitly out of scope for write access in this version.

**Reasoning.** Sourced, not assumed: `claude -p` has an undocumented
`--permission-prompt-tool` flag that delegates permission prompts to an MCP
tool — the same shape of mechanism — but in non-interactive mode an "allow"
result for a flagged tool is converted to a forced "deny"
("MCP tool requires user interaction; not supported via
--permission-prompt-tool"). `keryx-external-agent-runtime`'s `claude-cli`
codec runs `claude -p` (or the streaming-input equivalent) — the exact mode
this restriction targets. This is not a keryx design gap; it is a vendor-side
restriction outside keryx's control. Revisit if/when Anthropic changes it.

## D-02: Keep push; do not adopt helyx's pull pattern

**Decision.** Reaffirm `keryx-external-agent-runtime` D-03's choice of push
(keryx spawns the CLI headless) over pull (a human starts the CLI
interactively; keryx attaches as a server the CLI pulls work from).

**Reasoning.** The reference implementation studied for that decision, helyx,
has a working pull-mode pattern (`channel/`, "Pattern 1") where permission
requests are forwarded to a human via Telegram through a custom
`notifications/claude/channel/permission_request` notification. It genuinely
works — but only because the CLI runs interactively (a human/tmux supervisor
started it), not under `-p`. Adopting that shape for keryx would mean
reopening D-03 itself (keryx would stop being the headless orchestrator),
which is a much larger decision than this package's scope. The elicitation
path this package builds is push-compatible: `codex mcp-server`, spawned
headless by keryx, sends elicitation requests **to** its client — no human
needs to be watching a terminal for the mechanism to fire, only for
`resolveApprovalDecision`/whichever layer §9 of the spec picks to actually
answer them (a separate concern, not this decision's).

## D-03: Migrate codex fully to `mcp-server`, not just for writes

**Decision.** Both read-only and write dispatches for `codex-cli` move to the
`codex mcp-server` transport. The existing `codex exec` + stdout-parsing codec
is retired for this vendor, not kept as a parallel path.

**Reasoning.** Running two transports for one vendor (exec for read-only,
mcp-server for write) doubles the maintenance surface D-06 already warns
about (codec behavior diverges from documentation per-vendor; now it would
diverge per-transport too, for the same vendor). A single transport is
simpler to reason about and test.

**Cost, confirmed after this decision was first made, and reaffirmed anyway.**
Reading `src/harness/external/supervise.ts` in full showed this is not a
codec swap: `superviseExternalRun`'s entire seam
(`ExternalSpawnPort`/`SpawnedProcess`) is built around line-based
stdout/stderr text streaming, the shape a transcript-parsing codec needs, not
an MCP JSON-RPC client. Migrating `codex-cli` genuinely requires a second,
MCP-shaped supervision path (specification.md §3–§4), not a parameter change
to the existing one. Presented explicitly as a revised cost estimate before
proceeding; the decision to migrate fully stands, cost accepted.

## D-04: General-shaped client, single named consumer

**Decision.** Architect the client generally enough that a second MCP server
could plug in later, but this version ships exactly one consumer (codex
elicitation) and no "add your own MCP server" surface.

**Reasoning.** The PRD's own risk section names scope creep toward a general
client as the likeliest way this goes wrong. A single concrete, testable
consumer keeps the acceptance criteria honest and falsifiable; genericity
without a second real user is speculative design, which
`docs/requirements/keryx-external-agent-runtime/decisions.md` D-06 already
argues against in a sibling context (data vs. code, decided by evidence from
a shipped instance, not by anticipation).

## D-05: Elicitation responses route through `resolveApprovalDecision`

**Decision.** An elicitation from `codex mcp-server` is decided by
`resolveApprovalDecision` (`src/commands/permission-mode.ts`), using the same
`requestApproval`/`AgentIO` prompt path the interactive session already uses
for `shell`/`destructive`/`delegate`/`write`. Not
`src/harness/mutation/`'s guarded-mutation subsystem. Not a new fourth
decision layer.

**Reasoning.** Traced to source:

- `checkApproval` (`src/harness/mutation/approval.ts`) has exactly one
  production caller, `src/harness/extension/execute.ts` — the harness's
  pluggable-extension execution system. Unrelated to child/tool dispatch.
  D-04 in the parent package's phrase "guarded-mutation path" is the closest
  textual match in the codebase, but names the wrong module once traced —
  it was built for, and used exclusively by, extensions.
- `resolveApprovalDecision` has exactly one production caller,
  `src/commands/agent.ts`'s `executeCall` — the same function that already
  gates every `spawn_subagent` dispatch today (`risk === "delegate"`,
  agent.ts:2078–2095), including every external-agent dispatch shipped so
  far. Extending the same function for an elicitation-time write escalation
  is the consistent choice: it mirrors exactly how `write` (`apply_patch`)
  already escalates through its own classifier (`classifyPatchRisk`) into
  this same decision function, per ADR-0010 — not a new pattern, the same one
  applied to a new risk source.
- The call site is new (the MCP supervisor, specification.md §4), since an
  elicitation arrives mid-run, not as a tool dispatch `executeCall` handles.
- Headless safety is inherited, not re-derived: `requestApproval ===
  undefined` already fails every other gated risk closed
  ("not approved by the user; not executed"); the same default covers this
  case. `src/harness/mutation/`'s `interactive`-flag fail-closed behavior,
  flagged as a risk when this decision was still open, turned out to be
  irrelevant once the right layer was identified.

**Rejected alternative, with reasoning.** `src/harness/mutation/`'s
schema-pinned, single-use approval shape (immutable request/result,
fingerprint binding, explicit expiry) is genuinely more rigorous than
`resolveApprovalDecision`'s synchronous ask/auto call. It was not chosen
because it is not built for this call site — adapting it would mean either
widening `src/harness/extension/execute.ts`'s subsystem to a use case it was
never scoped for, or duplicating its shape as a new, parallel mechanism
outside that subsystem, which is a larger, unjustified undertaking next to
reusing a decision function already proven for exactly this kind of
escalation.
