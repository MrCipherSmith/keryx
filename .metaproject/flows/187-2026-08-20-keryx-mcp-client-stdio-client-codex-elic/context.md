# Context

Collected deterministically by `keryx flow init` at 2026-08-20T15:37:07.652Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-20T11:53:56.789Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Source package: `docs/requirements/keryx-mcp-client/` (README, prd, decisions,
brainstorm, specification — all v0.2.0, status "specification ready
(future)"). Both blocking design questions (§6 tool-registry bridging,
resolved not-applicable; §9 approval routing, resolved to
`resolveApprovalDecision`) are already settled — this flow implements a
ready spec, it does not re-derive the design.

Confirmed-present key source paths (verified on disk before freeze, not
assumed from the spec):

- `src/mcp/server.ts` — existing MCP *server* side; naming precedent for the
  new `src/mcp-client/` sibling module.
- `src/harness/external/supervise.ts` — `superviseExternalRun` +
  `ExternalSpawnPort`/`SpawnedProcess`; line-stream shaped, reused for spawn
  hygiene only (`buildExternalChildEnv`, `KERYX_` env sweep, disposable
  worktree), not for the MCP transport itself (D-03's accepted cost).
- `src/commands/permission-mode.ts` — `resolveApprovalDecision`, the
  approval-routing target per D-05/§9.
- `src/commands/agent.ts` — `executeCall`, the existing
  `resolveApprovalDecision` call site for `spawn_subagent` (risk ===
  "delegate"); the new elicitation call site is separate, inside the new MCP
  supervisor, not inside this switch.
- `src/capability/` — ceiling-pattern capability descriptors; this package
  folds into the existing `gdskills.external-agents` descriptor (§7), no new
  descriptor.
- `package.json` — `@modelcontextprotocol/sdk` `^1.0.0` already a declared
  dependency (also externalized in the `bun build` step), confirming
  Requirement 7 (no second MCP library).

Related package this flow revises (not silently reinterprets): pointer only,
do not touch its frozen ACs — `docs/requirements/keryx-external-agent-runtime/`
D-03 ("kept idea 1"), D-04 (read-only release gate this package's write path
now reaches beyond).

## T5 live probe findings (codex-cli 0.147.0, real process, not fixture-authored)

Full findings archived in `journal.md`. Load-bearing facts for T6-T10:

- **The SDK's `ElicitRequestSchema` strips codex's vendor fields** (`codex_call_id`,
  `codex_elicitation`, `codex_command`, `codex_cwd`, `codex_parsed_cmd`,
  `codex_mcp_tool_call_id`, `codex_event_id`) via Zod's default unknown-key
  stripping — `client.setRequestHandler(ElicitRequestSchema, ...)` alone never
  sees them. The new supervisor MUST read the raw JSON-RPC message off the
  wire (transport-level `send`/`onmessage` tap, or a loosened/custom Zod
  schema for this one method) to get `codex_call_id` at all — otherwise AC2
  cannot be satisfied even though the field is genuinely present on the wire.
- `codex_call_id` **is present** on 0.147.0 (flat in `params`, sibling of
  `message`/`requestedSchema`) — PRD Requirement 5 confirmed satisfied, no
  degraded-handling branch needed, but only once the wire-tap/schema fix
  above is in place.
- **`ElicitResult`'s standard shape is insufficient.** Codex's own
  `ExecApprovalResponse` deserializer requires a non-standard **top-level**
  `decision` field on the response envelope (`{action, decision}`, NOT
  `{action, content: {decision}}` despite `ElicitResultSchema.content`'s own
  shape) whose value must be one of that specific request's
  `available_decisions` — an array that is **not a fixed enum**; it comes
  from a sibling `codex/event` notification (`method: "codex/event"`,
  `params.msg.type === "exec_approval_request"`, correlated by `call_id`)
  sent just before the elicitation. `"denied"` is not always a valid value;
  `"approved"` and `"abort"` were confirmed valid for the exec-approval case
  probed. The supervisor must correlate `codex/event` notifications with
  pending elicitations by `call_id`/`event_id`, not just answer the
  elicitation in isolation.
- **Malformed/empty `content` (AC5) is not an anomaly — `requestedSchema` is
  ALWAYS `{"type":"object","properties":{}}`** on every elicitation observed;
  there is no schema-based signal for "correct" content. Correctness comes
  entirely from the sibling `codex/event`'s `available_decisions`. AC5's
  "malformed/empty content" defense should be interpreted as: when the
  sibling `codex/event`/`available_decisions` cannot be resolved for a given
  elicitation, deny safely rather than guess a `decision` value — this *is*
  the live manifestation of openai/codex#23383's condition, not a
  synthetic-only fixture.
- **Timeout (AC4):** codex self-aborts an unanswered elicitation after
  ~55-60s (`codex/event` `turn_aborted`, `reason: "interrupted"`) — keryx
  does not need to be the one enforcing this ceiling for codex's sake, but
  its own `defaultTimeoutMs` should still be shorter if it wants to own the
  refusal event's shape rather than react to codex's unprompted abort.
  Separately, **the outer `tools/call`'s own promise may never resolve even
  after a clean elicitation decline** (confirmed: SDK's own 60s client
  request timeout fired, `McpError -32001`) — the code that awaits
  `client.callTool(...)` needs independent timeout/cancellation handling
  regardless of how the elicitation itself was answered.
- Tool-call argument keys (`sandbox`, `approval-policy`, dash-cased) differ
  from the TOML spawn-config keys (`sandbox_mode`, `approval_policy`,
  underscore-cased) — both real, not interchangeable typos; T6/T8 must use
  the correct one in each context.
- Gap for T13: only the `exec-approval` elicitation variant (`codex_elicitation:
  "exec-approval"`) has confirmed vendor fields via the wire tap; a
  `patch-approval` variant (`codex_elicitation: "patch-approval"`) was also
  observed but only through the SDK-stripped view — its vendor field set is
  unconfirmed and should get its own live check before being pinned as a
  fixture.

## Local test-run noise (verified pre-existing, not this flow's concern)

A full local `bun test` on this macOS checkout shows ~46 failures beyond
CI's baseline (CI on PR #360, Linux, showed exactly 1 unrelated flaky
failure). Verified by stashing every T6-T8 change and re-running the same
files against clean `main`: the identical failures reproduce with zero
mcp-client code present. Two unrelated causes: (1) a macOS tmpdir symlink
quirk (`/var/...` vs realpath `/private/var/...`) affecting
`serve-server.test.ts`/`project-registry.test.ts`; (2) a `serve-turns`/
`serve-listener` route cluster returning 404 uniformly, likely a local
launcher/containment binary unavailable on this machine — also 28/28
reproduces on clean `main`. Neither touches `src/mcp-client/` or
`src/harness/external/supervise-mcp.ts`. Treat CI, not local `bun test`, as
this flow's authoritative test signal; do not re-diagnose this cluster in a
later task.

Memory constraint that applies to this flow's own verification phase: the
`keryx` binary on PATH (`~/.keryx/keryx`) is a separately-built install, not
this checkout — `keryx health run`/`keryx flow` bookkeeping commands use that
stale binary safely (they don't execute this repo's `src/`), but actual code
verification for T6-T14 must go through this checkout's own `bun test`/
`bun run`, never through the installed `keryx` CLI's behavior as a proxy for
"does the new code work."
