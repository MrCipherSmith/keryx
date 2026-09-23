# ACP client: drive a foreign agent under keryx's policy

`keryx acp` makes keryx an ACP **agent** that an editor drives. This guide is
about the other direction. `keryx agents external run` makes keryx an ACP
**client**: it launches an external [Agent Client
Protocol](https://agentclientprotocol.com) agent as a subprocess, gives it
keryx's project context, and answers every question that agent asks, using
keryx's own policy.

The foreign agent runs in a disposable git worktree. keryx decides its
permission questions and serves its file reads and writes from its own code.
Each run is recorded as a keryx session. keryx does **not** contain what the
agent does with its own tools. The [limits](#what-keryx-cannot-control) section
says exactly what that means.

!!! warning "The MCP server keryx hands the agent reads the whole real project"
    The agent works in a throwaway worktree, but the read-only MCP server keryx
    offers it is started for the **real project root**, not the worktree. Its
    reads cover the whole live project — including uncommitted files the
    worktree does not have — and they go straight to that server, so they
    **bypass the permission bridge**: no prompt, no decision entry. "Read-only"
    means no tool marked mutating is offered. It does not mean nothing is
    written: some of those read tools refresh keryx's own cache and report files
    under `.metaproject/data/**`. If the project holds anything the foreign agent
    must not read, turn the MCP module off for the run (`modules.mcp.enabled`)
    and the agent gets no MCP server at all.

## Run one

```bash
keryx agents external list                 # gemini-acp shows `transport: acp`
keryx agents external run gemini-acp --task "Find why the resume suite is flaky"
keryx agents external run gemini-acp --task "..." --unattended   # refuse anything that needs you
keryx agents external run gemini-acp --task "..." --write        # allow writes into the worktree
```

The same gates apply as for every external agent:

- the `externalAgents` capability, which is off by default and turned on with
  `externalAgents.enabled: true` in the keryx user config;
- a hard disable in CI and under a remote transport;
- the per-agent config (`externalAgents.agents.gemini-acp`);
- the nesting depth marker;
- a `--version` probe.

The agent must also print its final answer as a `subagent-result` document, as
every external child does. keryx validates that answer. A run whose final text
is not a valid document ends as `Error`, not as a silent success.

## What keryx advertises, and what it serves

In `initialize`, keryx advertises exactly what it will serve and nothing more:

| Capability | Read-only run | `--write` run |
|---|---|---|
| `fs.readTextFile` | yes: served from the worktree | yes |
| `fs.writeTextFile` | **no** | yes: into the worktree only, gated as risk `write` |
| `terminal` | **no** | **no** (never in this release) |
| `elicitation` | not advertised | not advertised |

keryx's own code serves every `fs/*` request:

- **Confinement.** Each path is confined to the worktree by its real path. A
  file that does not exist yet is checked through its nearest existing
  ancestor, so a symlinked directory that points outside the worktree cannot be
  used to create a file outside it. `../` traversal, agent credential files and
  managed flow-state files are refused.
- **Refusals.** A call to a method keryx did not advertise (`terminal/*`,
  `elicitation/create`, or `fs/write_text_file` on a read-only run) gets a
  JSON-RPC error that names the reason.

Every served or refused request is written to the run record.

## How permission questions are answered

When the agent sends `session/request_permission`, keryx answers through the
same gate as its own tools, `resolveApprovalDecision`. The tool call's `kind`
decides the risk:

| `toolCall.kind` | keryx risk | Outcome |
|---|---|---|
| `read`, `search`, `think` | read | allowed, unless a location is outside the worktree, which makes it a prompt |
| `edit`, `move` | write | prompt |
| `delete` | destructive | prompt |
| `execute` | shell, or destructive if the command is classified destructive | prompt |
| `fetch` | network | **denied** |
| `other`, `switch_mode`, missing | destructive shell | prompt |
| anything that targets a managed flow-state file | — | **denied** |

Four rules apply on top of the table.

- **Only this run's session, only during its turn.** A permission or `fs/*`
  request naming any other session id, or arriving before the prompt starts or
  after its answer, is refused with a named error and recorded; a
  `session/update` for another session is ignored.

- **The permission mode is always `ask`.** The tool kind, input and locations
  come from the foreign agent's own description of the call. keryx's `trust`
  and `auto` modes are a statement about keryx's own tools, so they are lowered
  to `ask` for a foreign agent. The run record shows the lowering, for example
  `requested: trust, effective: ask, clamped: true`.
- **Only an explicit yes allows a call.** keryx selects the agent's
  `allow_once` option in two cases: the gate returned `auto` (a read inside the
  worktree), or a human approved the prompt and the approval echoes that
  prompt's fingerprint. keryx **never** selects `allow_always`, because a grant
  the agent remembers is one keryx can no longer see. If the agent offers no
  `allow_once` option, the call is refused.
- **Otherwise the run fails closed.** Each of these cases selects
  `reject_once`, or answers `cancelled` if the agent offered no `reject_once`:
  - a policy deny;
  - an unattended run (`--unattended`, no TTY, or no approver);
  - an approver that does not answer within 45 s;
  - a human "no".

  Each question becomes one decision entry in the record: the mapped risk, the
  gate decision, the verdict, `timedOut`, and the reason (`policy`,
  `unattended`, `timeout`, `human` or `no-allow-option`).

## Context: keryx's own MCP server

`session/new` receives two things:

- `cwd`: the disposable worktree.
- `mcpServers`: one stdio server that launches the **running** keryx build
  (`process.execPath` plus this build's CLI entry, never a `keryx` found on
  `PATH`) as:

  ```
  serve-mcp --read-only --cwd <project-root>
  ```

  `--read-only` hides every tool the registry marks as mutating, because the
  agent's MCP calls go straight to that server and never pass the permission
  bridge. Keep in mind what that server sees: the **whole real project** at
  `<project-root>`, not the worktree, with no per-call approval, and some of
  its read tools still write keryx's own `.metaproject/data/**` cache and
  report files. If the MCP module is disabled for the project, or the optional
  `@modelcontextprotocol/sdk` is not installed, the run still goes ahead and
  the record says `context: not offered — <reason>`.

The first prompt is the same one every external child gets: the directive, the
task and the result schema. The project's `AGENTS.md` and
`.metaproject/index.md` go with it. They are sent as `resource` blocks only if
the agent advertised `promptCapabilities.embeddedContext`. Otherwise they are
sent inline as text.

## The record

Each run is saved as a keryx session with provider `acp:<agent-id>`. The model
field holds the agent's own name and version. `keryx sessions list` shows the
session, and the session directory contains:

- `context.jsonl` / `archive.jsonl`: the prompt, the tool calls and the
  agent's reply, redacted.
- `acp-run.json`: the redacted run record. It holds:
  - the argv and the worktree path;
  - `agentInfo` from `initialize`;
  - the mode clamp and the advertised capabilities;
  - the context offer;
  - every permission decision, and every `fs`/`terminal`/`elicitation`
    request with its outcome;
  - the reported tool calls;
  - `usage` from `usage_update`, or `"missing"`;
  - `cost` as the agent reported it, e.g. `{ "amount": 3, "currency": "EUR" }`,
    or `"missing"`. A missing cost is never recorded as 0, and keryx never
    converts a currency.
- `acp-worktree.patch` (`--write` runs only): the worktree's diff, captured
  before the worktree is removed. **It is never applied.** To keep it, review
  it and apply it through keryx's own `apply_patch` gate.

## What keryx cannot control

These limits come from the protocol, not from a missing feature. Read them
before trusting a run:

- **The agent's internal tools are invisible to keryx.** A foreign agent has
  its own shell, file editing, web access and subagents. When it uses them, no
  ACP message is sent, so keryx can neither see nor gate the action.
- **Not advertising a capability is a request, not a boundary.** Leaving out
  `terminal` or `fs.writeTextFile` stops the agent from asking keryx. It does
  not stop the agent from doing the same thing with its own tools.
- **Permission decisions depend on the agent's description.** keryx classifies
  each call from the `kind`, `rawInput` and `locations` the agent sends. A call
  the agent mis-describes is mis-classified. This is why the mode is always
  `ask`.
- **The agent's MCP calls skip the permission bridge.** They go straight to the
  MCP servers keryx handed it. keryx's own server offers no mutating tool for
  that reason — but it reads the **whole real project**, not the worktree, and
  some of its read tools write keryx's own `.metaproject/data/**` cache and
  report files.
- **The agent process runs without an OS sandbox in this release.** It needs
  the network to reach its model and its own credential directory under
  `$HOME`.
- **The disposable worktree is the real containment**, as it is for every
  external agent (decision D-08). Whatever the agent writes with its own tools
  lands in a throwaway `git worktree` checkout that is removed on every exit
  path, including a timeout, a crash and a spawn failure. The operator's project
  tree is never touched. The tests check this with a hash of the project tree
  taken before and after each run.

## Not in this release

- the TUI or `/delegate` driving an ACP agent;
- discovering agents from the ACP registry;
- running several agents together;
- a `terminal/*` served through the OS sandbox;
- OS-sandboxing the agent process itself;
- other ACP agents, such as the Claude Code adapter;
- recording an ACP run as a flow-task attempt.
