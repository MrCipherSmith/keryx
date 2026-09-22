# Context

Collected deterministically by `keryx flow init` at 2026-09-22T18:18:38.871Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.824] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.794] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
3. [1.758] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
4. [1.743] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
5. [1.743] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-09-21T08:21:59.610Z)
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

_(flow-init skill appends here)_

---

# T5 — The pinned ACP surface

Written by the T5/T6 dispatch, 2026-09-22. Source of truth for every shape
below: the published v1 JSON Schema,
`https://raw.githubusercontent.com/zed-industries/agent-client-protocol/main/schema/v1/schema.json`
(247 KB, fetched 2026-09-22), cross-read against the prose pages under
`https://agentclientprotocol.com/protocol/v1/`. The schema carries `x-method`
and `x-side` annotations, so the method table below is the spec's own spelling
and not a transcription from prose.

## 0. Version and transport

- **Pinned version: `protocolVersion: 1`** (one integer, `uint16`; bumped only
  for breaking changes, everything else arrives as a capability). ACP v2 exists
  but is explicitly a draft, and shipping clients speak v1.
- **Transport: JSON-RPC 2.0 over stdio, newline-delimited.** NOT LSP framing.
  The v1 transports page: "Messages are delimited by newlines (`\n`), and **MUST
  NOT** contain embedded newlines." The client launches the agent as a
  subprocess; the agent reads from `stdin` and writes to `stdout`; `stderr` is
  the only legal place for logging and the client may capture, forward or ignore
  it. Consequence for keryx: `keryx acp` must emit nothing but protocol frames
  on stdout — a stray `console.log` corrupts the stream.
- Constant: `ACP_PROTOCOL_VERSION` in `src/acp/protocol.ts`.

## 1. Methods keryx implements in this flow

| method | keryx surface it sits on |
|---|---|
| `initialize` | version negotiation + capability advertisement (T7) |
| `session/new` | `createSession()` — `src/session/store.ts:511` |
| `session/load` | `openSession()` / `loadContext()` — `src/session/store.ts:888`, replayed as `session/update` |
| `session/list` | `listSessions()` — `src/session/store.ts:558` |
| `session/prompt` | `runAgentTurn()` — `src/commands/agent.ts:1718` |
| `session/cancel` (notification) | `RunAgentTurnOptions.signal` — `src/commands/agent.ts:519` |

Client methods keryx may CALL: `session/update` (always), and
`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`,
`terminal/*` only when the client advertised the matching capability.

## 2. Methods keryx explicitly refuses, and with what

Every refusal is **`-32601 Method not found`** with a `data.reason`. `-32601` is
the spec's own answer for an unadvertised capability: a conformant client reads
`agentCapabilities` and never calls these. The `reason` is what separates "keryx
has not implemented it" from "your client ignored the capability" in a log.
Table lives in `ACP_REFUSED_AGENT_METHODS`, `src/acp/protocol.ts`.

| method | reason returned |
|---|---|
| `authenticate` | keryx advertises no `authMethods`; nothing to authenticate against |
| `logout` | `agentCapabilities.auth.logout` not advertised |
| `session/resume` | `sessionCapabilities.resume` not advertised; use `session/load` |
| `session/close` | `sessionCapabilities.close` not advertised; sessions are durable on disk |
| `session/delete` | `sessionCapabilities.delete` not advertised; retention is an operator decision |
| `session/set_mode` | `session/new` returns no `modes` |
| `session/set_config_option` | `session/new` returns no `configOptions` |

The six implemented plus these seven are all thirteen agent methods in the v1
schema. `src/acp/protocol.test.ts` asserts the partition is total and disjoint,
so a method added to ACP cannot end up silently unhandled.

## 3. Capabilities keryx advertises

`KERYX_AGENT_CAPABILITIES` (`src/acp/protocol.ts`), pinned by test:

```json
{
  "loadSession": true,
  "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
  "mcpCapabilities": { "http": false, "sse": false },
  "sessionCapabilities": { "list": {} },
  "auth": {}
}
```

with `authMethods: []`. Note the shape: ACP marks each session sub-capability by
**presence of an empty object**, not by a boolean — `{ "list": {} }` advertises
listing, an absent key declines it.

## 4. The mapping onto keryx, with citations

| ACP concept | keryx | file:line |
|---|---|---|
| session id (opaque string) | `SessionSummary.id` (`randomUUID`) | `src/session/store.ts:37` |
| `SessionInfo.cwd` | `SessionSummary.projectPath` | `src/session/store.ts:37` |
| `SessionInfo.title` / `updatedAt` | `SessionSummary.title` / `.updatedAt` | `src/session/store.ts:37` |
| `session/new` | `createSession({ cwd, ... })` | `src/session/store.ts:511` |
| `session/list` | `listSessions(cwd, dataDir?)`, newest-first | `src/session/store.ts:558` |
| `session/load` replay source | `openSession()` → `NormalizedMessage[]` | `src/session/store.ts:888` |
| history entry | `NormalizedMessage` (`role`, `content`, `toolCalls?`, `reasoning?`) | `src/harness/provider/types.ts:192` |
| `keryx sessions` CLI (same store) | `sessionsCommand` | `src/commands/sessions.ts:16`, routed `src/cli.ts:103` |
| policy decision | `PolicyOutcome = "allow" \| "ask" \| "deny"` | `src/harness/policy/types.ts:16` |
| the **ask path** | `AgentIO.requestApproval?: (tool, input, meta?) => Promise<ApprovalResponse>` | `src/commands/agent.ts:210` |
| default-deny when no asker | absent `requestApproval` ⇒ call not executed | `src/commands/agent.ts:2694` |
| assistant text stream | `AgentIO.write` / `onAssistantText` | `src/commands/agent.ts:142`, `:155` |
| reasoning stream | `onReasoningDelta` / `onReasoning` / `onReasoningEnd` | `src/commands/agent.ts:172`, `:161`, `:185` |
| tool call start | `onToolCall(name, input)` | `src/commands/agent.ts:189` |
| tool call result | `onToolResult(name, result)` (`result.isError`) | `src/commands/agent.ts:191` |
| token usage | `onUsage(NormalizedUsage)` → `usage_update` | `src/commands/agent.ts:187` |
| turn entry point | `runAgentTurn(io, deps, history, userLine, options)` | `src/commands/agent.ts:1718` |
| cancellation | `RunAgentTurnOptions.signal?: AbortSignal` | `src/commands/agent.ts:519` |
| MCP server config | `McpServerEntry` (stdio / http / sse) | `src/mcp-servers/config.ts:16` |
| MCP runtime, one per session | `createMcpRuntime(options)` | `src/mcp-servers/runtime.ts:137` |

## 5. Findings — where the spec and keryx disagree in shape

These are the reason T5 exists. Each one constrains a later dispatch.

**F-1 (AC1 vs the spec). Version negotiation is not a refusal.** AC1 reads "a
request naming an unsupported protocol version is refused with a JSON-RPC error
rather than a crash or a silent downgrade". The v1 initialization page says the
opposite for the common case: "If the Agent supports the requested version, it
MUST respond with the same version. Otherwise, the Agent **MUST respond with the
latest version it supports**", and the client then decides whether to proceed or
close the connection. A blanket JSON-RPC error would be non-conformant and would
leave every future v2 client with no way to fall back.
`negotiateProtocolVersion()` therefore returns three outcomes: `exact` (asked
for 1), `offer` (asked for >1 — answer 1; spec-conformant and not silent, the
number is in the response and the client decides), `refuse` (not an integer,
outside `uint16`, or below the floor — `-32602` with
`{ requested, supported, latest }`). **Decision needed from the operator: AC1 as
written cannot be satisfied for the `offer` case without breaking conformance.
Recommend `keryx flow ac update` to read "…is answered explicitly — the latest
supported version where the spec requires it, a JSON-RPC error where no
conformant version exists — never a crash and never a silent pretend-success."**
No AC file was edited by this dispatch.

**F-2. There is no `"denied"` permission outcome, and no boolean.** The prose
example is wrong; the schema has
`outcome: { outcome: "selected", optionId } | { outcome: "cancelled" }`, and a
denial is a *selected* option whose `kind` is `reject_once` or `reject_always`
(the four kinds are `allow_once`, `allow_always`, `reject_once`,
`reject_always`). keryx's ask path returns
`ApprovalResponse = boolean | { approved, fingerprint? }`
(`src/commands/agent.ts:138`). The mapping T9 must implement:
`allow_once → true`; `allow_always → { approved: true, fingerprint }` (keryx's
remember-this-fingerprint path, and the only ACP kind that has one);
`reject_once` / `reject_always` / `cancelled → false`. `cancelled` is not an
answer at all and must not execute the tool. `permissionGranted()` in
`src/acp/protocol.ts` encodes this.

**F-3. `session/request_permission` carries a whole `ToolCallUpdate`, and keryx
has no tool-call id.** The schema's `RequestPermissionRequest` is
`{ sessionId, toolCall: ToolCallUpdate, options }` — the client is shown the call
it is authorising. keryx's hooks are id-less: `onToolCall(name, input)` and
`onToolResult(name, result)` (`src/commands/agent.ts:189`, `:191`), and
`requestApproval(tool, input, meta?)` (`:210`) has no id either. So the adapter
must **mint** a `toolCallId`, emit the `tool_call` update *before* asking, and
correlate `onToolCall` → `requestApproval` → `onToolResult` itself. With only
`(name, input)` to key on, two identical concurrent calls are indistinguishable.
`ApprovalMeta.fingerprint` (`src/commands/agent.ts:76`) is the closest existing
key. T9/T11 must either thread an id through `AgentIO` or document the
correlation heuristic and its failure mode.

**F-4. The policy engine fails closed to `deny` when it thinks it is headless.**
`src/harness/policy/engine.ts:234` — `if (ctx.interactive === false)` turns an
`ask` into a `deny` with "the session is non-interactive; failing closed". An
ACP client **is** an operator. If `keryx acp` builds its policy context with
`interactive: false` (`src/harness/policy/types.ts:86`),
`session/request_permission` is never sent and AC3 fails silently in the *safe*
direction — the hardest kind of failure to notice. T9 must set
`interactive: true` **and** supply `AgentIO.requestApproval`; the two go
together. (Absent `requestApproval` is also default-deny —
`src/commands/agent.ts:2694` — so forgetting one of them never opens a hole,
only leaves the client unasked.)

**F-5. keryx has no "cancelled" turn outcome to report.** ACP requires
`session/prompt` interrupted by `session/cancel` to resolve with
`stopReason: "cancelled"` — a MUST, so the client can tell "you stopped me" from
"I broke". `RunAgentTurnResult.finishReason` is
`"budget" | "tool-call-budget" | "no-progress" | undefined`
(`src/commands/agent.ts:583`), and an aborted turn returns `{}`,
indistinguishable from a clean finish at the return value. T10 must track the
abort itself (it owns the `AbortController`) rather than reading it off the
result. Suggested mapping: `budget → max_tokens`,
`tool-call-budget → max_turn_requests`, `no-progress → end_turn`,
`undefined → end_turn`, adapter-observed abort → `cancelled`. Nothing in keryx
currently produces ACP's `refusal`.

**F-6. `session/new` binds to a project root, not to the `cwd` that was sent.**
ACP's `cwd` is required and `SessionInfo.cwd` is "always an absolute path".
keryx resolves it — `resolveProjectRoot(cwd)` (`src/session/paths.ts:52`) — and
stores `projectPath`. A client that opens a session with
`cwd: /repo/packages/web` will see `/repo` come back from `session/list`. That
is not a bug to hide: T13 must document it, and `session/load`'s "cwd must match
the original" check has to compare resolved roots, not raw strings.

**F-7. `session/list` cannot enumerate across projects.** ACP's `cwd` parameter
is an optional *filter*; omitting it means "all sessions". `listSessions(cwd,
dataDir?)` is project-isolated by construction (`src/session/store.ts:558`) and
there is no cross-project listing. Options for T10: require `cwd` and answer
`-32602` without it, or list the sessions of the ACP process's own project root.
The latter is recommended plus a documented note, since a `-32602` on an
optional parameter is its own conformance break. Pagination
(`cursor`/`nextCursor`) has no keryx equivalent either; a single page with no
`nextCursor` is conformant.

**F-8. Per-session MCP servers have no seam.** `session/new.mcpServers` is
required (may be `[]`) and means "connect these for this session".
`createMcpRuntime` (`src/mcp-servers/runtime.ts:137`) reads config from disk
layers, and `addServer` (`src/mcp-servers/store.ts:166`) always *writes a config
file*; there is no in-memory registration. keryx advertises
`mcpCapabilities: { http: false, sse: false }`, so a conformant client sends no
URL-based servers — but **stdio servers need no capability flag** and a client
may still send them. T8 must answer a non-empty `mcpServers` honestly; `-32602`
with a reason is acceptable, silently ignoring it is not, because the client
then believes tools are available that are not.

**F-9. Not every keryx history role has an ACP chunk.** `session/load` must
replay the conversation as `session/update` notifications *before* responding.
ACP's chunk variants are `user_message_chunk`, `agent_message_chunk`,
`agent_thought_chunk`, plus `tool_call` / `tool_call_update`.
`NormalizedMessage.role` is `"system" | "user" | "assistant" | "tool"`
(`src/harness/provider/types.ts:192`). `system` has no ACP home at all, and
`tool` must be rebuilt as a `tool_call`/`tool_call_update` pair with a
synthesised id (see F-3). T10 must decide explicitly what happens to `system`
messages — dropping them is defensible, dropping them silently is not.

**F-10. Schema bug, noted for completeness.** `$defs.AvailableCommand` lists
`description` in `required` but does not define it in `properties`. keryx does
not emit `available_commands_update`, so this costs nothing today.

## 6. Repository consequences already handled by T6

- `src/acp/` is registered in the zone table as **adapter**
  (`src/lib/import-zones.ts`), beside `commands`, `mcp` and `cli.ts`. Without
  it, `unclassifiedSegments()` fails the import-policy guard.
- `src/acp/` is added to the `test:core` filter list in `package.json`. CI runs
  `check:core` (`.github/workflows/ci.yml:66`) and the `test:client:*` matrix
  (`:133`), both **explicit directory lists**, and
  `src/core-package.test.ts:575` fails on any test file matched by neither. A
  new directory is invisible to CI until it is named.
- Still owed when `keryx acp` becomes a verb: a route in `CLI_ROUTES`
  (`src/cli.ts:66`), a `USAGE_BODY` line, and either a descriptor in the
  `src/standard` command registry or an explicit exclusion — the coverage test
  fails a new verb until one exists.

---

# T7/T8 — `keryx acp`, initialize, session/new, session/prompt

Written by the T7/T8 dispatch, 2026-09-22. What exists now, and what the
next dispatches (T9-T13) build on.

## 0. What was built

- `src/commands/acp.ts` — the CLI verb. `keryx acp [--provider <p>] [--model
  <m>] [--base-url <url>] [--data-dir <dir>]`, wired into `CLI_ROUTES`,
  `USAGE_BODY`, the `Commands:` list, and excluded from `src/standard`'s
  command-registry coverage test (same reasoning as `serve-mcp`: it owns
  stdout as the protocol wire, so it has no machine-consumable result a
  descriptor could describe). `keryx acp` is a long-running stdio server, not
  a one-shot command — its provider/model are fixed for the whole connection.
- `src/acp/server.ts` — `runAcpServer(options)`: the framer→dispatcher→handler
  loop for ONE connection (connection-scoped `initialized`/
  `clientCapabilities`, never module globals — a real ACP client launches a
  fresh subprocess per session, and so does every test connection here).
  Registers `initialize`, `session/new`, `session/prompt` only; every other
  method (`session/cancel`, `session/list`, `session/load`,
  `session/request_permission` answers, `fs/*`, `terminal/*`) is unregistered
  and falls through to the dispatcher's generic `-32601`, which is correct for
  now but means `ACP_IMPLEMENTED_AGENT_METHODS` (protocol.ts) currently
  advertises more than this dispatch actually answers — T9-T11 close that gap
  method by method, nothing here needs to change for them to land.
- `src/acp/session.ts` — `AcpSessionRegistry`, in-memory per-connection.
  `create(cwd, clientCapabilities)` calls `createSession({cwd:
  resolveProjectRoot(cwd), ...})` (F-6) and stores BOTH `requestedCwd` and
  `resolvedRoot` on `AcpSessionState`, plus the client's capabilities
  snapshotted at `session/new` time (unused by T7/T8; T9/T11 read it to decide
  whether to call `fs/*`/`terminal/*` or fall back to built-in tools, per AC6).
  `history: NormalizedMessage[]` is the SAME array reference across every
  `session/prompt` for that session, mirroring `commands/shell.ts`'s own
  history threading — `runAgentTurn` mutates it in place.
- `src/acp/agent-io.ts` — `createAcpAgentIo(sessionId, send)`: the one place
  `AgentIO` hooks become `session/update` notifications, streamed as the turn
  runs (not buffered to the end). `onToolCall`/`onToolResult` carry no id
  (F-3); this mints a `toolCallId` per call and resolves each result against
  the OLDEST open call of the SAME NAME (a per-name FIFO). Two concurrent
  identical calls are indistinguishable and resolve in start order — the
  limitation F-3 already named, not a new one. **`requestApproval` is NOT set
  here** — that is exactly what leaves `AgentIO`'s documented default-deny
  floor in charge of shell/destructive tools until T9 wires it.
- `src/acp/prompt-content.ts` — `renderAcpPromptContent(blocks)`: ACP's
  `prompt` content-block array → the single `userLine` string
  `runAgentTurn`/`AgentIO` take. Text and embedded text resources are
  inlined; image/audio/resource_link/binary resources become a bracketed
  placeholder (never silently dropped) — `promptCapabilities.image/audio:
  false` means a conformant client should not send the first two anyway.
- `src/acp/fixture-provider.ts` — `loadAcpFixtureProvider(path)`: a
  deterministic, offline `ProviderPort` for the real-process conformance
  test, selected only via `keryx acp --fixture <path>` (test-only, never a
  production path). Replays a JSON file's `turns[N]` on the (N+1)th
  `stream()` call — BY CALL ORDER, not `FakeProvider`'s exact-request-hash
  matching, which is impractical to hand-author against `runAgentTurn`'s real
  system instruction + tool list from outside the process. Mirrors
  `commands/agent.test.ts`'s in-process `scriptedProvider` helper.

## 1. Decisions later dispatches should know about

**Tool roster is `builtinReadOnlyTools` only, for now.** `session/prompt`
does not yet offer `shell_exec`, `apply_patch`, `workspace_propose`,
metaproject tools, MCP tools, or bus tools. Not an oversight: every one of
those needs either an approval seam that does not exist until T9
(`requestApproval`), or a port (`metaprojectPort`, `searchController`,
`jobRegistry`) this dispatch had no scoped reason to construct. Widening the
roster is T9+'s call, once the tools it adds can actually be approved rather
than silently default-denied.

**`AgentDeps.unattended` is deliberately never set.** This is how F-4's "an
ACP client counts as the operator" is satisfied at the `commands/agent.ts`
layer today: `commands/agent.ts` has NO reference anywhere to
`src/harness/policy/engine.ts`'s `PolicyContext`/`decide()` — that machinery
backs `keryx harness run/exec/wave` (`src/harness/run/run.ts`,
`src/harness/mutation/guard.ts`) and the SAC proposal-review `interactive`
checkpoint (`src/sac/proposal-lifecycle.ts`, `SLATE-8`), NEITHER of which
`session/prompt` calls into. The gate that actually governs a tool call
inside `runAgentTurn` is `AgentDeps.unattended` (intercepts `ask_user`,
degrades budget exhaustion to a silent `TerminalState`) plus `AgentIO`'s own
default-deny-when-absent `requestApproval`. Leaving `unattended` unset and
`requestApproval` unset (this dispatch) means every ask-shaped path is
currently either unreachable (no shell-risk tools offered) or safely refused
— never silently auto-approved. T9, when it adds `requestApproval` AND
widens the tool roster, must keep `unattended` unset too, or the two
undoes each other exactly as F-4 warned.

**`session/cancel`, `session/list`, `session/load`,
`session/request_permission`, `fs/*`, `terminal/*` are all still
unimplemented.** `ACP_IMPLEMENTED_AGENT_METHODS` (protocol.ts, T5) already
names `session/load`, `session/list`, `session/cancel` as agent methods this
flow answers — that constant is the PINNED TARGET SURFACE for the whole
flow, not a claim about what any one dispatch finished. A client calling one
of those today gets the dispatcher's generic `-32601 Method not found` (not
a crash, not silently dropped) naming `ACP_IMPLEMENTED_AGENT_METHODS`, which
is momentarily misleading until T9-T11 land — worth knowing when reading a
conformance run against an unfinished flow, not a bug to fix in isolation.

---

# T9 — the permission path

Written by the T9 dispatch, 2026-09-22. AC3: a gated tool call asks the
client, a denial leaves it unexecuted, an outright refusal never reaches the
client.

## 0. What was built

- `src/acp/permission.ts` — the option set keryx offers and the outcome
  mapping. Pure; no transport.
- `src/acp/client-requests.ts` — `AcpClientRequests`: the pending-request
  table for questions keryx asks the CLIENT. ACP-agnostic (it knows JSON-RPC
  ids, not permissions). Every request settles exactly once: answered,
  errored, or `closed`.
- `src/acp/agent-io.ts` — `createAcpAgentIo(sessionId, send, askPermission?)`
  now sets `AgentIO.requestApproval` when an asker is given. The FIFO that
  already correlated `onToolCall`→`onToolResult` is reused so the ask carries
  the id the client was already shown (F-3).
- `src/acp/server.ts` — sends `session/request_permission`, routes the
  incoming response into the pending table, widens the tool roster, and
  stopped awaiting each line before reading the next (see F-12, which is the
  finding of this dispatch).

## 1. The mapping, as implemented

| client answers | keryx `ApprovalResponse` | effect |
|---|---|---|
| `selected` `allow_once` | `true` | runs |
| `selected` `allow_always` | `{ approved: true, fingerprint }` | runs |
| `selected` `reject_once` / `reject_always` | `false` | denied |
| `cancelled` | `false` | denied |
| an `optionId` keryx never offered | `false` | denied |
| a malformed / non-object result | `false` | denied |
| a JSON-RPC error answer | `false` (and latches, F-11) | denied |
| no answer, connection closed | `false` | denied |

The mapping keys on the `kind` of an option **keryx sent**, never on the id's
text, so a client echoing an invented `"allow_everything"` is denied.

`allow_always` is the only kind that binds a fingerprint, because it is the
only one that means "this decision outlives the call" (`isApprovalFor`
rejects an answer that echoes a different action's fingerprint). keryx
persists **nothing** from it: the "always" lives in the client, which answers
the next identical request itself. A keryx-side allowlist entry minted from
this wire would recreate `memory/lessons/allowlist-not-a-boundary` for an
answer keryx never showed a human.

An **escalated** call — `ApprovalMeta.destructive`, `credentials`,
`publishLease`, or `untrustedOrigin` — is offered **no `allow_always` option
at all**. keryx's own rule for those is "always prompt, never remember"
(ADR-0009); an ACP client remembers an `allow_always` itself, which is the
saved allowlist that rule forbids, so the option is withheld rather than
offered and then ignored.

## 2. Which tools became reachable, and why that is safe

`session/prompt`'s roster was `builtinReadOnlyTools` only (T7/T8), because a
tool that needs approval with no approver wired is not safe, it is
**unreachable** — every call silently default-denied. With the approver wired
it is now:

    get_cwd, list_dir, read_file   (risk `read`, unchanged, never gated)
    shell_exec                     (risk `shell`)
    apply_patch                    (risk `write`, ADR-0010)

Both additions are gated by exactly one thing: `executeCall`'s approval
branch, which now calls the client. Neither can run without an explicit allow
for that specific call (the fingerprint is bound), both are constructed
against `state.resolvedRoot`, `apply_patch` confines every target path to
that root before git runs, and `shell_exec`'s destructive/credential
escalation reaches the client as a reduced option set. **Nothing else was
added**: `spawn_subagent`, the metaproject tools, MCP, bus and workspace tools
need ports this server does not construct, and `ask_user` needs an
interactive host seam that does not exist over this wire — offering any of
them would put back the unreachable-call state this widening removes.

`AgentDeps.unattended` remains unset, as T7/T8 required: it intercepts the
very questions this wire now carries.

## 3. How a denial ends the turn

It is not adapter behaviour at all, which is the point. A denial makes
`requestApproval` return `false`; `executeCall` returns
`{ output: "command not approved by the user; not executed", isError: true }`;
`runAgentTurn` reports it through `io.onToolResult` (→ a `tool_call_update`
with `status: "failed"` carrying that exact string), pushes it into history as
a `role: "tool"` message and carries on to the next round. The model sees the
refusal and answers; the turn ends `end_turn`. That is byte-for-byte the local
path — the process test asserts the exact string rather than a
denial-shaped one, so a future adapter-invented message would fail it.

## 4. New findings

**F-11. ACP v1 has no client capability for permissions, so "cannot be asked"
is DISCOVERED, not advertised.** `ClientCapabilities` is `fs`, `terminal`,
`session`, `auth`, `elicitation` — nothing about permissions; the spec simply
requires every client to implement `session/request_permission`. keryx
therefore asks by default, and learns otherwise from the first answer: a
JSON-RPC **error** answer (e.g. `-32601`) latches
`clientAnswersPermissions = false` for the connection, and every later gated
call is denied **locally, without a request going out** — asking again floods
a client that already said it has no such method. The call is denied, never
approved-by-default. A `cancelled` answer denies that one call and does NOT
latch (it is a live client choosing not to decide).

**F-12. The read loop deadlocked the moment the agent asked anything, and
T10 must not put that back.** `runAcpServer` used to `await
dispatcher.handleLine(line)` before reading the next line. That is fine while
every handler answers out of its own state, and it is fatal as soon as
`session/prompt` blocks on `session/request_permission`: the answer is the
NEXT LINE ON STDIN, which a loop parked inside the prompt handler will never
read. Lines are now STARTED in order and AWAITED separately. Ordering that
matters is preserved because `handleLine` runs synchronously into the handler
body, so handlers still start in wire order and `session/new` (synchronous end
to end) has finished registering before the next line is decoded. **T10's
`session/cancel` depends on this same change** — a cancel notification that
arrives during a running turn is exactly the same shape of problem.

**F-13. Input end is a settlement event, not cleanup.** When stdin ends,
`AcpClientRequests.close()` settles every open question as a denial and the
server then DRAINS the turns still running before returning, so the
`session/prompt` response and the denial updates still reach stdout (which is
still open). Without the drain the process would exit holding an unanswered
prompt; without the close it would wait forever on a pipe that cannot answer.

**F-14 (owed to T10). A `session/cancel` while a permission request is open
must settle that request.** Cancelling the turn does not currently cancel the
outstanding ask — the turn would abort while `AcpClientRequests` still holds a
promise the client may never answer (it settles at connection close, which
may be much later). T10 should call `close`/a per-request abort on the pending
ask as part of cancelling the turn, and note that keryx sends no
`$/cancel_request` for its own outstanding permission request; a client that
wants out answers `cancelled`, which is already mapped to a denial.

## 5. Tests

- `src/acp/permission.test.ts` — the mapping answer by answer, including
  `cancelled`, an unknown `optionId`, a malformed answer, the fingerprint
  binding and the escalated option set.
- `src/acp/client-requests.test.ts` — every request settles exactly once;
  close settles what is open; a request after close answers immediately.
- `src/acp/permission.process.test.ts` — the whole path over a real stdio
  pipe against the built CLI with the fixture provider: the `tool_call` update
  precedes the ask and carries the same id; `allow_once` / `allow_always` run
  the command; `reject_once` and `cancelled` do not; a client that never
  answers is denied without hanging; a client that errors is asked once and
  then denied locally; and a call the driver refuses on its own (unknown tool,
  or a `read`-risk tool) produces **no** `session/request_permission` at all.

The load-bearing test habit here, per F-4: assert the request was **sent**.
"The denied call did not run" passes just as well against a keryx that never
asked, which is the failure in the safe direction that is hardest to notice.
