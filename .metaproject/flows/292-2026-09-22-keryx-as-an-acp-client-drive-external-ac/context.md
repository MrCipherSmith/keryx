# Context

Collected deterministically by `keryx flow init` at 2026-09-22T23:36:27.183Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.966] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.844] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
3. [1.802] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
4. [1.781] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
5. [1.764] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

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

Phase 1 research, 2026-09-23. Worktree `/home/altsay/keryx-acpc`, branch
`feat/acp-client`. Nothing below is implemented; it is evidence plus a proposal.
All paths are relative to the worktree root.

### 0. Summary

- The ACP client is **not a new codec**. The codec port is pure and one-way
  (argv in, stdout lines out). ACP needs requests in both directions, and the
  agent blocks until keryx answers. The fitting seam is the one flow 182 already
  used for `codex mcp-server`: a **third supervision path** next to
  `superviseExternalRun` and `superviseCodexMcpRun`. It reuses the existing
  **spawn port** (which already gives stdout lines plus a stdin writer), the
  registry, the capability gate, the disposable worktree, the env strip, the
  depth marker and the `ExternalEvent` vocabulary.
- About 70% of the ACP wire layer is reusable as it stands (`protocol.ts` types
  and method partitions, `jsonrpc.ts`, `framing.ts`, `client-requests.ts`).
  `dispatch.ts` can be reused if one agent-specific branch is parameterised.
  What is new: handlers for the methods the **agent** calls on the client, and a
  `session/update` → `ExternalEvent` fold.
- Policy: `session/request_permission` maps onto `resolveApprovalDecision` in
  the same way `superviseCodexMcpRun` already maps codex elicitations, with the
  same default deny and its own timeout. `fs/*` can be served only through
  keryx's own confined code. `terminal/*` should **not be advertised** in this
  flow.
- **Honest limit:** capability advertisement is a request to the agent, not a
  boundary. The agent's own internal tools never touch ACP. The load-bearing
  containment is the disposable worktree (D-08), exactly as it is for
  claude-cli and codex-cli today.
- Correction to the brief: the v1 schema keryx pinned **does** carry an
  optional cost, `usage_update.cost {amount, currency}` (`src/acp/protocol.ts:887-930`).
  An agent may omit it, so a missing cost must be recorded as missing, never
  as zero.

### 1. What keryx already has for driving foreign agents

**Types and port** — `src/harness/external/types.ts`
- `ExternalSandbox = "read-only" | "worktree-write"` (:19).
- `ExternalAgentEntry` is metadata only: binary, detect argv, version range,
  `sandboxModes`, `streamingInput`, `resumable`, `reportsCost`, `budgetFlag`
  (:26-52).
- `ExternalEvent` is the canonical event set: `child_started`, `tool_call`,
  `tool_result`, `assistant_text`, `thinking`, `user_message`, `retry`,
  `usage{inputTokens,outputTokens,costUnits}`, `child_finished`,
  `child_failed` (:91-106).
- `ExternalAgentCodec` (:138-190) is **three pure functions**: `buildArgv`,
  `parseLine`/`parseEvents`, `classifyFailure`, plus resume and streaming argv.
  It is one-way: nothing in the port can *answer* the child.
  → An ACP agent cannot be expressed as a codec.

**Registry** — `src/harness/external/registry.ts:27-64`
- Two entries: `codex-cli` and `claude-cli`. Both declare
  `sandboxModes: ["read-only","worktree-write"]` as a statement of what the
  **CLI** can do. The keryx release gate is a separate check (:19-25).
- `resolveAvailability` gives a three-state availability, with `not-probed`
  as a first-class state (:147-174).
- The read-only surface is `keryx agents external list|probe`
  (`src/commands/agents-external.ts:4-5`).

**Release gate: "read-only in this release"** — `src/harness/external/dispatch.ts`
- Stated at :12-14. `IMPLEMENTED_SANDBOX_MODES = ["read-only"]` (:68).
- The refusal carries code `not-implemented`, which keeps it distinct from
  `agent-cannot` (:117-131).
- `READ_ONLY_FORBIDDEN_ACTIONS = ["write","network","spawn-subagent"]` (:46).
  `run-command` is deliberately absent, because the CLI runs commands inside its
  own sandbox (:36-45).
- Decision text: `docs/requirements/keryx-external-agent-runtime/decisions.md`
  D-04 (:123). The prerequisite for writes is "a credible audit boundary for
  writes", not more spawn machinery.

**Launch path** — `src/harness/external/runtime.ts:320-519` (`runExternalChild`)
- Fixed fail-closed order:
  1. capability (:324)
  2. nesting depth (:329, `canNestExternalChild`)
  3. `validateRuntimeBlock` (:332)
  4. codec (:342)
  5. detect/version, advisory only (:347-360)
  6. result schema (:367)
  7. `buildExternalPrompt` (:378)
  8. `worktree.create` (:397)
  9. `superviseExternalRun` (:444)
  10. `classifyFailure` (:479)
  11. result-schema validation (:487-505)
  12. `worktree.remove` in a `finally` (:510)
- Cost: `ExternalChildOutcome.costUnits` is "absent means missing, never zero"
  (:95-96). It is folded from `usage` events (:530).
- Env: `buildExternalChildEnv` works by copy-then-strip. It removes
  vendor-redirect variables (`src/harness/external/env.ts:32-45`), sweeps
  `KERYX_*` and `CLAUDE_CODE_*` (:51), then adds `KERYX_EXTERNAL_DEPTH` (:57).

**Process seam — directly reusable for ACP**
- `ExternalSpawnPort`/`SpawnedProcess` in `src/harness/external/supervise.ts:72-100`.
- stdout and stderr arrive as **complete lines**. There is
  `writeStdin(text)`, `kill()` and `exited`.
- ACP is newline-delimited JSON (`src/acp/framing.ts:6-17`), so this seam
  carries ACP without change.
- The real implementation is `createBunSpawnPort`
  (`src/harness/external/bun-spawn-port.ts:83-95`): stdin `pipe`, never
  `inherit`.

**Dispatch path into the agent loop** — `src/harness/run-external-factory.ts`
- `spawn_subagent` has exactly one external seam,
  `SpawnSubagentToolDeps.runExternal` (:4-8). `createRunExternal` (:330) builds
  it from the capability gate, the user config, the spawn port and the git
  worktree port.
- It returns `undefined` when the capability is off (:12-17).
- `DEFAULT_MAX_EXTERNAL_DEPTH = 1` (:68).
- Allowed actions by mode: `read_only: ["read-file"]`,
  `general: ["read-file","run-command"]` (:82-85).
- Hosts: `src/commands/shell.ts` (~:3510) and `src/tui/external-bridge.ts`.

**Capability gate** — `src/capability/external-agents.ts:13-24`
- The gate has three ordered layers:
  1. a **hard disable on remote transport and CI**, checked first;
  2. the user-global `externalAgents.enabled` (default false);
  3. the project manifest `gdskills.external-agents`.
- Consequence for tests: CI can never exercise the CLI end to end. Process
  tests must inject the capability, as `supervise-mcp.test.ts` and
  `run-external-factory.test.ts` already do. The CI refusal is itself a
  testable property.

**The precedent that fits: the MCP-shaped supervisor** — `src/harness/external/supervise-mcp.ts`
- The header (:5-13) explains why a bidirectional protocol needed "a genuinely
  separate function rather than a parameter to the existing one".
- `superviseCodexMcpRun` (:215):
  - answers each elicitation through `resolveApprovalDecision` unconditionally,
    with `risk: "write"` (:263-273);
  - on `auto`, approves and reports `onAutoApproved` (:281-286);
  - with **no approver, denies at once** (:287-290);
  - with an approver, races `DEFAULT_ELICITATION_TIMEOUT_MS = 45_000`
    (:91, :303-330);
  - records every decision as an `ElicitationHandledRecord`, never as an
    `ExternalEvent` (:94-114).
- The gated entry `gatedSuperviseCodexMcpRun` (:458) reuses the same
  capability plus the per-agent config.
- It is **not wired** into `dispatch.ts` or `runExternalChild` (:15-21, :450-456).
  The ACP client should avoid repeating that gap for its own entry point.

**Answer to Q1.** The ACP client should be a **new external agent transport**,
not a codec:
- `ExternalAgentEntry` gains a transport discriminator:
  `"line-stream" | "mcp" | "acp"`.
- A new `superviseAcpRun` sits beside the other two supervisors.
- `runExternalChild` picks the supervisor by transport.
- Everything before and after supervision is kept unchanged: gate, depth,
  validate, detect, prompt, worktree, cleanup, the outcome vocabulary and
  `bridgeExternalEvents` (`src/harness/external/agent-event-bridge.ts:77,130`).

The named seam is: **`ExternalSpawnPort` (reused) → `superviseAcpRun`
(new) → `ExternalEvent[]` + decision records → `ExternalChildOutcome`
(reused)**.

### 2. ACP code: reusable vs new

**Reusable as is**
- `src/acp/protocol.ts`: every wire type. The method partitions are already
  split by direction:
  - `ACP_AGENT_METHODS` (:64-78): what keryx-as-client will *call*.
  - `ACP_CLIENT_METHODS` (:81-93): what keryx-as-client must *answer*.
- The remaining shapes the client needs:
  - client and agent capabilities (:381-451), tool calls (:755-811),
    request permission (:817-874), `session/update` (:880-936),
    fs and terminal (:942-998);
  - `permissionGranted()` (:864) already encodes "explicit allow only". It is
    the helper the *agent* side uses, but its truth table is the one the client
    side must *emit*.
- `src/acp/jsonrpc.ts` is protocol-agnostic by design (:1-10).
- `src/acp/framing.ts`: `encodeAcpMessage` (:67) and `decodeAcpLine`. The spawn
  port already yields lines, so `AcpLineFramer` is not needed on the client
  side.
- `src/acp/client-requests.ts`: the pending-request table (:43-147) with the
  settle-exactly-once and `close()` contract. keryx-as-client uses it for
  `initialize`, `session/new` and `session/prompt`. One small change: the id
  prefix is hard-coded as `acp-agent-` (:74) and should become a constructor
  option.
- `src/acp/session-mcp.ts` `scrub()` (:224) can remove known secrets from the
  agent's text and stderr before they are recorded.

**Reusable with a small generalisation**
- `src/acp/dispatch.ts`: routing is generic (:125-191). `unknownMethodError`
  (:201-209) is agent-specific: it reports `ACP_IMPLEMENTED_AGENT_METHODS` and
  `refusalError`. The client side needs its own implemented list and refusal
  table, for example "fs/write_text_file not advertised in a read-only run".
  Make it an option instead of copying the class.

**Not reusable (inverse direction)**
- `src/acp/permission.ts` maps a client's answer onto keryx's `ApprovalResponse`
  (:15-26), and `src/acp/agent-io.ts` builds keryx's own asks. The client side
  is the mirror image: it *receives* the ask and *chooses* an `optionId`.
- `src/acp/capability-tools.ts:5-43`: keryx-as-agent never calls
  `fs/write_text_file` or `terminal/*`. That is a decision about the agent
  side and has no client code to reuse.

**New code** (proposed location `src/harness/external/acp/`)
1. **Client handshake driver:**
   - `initialize` with `protocolVersion: 1` and an explicit
     `clientCapabilities`;
   - check the agent's returned version and refuse with a named reason if it is
     unsupported;
   - `session/new {cwd: <worktree>, mcpServers: [keryx]}`, then
     `session/prompt`, then `session/cancel` on timeout or abort.
2. **Handlers for agent→client requests:**
   - `session/request_permission`: the policy bridge (§3).
   - `fs/read_text_file` and `fs/write_text_file`: confined (§3).
   - `terminal/*`: refused while not advertised (§3).
   - `elicitation/create`: refused, because the client does not advertise
     `elicitation`.
3. **`session/update` fold** into `ExternalEvent`:

   | ACP `session/update` | `ExternalEvent` |
   |---|---|
   | `agent_message_chunk` | `assistant_text` |
   | `agent_thought_chunk` | `thinking` |
   | `tool_call` | `tool_call{name: title/kind, detail}` |
   | `tool_call_update` with status completed or failed | `tool_result` |
   | `usage_update` | `usage` |
   | `plan`, `available_commands_update`, `current_mode_update`, `config_option_update` | record-only |

4. **`stopReason` → terminal event**:
   - `end_turn` → `child_finished`;
   - `refusal`, `max_tokens`, `max_turn_requests` → `child_failed` with that
     name;
   - `cancelled` → the runtime's `Timeout` or `Denied`, whichever caused it.
5. **Registry entries.** For example `gemini-acp`
   (`gemini --experimental-acp`) and a test-only fixture entry. The Claude Code
   ACP adapter is a later entry.

### 3. Policy — the crux

**Engines available**
- `resolveApprovalDecision` (`src/commands/permission-mode.ts:119-144`):
  - modes `ask|trust|auto` (:18);
  - risks `read|shell|destructive|delegate|write` (:38);
  - hard floors: `credentials`, `sacReviewConfirmation` and `publishLease`
    force `ask` in every mode, and `readOnly` → `deny` (:122-132).
- `src/harness/policy/engine.ts` `decide()` (:4-23) is the profile-based
  allow/ask/deny engine. It includes **headless fail-closed: ask → deny when
  non-interactive** (:18-19) and a guard for managed flow files (:92-96).
- The supervise-mcp precedent calls `resolveApprovalDecision`. The ACP bridge
  should do the same, so all three external paths share one decision function.
  It should also borrow `decide`'s rules for headless runs and flow files.

**Mapping `session/request_permission` → keryx gate**

The request carries a full `ToolCallUpdate`: `kind`, `title`, `rawInput` and
`locations` (`src/acp/protocol.ts:787-843`). The tool kinds are listed at
:757-767.

| ACP `toolCall.kind` | keryx risk | escalation inputs |
|---|---|---|
| `read`, `search`, `think` | `read` → auto, **but** any `locations[].path` outside the worktree ⇒ treat as `write`-level ask | `confineToRoot` per location |
| `edit`, `move` | `write` | `touchesAgentCredentials(paths)`, flow-file guard |
| `delete` | `destructive` | same |
| `execute` | `shell`; `destructive` if `isDestructiveCommand(rawInput.command)` (`src/lib/command-risk.ts:246`) | `touchesAgentCredentials`, `touchesSacConfirmReview` (:338, :365) |
| `fetch` | network → **deny** (keryx hard-denies network risk today; `permission-mode.ts:29-35`) | — |
| `switch_mode`, `other`, missing | `shell` + `destructive` (never auto) | — |

**Choosing the answer**
- `auto`, or a human approval checked with `isApprovalFor`:
  - select the agent's `allow_once` option;
  - **never `allow_always`**. A remembered grant inside the foreign agent is a
    grant keryx can no longer see or record.
  - If the agent offered only `allow_always`, treat the result as `ask`.
    Unattended, that becomes a deny.
- `deny`, unattended `ask`, approver timeout (reuse the 45 s default), or a
  closed pipe:
  - select `reject_once`;
  - if the agent offered no reject option, answer `{outcome:"cancelled"}`.
    The spec reads `cancelled` as "do not run" (`protocol.ts:845-853`).
- Record every decision in the style of `ElicitationHandledRecord`: request,
  mapped risk, gate decision, verdict, `timedOut`, chosen `optionId`.

**Human present vs absent**
- Present: reuse `AgentIO.requestApproval`. This is the same approver shape
  `supervise-mcp` takes (`src/harness/external/supervise-mcp.ts:157`), so the
  TUI and shell approvers plug in unchanged.
- Absent: `--unattended`, no TTY, or CI means default deny.

**`fs/*` requests the agent makes**
- **Read:** `confineToRoot(worktree, path)`
  (`src/harness/tool/builtin/interactive-tools.ts:135-148`), then the bounded
  read. It honours `line` and `limit`.
- **Write:** only when advertised (see the contentious choices below). The
  steps are:
  1. confine the path;
  2. refuse credential files and managed flow files;
  3. gate the write through the same bridge as risk `write`;
  4. write inside the **disposable worktree only**.
- **Gap found:** `confineToRoot` checks a *non-existent* target lexically
  (:132-133). A new file under a symlinked directory that points outside the
  root therefore passes. A write path must realpath the **nearest existing
  ancestor**. This needs a dedicated test.

**`terminal/*`**
- keryx has containment it could use:
  - `shell-spawn.ts` with bwrap/seatbelt (`src/harness/process/shell-spawn.ts:31-47,181`);
  - the hardened unattended profile `planUnattendedSandbox`
    (`src/harness/process/sandbox/unattended.ts:1-34,152`), which is
    Linux-only and refuses on macOS.
- Building five terminal methods on top of it is a flow of its own.
- Recommendation: advertise `terminal: false`, and answer `-32601` with a
  named reason if the agent calls anyway.

**Refusing to advertise.** Yes. `clientCapabilities` is fully under keryx's
control (`src/acp/protocol.ts:403-410`). A read-only run should advertise
`fs.readTextFile: true`, `fs.writeTextFile: false`, `terminal: false`, and no
`elicitation`.

**What keryx CANNOT control (must be stated in the criteria and docs)**
1. **Internal tools.** The agent's own tools never reach ACP: its built-in
   shell, file edits, web fetch and sub-agents. Gemini CLI and the Claude Code
   adapter both have them. Not advertising `terminal` or `fs.write` does not
   stop them; the agent simply uses its own.
2. **Voluntary permission asks.** `session/request_permission` is sent only
   when the agent chooses to ask. keryx judges the call as the agent describes
   it: `kind`, `rawInput` and `locations` are self-reported, and a
   mis-described call is mis-classified.
3. **MCP calls.** Calls the agent makes to the MCP servers keryx hands it,
   including keryx's own `serve-mcp`, go straight to that server. They do not
   pass through the permission bridge.
4. **The agent process itself.** It is not OS-sandboxed in this slice: it
   needs network to reach its model and its own credential directory under
   `$HOME`, and the unattended profile hides `$HOME`. Wrapping the whole
   process in bwrap is possible later, using the allowlist proxy
   (`src/harness/process/sandbox/proxy.ts`) and a read-only bind of the
   agent's own configuration.
5. **The load-bearing guarantee.** The agent runs with `cwd` = a disposable
   `git worktree add --detach` checkout that is removed on every path
   (`runtime.ts:397,510`). This is D-08 (decisions.md :227): "A disposable
   worktree survives a hole in the list". The same argument applies to ACP.

### 4. Context — "with keryx's context"

- **MCP (primary).** Pass keryx's own MCP server in `session/new.mcpServers`
  as a stdio entry `{name:"keryx", command, args:["serve-mcp","--cwd",<root>], env:[]}`.
  - Stdio needs no capability flag. Only http/sse depend on the agent's
    `mcpCapabilities` (`src/acp/protocol.ts:419-423`; the note at :474-479
    already records this for the agent side).
  - Launch the **running build**: `process.execPath` plus the CLI entry, not
    `keryx` from PATH. The memory constraint "The keryx on PATH is a stale
    build" applies.
  - `serve-mcp` requires `modules.mcp.enabled` and the optional SDK
    (`src/commands/serve-mcp.ts:28-31,56`). When those are unavailable the run
    continues and records "context: not offered (<reason>)".
  - `src/mcp/tools.ts` is read-only unless an entry says `mutating: true`
    (:8). There are 7 mutating tools (:267, :298, :362, :399, :425, :522, :664).
    Because the agent's MCP calls bypass the permission bridge (limit 3),
    recommend a new `serve-mcp --read-only` filter that drops every
    `mutating: true` tool.
- **Initial prompt.** Reuse `buildExternalPrompt`
  (`src/harness/external/prompt.ts:258`): directive, task, acceptance criteria,
  working diff and result schema. It already refuses rather than truncate the
  task.
- **Embedded resources.** Attach `AGENTS.md` / `.metaproject/index.md` as
  `resource` blocks only if the agent's `initialize` returned
  `promptCapabilities.embeddedContext: true`
  (`src/acp/protocol.ts:412-417`). Otherwise inline them as text.
- **Negotiation.** keryx reads `agentCapabilities.mcpCapabilities` and
  `promptCapabilities` from the `initialize` response. keryx's own
  `clientCapabilities` govern `fs`/`terminal`.
- **Which root MCP serves.** Serve the real project root, read-only. The
  detached worktree carries tracked `.metaproject` data but not untracked
  state.

### 5. Record

- **Session.** `persistHistory` (`src/session/store.ts:699`) redacts before
  writing `context.jsonl`, `archive.jsonl` and `transcript.jsonl`.
  `listSessions` (:558) makes the run visible to `keryx sessions`.
  - Proposal: one keryx session per foreign run, with
    `provider: "acp:<agent-id>"`.
  - Record the agent's `agentInfo` name and version from `initialize`.
  - Record the argv and the worktree path.
  - Include a side record of every permission decision and every
    fs/terminal request with its outcome.
- **Structured record, alternative.** The harness `AppendOnlySession` (redaction
  plus an append-only record, used by `src/harness/run/run.ts:1-16`) is the
  stricter record. It fits if the run should produce evidence for the
  completion gate.
- **Cost.** Recordable:
  - token `used`/`size` and optional `cost{amount,currency}` from
    `usage_update` (`protocol.ts:924-930`);
  - wall time;
  - the permission-decision count.
  Missing cost is recorded as missing (`runtime.ts:95-96`). Record the raw
  amount and currency; do not convert.
- **Flow task.** The outcome is already a `StructuredSubagentResult`-shaped
  `ExternalChildOutcome` (`runtime.ts:73-97`). Once `runExternalChild` is
  routed by transport, an ACP run is reachable from `spawn_subagent`
  (`run-external-factory.ts:4-8`) like any other external child.
  - Completion stays keryx's: `evaluateCompletion` never accepts a final
    message alone (`src/harness/completion/gate.ts:1-14`).
  - Attaching a run as a flow-task attempt, and flow 290's unattended
    trigger dispatch, belong to a later flow. Flow state changes go through
    the `keryx flow` CLI only.
- **Writes.** If `fs.writeTextFile` is advertised, capture the worktree's
  `git diff` as the run's **patch artifact** before the worktree is removed.
  It is never auto-applied. The operator re-enters it through keryx's own
  `apply_patch` gate. This is the audit boundary for writes that D-04 asks
  for, while the project tree stays untouched.

### 6. Proposed slice (one flow)

**In scope**
1. Registry: a transport discriminator, a `gemini-acp` entry and a test-only
   fixture entry.
2. `superviseAcpRun`, using the existing spawn port, with the handshake,
   update fold, permission bridge, confined `fs/read_text_file`, refusal of
   unadvertised methods, timeout → `session/cancel` → kill, and
   `close()`-settles-all.
3. `runExternalChild` routes `transport: "acp"` to it. The worktree, gate,
   depth and env steps are unchanged.
4. CLI: `keryx agents external run <id> --task "<text>" [--unattended] [--write]`,
   next to the existing `list|probe`. It uses the same capability gate and
   per-agent config.
5. Context: a stdio `serve-mcp --read-only` entry in `session/new`, plus
   `buildExternalPrompt`.
6. Record: a keryx session, decision records, the cost or "missing", and the
   patch artifact when `--write` is set.
7. Tests:
   - a scripted fake ACP agent (a bun script driven by a JSON script) over
     real pipes;
   - an interop test in which keryx-as-client drives
     `keryx acp --fixture` (a real ACP agent already in the repo,
     `src/acp/fixture-provider.ts`), whose gated tools raise real
     `session/request_permission` asks.
8. Documentation, including the honest-limits section.

**Deferred**
- TUI and `/delegate` integration, and approval UI polish.
- Registry discovery from the ACP registry.
- Multi-agent orchestration.
- `terminal/*` served through a bwrap sandbox.
- OS sandboxing of the whole agent process.
- An adapter entry for Claude Code over ACP.
- Wiring into `spawn_subagent` and flow-task attempts, including flow 290
  triggers.
- `session/load` resume.
- http/sse MCP.
- Lifting D-04 for the real project tree.

### Routing audit (phase 1)
- graph_used: no. Targeted ctx rg plus direct reads of known files were
  enough, and the graph predates this worktree's checkout.
- wiki_used: no. The external-runtime decisions were read directly in
  `docs/requirements/keryx-external-agent-runtime/decisions.md`.
- ctx_used: yes (`keryx ctx rg`, `keryx ctx read`, `keryx memory search`).
- raw_rg_used: yes. One `grep -n` over `src/acp/*.ts`, marked `keryx:raw`,
  pinned exact line numbers for the `usage_update` citation.
