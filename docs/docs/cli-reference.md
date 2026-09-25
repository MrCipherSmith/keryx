# CLI Reference

Complete reference for the `keryx` command-line interface. `keryx`
manages a per-project `.metaproject/` workspace: it scaffolds the workspace,
keeps managed "service" files in sync (never touching your `data/` artifacts),
and exposes feature commands for graph/wiki context, skills, code health, testing,
memory, agent orientation, managed work and review lifecycles, and security.

## Global usage

```
keryx <command> [args] [flags]
```

| Global flag | Alias | Effect |
|---|---|---|
| `--help` | `-h` | Print the top-level usage block. Also works (per subcommand) as `keryx <command> --help`. |
| `--version` | `-v` | Print the installed version and exit. |

Running `keryx` with no command, or with `--help`/`-h`, prints the usage
block. An unknown command prints an error plus the usage block and exits with
code `1`.

## version

Check the installed Keryx version against the fixed npm registry endpoint.

```
keryx version check [--json]
```

The command uses the same advisory service as `keryx shell`. Human output shows
the exact upgrade command only when npm reports a strictly newer validated
version; `--json` returns the typed result for agents. A successful result is
cached for 24 hours, failed checks are suppressed for 15 minutes, and the
request timeout is 2 seconds. Unavailable, offline, timeout, and malformed
registry results are operational outcomes and exit successfully; they must not
block project work. Keryx never auto-installs an update. If an update is
available, run:

```bash
npm install -g @mrciphersmith/keryx@latest
```

A pre-feature installation cannot discover the first release containing this
check through code it does not yet have; if `version check` is unknown there,
continue work and update through an external or manual channel. A project's
generated index gains the guidance only after `keryx init`, `keryx update`, or
rules sync regenerates it. That index text is prompt guidance, not enforcement.

### Top-level commands

| Command | Purpose |
|---|---|
| `help` | Grouped command help by task — `keryx help [group|command]`. |
| `shell` | Start the interactive TUI agent shell (sessions are per-project). |
| `version` | Check whether the installed Keryx version has a newer npm release. |
| `sessions` | List, fork, export, or locate agent sessions for the current project. |
| `bus` | Agent bus across this clone's worktrees: list peers and leases, read the log, send a message, prune. |
| `harness` | Drive the agent execution loop non-interactively (`run`, `exec`, `extension`, `wave`, `replay`). |
| `init` | Initialize `.metaproject/` in the current project. |
| `status` | Show local Metaproject status. |
| `modules` | View, enable, or disable workspace modules. |
| `projects` | Manage the user-global project registry that remote entry addresses projects by. |
| `serve` | Loopback-bound HTTP entry over the agent harness (opt-in, off by default). |
| `metrics` | Collect, validate, and report execution-observability metrics. |
| `update` | Refresh managed service files without touching data artifacts. |
| `sync` | Reconcile graph, wiki and memory with the current code; optional git hooks keep them in step. |
| `commands` | The agent-facing command registry: descriptors, and natural-language intent resolution. |
| `dashboard` / `dash` | Build or open the project admin dashboard. |
| `gdgraph` | Build and query the code dependency graph. |
| `ctx` | Run compact, token-aware context commands and save raw output. |
| `wiki` | Manage the local project knowledge base. |
| `skills` | Manage bundled and project working skills. |
| `skill-verify-skill` | Alias for `skills verify`. |
| `health` | Aggregate code-quality signals and run the quality gate. |
| `test` | Analyze testing context and normalize test reports. |
| `memory` | Store and search long-term project memory. |
| `flow` | Agent-first work lifecycle (Task Manager). |
| `review` | Create and complete durable managed review packages. |
| `rules` | Sync/distill root AGENTS.md/CLAUDE.md into project rules. |
| `standard` | Validate the workspace against the Metaproject Standard and report capabilities. |
| `agents` | Manage the optional global Metaproject bootstrap for agent runtimes. |
| `orient` | Emit or install bounded Metaproject + graph + wiki startup context. |
| `security` | Policy-based scanning, redaction, guardrails, and audit reports for agent input/output and artifacts. |
| `mcp` | Expose Metaproject services over the Model Context Protocol (opt-in, off by default). SAC tools are stdio-only. |
| `acp` | Serve the harness to an editor over the Agent Client Protocol (newline-delimited JSON-RPC on stdio). |
| `workspace` | Shared Agent Context: create/list/show workspaces, FWK overview/read, propose/review, collaboration overview, policy-readiness. Not listed by `keryx commands`. |

### Optional dependencies and graceful degradation

Several commands ship as opt-in capabilities that lean on an optional dependency
(e.g. a tree-sitter grammar, an embedding/model backend) or a pulled asset. When
that dependency or asset is absent, the command **degrades gracefully**: it warns
once, falls back to the deterministic built-in path, and still exits `0` (for
example `memory index --embeddings` builds the lexical index only, and
`security eval --with-model` silently uses the pure detector path). The single
sanctioned exception is **`mcp serve`**, which hard-fails with an actionable
message when the optional MCP SDK is not installed.

---

## help

Grouped command help by task, added by flow 303. Separate from `--help`/`-h`
and a bare `keryx`, which keep printing the flat usage block above unchanged.

```
keryx help [group|command]
```

- `keryx help` (no argument) prints every command group, in onboarding order
  (Start here; Connect a model provider; Look and feel; Working in keryx
  shell; Project knowledge; Managed work; Automation; External agents, ACP
  and MCP; Maintenance and diagnostics), each with its commands and a
  one-line summary.
- `keryx help <group>` — a group slug (`start-here`, `connect`,
  `look-and-feel`, `shell-work`, `project-knowledge`, `managed-work`,
  `automation`, `external-agents`, `maintenance`) — prints just that group.
- `keryx help <command>` prints that command's full usage: the same rich
  help `keryx <command> --help` prints today (`flow`, `trigger`, `serve-mcp`
  and `governance` keep their own richer help; every other verb gets its
  `USAGE_BODY` usage block). `keryx help <slash-command>` (e.g.
  `keryx help /theme`) explains a `keryx shell` command, since those have no
  standalone CLI form.
- An unknown group, command or slash-command name exits non-zero and
  suggests the closest matches by edit distance.

In the OpenTUI shell, `/help` opens a tabbed modal built on the same grouped
table — one tab per group, arrow keys to move, Enter for a command's detail,
Esc to close. The readline shell, `--no-tui`, and the ACP host print the
same grouping as text, since a modal cannot render there. On a brand-new
`keryx shell` with no model provider configured yet, the modal opens once,
already on the "Connect a model provider" tab.

---

## shell

Start the interactive agent shell. This is the TUI agent harness; bare `keryx`
prints CLI usage and does **not** start it. Sessions are per-project.

```
keryx shell [-c|--continue] [-r|--resume [id]] [--fork|--take-over]
            [--provider <p>] [--model <m>] [--base-url <url>] [--agent|--chat]
            [--tui|--no-tui] [--debug] [--name <name>] [--guard]
```

| Flag | Description |
|---|---|
| _(default)_ | Full-screen OpenTUI renderer plus the agent, whenever `stdout` is a TTY. |
| `-c`, `--continue` | Resume the most recent session for this project that no other shell has open. When it skips a newer session, it prints that session and its holder. |
| `-r`, `--resume [id]` | Resume a specific session; without an id, pick one interactively. Without a TTY, bare `-r` uses the latest session no other shell has open. |
| `--fork` | With `-r <id>`: fork a session another shell has open, and continue in the fork. |
| `--take-over` | With `-r <id>`: take over a session whose holder is stale — on this host, process alive, but no longer heartbeating. Refused while the holder is live. |
| `--provider <p>`, `--model <m>` | Skip the provider/model picker. |
| `--base-url <url>` | Point the provider at a custom endpoint. |
| `--agent` / `--chat` | Agent mode with tools, or chat without them. |
| `--tui` / `--no-tui` | Force the full-screen renderer, or fall back to the line-based readline shell. |
| `--debug` | Record the session to `~/.local/share/keryx/debug/<run>/` (`shell.ndjson`: terminal-input state, stdin calls with stacks, key names but never typed text, dialogs, tools, agent state) and start a watcher process (`watcher.ndjson`) that re-arms terminal input if the shell stops reading it. The newest run is named in `debug/latest.txt`. |
| `--name <name>` | Set this shell's bus name. Names follow D-06: lowercase letters, digits and `-`, up to 32 characters. `all`, `cli` and `system` are reserved. If a live shell already holds the name, the new shell gets `<name>-2`. |
| `--guard` | Turn on the turn guard for this session only (TUI, agent mode; off by default). `/guard on` turns it on for every future session too. |

The renderer falls back to readline gracefully when the TUI cannot start, and
off a TTY the shell is non-interactive by default.

An interactive shell joins the agent bus at start, printing `bus: joined as @<name> · <n> peers`. Inbound messages appear as `⇄ [#<seq>] @from kind: preview` — the sequence number and the message's short id (its first 8 characters). The `/bus` slash command offers `list` (show peers), `send @x` or `@x text` (send a message), `ask`, `reply <#seq|id-prefix> <text>`, `name <new>` (rename this shell), `pause [@name|@all] [--scope turns|git-publish|advisory] [--ttl 30m] <reason…>` (create a pause lease held by this shell; target and scope default to `@all` and `turns`), `resume [leaseId]` (end a lease this shell holds — the id defaults to its own), and `override [leaseId]` (release just this shell from a lease that targets it — the id defaults to whichever `turns` lease currently holds it). `/bus reply` resolves its first argument against the last 200 rendered events — a bare or `#`-prefixed sequence number, or a unique prefix (at least 8 characters) of a message's id — and always replies to that sender's underlying instance, so it still reaches them even if they renamed since; an argument matching no rendered message is refused with one line. The bus stays off when `KERYX_BUS=off`, shell config `bus.enabled: false`, or a CI environment is detected, printing `bus: off (<reason>)`.

While a `turns` pause lease applies to this shell, an operator line at the readline prompt does not start a main-agent turn: it prints one line naming the holder, the reason and the remaining TTL, keeps the line, and runs it once the lease is resumed, overridden with `/bus override`, or expires. `/bus` and `/exit` still work while held.

When the bus is joined, peer messages also reach the agent as tool-provenance context. An idle agent is woken by a question, reply, handoff or name-addressed notice, with the wake capped by the same auto-wake limit as task notifications; readline shows `bus: N message(s) pending` and delivers them on the next turn. The agent has two tools: `bus_list` (read peer names and message log) and `bus_send` (send a message to a peer or broadcast).

One shell holds a session at a time. `-r <id>` on a session a live shell holds
offers fork, view or cancel in an interactive run, plus take over when the
holder is stale; a non-interactive run exits `1` with a `--fork` hint instead.
Invalid combinations are refused: `--fork` or `--take-over` without `-r <id>`,
both together, or either with `-c`.

If a TUI session stops reacting to the keyboard and mouse while it still draws
(spinner and timer running), run `kill -USR2 <keryx pid>` from another
terminal: every session re-arms its terminal input on `SIGUSR2`.

**Turn guard** (opt-in, off by default). After an agent turn ends with a final
message, the guard checks — advisory only, never blocking — whether the
request looks done and whether the message contradicts what the tools really
did (a claimed passing test suite when the last test run failed, a failure
never mentioned). A likely-incomplete or contradicted turn prints one compact
notice line; `/guard` opens a modal with this session's history, each entry's
deterministic facts, Jev's probabilities when it was asked, and the reason.
Deterministic contradictions are caught even without a Jev credential. Turn on
for one session with `--guard`, or persist it with `/guard on` (`/guard off`
turns it back off); the setting lives in `ShellConfig.turnGuard.enabled`
(`~/.local/share/keryx/auth.json`). A turn with no tool calls and a short
reply to a short question is skipped without asking Jev. When the guard IS
asked (i.e. no deterministic contradiction already decided the turn and it
was not skipped as trivial), the turn's user request, the final assistant
reply, and the deterministic facts (tools called and failures, files
written/edited, commands run and their exit status, tests run and their
pass/fail counts) are sent — redacted through the same security service every
other Jev-backed review command uses — to Jev on OpenRouter.

---

## sessions

Inspect the append-only agent sessions recorded for the current project.

```
keryx sessions list | fork <id> | export <id> | path
```

| Subcommand | Description |
|---|---|
| `list` | Print the sessions recorded for this project, newest first. Forks are marked `↳`. The `LIVE` column reads `live` when a shell has the session open, `stale` when its holder stopped heartbeating, and is blank when no shell holds it. `--json` prints the rows as JSON, each with a `live` field: `"live"`, `"stale"` or `null`. |
| `fork <id>` | Branch a session: a new session with the same history and `parentSessionId` set to the original. `--title "<t>"` names it, `--json` prints the result as JSON. Writing to the fork never touches its source. |
| `export <id>` | Emit one session in full, for archiving or review. |
| `path` | Print the directory sessions are stored under. |

`session` is accepted as a singular alias. Sessions are per-project — isolated by
git root, or by absolute cwd outside a repository — so `list` never shows another
project's work. The [harness page](./harness.md#sessions) covers what a session
holds and what forking copies.

## acp

`keryx acp` makes keryx speak the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) v1: an editor
or another ACP client launches it as a **subprocess** and talks to it over
its stdin/stdout — newline-delimited JSON-RPC 2.0 in both directions, no
`Content-Length` framing (not LSP framing). It is not something a person runs
interactively; the client owns the process's lifetime and the conversation.

```
keryx acp [--provider <p> --model <m>] [--base-url <url>] [--data-dir <dir>]
```

**Provider and model.** With no flags, `keryx acp` uses the provider and model
`keryx shell` would start with in the same place — it calls the shell's own
start-up resolution, not a copy of it: the selection `keryx shell` saved the
last time you picked one (in `auth.json` under keryx's config directory,
`~/.local/share/keryx/` on Linux and macOS), with saved logins refreshed first
and your saved API keys applied the same way. `--provider` and `--model`
override that, and must be given together. The per-provider settings the shell
applies at launch come along through the same resolvers: saved `modelParams`
(`temperature`, `maxOutputTokens`, `timeoutMs`), the output-token budget, and
the saved reasoning effort (each still overridable by its environment
variable). What has no ACP equivalent is the shell's in-session state — a
`/reasoning` or `/model` change made inside a running shell applies to that
shell only. What `keryx shell` does beyond that — detecting
providers and asking you to pick — has no equivalent here, because there is
no one to ask over this wire; so run `keryx shell` once and pick, or put both
flags in the arguments your client launches `keryx acp` with. `--base-url`
overrides the endpoint, as in the shell; `--data-dir` overrides where sessions
are stored (mainly useful for a sandboxed client integration test).

**Switching model from the editor.** That launch model is where a session
starts, not where it has to stay. Every `session/new` and `session/load`
response carries `configOptions` with one `select` option of category
`model` — the editor's model picker — whose `currentValue` is the model the
session is running. Its values are `<provider>/<model>` for every model keryx
can run here, from the same source `keryx shell`'s picker uses: the providers
it detects (with your saved API keys) and each one's model list, narrowed to
providers that have a usable credential — the shell's picker also lists
providers you have not configured yet so you can enter a key, and an editor
has nowhere to enter one. Each provider is reached at the endpoint the shell
would use (a per-provider endpoint you saved in the shell wins), and Ollama is
probed at `--base-url` only, as in the shell. The launch model is always in
the list. Building the list touches the network, so it is started at launch
and a new session waits for it at most 8 seconds: a list not ready by then is
not waited for — that session offers only the launch model, stderr says so,
and the next session asks again. If the list was still building, that session
is not left with one entry forever: once it arrives, keryx sends that
session's picker one `config_option_update` with the complete list (the model
already running stays selected) — nothing arrives if the list fails, or if
the session or connection has ended first. Choose one
in the editor (`session/set_config_option`, answered with the complete,
updated `configOptions`) or type `/model <value>` (a bare model id works when
only one provider has it; keryx then sends `config_option_update`). The
switch is per session, applies **from the next turn** — a turn already
running finishes on the model it started with — and builds the provider the
way the launch did: saved logins refreshed first, the shell's own provider
factory, the new provider's saved settings. A value that is not in the list,
or a provider that turns out to have no usable credential, is refused with
the reason and the session stays on its model; of two switches in flight,
the one requested later wins, and one that fails leaves the other in effect.
Nothing is saved: `keryx shell`'s selection is left as it was.

A **loaded** session continues on the model it last ran — the session record
names it — when that model is still in the list here; otherwise it continues
on the launch model, and keryx says so in the session (`keryx: this session
last ran …, but …; it continues on …`). A session this connection has already
run keeps the model it has now.

**When nothing is configured** — no flags, nothing saved, or a provider with
no usable credential — `keryx acp` still starts and still answers
`initialize`, writes one line to stderr saying what is missing, and refuses
every `session/new` and `session/load` with a JSON-RPC error (`-32600`,
`data.condition: "provider-not-configured"`) whose message names what to
configure and how. It never answers a turn with a stand-in: the offline test
provider is reachable only through the test-only `--fixture` flag, and
`--provider fake` is refused like any other missing provider.

Nothing but protocol frames ever reaches stdout — every diagnostic goes to
stderr, which the client may capture, forward, or ignore; a stray log line on
stdout would otherwise corrupt the stream.

**Honesty note:** this is verified against the published v1 JSON Schema and
against this repository's own scripted test client, driving a real
`keryx acp` subprocess over a real pipe (`src/acp/*.process.test.ts`). The
first shipping client driven against it by hand — Zed, right after 0.2.154 —
found two defects the scripted client could not (a test provider as the
default, and every `session/new` carrying MCP servers refused); both are
fixed. No shipping IDE is part of the automated tests — if you wire one up and
hit a mismatch, that is new information, not a contradiction of something
promised here.

### Methods implemented

| Method | What it does |
|---|---|
| `initialize` | Negotiates the protocol version and returns keryx's `agentCapabilities`/`agentInfo`. Requesting the version keryx serves gets it back unchanged; requesting a newer one gets keryx's latest supported version — not an error, the spec requires this, and the client then decides whether to proceed or close the connection; a malformed or out-of-range version (not an integer, or outside `uint16`) is refused with a JSON-RPC error. Any other request before `initialize` succeeds is refused, not served. |
| `session/new` | Creates a keryx session bound to `resolveProjectRoot(cwd)` — the git toplevel above the requested `cwd`, or the requested `cwd` itself outside a repository. `session/list`/`session/load` report this resolved root back, not the `cwd` you sent, so a session opened at `/repo/packages/web` is later listed with `cwd: /repo`. `mcpServers` is accepted: its stdio entries are started (or, when another session on this connection already runs the same list, shared) and the others are reported — see [MCP servers from the client](#mcp-servers-from-the-client). Only a list that does not match the schema (not an array, or an entry with no `name`) is refused, with `-32602`. Refused with the configured message when no provider is configured (see above). The response carries `configOptions` (the model option, see *Switching model from the editor* above), and right after it keryx sends one `available_commands_update` (see [Slash commands](#slash-commands)). |
| `session/set_config_option` | Switches the session's model from its next turn (`configId: "model"`, `value` one of the option's values) and answers with the complete `configOptions`. Not refused while a turn runs — that turn keeps its model. An unknown option id or value, or a provider that cannot be built, is refused with `-32602` and the reason. |
| `session/prompt` | Runs a real harness turn in that session and streams `session/update` notifications (assistant text, reasoning, tool calls and their results) as the turn runs — not buffered to the end — resolving with the spec's `stopReason` (`end_turn`, `max_tokens`, `max_turn_requests`, or `cancelled`) once it finishes. One turn per session at a time: a second `session/prompt` for a session whose turn is still running is refused with `-32600` and `data.condition: "session-busy"` rather than interleaved into the same transcript. Wait for the first turn's response before prompting again; `session/cancel` shortens that wait but does not end it, because the slot is freed by the cancelled turn itself once it observes the abort — a turn parked in a long tool call frees it a moment later, not instantly. |
| `session/cancel` | A notification (no reply). Aborts the running turn — the same abort path a local hard-stop uses — and settles any `session/request_permission` the turn had open as a local denial, so a pending ask never leaves the client hanging. The turn's `session/prompt` response resolves `stopReason: "cancelled"`, and no further `session/update` for that turn is sent afterwards. Cancelling an unknown or already-finished session is a harmless no-op. |
| `session/list` | Lists the project's durable sessions — the same store `keryx sessions` and `keryx shell --resume` read. An omitted `cwd` lists the sessions of the ACP process's own project root (refusing an optional parameter would itself be a conformance break); a provided `cwd` filters to that project. One page per call; there is no pagination (`nextCursor`) today. |
| `session/load` | Loads a session created anywhere — including one created outside any ACP connection, such as with `keryx shell` — and replays its history as `session/update` notifications **before** responding, as the spec requires. `user`/`assistant` messages become `user_message_chunk`/`agent_message_chunk`; a stored tool call/result pair becomes a `tool_call` + `tool_call_update` sharing one id; `system` messages are dropped (there is no ACP chunk for them). A replayed tool call's status is always reported `completed` — the persisted transcript keeps only the final content, not a separate success/failure marker, so that is the honest approximation available, not a claim that the original call actually succeeded. Loading a session that has a turn in flight is refused the same way `session/prompt` is (`-32600`, `data.condition: "session-busy"`): the load would replace the history the running turn is still writing to. A session whose transcript exists but cannot be read is answered `-32603` with the session id, the transcript's path and the reason in `error.data` — not `resourceNotFound` (the session does exist) and not an empty replay (which would tell the client the conversation had no messages). This is the one error on this wire that names a path on the agent's filesystem; it is the transcript under the data directory the client itself launched the agent with, and it is there because "which file, and why" is what makes the failure fixable. `mcpServers` is handled as for `session/new`, and the list a load carries **replaces** the session's servers: the session is rebound to the set for its new list, a set no session uses any more is stopped, and nothing is started if the load itself is refused. Like `session/new`, the response carries `configOptions` and is followed by one `available_commands_update`. |

### Tools a session offers

A turn in an ACP session is offered:

- **keryx's project tools** — `search_code`, `graph_find`, `graph_query`,
  `graph_symbol`, `graph_path`, `graph_affected`, `repomap`, `memory_search`,
  `read_wiki`, `wiki_ask`, `wiki_resolve`, `wiki_evidence`, `wiki_backlinks`,
  `wiki_freshness`, `flow_status`, `health_status`, `skills_catalog`,
  `skill_load` and `test_related` — in exactly the projects where `keryx
  shell` offers them. They come from the same assembly the shell uses, gate
  included: in a project with no usable metaproject (no manifest and nothing
  built under `.metaproject/`) only `search_code` is offered, because every
  other one could only answer "never built here". All are read-only.
- `get_cwd`, `list_dir`, `read_file` (through the client's `fs/read_text_file`
  when it advertises it, see below), `shell_exec` and `apply_patch` — the last
  two always asked through `session/request_permission`.
- `search_tool`/`use_tool`, only when the client sent MCP servers (above).

Each is reported to the client with an ACP tool `kind`: the search tools as
`search`, the read tools as `read`, `shell_exec` and `use_tool` as `execute`,
`apply_patch` as `edit` — so an editor shows what kind of call it is looking
at rather than a generic one.

Not offered, on purpose: `web_fetch` and `web_search`, and keryx's own
configured MCP servers — their results are untrusted content, which switches
on an approve-before-announce path this wire has no live test for yet;
`spawn_subagent`, because delegation needs a process port the ACP server does
not build; the agent-bus tools, a shell surface; and `ask_user`, workspace,
Slate, execution-plan and background-task tools, which need a host or a
session store this wire does not carry. `/status` lists what a session is
actually offered.

### Slash commands

After every `session/new` and `session/load` keryx sends one
`available_commands_update` listing the commands it handles over ACP, in the
published shape (`name`, `description`, and `input.hint` for one that takes an
argument). A command arrives as ordinary prompt text beginning with `/`;
keryx answers it itself — it never reaches the model and adds nothing to the
conversation's history.

**What counts as a command:** a prompt whose first block is ONE line of
text starting with `/` and a word — `/model x`, `/status`, but also `/tmp is
full` or `/explain this`, which are answered with the command list rather
than sent to the model. To send text like that to the model, start it with a
space (` /explain this`), as Zed itself suggests, or put it on more than one
line: a prompt with a second line is never a command, so nothing typed after
a command is silently dropped. A path (`/src/cli.ts fails`) is not a command
either. A command that takes no argument refuses extra text, and any command
sent with an attachment refuses it — in both cases saying so and doing
nothing, and never repeating the attachment back. `session/cancel` while
`/model` is building the new provider cancels the switch: the session keeps
its model.

| Command | What it does |
|---|---|
| `/help` | Lists these commands. |
| `/model [<model>]` | Without an argument, lists the models the session can run and marks the current one. With one, switches to it from the next turn — the same switch as the editor's model picker — and sends `config_option_update`. |
| `/reasoning [<level>]` | Shows or sets this session's reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) from the next turn. Not saved, as in the shell. |
| `/status` | The session id, project root, model, reasoning effort, the tools the session's turns are offered, and whether the client's MCP servers are running. |

Every other shell command is left out because it needs the terminal UI —
`/workspace`, `/review`, `/governance`, `/triggers`, `/integrate`, `/mcp`,
`/game` and the pickers — or
a session feature this wire does not carry. One typed anyway is answered with
the list above rather than sent to the model.

### MCP servers from the client

An ACP client may send the MCP servers configured in its own settings with
every `session/new` and `session/load` — Zed does. keryx handles each entry on
its own:

- **stdio** entries (`{name, command, args, env: [{name, value}]}`) are
  started with their `command`, `args` and `env`, through the same MCP client
  and dial procedure `keryx shell` uses for its configured servers. The child
  gets the entry's `env` on top of keryx's own environment, with keryx's
  credentials stripped from it — credential-shaped names, and every name
  saved in your config (`auth.json`), whether or not this run has actually
  loaded it; its stderr is discarded. The session is answered at once; its
  first `session/prompt` waits for the servers to finish starting.
- **One running set per distinct list.** Zed sends its whole list with every
  new thread; sessions on one connection that send the same list (same
  entries, same project root) share one set of server processes rather than
  starting a copy each. **Threads therefore share each server process** — a
  stateful server (one holding an open browser, a login, a cache) shares that
  state across them. When a thread binds to a running set, any server in it
  known to be dead — it failed to start, or its process has exited — is
  redialled, so a new thread recovers a broken server without restarting the
  agent. A server that is merely slow (busy in another thread's long call) is
  left alone: slowness is not taken as death. A server that hangs without
  exiting is therefore not recovered until the agent restarts. A set
  stops when no session uses it any more (a `session/load` rebinding the last
  one to a different list) or when the connection ends. Once `keryx acp` has
  begun shutting down, new `session/new`, `session/load` and `session/prompt`
  requests are refused (`-32600`, `data.condition: "shutting-down"`).
- Their tools reach the model the way they do in `keryx shell`: through
  `search_tool` (find a tool) and `use_tool` (call one), offered only in a
  session that has client servers. **Every `use_tool` call is asked** through
  `session/request_permission` and runs only on an explicit allow; a denial
  ends it exactly as a local denial does. A server's output is treated as
  untrusted content, so a later gated call in the same turn is asked about
  too, even under a mode that would otherwise allow it.
- **`http` and `sse`** entries are not started — keryx advertises
  `mcpCapabilities: {http: false, sse: false}` — and a server that fails to
  start (a missing command, a failed handshake) does not fail the session.
  Either way the session is created, every other server still starts, and
  the client is told, per server, by name and with the reason: as an agent
  message in that session (`keryx: MCP server "<name>" …`), sent right after
  the `session/new`/`session/load` response — ACP has no dedicated channel for
  server status, and an agent message is the one every client shows — plus the
  same line on stderr.
- Every server keryx started is **stopped when the connection ends** — stdin
  closing, or `keryx acp` receiving SIGTERM or SIGINT (it then exits 143 or
  130) — and when no session uses its set any more. keryx closes each
  server's stdin and escalates to SIGTERM, then SIGKILL, if it does not exit,
  within the same bounded grace `keryx shell` uses. **SIGKILL to `keryx acp`
  cannot be handled:** its servers run in keryx's process group, so a client
  that kills the group takes them down too; one that kills only keryx closes
  their stdin, which a conforming stdio server treats as the end — a server
  that ignores end of input outlives it.
- **Secrets.** The `env` values and header values in these entries are
  passed to the server process. What keryx itself writes is scrubbed of them
  — replaced with `<redacted>` — in these places: every text a client
  server produces through `search_tool` and `use_tool` (results, error
  messages and tool descriptions), matched both as written and in its
  JSON-escaped form (a value containing `"` or `\` appears escaped once
  serialised) and before the 20,000-byte result cap is applied, so a value
  the cap would cut in two is still removed; and every start-up failure
  reason reported to the client or stderr. keryx never logs an entry or
  writes it to the session record. The limits: a value shorter than 8
  characters (`DEBUG=1`, a port) is not treated as a secret, since replacing
  every `1` in a message would make it unreadable and protect nothing; and
  a server that transforms its credential before returning it — base64 or
  otherwise re-encoded, split across fields, reversed — is not recognised.
  Anything the model then writes itself (for example, copying such a
  transformed value into a later tool call) is not scrubbed either.

### Methods refused, and why

Every method ACP defines that keryx does not implement answers
**`-32601 Method not found`** with a `data.reason` explaining which of the
two situations it is: "keryx has not implemented this" or "your client
called something its own advertised capabilities say it shouldn't have". A
conformant client reads `agentCapabilities` on `initialize` and never calls
these; the refusal exists for the client that does anyway.

| Method | Refused because |
|---|---|
| `authenticate` | keryx advertises no `authMethods`; there is nothing to authenticate against. |
| `logout` | `agentCapabilities.auth.logout` is not advertised. |
| `session/resume` | `sessionCapabilities.resume` is not advertised; use `session/load`, which replays history instead. |
| `session/close` | `sessionCapabilities.close` is not advertised; keryx sessions are durable on disk and have no open/closed state to leave. |
| `session/delete` | `sessionCapabilities.delete` is not advertised; session retention is an operator decision, not a client one. |
| `session/set_mode` | `session/new` returns no `modes`, so there is no mode to set. (The model is a config option — see `session/set_config_option` above.) |

### Client capabilities

On `initialize`, a client advertises `clientCapabilities.fs` (with
`readTextFile`/`writeTextFile`) and `clientCapabilities.terminal`. What keryx
does with each is a deliberate, per-capability decision, not a uniform rule:

- **Reads.** With `fs.readTextFile: true` advertised, keryx's `read_file`
  tool calls `fs/read_text_file` on the client and returns whatever content
  the client answers with — not necessarily what is on disk, since the
  client's view may differ (an unsaved buffer, for instance). Without it, or
  with it `false`, keryx reads the file itself with no wire call at all; the
  turn completes the same way either way. This is the one half of AC6 that
  is fully capability-routed, and it is tested both ways over a real pipe:
  the frame is asserted present when advertised and absent — for the whole
  connection, not just the one call — when it is not.
- **Writes.** keryx's `apply_patch` tool always writes locally, whether or
  not `fs.writeTextFile` is advertised. `apply_patch` applies a multi-file
  unified diff atomically (via `git apply`) — all hunks across all files
  land, or none do — and `fs/write_text_file`'s shape (one file, full
  content, no diff, no cross-file atomicity) cannot express that guarantee.
  Rerouting through it would mean giving up atomicity or reconstructing it
  with scratch-index plumbing outside `git apply`, which is a redesign of
  `apply_patch`, not a capability branch. `keryx acp` never calls
  `fs/write_text_file` in this release, with or without the capability being
  advertised.
- **Shell.** keryx's `shell_exec` tool always runs locally too, regardless of
  `terminal`. Its local implementation (background jobs, streaming output,
  timeouts, and the permission gate below) has no one-for-one match in ACP's
  `terminal/create` + `output` + `wait_for_exit` + `kill` + `release`
  surface, and keryx does not need a remote terminal — the client and the
  agent already share a machine, exactly as `keryx shell` does. `keryx acp`
  calls no `terminal/*` method in **any** capability configuration, tested
  both with and without `terminal` advertised.

### Permissions

A tool call the policy engine would ask a local operator about produces a
`session/request_permission` request instead, carrying the `tool_call` the
client has already been shown (as a `session/update`, sent before the ask) and
four options: allow once, allow always, reject once, reject always. **Only an
explicit allow runs the call** — a reject of either kind, a `cancelled`
outcome (the client closing the question without deciding), an unrecognised
option id, a malformed answer, a JSON-RPC error answer, or the client simply
going away all deny it, and the tool call is left unexecuted. The turn then
continues (or ends) exactly as it would after a local denial — same message,
same history entry, same next steps — so a client cannot distinguish "the
operator said no" from "the ACP wire said no" by the turn's behaviour.

A tool call escalated for destructive effect, credentials, a publish lease,
or an untrusted origin is offered **no "allow always" option at all** — keryx's
own rule for those is "always prompt, never remember".

**`allow_always` is remembered by the client, not by keryx.** keryx persists
nothing from an "allow always" answer; it is the client's job to answer the
identical next request itself, the same way an editor's own permission UI
would. keryx does not mint a local allowlist entry from it — a
keryx-side allowlist matched against an ACP answer it never showed a human
would be exactly the kind of "boundary" that has already gone wrong before.

If a client's very first answer to a `session/request_permission` comes back
as a JSON-RPC error (e.g. the client does not implement the method), keryx
remembers that for the rest of the connection and denies every later gated
call **locally, without asking again** — it does not retry a method a client
has already said it lacks, and it never treats "cannot ask" as "must be fine
to run".

### Limits, plainly

- **No transport but stdio.** There is no HTTP or WebSocket ACP transport;
  `keryx acp` only ever speaks newline-delimited JSON-RPC over the pipes the
  client gave it when it spawned the process.
- **No authentication.** `authMethods` is empty and `authenticate`/`logout`
  are refused; keryx authenticates to model *providers* out of band, through
  its own credential store, never over this wire.
- **Writes and shell execution never leave the machine**, as above — not a
  missing feature so much as a decision not to give up `apply_patch`'s
  atomicity or `shell_exec`'s streaming/approval behaviour for a capability
  keryx does not need on a machine it already shares with the client.
- **Not implemented at all:** `session/resume`, `session/close`,
  `session/delete`, `session/set_mode` — see the refusal table above for why
  each one specifically.
- **No cross-project `session/list`.** Only the ACP process's own project
  (or a `cwd` you pass) is listed; there is no "every session on this
  machine" view.

## bus

The agent bus: keryx shells in every worktree of one clone see each other and
exchange short messages. The bus lives in the git common directory
(`<git-common-dir>/keryx/bus/<project-key>/`), outside `.metaproject/`, and
never writes flow state.

```
keryx bus list [--json]
keryx bus log [--since <seq>] [--limit N] [--json]
keryx bus send <@name|@all> [--kind notice|question|handoff|reply] [--reply-to <id>] [--json] <text…>
keryx bus pause <@name|@all> --reason <text> [--scope turns|git-publish|advisory] [--ttl 30m] [--json]
keryx bus resume <leaseId> [--json]
keryx bus prune [--json]
```

| Subcommand | Description |
|---|---|
| `list` | Live and stale peers — name, state, status, heartbeat age, branch, checkout and activity — and the active pause leases. Gone peers are hidden. `--json` prints both as JSON. |
| `log` | The retained events, oldest first. `--since <seq>` shows only events after that sequence number, `--limit N` only the last `N`, `--json` prints them as JSON. |
| `send` | Send a message as `cli` with a fresh sender id. `@name` must name a live instance: a name nobody holds is refused with `unknown-recipient`, one held only by stale or gone instances with `recipient-not-live`. `@all` is every instance. `--kind` (default: `notice`) accepts `notice`, `question`, `handoff`, or `reply`; `--kind reply` requires `--reply-to <id>`. `--json` prints `{ seq, id, resolvedTo }`. |
| `pause` | Create a pause lease held by `cli` against a live `@name` or `@all` (`--reason` is required). `--scope` (default: `turns`) is `turns` (hold new main-agent turns), `git-publish` (escalate publish commands to an approval prompt), or `advisory` (delivered like a notice). `--ttl` (default: `30m`) is `30m`/`2h`/`45s`-style, with a minimum of 1 minute and maximum of 4 hours. The `cli` holder has no presence, so the lease's own TTL bounds it; at most one CLI-origin lease can be active in the clone. `--json` prints `{ leaseId, scope, targets, expiresAt }`. |
| `resume` | End any lease by id, as `cli` — the operator's escape hatch from a terminal, regardless of who holds it. Resuming an id that is already gone is a silent no-op. `--json` prints `{ leaseId }`. |
| `prune` | Remove presence records gone for more than 24 hours, inactive pause leases (each gets one `lease-expired` event), and rotated log segments beyond the retention bound. Live and stale peers are never touched. `--json` prints what was removed. |

Refusals print their code and exit non-zero (except where noted):

- **`use-agent-tool`** (exit `2`): `send`, `pause` or `resume` run inside a
  keryx tool call, where `KERYX_TOOL_CALL=1` is set on every `shell_exec`
  child. An agent uses its bus tools instead (`bus_send`, `bus_pause`).
  `list`, `log` and `prune` still work there. `KERYX_SESSION_*` variables
  alone do not trigger this.
- **`bus-disabled`**: `send`, `pause`, `resume` and `prune` when the bus is
  off — `KERYX_BUS=off`, shell config `bus.enabled: false`, or a CI
  environment. The reason is named. `list` and `log` still read.
- **`unknown-recipient`**: `send` or `pause` when `@name` does not match a live
  instance, or when the address is malformed.
- **`recipient-not-live`**: `send` or `pause` when `@name` is held only by stale
  or gone instances.
- **`recipient-is-self`**: `send` or `pause` when the message or lease targets
  resolve only to this instance.
- **`lease-already-held`**: `pause` when the holder already has an active lease,
  or when a CLI-origin lease is already active anywhere in the clone and this
  request is also CLI-origin.
- **`ttl-out-of-range`**: `pause` when `--ttl` is less than 1 minute or greater
  than 4 hours.
- **`not-lease-holder`**: `resume` when the lease holder is not `cli` and not
  this instance.
- **`reply-without-replyTo`**: `send` when `--kind reply` is used without
  `--reply-to <id>`.
- **`invalid-id`**: `send` when `--reply-to` is not a valid UUID, or `resume`
  when the lease id is not a valid UUID.
- **`rate-limited`**: `send` when the clone-wide CLI message rate exceeds 30 per
  minute.

## shell behavior

### Interactive behavior

- `/help` lists every slash command available in the current mode
  (`agent` vs `chat`). The registry is `AGENT_SLASH_COMMANDS`.
- `/status` (chat and agent) opens a read-only inspector. The TUI modal
  always has **Status** and **Context**: last-turn tokens, a labelled
  estimate, and — when the provider reported one — the model context
  window, optional rate-limit headers, and DeepSeek/OpenRouter balance.
  A missing figure stays `—`; the bar never invents a 128k window.
  **Workspaces** and **Flow** tabs appear only when the session actually
  referenced a SAC workspace or a flow (`runLink.sessionId` or an
  explicit `flow 154` / `/flows 154` mention). `c` copies the session id.
  Readline / `--no-tui` prints the same rows. `/session-info` and `/info`
  are **not** aliases.
- `/flows` lists project flows, newest first (highest id, then `updatedAt`).
  In the TUI, the List tab uses `↑/↓` to move the selection; Enter or `→`
  opens Detail. On Detail, `↑/↓` scroll the body instead — `[`/`]` (or
  `p`/`n`) switch to the adjacent flow. `/flows 154` (id, padded id, or slug)
  opens one package directly. Readline prints the list, or one package when
  given an argument. `/status` and `/flows` remain usable even while the main
  turn is busy.
- `/sessions` opens an interactive session picker in the TUI and switches the
  live shell to the chosen session. Sessions written by `keryx agents external
  run` appear there too. They are marked `acp:<agent>` in the row's description,
  and typing `acp` in the filter finds them. `keryx shell -c` never continues
  one: it continues the newest session of the shell's own kind.
- **Governance** (TUI sidebar, always present, below Jobs). The row shows one of
  five states:
  - `no report — click to run`: there is no stored report.
  - `unreadable — click for reason`: a stored report exists but is malformed or
    cannot be read.
  - `running…`: a report is being built.
  - `last report <YYYY-MM-DD HH:MM>`: taken from `generated_at`, in UTC.
  - `failed — click to retry`.

  With no report, clicking the row runs the same `buildGovernanceReport` +
  `writeGovernanceArtifacts` pair that bare `keryx governance report` runs:
  current project, no filters. The run happens in the shell's own process, in
  the background. The composer stays usable, a second click starts nothing, and
  one toast appears when it finishes. It never goes through the agent's task
  registry, so it never starts an agent turn. With a report, clicking the row
  opens the report modal. `/governance` does the same from the keyboard.

  The modal shows the stored report's `generated_at`, filters and
  `all_projects`, above `latest.md` wrapped to the panel. `↑/↓` and `j/k` scroll
  one line, `PgUp/PgDn` scroll one page, `r` re-runs the report in the
  background and refreshes the modal when it finishes, and `Esc` closes it. A
  malformed or unreadable stored report is never rebuilt behind your back:
  clicking the `unreadable` row or `/governance` opens the modal, which gives
  the reason and offers `r` to rebuild it. A report
  written by another process after a failed run replaces the `failed` state.
  Both artifacts are replaced atomically, `latest.json` last.
- **Triggers** (TUI sidebar, below Governance). The section is hidden when
  `.metaproject/triggers.json` does not exist, and shows one error row when the
  file, or the ledger, cannot be read. Row ages are repainted at least once a
  minute. It shows:
  - Project trigger spend, as `keryx governance report` computes it and in the
    same format (`$0.004`, never rounded to `$0.00`). Runs that closed with
    their cost not recorded are counted separately and never added in as $0. A
    dispatch's spend reservation is not a run of its own once the run's closing
    record (or `keryx trigger resolve`) exists.
  - Open spend reservations, when there are any, with the USD they hold:
    `! 1 open · $0.5 reserved`. An open reservation — a run in flight, or a
    killed one nobody has resolved — is named only as open: it is never also
    counted as "not recorded", and stays open until the run closes it or
    `keryx trigger resolve`.
  - One row per event-fired trigger: its name, `enabled` or `disabled`, and
    either the last outcome with its age or `never fired`. A trigger whose
    dispatch has `network: true` is marked `NET`.

  Schedule-fired triggers get no rows here, only an `N scheduled` line; the
  Schedules section owns them.

  Clicking a row, or `/triggers [name]`, opens a list+detail modal. A name that
  matches no trigger stays on the list with `no trigger named "<name>"`. Both
  modals ignore keys while a permission prompt or another composer choice is
  open.
  - **List keys:** `↑/↓` to select, `Enter` to open Detail, `[`/`]` for the
    previous or next trigger.
  - **Detail** shows the entry exactly as `keryx trigger list`/`status` print it
    (they share the same formatter) and whether its hook is installed. For a
    dispatching `flow-next` it also shows provider/model, permission mode,
    ceiling, max seconds, max attempts, the unattended roster, and network with
    the full NETWORK ON warning.
  - **Detail also lists** the last ledger records (outcome, cost, refusal code,
    denials) and every open reservation with its exact
    `keryx trigger resolve <runId> --spent <usd>` command. The TUI never
    resolves a reservation itself.
  - **Run now:** `r` arms it, `y` confirms, and any other key cancels. For a
    dispatching entry the prompt names its ceiling and whether the network is
    ON. A disabled or malformed entry cannot be armed, and the modal says why.
    A confirmed run is `keryx trigger run <name>` executed as a child process
    of the same keryx build the shell runs (its own interpreter and entry
    script, or the binary itself for a compiled build — never whatever `keryx`
    is on `PATH`), in the project root, without the shell's `KERYX_SESSION_*`
    variables. It is therefore bound by exactly the CLI's locks, budgets, spend
    reservations, refusals and unattended floor. The modal shows `running…`,
    then the new ledger record and the tail of the run's output, and one toast
    appears.
  - **Quitting while a run is in flight** does not stop it. The child runs
    detached, in its own process group, and writes its output to its own
    file, `.metaproject/data/trigger/run-now/<name>-<startedAt>.log`, in a
    directory that ignores itself in git. The newest five logs per trigger are
    kept. The log is never written through a symbolic link: if
    `.metaproject/data/trigger`, `run-now` or the log file is a symlink (or not
    what it should be), run-now refuses and the modal says why. On exit the shell prints one line naming the trigger and
    the log. The run writes its own closing record, which the sidebar shows on
    the next start. A second run-now of the same trigger from a restarted shell
    is refused by the CLI's own lock (`lock-refused`, or `dispatch-locked` for a
    dispatching `flow-next`), not by the TUI.

  Both sections poll `runs.jsonl`, `triggers.json` and the governance
  `latest.json` every few seconds, and again after every settled turn. They
  repaint only when one of those files changed, so a run finished by a git hook,
  CI or another shell shows up without a restart. `/governance` and `/triggers`
  also work while a turn is busy.
- `/theme` (chat and agent) with no argument opens a picker modal: a theme
  list on the left, a live preview (assistant markdown, a code block, tool/
  side/chip/ok/error samples) on the right. Arrow keys move the highlight and
  repaint the preview instantly; the palette itself only applies on Enter or
  a click on `[ Apply ]` — Esc/close leaves the current theme untouched.
  `/theme <name>` still applies immediately without opening the picker.
  Readline / `--no-tui` supports only the immediate-apply form.
  The chosen palette also drives existing and future transcript content:
  prose, headings, emphasis, inline code, syntax roles, diff rows, and table
  chrome repaint together. In assistant Markdown, use a language-tagged fence
  such as `typescript` for syntax color, `diff` for themed additions and
  deletions, and `text` or `txt` for literal preformatted output. GFM pipe
  tables render as responsive bordered tables; escape a literal separator as
  `\|` or place it inside inline code.
- Structured execution plans need no operator command. During multi-step work,
  the agent can create and update a session-backed plan with `proposed`,
  `pending`, `in_progress`, `completed`, `blocked`, and `skipped` states. When
  present, its current window appears automatically under **Plan** in the TUI
  sidebar and returns after session resume; clicking the section opens the whole
  plan in a modal (`Plan` and `Meta` tabs). `proposed` means the item is
  awaiting YOUR approval and is not work in progress: it never makes the agent
  continue on its own, so a plan published for approval is a legitimate place for
  a turn to end. Orchestrator pipelines publish their own steps into the same
  plan — the `session-plan-bridge` rule holds the ids and the status translation
  from `keryx job status` / `keryx flow status` — so a job or Flow run is
  watchable while it runs, not only once it reports. Approving is the operator turning those items into
  `pending`/`in_progress` work. This is separate from `/plan`, whose name
  predates the panel and still means the operator-controlled read-only mode.
- `/search-provider` configures and tests web search providers for `web_search`
  (DuckDuckGo is the default and needs no setup): run with no arguments to open
  a wizard (select provider → enter fields/credential when required →
  active-toggle → test); pass `provider id` plus `key=<value>` (for keyed
  providers) to configure and validate one directly.
- `/search-connect` selects the active search provider: run with no arguments to
  open a picker over DuckDuckGo plus any tested providers, or pass an ID to
  switch directly. `duckduckgo` can be selected without a prior test.
- `/delegate <agent> <task>` hands a bounded read-only task to a vendor coding
  CLI hosted as a child agent (`keryx agents external list` for the ids). It is
  refused with a named reason when the capability is off — which is the default.
  The child appears in the subagent sidebar with a `⤳` marker and opens a
  **Work / Meta / Command** modal: the live transcript, the run's metadata, and
  the exact launch argv plus how to continue the session by hand. Operator
  messages to a running child use the same `/queue` semantics
  (`remove`/`edit`/`force`); `force` here is kill-plus-resume, not an abort. See
  [the harness page](./harness.md#external-children-a-vendor-cli-as-a-child-agent).
- `keryx shell` supports a hard stop for a running main turn via
  `/interrupt`.
- Session history is durable during a turn: user input and tool results save
  immediately; streamed assistant text checkpoints every 300 ms and is flushed
  by `/interrupt`.
- If the main turn is busy, submitting a normal message opens a selector:
  **Main queue** (default) or **Side-1** (a read-only worker, outside main
  history, single slot by default; the transcript notes `◦ side-1 queued`
  while it processes). A message sent to the main queue appears as `qN (p)`
  in a dedicated panel above the composer input and drains FIFO right after
  the current turn completes. Each queued item shows clickable Force/Edit/Delete
  buttons in the panel; `Ctrl+Q` opens a keyboard-only selector for the same
  actions (↑/↓ select, ←/→ choose action, Enter fire, Esc exit). The `/queue`
  text command (`remove`/`edit`/`force`) remains available unchanged.

When side-worker context is still processing, queued questions do not block the
session state and still see recent context about the busy main turn.

### Reasoning effort and output budget

- `/reasoning [off|minimal|low|medium|high|xhigh|max]` sets the session's
  thinking effort for the main agent turn; no argument prints the resolved
  level and which tier it came from. Precedence, highest first: this
  session's `/reasoning` override, then `KERYX_REASONING_EFFORT`, then the
  persisted `reasoningEffort` in the shell config, then `off` (no reasoning
  requested — the default). Setting it also persists to the shell config, so
  it survives a restart. Readline (`--no-tui`) has the same command.
- Each native provider maps the requested level onto its own knob and clamps
  a level it does not support to the nearest one it does, rather than
  sending an unrecognized value:
  - **Anthropic** — current-generation models (Opus/Sonnet 5, Fable, Mythos,
    Opus/Sonnet 4.6 and newer) use adaptive thinking
    (`thinking: { type: "adaptive" }`) with `display: "summarized"` forced
    on — the default arrives with empty thinking text — and the level
    passed as `output_config.effort`. The `4.5` generation (Haiku, Sonnet
    and Opus 4.5) and any Claude 3.x/2.x model use budget-based thinking
    instead (`thinking: { type: "enabled", budget_tokens }`), with
    `budget_tokens` fixed per level (2048 low, 4096 medium, 8192 high,
    16000 xhigh/max) and `max_tokens` raised to make room for it. Anthropic
    has no `minimal` level (clamps to `low`), and Opus/Sonnet 4.6 have no
    `xhigh` (clamps to `high`).
  - **OpenAI (Responses API)** — passed as `reasoning.effort`, with a
    requested summary. OpenAI's own vocabulary is
    `minimal|low|medium|high`; `xhigh`/`max` clamp to `high`.
  - **Gemini** — `generationConfig.thinkingConfig`, always requesting
    `includeThoughts: true` alongside the depth control. `gemini-3*` models
    use `thinkingLevel` (`low` or `high` — `medium` clamps to `high`);
    older or unrecognized model ids use `thinkingBudget`, a token budget per
    level. No effort requested means no `thinkingConfig` at all.
  - **Custom OpenAI-compatible providers ignore this control.** Their
    reasoning shape is configured per-provider in `llm-providers.json`
    instead — see
    [Custom-provider reasoning configuration](#custom-provider-reasoning-configuration)
    below. `/reasoning <level>` still prints a note naming the active
    provider when it has no `reasoning` entry there.
- **Output budget.** The main turn's per-request output-token budget
  defaults to 8192 — the tightest hard ceiling among currently supported
  providers (DeepSeek's OpenAI-compatible `max_tokens` cap). Precedence,
  highest first: the `KERYX_MAX_OUTPUT_TOKENS` env var, a custom provider's
  own `maxOutputTokens` in `llm-providers.json` (set via the "add custom
  provider" wizard, or by hand — a positive integer), the operator's global
  `maxOutputTokens` shell-config setting, then the 8192 default. No upper
  ceiling is enforced on an override. A configured `temperature` (same
  wizard, any finite number) is sent on every request to that provider once
  one is set — absent, no `temperature` is sent at all, unchanged from
  before this setting existed.
- **Streaming and timeouts.** Every provider adapter (Anthropic, OpenAI,
  Gemini, and the OpenAI-compatible engine) streams the reply incrementally
  instead of waiting for the full response. Two independent deadlines guard
  a stalled connection: a first-byte timeout (no byte at all since the
  request was sent) and an idle timeout (no further chunk since the last
  one) — both default to 120 seconds and have no user-facing setting today.
  Separately, a custom OpenAI-compatible provider may also set an opt-in
  overall `timeoutMs` (same wizard, or by hand in `llm-providers.json` — a
  positive integer) that bounds the WHOLE chat/completions call from the
  moment it starts, independent of the first-byte/idle deadlines above;
  absent, no such overall timer runs and only the two deadlines above (and
  the caller's own cancellation) can end a stalled call. A first-byte/idle
  timeout surfaces as a retryable `unavailable` provider error, the same
  class as a dropped connection; the configured `timeoutMs` firing (like an
  operator/UI cancellation) surfaces as a `cancelled` error instead. Whichever
  fires first ends the call with exactly that one terminal error — never a
  second, duplicate error alongside it.
- Tab or Right accepts the next-step hint shown under the composer;
  starting a new turn, or typing or pasting into the composer, cancels an
  in-flight or already-shown hint. Enter on an empty composer no longer
  sends the hint — only Tab/Right accept it.

- While the model reasons, the busy line switches to `thinking…` on the
  first reasoning fragment and shows the latest reasoning lines next to the
  elapsed time. When the reasoning ends it becomes a collapsed block headed
  `◆ thought for 12s · 1.8k tokens`; the token count appears when the
  provider reports it (OpenAI, Gemini). Reasoning the provider hides is
  shown as `◆ thought · hidden by provider`.
- `/think` with no argument expands or collapses the last reasoning block;
  `Ctrl+O` and `y` (copy) work on it like on any other transcript block.
- `/think auto|expand|hide` sets how reasoning is shown and is saved as
  `thinkDisplay` in the shell config: `auto` (default) collapses the block,
  `expand` shows it expanded, `hide` shows neither the live preview nor the
  block, and the hidden reasoning is not kept for copying. The plain
  (non-TUI) shell prints `◆ thought for 12s (3 lines)` and follows `hide`
  too.

---

## harness

Drive the agent execution loop **non-interactively** — the same loop `shell`
runs, without a terminal attached. This is the scriptable and CI-facing surface.

```
keryx harness run --provider <p> --model <m> [--base-url <url>] [--record <path>] "<prompt>"
keryx harness exec [options] -- <path> [args...]
keryx harness extension --spec <path>
keryx harness wave --spec <path>
keryx harness replay --record <path> [--fixture <path>] [--write-fixture <path>] [--json]
```

| Subcommand | Description |
|---|---|
| `run` | Execute one prompt through the run loop against the named provider and model. `fake` is a deterministic in-process provider, which is what makes the loop testable without a network. |

`--provider` accepts `anthropic`, `ollama`, `fake`, and the OpenAI-compatible
gateways — `openrouter`, `deepseek`, `zai`, `zai-coding`, `cerebras`, `groq`,
`moonshot`, `grok`. `keryx shell` offers the same set through its picker, which
lists each provider with the environment variable it reads.

Operator-defined OpenAI-compatible providers can be added on top of that list
by registering them in `~/.local/share/keryx/llm-providers.json`; the
`/provider` wizard in `keryx shell` has an "add custom provider" entry that
writes this file for you (name → URL → key → models → temperature (optional)
→ max output tokens (optional) → request timeout ms (optional)). A custom
name colliding with a built-in provider is rejected. Custom providers may
target private LAN hosts (RFC1918/CGNAT) — an explicit opt-in that built-in
providers never get; loopback and link-local metadata addresses stay denied
regardless.

The three optional wizard fields persist straight onto the provider's
`llm-providers.json` entry and are consulted on every request: `temperature`
(any finite number, including `0`) is sent verbatim; `maxOutputTokens` and
`timeoutMs` must each be a positive integer when set — a `0`, negative, or
fractional value is rejected by the wizard and by a hand-edited file (the
whole entry is dropped rather than accepted). See "Output budget" and
"Streaming and timeouts" under
[Reasoning effort and output budget](#reasoning-effort-and-output-budget)
above for how each is applied.

| `exec` | Run a subprocess under the containment options below. |
| `extension` | Run a declared extension from a spec file. |
| `wave` | Run a declared multi-agent wave from a spec file. |
| `replay` | Check that a replay fixture still describes the run it was built from. `run --record <path>` writes the record; `replay --record <path>` builds a fixture from it and validates, `--write-fixture` keeps that fixture, and `--fixture` compares against a kept one. A divergence prints a typed mismatch naming the field and exits non-zero. |

`harness replay` is `validate-log`: it recomputes hashes from a recorded run and
compares them. It does **not** re-execute the run, so it answers "is this
fixture still true of this record", not "would this prompt behave the same
today". Nothing is contacted — no provider, no tool, no network.

### `harness exec` containment options

| Flag | Description |
|---|---|
| `--allow-env KEY` (repeatable) | Pass one environment variable through. The default is to pass none. |
| `--max-runtime-ms N` | Wall-clock bound on the child. |
| `--allow-real-subprocess` | Permit a real subprocess at all. Without it, execution is refused. |
| `--allowed-domains a,b` | Restrict network egress to a domain allowlist, served by a loopback proxy that reports each allow/deny ruling. **macOS only** — on Linux this refuses rather than degrading to full host network. |
| `--mask-env NAME@host` | Mask a credential toward a specific host. |
| `--tls-terminate` | Terminate TLS so HTTPS traffic can be masked. **macOS only.** |
| `--mask-mode auto\|manual\|off`, `--auto-mask` | Credential-masking mode. Resolution order is env → project → global → built-in; the built-in default is `auto` when the restricted sandbox is on. |

Masking without TLS termination **fails closed** — it does not proceed with an
unmasked connection. Spawn failures carry structured diagnostics rather than a
bare exit code.

### Custom-provider reasoning configuration

An entry in `llm-providers.json` (see above) may carry a `reasoning` block
that tells the OpenAI-compatible adapter how to read — and later replay — a
gateway's reasoning output. Absent, reasoning is read the default way — with
two exceptions: a provider whose `baseUrl` host is `api.minimax.io` or
`api.minimaxi.com` (any path) with no `reasoning` block of its own gets
`{ "format": "split", "requestParams": { "reasoning_split": true }, "replay":
"minimax" }` automatically, and one whose host is `api.deepseek.com` — the
built-in `deepseek` provider included — gets `{ "format": "field", "replay":
"deepseek" }` automatically, so a tool-using round always replays its prior
`reasoning_content` back and thinking mode never 400s on the follow-up
request. MiniMax's own default mode sends every reasoning phrase twice
(inline in `content` as `<think>…</think>` AND again in a `reasoning`
field), so its preset asks it for out-of-band reasoning instead. An explicit
`reasoning` block on a MiniMax or DeepSeek entry always overrides its preset.

```json
{
  "schemaVersion": 1,
  "providers": {
    "my-minimax": {
      "name": "my-minimax",
      "baseUrl": "https://api.minimax.chat",
      "models": ["MiniMax-M3"],
      "reasoning": {
        "format": "split",
        "requestParams": { "reasoning_split": true },
        "replay": "minimax"
      }
    }
  }
}
```

`reasoning.format`:

| Value | Use when | Behavior |
|---|---|---|
| `"field"` (default when `reasoning` is absent or `format` is omitted) | The gateway sends reasoning in a `reasoning`/`reasoning_content` delta field, separate from `content` (DeepSeek, OpenRouter, vLLM, most gateways). | The field is read as-is; a literal `<think>`/`</think>` tag leaked into it (and its one adjacent newline on each side) is stripped, same as `"split"` below. |
| `"inline-tags"` | The gateway writes reasoning INSIDE `delta.content` as `<think>…</think>` — MiniMax's own default shape, and typical of Qwen3 or a DeepSeek-R1 distill served with no reasoning parser in front of it. | keryx strips the tags out of the visible content and surfaces the tagged text as reasoning, via `ThinkTagParser`. `content` is the ONLY reasoning source under this format — a `reasoning`/`reasoning_content`/`reasoning_details` delta is ignored, so a gateway that sends both (MiniMax's own default mode) never double-emits the same reasoning text. |
| `"split"` | The gateway can be asked, via `requestParams`, to send reasoning out-of-band instead of inline. | `delta.content` passes through unchanged; reasoning is read from `reasoning_content`/`reasoning_details` as usual. A literal `<think>`/`</think>` tag a gateway echoes into that field (MiniMax's split-mode stream was observed to end with one) is stripped out, along with its one adjacent newline on each side. |

`reasoning.requestParams` — an object shallow-merged into the request body
AFTER every field keryx builds itself. It cannot override `model`,
`messages`, `stream`, or `tools` — those keys are dropped from the merge;
every other key passes through, including a provider-specific flag like
MiniMax's `reasoning_split`.

`reasoning.replay` — which shape a resumed transcript uses to replay this
provider's own past reasoning: `"none"` (default), `"deepseek"` (echoes an
owned `reasoning_content` field back for a tool-using round), or
`"minimax"` (an owned `raw_content` replay item replaces `content`).

Two worked examples, alongside the inline-tags one above:

- **MiniMax**, asking for out-of-band reasoning and replaying it MiniMax's way:
  ```json
  { "format": "split", "requestParams": { "reasoning_split": true }, "replay": "minimax" }
  ```
- **DeepSeek**, default field-based reasoning with DeepSeek-shaped replay:
  ```json
  { "format": "field", "replay": "deepseek" }
  ```

**Per-provider output budget, temperature, and timeout.** `maxOutputTokens`,
`temperature`, and `timeoutMs` are sibling fields of `reasoning` (not inside
it, and each independent of it): `maxOutputTokens` overrides the main turn's
output-token budget for just this provider, `temperature` is sent on every
request to it, and `timeoutMs` bounds the whole chat/completions call — see
[Reasoning effort and output budget](#reasoning-effort-and-output-budget)
above.

---

## init

Initialize the `.metaproject/` workspace in the current directory: scaffold
directories, enable the optional modules, optionally install git hooks, and write
the `metaproject.json` manifest. Re-running `init` over an existing workspace
updates managed files but never clobbers seeded user files or `data/`.

```
keryx init [--yes] [module flags] [hook flags] [capability flags]
```

| Flag | Description |
|---|---|
| `--yes`, `-y` | Non-interactive: accept every module default (enabled) instead of prompting. |
| `--help`, `-h` | Print `init` usage and exit. |
| `--gdskills-profile <profile>` | Set the gdskills install profile (`minimal`, `recommended`, `full`, `custom`); defaults to `recommended`. |

**Module flags** — each of the 9 modules is enabled by default; pass its
`--no-<module>` flag to disable it:

| Flag | Disables module |
|---|---|
| `--no-gdgraph` | Dependency graph. |
| `--no-gdctx` | Compact context commands. |
| `--no-gdwiki` | Project knowledge base. |
| `--no-gdskills` | Working-skills subsystem. |
| `--no-health` | Code-health quality gate. |
| `--no-testing` | Testing context / reports. |
| `--no-memory` | Long-term project memory. |
| `--no-tasks` | Flow / Task Manager lifecycle. |
| `--no-security` | Metaproject Security (input/output + artifact scanning). |

**Hook flags** — git hooks are installed only for enabled modules. Under `--yes`
most default on; the testing **pre-push** hook stays off even under `--yes` (opt-in).
Pass the matching `--no-*-hook` flag to force a hook off:

| Flag | Skips hook |
|---|---|
| `--no-gdgraph-hook` | gdgraph post-commit hook (it rebuilds the graph; `KERYX_GDGRAPH_HOOK_REBUILD=0` downgrades it to a reminder instead). |
| `--no-gdskills-hook` | gdskills post-commit hook. |
| `--no-health-hook` | health post-commit hook. |
| `--no-testing-post-commit-hook` | testing post-commit (refresh) hook. |
| `--no-testing-pre-push-hook` | testing pre-push (gate) hook. |
| `--no-security-hook` | security **pre-push** gate hook. |
| `--no-security-agent-hook` | security **`.claude/settings.json`** agent hook. |

**Capability flags** — opt-in ceilings that are **off by default**. Each has a
matching `--no-<capability>` form (the default) that keeps the generated
`metaproject.json` byte-identical to a plain `init`; only passing the positive
flag touches the manifest:

| Flag | Enables capability |
|---|---|
| `--mcp` / `--no-mcp` | The opt-in MCP server module (`mcp serve`). Interactively, `init` also offers this as a question (default No); `--mcp`/`--no-mcp` set it non-interactively. Wire a client config afterwards with `mcp install`. |
| `--treesitter` / `--no-treesitter` | The gdgraph tree-sitter symbol layer (optional `web-tree-sitter` dependency). |
| `--testing-tia` / `--no-testing-tia` | The testing coverage-map test-impact analysis (drives map-first `test run --changed`). |

The two security hooks are offered only when the `security` module is enabled and
default on (confirm prompt; accepted under `--yes`). The **pre-push** hook adds a
managed block to `.git/hooks/pre-push` that scans changed files with
`keryx security scan` before a push — it warns in `advisory` (the default)
and blocks the push in `enforced`/`ci`/`gateway` mode; it coexists with the testing
pre-push hook and any user content. The **agent** hook merges (merge-safe, never
clobbering existing settings) two Claude Code hooks into `.claude/settings.json`:
`UserPromptSubmit` → `security check-input` and `PreToolUse(Write|Edit)` →
`security check-output`, advisory by default.

---

## status

Print the local Metaproject status. Read-only — never writes.

```
keryx status [--help]
```

Reports one of: `not initialized` (no `.metaproject/`), `incomplete` (missing or
invalid `metaproject.json`), or `ready` — in which case it prints the workspace
root and each module as `enabled` or `disabled`.

---

## modules

View and toggle Metaproject modules. Enabling or disabling a module re-runs
`init` with the appropriate `--no-<module>` flags to add or remove its scaffold.

```
keryx modules [status | enable <name> | disable <name>]
```

| Subcommand | Description |
|---|---|
| `status` (alias `list`) | Print each module and whether it is enabled. Also the default in a non-interactive (non-TTY) context. |
| `enable <name>` (alias `on`) | Enable a module by its `metaproject.json` key and re-scaffold it. |
| `disable <name>` (alias `off`) | Disable a module and drop it from the workspace. |
| _(no argument)_ / `interactive` / `-i` | Interactively toggle modules on/off, then apply via `init`. |

Module names are the manifest keys: `gdgraph`, `gdctx`, `gdwiki`, `gdskills`,
`health`, `testing`, `memory`, `tasks`, `security`.

---

## projects

Manage the **user-global project registry** — the set of projects on this
machine, and the addressing keys a remote transport routes by. `keryx init`
registers a project into it automatically; nothing on the machine knew the
project set before this registry existed.

```
keryx projects [list [--json] | register <path> | forget <id>]
```

| Subcommand | Flags | Description |
|---|---|---|
| `list` (default) | `--json` | Print every registered project with its id and root path. `--json` emits the machine-readable form. |
| `register <path>` | — | Register a project root explicitly. Idempotent. |
| `forget <id>` | — | Remove a project from the registry. Removes the registry entry only — it never touches the project's `.metaproject/` workspace or any file under its root. |

The registry is user-global (not per-project) and is what `keryx serve` resolves
a request's target project against. A request naming an unregistered project is
refused; there is no fallback to "some other project".

---

## auth

Authorize a **vendor-sanctioned subscription** (SuperGrok, ChatGPT Plus/Pro, GitHub Copilot) or inspect that state. Credentials are written to the user-global `auth.json` at mode 0600. Secrets are never printed.

Claude Pro/Max, Gemini Google-account login, and DeepSeek subscription OAuth are refused at the point of choice.

```
keryx auth list [--json]
keryx auth login <provider>
keryx auth logout <provider>
keryx auth status <provider> [--json]
```

| Subcommand | Flags | Description |
|---|---|---|
| `list` | `--json` | Authorized providers (method and expiry, never a token) and which subscription logins are offered. |
| `login` | `<provider>` | Run the provider's device authorization grant. Prints a verification URL and code (opens a browser only when a graphical session is present); keryx polls for the token. |
| `logout` | `<provider>` | Discard the stored grant. |
| `status` | `<provider>`, `--json` | Method, state, expiry, refreshability — never the secret. |

`/provider` in `keryx shell` offers the same SuperGrok vs API-key choice for xAI.

---

## providers

Report over the **provider configuration** — the built-in OpenAI-compatible
registry plus the operator-defined entries in `llm-providers.json` — plus, since
flow 304, `test` and `remove`: the CLI form of the `/connect` row buttons
("Test connection" and "Disconnect"). `list` and `cross-family` stay read-only
and network-free, exactly as before; `test` makes ONE network call (the live
`/models` probe), `status` (flow 309) reads or refreshes the live model
catalog, and `remove` writes to disk only after confirmation.

```
keryx providers list [--json]
keryx providers status [--json] [--refresh]
keryx providers cross-family [--opt-in] [--session-provider <id>] [--session-model <id>] [--from-shell-config] [--json]
keryx providers test <name> [--json]
keryx providers remove <name> [--yes]
```

| Subcommand | Flags | Description |
|---|---|---|
| `list` | `--json` | Providers this operator has actually **configured** — a custom entry in `llm-providers.json`, or a built-in with a resolvable credential — and the model family of each. Read-only, network-free. |
| `status` | `--json`, `--refresh` | The **live provider catalog** (flow 309): per connected provider, its status (`ok` / `auth-failed` / `unreachable` / `timeout` / `not-supported`), its live model count (or the curated offline count, clearly marked, when the live fetch failed), its balance when the provider exposes one (OpenRouter, DeepSeek — never a guessed number), and how old that reading is. An unconnected provider is never probed and never listed. A fresh cache (already refreshed by `keryx shell` starting up, `/connect`, or `providers test`) answers immediately; `--refresh` forces a fresh probe of every connected provider now. |
| `cross-family` | `--opt-in`, `--session-provider <id>`, `--session-model <id>`, `--from-shell-config`, `--json` | Decide whether review may run on a different model family than authored the change, and print the record the round should carry. The authoring session comes from the flags, else `KERYX_SESSION_PROVIDER`/`KERYX_SESSION_MODEL`; the selection `keryx shell` persisted only with `--from-shell-config`. |
| `test` | `<name>`, `--json` | Run that provider's live model-list probe (the same one `/connect` uses to decide what's "connected") and report `ok` with the model count, or the humanized failure reason. Exits non-zero on a failed probe. Also updates that provider's entry in the `status` catalog. |
| `remove` | `<name>`, `--yes` | **Disconnect** that provider: remove its saved API key, its OAuth grant, or its `llm-providers.json` entry (together with any saved base-URL/model-param override) — whichever one it actually has. Asks for confirmation on a terminal; refuses without one unless `--yes`. A provider whose only credential is an environment variable you exported yourself is refused outright — the command names the exact variable to `unset`. Disconnecting removes only keryx's LOCAL copy of the credential: an OAuth grant is deleted from `auth.json` with no vendor revoke call, and a removed API key simply stops being read (the key itself stays valid at the vendor until you revoke it there yourself). |

### Live provider catalog

`keryx shell` refreshes this catalog during startup loading (a "checking
providers…" step that never blocks the first prompt — a hung provider just
never fills in), and `/routing`'s flat model picker and `/connect` read the
same cache instead of a stale, hardcoded model list. The cache lives at
`provider-catalog.json` in the per-user keryx config directory, mode `0600`,
and never carries a credential — only `name`/`status`/`models`/`balance`/
`fetchedAt`.

### Cross-family review

Reviewing with a different model family than authored the code is worth ~8–10
recall points in the 1,000-PR study this feature is built on (Claude→Claude 53.7%
vs GPT→Claude 62.0%; GPT→GPT 50.5% vs Claude→GPT 60.0%).

Three properties, each of which the command enforces rather than describes:

- **Opt-in.** Without `--opt-in` the answer is `single-family`, whatever is
  configured. Dispatching to another provider spends tokens and sends the change
  to a second vendor; that is a decision, not an optimisation. The options that
  were declined are still listed, because "we chose not to" and "there was
  nothing to choose" are different facts.
- **Recorded, and read back.** The `--json` output is a `cross_family_review`
  block naming `author_family` and `reviewer_family`. Hand it to the round:

  ```bash
  keryx providers cross-family --opt-in --json > cross-family.json
  keryx review ingest --report round.md --ref <ref> --cross-family-review cross-family.json
  keryx review status <review-id>
  ```

  `review ingest` writes it onto `manifest.cross_family_review`; `review status`
  — a later, separate invocation — reads it off disk, prints it, and **exits
  non-zero** on a record that contradicts itself: `cross-family` naming no
  reviewer, naming the family that authored the change, or naming a reviewer that
  was never among the recorded candidates. A round that recorded nothing reports
  `not recorded`, which is **not** `single-family`: nobody decided.
- **Degrades, never fails.** With no second family configured it reports
  `single-family` with a stated reason and **exits 0**. One vendor is a normal
  configuration.

A gateway (`openrouter`) or a local runner (`ollama`, `rapid-mlx`) is deliberately
**not** classified as a family — it fronts many. Such a provider contributes
candidates only through the specific models it lists, so a round is never
recorded as cross-family when both sides in fact ran the same vendor.

---

## routing

The **routing table** — flow 305 — maps a task category to a model, so
different kinds of work land on different providers/models without running
`/model` before every turn. Two config layers, same precedence pattern as
`security.config.json`: **explicit per-call override > per-project
`routing.config.json` > per-user entry (shell config) > session default**.

Categories (PRD `docs/requirements/keryx-jev-router/PRD.md` §4): `default`,
`review`, `subagents`, `quick`, `coding`, `planning`, `docs`, `unattended`.
Only `review` (`keryx review tier`) and `subagents` (`spawn_subagent`) are
**wired** in this release — resolved automatically at their call site; the
rest are catalogue entries the table/CLI/`/routing` already support, ready for
a later flow to wire up without a second migration.

**Not connected falls through.** An assignment naming a provider the operator
has not connected — or a model that provider does not list — is treated as
unresolved at its layer and falls through to the next one (project -> user ->
session default), at every call site (`review tier`, `spawn_subagent`,
`keryx routing list`, `/routing`). "Connected" is the same notion `/connect`
uses (configured/detected providers and their reported models) — never an
extra live network probe on every resolution. `keryx routing list` and
`/routing` show the rejected entry:

```
<provider>/<model> - not connected, falling back to <resolved>
```

**A project `routing.config.json` requires approval.** Because it is a
COMMITTED file, a repository could otherwise silently steer which model
reviews its own diff. A project entry takes effect only after the operator
has approved its CURRENT content once — a content fingerprint recorded per
user, keyed by project root (the same "approve the exact thing that will run"
shape `.keryx/mcp-servers.json` project-scope trust already uses). Until then,
and whenever the file changes afterward (a pure reformat does not count — the
fingerprint is over the validated category table, not the raw bytes), its
entries are ignored, with a visible notice in `keryx routing list`, `/routing`
and `keryx review tier`'s output. `keryx routing trust` shows the file's
entries and then approves it; a routed review model is printed with
`routed: true`, never folded into `tier_resolution: "discovered"` (which
means the TIER, not routing, picked the model).

```
keryx routing list [--json]
keryx routing set <category> <provider>/<model> [--user|--project]
keryx routing set <category> <provider> [--user|--project]
keryx routing unset <category> [--user|--project]
keryx routing trust
```

| Subcommand | Flags | Description |
|---|---|---|
| `list` | `--json` | Every category, its resolved assignment (`session default`, `<provider>/<model>`, or `<provider> (provider default)`), which layer answered (`project`, `user`, or `default`), and — when applicable — the not-connected entry it fell back from. |
| `set` | `<category> <provider>/<model>`, `--user`\|`--project` | Pin an exact model for a category. Default layer: `--user`. A `--project` write is not auto-approved — run `keryx routing trust` afterward. |
| `set` | `<category> <provider>`, `--user`\|`--project` | Pin a provider's own default model for a category (no `/model` — the "provider default" form). |
| `unset` | `<category>`, `--user`\|`--project` | Clear a category back to `session default`. Default layer: `--user`. |
| `trust` | — | Print `routing.config.json`'s entries and approve its current content, so the project layer starts applying. |

In the TUI, `/routing` opens a list+detail modal: the list side shows every
category's current resolution (with a not-connected fallback notice inline,
and an unapproved-project notice when relevant); selecting one opens a
**flat** searchable model picker — one list spanning every connected
provider's models (built on the same type-to-filter machinery `/model` uses),
never a "pick a provider first" step — with a "provider default" row per
connected provider and a "session default" row. A confirmed pick writes
immediately to the per-user layer. `t` on the list side shows the project
file's entries and arms an approval; `y` confirms, any other key cancels.

---

## serve

An **opt-in, off-by-default** loopback-bound HTTP entry over the same agent
harness `keryx shell` drives. It exists so a bot, a browser workspace, or a
third-party embedding becomes a client of one surface rather than a second
agent runtime with its own copy of session state.

```
keryx serve [--bind <addr>] [--port <n>] [--profile <name>] [--acknowledge-non-loopback]
keryx serve status [--json]
keryx serve token issue | rotate | revoke
keryx serve config init | set | show
```

| Subcommand | Flags | Description |
|---|---|---|
| _(no argument)_ | `--bind <addr>`, `--port <n>`, `--profile <name>`, `--acknowledge-non-loopback` | Bind and listen. Defaults to loopback; a non-loopback bind requires `--acknowledge-non-loopback` and is never the default. `--profile` selects the remote policy profile. |
| `status` | `--json` | Report state. **Configuration state only** — there is no PID file, so a listener in another process is not visible here; `listening` and `draining` are knowable only over the authenticated `GET /v1/status`. |
| `token issue \| rotate \| revoke` | — | Bearer-token lifecycle. Only a **salted hash** is persisted; the plaintext token is printed once, at issue, and cannot be recovered afterwards. |
| `config init \| set \| show` | — | Create, modify, and print the listener configuration. Without a config, `serve` does not listen. |

### Routes

| Route | Description |
|---|---|
| `GET /v1/status` | Listener state, authenticated. |
| `GET /v1/projects` | The projects this listener will accept turns for. |
| `POST /v1/turns` | Submit a turn. Takes an idempotency key **scoped per project**, so two projects cannot collide on one key. |
| `GET /v1/turns/<id>` | The durable turn record, and its server-sent-event stream. |

### Boundaries

These are properties of the implementation, not advice:

- **Authentication runs before routing.** An unauthenticated caller cannot
  distinguish a known path from an unknown one — both answer identically.
- **Bearer tokens are compared in constant time.**
- **`refused` binds no socket at all.** It is a terminal state, never a degraded
  listen: a listener that cannot satisfy its configuration does not open a port.
- **The remote policy profile may never be weaker than the local one.** It is
  compared per turn, and a weaker profile is refused rather than accepted.
- **Approvals are not implemented.** A turn whose policy decision is `ask`
  terminates in a **recorded denial**. This is written into the turn module as a
  stated boundary rather than left to follow from the absence of an approval
  store, because an accident stops holding the moment the store lands.
- **Repeated authentication failures are throttled**, per peer.
- **`GET /health` does not exist.** Liveness is authenticated-only today.

---

## update

Refresh managed "service" files (templates, manifests, skills, hooks, dashboard)
to match the current runtime, without ever writing under `.metaproject/data/`.
Also self-updates the runtime it was launched from and backfills newly added
modules. Errors with exit code `1` if `.metaproject/` does not exist.

```
keryx update [--skip-runtime] [--hooks] [--no-tasks]
```

| Flag | Description |
|---|---|
| `--skip-runtime` | Skip the git fetch/checkout that self-updates the vendored runtime. |
| `--hooks` | After refreshing, run every executable in `.metaproject/hooks/post-update.d`. Without it, a hint is printed instead. |
| `--no-tasks` | Do not auto-enable (backfill) the tasks/flow module on pre-tasks workspaces. |
| `--help`, `-h` | Print `update` usage and exit. |

---

## sync

Reconcile the derived layers — graph, wiki, memory — with the current code. Each
artifact records the commit it was built from; `sync` diffs that commit against
`HEAD` and reports exactly what changed, or updates the artifact incrementally and
advances its provenance. This is what keeps a `git pull` or a branch switch from
leaving the agent reading a stale map.

```
keryx sync                    # report added / changed / deleted since each artifact was built
keryx sync --apply            # update the artifacts incrementally and advance provenance
keryx sync install-hooks      # run sync on git pull (post-merge) and branch switch (post-checkout)
keryx sync uninstall-hooks
```

| Subcommand / flag | Description |
|---|---|
| *(none)* | Advisory report per module. Prints `HEAD`, then per artifact either "up to date" or the change counts with the first few paths. Always exits `0` — the hooks decide what to do with the report. |
| `--apply` | Rebuild each stale artifact incrementally and record the new provenance. An artifact with no provenance yet is built as a baseline. Takes the project's maintenance lock (see [trigger](#trigger) → **Locking**): when another keryx run holds it, waits up to `KERYX_MAINTENANCE_LOCK_WAIT_MS` (default 120 s), then exits `75` naming the holder's pid. |
| `install-hooks` | Install `post-merge` and `post-checkout` git hooks that run the advisory report. Prints that nothing was installed when there is no `.git`. |
| `uninstall-hooks` | Remove them. |
| `--help`, `-h` | Print `sync` usage and exit. |

Outside a git repository the command reports that there is nothing to sync and
returns. When `--apply` updates the wiki and files were deleted, orphaned pages
are pruned; a human-owned page whose module disappeared is reported rather than
deleted.

---

## trigger

Fire one declared project trigger — the single entry point every git hook, cron
line, systemd timer and CI job calls. A trigger is declared by hand in
`.metaproject/triggers.json` (keryx never writes this file — see
[sync](#sync) and [update](#update) for the files it *does* own), each entry
naming what fires it (a repository event or a schedule) and what it does
(`reconcile`, `rebuild`, `open-flow`, or `flow-next`). Scheduled agent tasks
(`agent-task`) are the one kind keryx writes. It writes them only after you
confirm, and into a separate per-machine store, never into `triggers.json`. See
[schedule](#schedule).

### The config file

`.metaproject/triggers.json`:

```json
{
  "schemaVersion": 1,
  "triggers": [
    { "name": "reconcile-on-merge", "on": { "kind": "event", "event": "post-merge" },
      "action": { "kind": "reconcile" }, "enabled": true },
    { "name": "rebuild-on-commit", "on": { "kind": "event", "event": "post-commit" },
      "action": { "kind": "rebuild" } },
    { "name": "nightly-maintenance", "on": { "kind": "schedule", "cron": "0 2 * * *" },
      "action": { "kind": "open-flow", "template": "Nightly graph/wiki maintenance", "skipIfOpen": true } },
    { "name": "report-next-task", "on": { "kind": "event", "event": "ci" },
      "action": { "kind": "flow-next", "flow": "142-2026-08-01-nightly-maintenance" } },
    { "name": "overnight-next-task", "on": { "kind": "schedule", "cron": "0 1 * * *" },
      "action": { "kind": "flow-next", "flow": "142",
        "dispatch": { "provider": "anthropic", "model": "claude-sonnet-4-5", "permissionMode": "trust",
                      "rates": { "inputUsdPerMTok": 3, "outputUsdPerMTok": 15 },
                      "ceilingUsd": 2, "maxSeconds": 1800, "maxAttempts": 3 } } }
  ]
}
```

Each entry: `name` (unique, also the `trigger run <name>` argument — letters,
digits, `-`, `_`, `.`, max 64 chars), `on` (`{ kind: "event", event:
"post-merge" | "post-commit" | "post-checkout" | "ci" }` or `{ kind:
"schedule", cron: "<5- or 6-field cron expression>" }`), `action`, and
`enabled` (defaults to `true`). `"ci"` is declared, not hooked — nothing writes
a git hook for it; it exists so an entry can say "a CI job calls `keryx
trigger run` for this itself" and show up in `list`/`status`.

Action kinds:

- `{ "kind": "reconcile" }` — one pass of `keryx sync --apply`.
- `{ "kind": "rebuild" }` — one pass of `keryx gdgraph build`.
- `{ "kind": "open-flow", "template": "<flow title>", "skipIfOpen"?: true }` —
  `keryx flow init --title "<template>"`. With `skipIfOpen`, a fire is a no-op
  when another flow's title is exactly `template` and that flow's status is
  not `done` (an `initializing`, not-yet-`start`ed flow still counts as open).
- `{ "kind": "flow-next", "flow": "<flow id>" }` — **report-only**: records
  `keryx flow next <flow>`'s decision into the run record. `list`/`status` show
  it as `flow-next(<flow>, report-only)`.
- `{ "kind": "flow-next", "flow": "<flow id>", "dispatch": { … } }` —
  **dispatches** a keryx agent to work the flow's next task, unattended. See
  **Dispatching `flow-next`** below.
- `{ "kind": "agent-task", … }`: a free-form scheduled agent task that leaves
  a report. It is created only with `keryx schedule add` or `/schedule` and lives in
  `.metaproject/data/trigger/schedules.json`. An `agent-task` written into
  `triggers.json` is refused on load. See [schedule](#schedule).

An entry that fails validation is refused on load with the reason, and its
neighbours still load; a later entry re-using an already-used `name` is
refused the same way. `keryx trigger list` prints every rejected entry
alongside the valid ones.

### Subcommands

```
keryx trigger run <name>        # perform exactly one pass of <name>'s action
keryx trigger install           # write a git hook block for every event-fired entry
keryx trigger uninstall         # remove those hook blocks
keryx trigger list              # list declared entries: enabled state, fire, action, hook status
keryx trigger status [<name>]   # show the last recorded outcome for one or every entry
keryx trigger schedule <name>   # print the cron line / systemd timer unit (real OnCalendar=) for a schedule entry
```

| Subcommand | Description |
|---|---|
| `run <name>` | Resolve `<name>` against `.metaproject/triggers.json` and perform exactly one pass of its action. |
| `install` | Write a managed hook block (`# keryx:trigger-<name>:begin/end`) into `post-merge`/`post-commit`/`post-checkout` for every declared, event-fired entry — `enabled` or not, so re-enabling one later takes effect on its next fire without reinstalling. No `.git` directory: prints and does nothing. |
| `uninstall` | Remove those blocks. Every other managed block in the same hook file is untouched. |
| `list` | List every declared entry — name, enabled state, what fires it, what it does, and whether its hook is installed — plus every rejected entry and why it was refused. |
| `status [<name>]` | Print the last recorded outcome for one entry, or every entry, read from the run record (below). |
| `schedule <name>` | Print the cron line and the systemd service/timer pair for a schedule-fired entry, with a real `OnCalendar=` translated from the cron and a project-unique unit name. Installs nothing. `keryx schedule add` installs a timer for you. |
| `--help`, `-h` | Print `trigger` usage and exit. |

**Exit codes.** Non-zero only when the action itself failed (for a dispatch:
the task did not end `done`), the name is unknown, or the matching entry is
malformed. Every other outcome exits `0`: nothing declared, a disabled entry,
a lock refusal, a budget refusal and a dispatch refusal are all "nothing done
this pass", not an error — which is also how each is classified in the run
record.

### Dispatching `flow-next`

A `dispatch` block turns `flow-next` from a report into real work: one fire
starts one keryx agent on the flow's next ready task, with no terminal and
nobody present, and records what happened.

| Field | Required | Meaning |
|---|---|---|
| `provider`, `model` | yes | The model the agent runs on. Only providers known to report token usage on every response are accepted: `anthropic`, `openai`, `gemini`, and an OpenAI-compatible provider whose registry entry sets `streamUsage` (today: `grok` and `deepseek`). Anything else is refused (`provider-usage-unknown`). A provider with no usable credential is refused before anything is written. |
| `permissionMode` | no (`ask`) | `ask` — every non-read call is denied (read-only by construction). `trust` — non-destructive `shell_exec`/`apply_patch` run, **inside the hardened sandbox, which is then mandatory**. `auto` is **rejected at load**. |
| `rates` | yes | `{ inputUsdPerMTok, outputUsdPerMTok }` — USD per million tokens, both **greater than zero**. Without rates, or with a zero rate, a run is free to the ceiling; the entry is rejected at load. |
| `ceilingUsd` | yes | This trigger's own spend ceiling, on top of the project-wide one. Rejected at load when absent. |
| `maxSeconds` | no (1800) | Wall-clock limit for one agent run. |
| `maxAttempts` | no (3) | A task whose attempt count has reached this is not dispatched again. |
| `baseUrl` | no | Provider base URL override — **loopback only** (`localhost`, `127.0.0.0/8`, `[::1]`). `triggers.json` is a committed file and the run sends the operator's saved key for `provider` to this URL, so a non-loopback URL is rejected at load. |
| `network` | no (`false`) | Network for the agent's **shell commands**. `true` gives them the host's **full** network: the internet, every service on the host's loopback (a local model server, a database, …) and the host's abstract unix sockets — nothing is filtered, and `keryx trigger list` says so for the entry. The **model call** is made by the dispatcher itself, outside the sandbox, so talking to the provider — including a local Ollama on `127.0.0.1` — never needs this. Leave it off unless the task's own commands truly need the network (a loopback-only mode via `slirp4netns --disable-host-loopback` is possible but not built in this version). |

**One fire, in order** — every refusal happens before any model call:

1. A per-flow dispatch lock: a second dispatch on the same flow refuses
   (`dispatch-refused`, `dispatch-locked`); different flows do not wait on
   each other.
2. The flow must be `in-progress` with frozen acceptance criteria, `flow next`
   must be `ready`, the ready task must have no open attempt, and its attempt
   count must be under `maxAttempts`. Otherwise `dispatch-refused` with the
   cause (`flow-not-in-progress`, `flow-not-frozen`, `nothing-ready`,
   `blocked`, `open-attempt`, `attempt-cap`), exit `0`.
3. Containment: `trust` refuses (`sandbox-unavailable`, exit `0`, reason
   recorded) unless the hardened sandbox below can be built — no launcher, a
   launcher that cannot create namespaces, a non-Linux host,
   `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` or `KERYX_SANDBOX_SHELL=off` all refuse.
   `ask` may run without one: every command and patch is an approval request,
   every approval request is denied, and its shell runner refuses every command
   as well.
4. The spend reservation: under a project-wide spend lock, the remaining
   allowance (the smaller of the trigger's and the project's) is written to the
   ledger as a `reserved` record **before the first model call**. At or over
   either ceiling, or with nothing left to reserve → `budget-refused`, exit `0`.
   Two triggers firing together cannot both get the full allowance.
5. A throwaway git worktree on branch `trigger/<flow>-<task>` (reused when it
   exists). Never your checkout; the branch is never pushed. A worktree a
   killed run left registered to that branch is recovered first — removed when
   it is under the dispatcher's own worktree directory, pruned when its
   directory is gone; a branch checked out anywhere else refuses
   (`worktree-conflict`) and is never touched.
6. `flow task attempt <flow> <task> --outcome started` with the run id —
   before the model is called.
7. One agent turn in the worktree (see **Unattended posture**), stopped by
   `maxSeconds`, when its priced cost reaches the reservation, or when a
   response arrives without token usage (that run is charged its whole
   reservation).
8. Whatever changed is committed on the trigger branch; then `keryx health run`
   and `keryx health gate` run in the worktree **inside the same sandbox** —
   they execute code the agent wrote.
9. Exactly one closing fact: `flow task done --disposition completed` with a
   `runLink` **only** when the turn ended normally, the branch has a new commit
   and the health gate passed; otherwise `flow task attempt --outcome
   failed|blocked` with the reason (`blocked` when the run was stopped by
   denials or by `ask_user`). The worktree is removed; the branch stays for you
   to review and merge.

**The unattended sandbox (Linux, bubblewrap).** Every `shell_exec` of a
dispatched run, and its health gate, run inside a profile built from allow
lists: `/` read-only; your home directory and **all of `/run`** (and
`/var/run` where it is not a symlink to it) hidden behind an empty tmpfs.
`/run` is where the host's services listen — the system D-Bus, systemd-resolved,
tailscaled, libvirt, snapd, Docker, ssh-agent and gpg-agent under
`/run/user/<uid>` — and turning the network off does **not** isolate unix
path sockets, so the whole directory is hidden rather than known sockets masked
by name. Nothing under `/run` is bound back; with `network: true` only the
resolver file `/etc/resolv.conf` points to is bound back, read-only; bound back read-only only the toolchain roots found on `PATH` under
your home (`~/.bun`, an nvm node version — detected, not hard-coded), the
repository's git directory, the keryx package and `node_modules`; the worktree
and a scratch `HOME` read-write; a private `/tmp`; the Docker socket masked;
network off unless `dispatch.network: true` (abstract-namespace unix sockets
are per network namespace, so they are isolated with it). The environment is an allowlist —
`PATH`, locale, `TERM`, `TZ`, colour flags — with `HOME`, the XDG directories
and `TMPDIR` pointed at the scratch home: no exported token, no
`SSH_AUTH_SOCK`. The known-secret deny list (`~/.ssh`, `~/.config/gh`, …) is
still applied inside anything bound back. macOS `sandbox-exec` is not
implemented for this profile, so `trust` refuses on macOS.

**Unattended posture — fail closed.** The agent runs with `unattended: true`.
Its permission mode is the entry's — never the project's stored default
(`/mode`), never the saved shell allowlist. Every call that would ask — a
write or command under `ask`, a destructive one under `trust`, anything
touching credentials or the SAC confirm flow, anything after untrusted
content, `ask_user` — is **denied and written to the run record** with the
tool and the reason; nothing is ever approved on your behalf. On top of the
mode, a text floor denies: `git push` (any form), `git merge`, `git tag`, `git
update-ref`, `git branch -f|-D|-m|…`, `gh pr merge`, `gh release`, `gh api`
with a mutating method or a body, `npm publish`, `bun publish`; `keryx flow
freeze`, `flow start`, `flow ac update|reseal|confirm`, `flow implemented`,
`flow complete`, `flow renumber`, `flow block|unblock`, `flow task
add|depends|done|attempt|skip`, `keryx trigger run` (no nested dispatch); and
any write — by `apply_patch` or by a command that names them — to
`flow.json`, `acceptance-criteria.md`, `.metaproject/triggers.json` or
`.metaproject/data/trigger/**`. **The floor is defence in depth, not the
boundary**: it is text matching, a shell can spell a command in ways it does
not see (quoting, `$(…)`, aliases, `bun -e`/`python3 -c`), and it is
deliberately over-broad (a commit message containing "tag" is refused). The
boundary is the sandbox — with the network off and credentials hidden, a push
or an API call that slips past the text has nothing to authenticate with and
nowhere to go. The tool roster is `get_cwd`, `list_dir`, `read_file` (confined
to the worktree), `shell_exec`, `apply_patch` — no `web_fetch`, `web_search`,
`search_tool`/`use_tool`, `spawn_subagent` or `ask_user`.

**Cost.** Every dispatched run records `cost: { recorded: true, usd, tokens:
{ input, output } }` — tokens as the provider reported them, USD from the
entry's `rates` — including a run that failed, timed out, was stopped, or hit
an error while writing its closing fact. That record also closes the run's
`reserved` record. Both ceilings sum recorded costs **plus every reservation
no record has closed yet**, so a run in flight — or one whose process was
killed — keeps its whole reservation counted. `keryx trigger status` lists
open reservations; once you know the killed run is gone, close its
reservation with what it really spent (from your provider's console):

```
keryx trigger resolve <runId> --spent <usd>
```

There is no default for `--spent`: guessing would be the fail-open this
exists to prevent.

### The run record

Every `run` that resolves to a real, declared entry (`disabled` or `ready`)
appends one line to `.metaproject/data/trigger/runs.jsonl` — when it fired,
what fired it (`on`, verbatim), what it did (`action`, verbatim), the outcome
(`ok`, `no-op`, `lock-refused`, `budget-refused`, `dispatch-refused`, or
`failed`), a human-readable detail, and its cost — `{ recorded: false, reason }`
for every action that calls no model, `{ recorded: true, usd, tokens }` for a
dispatched `flow-next`. A dispatch also records `dispatch: { runId, flow,
task, attempt, branch, closing, refusal?, denials? }`. A scheduled `agent-task`
run records `agentTask: { runId, reportPath?, grantedCalls, denials?,
refusal?, permissionMode, network }`. Lines written before
`tokens`/`dispatch` existed still read. A run that never reaches a concrete entry (no config,
unknown name, malformed entry) is not recorded — that stays a stderr line and
an exit code. `status` reads this file; it never resolves or re-runs anything.
Taken from a real run:

```
$ keryx trigger status
keryx trigger status (reading /path/to/project/.metaproject/data/trigger/runs.jsonl):
  - nightly-reconcile  [enabled]  schedule:"0 2 * * *"  -> reconcile
      last: 2026-09-22T19:33:15.623Z — ok — action "reconcile" completed. [cost: not recorded (this action does not call a model — reconcile/rebuild are deterministic, no spend to record)]
```

**Locking.** One project maintenance lock —
`.metaproject/data/.locks/maintenance.lock`; the `.locks` directory carries its
own `.gitignore` (`*`), so a `git add -A` that runs while a build holds the
lock (the post-commit hook's own rebuild is such a moment) never commits it,
and it stays writable inside the unattended sandbox — is shared by `keryx sync --apply`,
`keryx gdgraph build`, and the triggered `reconcile`, `rebuild` and
`open-flow`. A triggered run that finds it held refuses at once
(`lock-refused`, exit `0`, the holder's pid named) — one run stays exactly one
pass. An interactive `sync --apply` or `gdgraph build` waits instead, up to
`KERYX_MAINTENANCE_LOCK_WAIT_MS` (default 120 s), then exits `75` naming the
holder's pid — "not run", not "build failed"; the `post-commit` hook reports
exit `75` as a skipped rebuild. The lock is re-entrant within one process's
call chain, so `sync --apply` building the graph, or a triggered `reconcile`
running `sync --apply`, never waits on itself. A dispatching `flow-next` does
**not** hold it while the agent runs — the agent's own `keryx gdgraph build`
must be able to take it — and uses its own per-flow dispatch lock instead.
(Flow 286 described its trigger lock as the one the interactive commands take;
until this change they took none.)

**Installing hooks.** `install`'s blocks live beside the ones `keryx sync
install-hooks` (its `keryx-sync` block) and `keryx update` (its
`gdgraph-post-commit`, `gdwiki-post-commit`, etc. blocks) already write into
the same `post-merge`/`post-commit`/`post-checkout` files — each installer
owns only its own delimited block, so all of them, plus any hand-authored
content already in the file, coexist regardless of install order.

**Scheduling.** `schedule <name>` runs no daemon and installs nothing itself —
it prints a ready-to-use cron line and an alternative systemd service+timer
pair for you to install with your own scheduler. The timer carries a real
`OnCalendar=`: each cron field is expanded to an explicit list, which systemd
always accepts, and a test checks it with `systemd-analyze calendar`. A cron
with no systemd equivalent (day-of-month AND day-of-week both restricted) keeps a
commented placeholder and says why. Unit names are `keryx-<projecthash>-<name>`,
so two projects never share one. To have keryx install the timer for you, after a
confirmation, use [schedule](#schedule). Both bake in the absolute
path to the interpreter (`node`/`bun`) and script actually running `keryx
trigger schedule`, plus an explicit `PATH` (that interpreter's own directory,
then `/usr/local/bin:/usr/bin:/bin`, for whatever the action shells out to,
e.g. `git`) — never bare `keryx`, because cron and a systemd unit resolve
commands with a minimal or absent `PATH` that a version-manager install (nvm,
bun) is frequently not on. Output is appended to
`.metaproject/data/trigger/<name>.schedule.log`. **Assumption, stated rather
than hidden:** the printed paths stay valid only while the resolved
interpreter and script stay where they were at the moment you ran `schedule`
— an nvm prune, or a `node`/`bun` version switch, afterward needs a
regenerate-and-reinstall of the line.

### Honest limits

- **A dispatched task is "done" by the dispatcher's checks, not by review.**
  `task done` means: the turn ended normally, the trigger branch got a commit,
  and `keryx health gate` passed in the worktree. Nobody has read the diff; the
  branch waits for you. A fresh worktree has no dependencies of its own — the
  project's `node_modules`, when present, is linked in for the gate.
- **The unattended text floor is defence in depth.** It is over-broad by
  design and still incomplete by construction (a shell can spell a command
  many ways). The boundary is the hardened sandbox, which `trust` requires —
  Linux with a working bubblewrap only in this version.
- **Review the trigger branch before you install or build it.** The agent can
  commit anything a task could — including a `package.json` script or a build
  step that runs when you later install or build that branch on your machine.
- **The sandbox hides your home, not the host.** `/` stays readable (read-only)
  outside the hidden directories, so a secret kept outside `$HOME` and outside
  the known deny list — `/etc/some-token`, another user's readable file — is
  visible to the agent's commands, and through them to the model provider.
- **Cost is priced from your rates.** keryx has no price table; if `rates` are
  wrong, both ceilings are wrong by the same factor. Token counts are summed
  from every usage event the provider emits.

---

## schedule

Scheduled agent tasks, run in the background. You describe a task and a cadence,
for example "check open PRs on my repo every 4 hours and summarise what needs my
attention". keryx shows you a **confirmation card**. Only after you confirm does it
store the schedule and install an OS timer that runs the task unattended. Each run
leaves a **report** you read later in `keryx shell` or with `keryx schedule show`.

keryx still runs no daemon of its own. The OS scheduler calls `keryx trigger run
<name>` from the project root:

| Backend | Where | Catch-up after the machine was off/asleep |
|---|---|---|
| systemd `--user` (Linux) | `~/.config/systemd/user/keryx-<projecthash>-<name>.{service,timer}`, `OnCalendar=` translated from the cron, `Persistent=true` | one catch-up run at the next boot/wake |
| launchd (macOS) | `~/Library/LaunchAgents/ai.keryx.<projecthash>.<name>.plist`, `StartCalendarInterval` | one catch-up run on wake |
| cron (elsewhere) | a marked block in your crontab (`# >>> keryx-managed <projecthash> <name> >>>`) | none |

```
keryx schedule add --name <name> --every "<cadence>" --prompt "<task>" \
    --provider <p> --model <m> --rates <in>,<out> --ceiling <usd> \
    [--max-seconds 600] [--mode ask|trust] [--network off|full|allowlist] \
    [--domain example.com]... [--tool <id>]... [--repo owner/name]... [--backend systemd|launchd|cron] [--yes]
keryx schedule list
keryx schedule show <name>
keryx schedule pause <name>
keryx schedule resume <name>
keryx schedule run <name>
keryx schedule remove <name> [--yes]
```

| Subcommand | Description |
|---|---|
| `add` | Draft the schedule, print the confirmation card, then store it and install its timer **only after you confirm**: `y` at the prompt, or `--yes`. It needs a terminal on both stdin and stdout; without one it refuses (exit 1), `--yes` included, so a pipe, an agent's shell or an unattended run cannot confirm it. Declining writes nothing and installs nothing. |
| `list` | Every schedule: cadence, enabled or paused, timer installed or not, next run, last outcome with its cost, and the last report's path. |
| `show <name>` | The same row plus the prompt, the runner and budget, the grants, the last five runs, and the latest report. |
| `pause <name>` | Disable the timer and mark the entry disabled. A fire while paused records `no-op`. |
| `resume <name>` | Re-enable both. No new confirmation is asked, so resume first checks that the entry still carries this machine's signature and that every granted binary still matches its pin, and refuses with the reason otherwise. It reinstalls the keryx recorded when you confirmed the card, never the one running `resume`. |
| `run <name>` | One pass now (`keryx trigger run --schedule <name>`: local schedules only). |
| `remove <name>` | After a confirmation, uninstall the timer and delete the entry. keryx deletes only files that carry its `# keryx-managed <projecthash> <name>` header. Anything else found at those paths is left untouched and named. |

**Drafting checks the provider before the card is even shown.** `add`, `/schedule`
and the agent's `schedule_create` tool all draft through the same code, which
refuses — before anything is written or installed — a provider that is not known
to report token usage on every response (`anthropic`, `openai`, `gemini`, or a
registry provider whose entry sets `streamUsage`, for example `grok` or
`deepseek`; see [Dispatching flow-next](#dispatching-flow-next)), and a provider
with no usable credential in this environment. Both use the same resolution the
scheduled run itself would use, so a confirmed card cannot install a timer whose
every fire is bound to refuse with `dispatch-refused (provider-usage-unknown)` or
for want of a credential.

**Cadence.** A five-field cron expression, or one of `every N hours` (a divisor of
24), `every N minutes` (5, 10, 15, 20 or 30), `hourly`, `daily at HH:MM`,
`weekdays at HH:MM`, `every monday at HH:MM`. The phrase is turned into cron by
fixed code, never by the model. The card shows the cron and the next three run
times, so a wrong translation is visible before anything is installed. A cron that
restricts both day-of-month and day-of-week is refused: cron fires on either,
systemd and launchd only on both.

**The confirmation card** lists:

- the cadence and the next three run times;
- the prompt;
- the provider and model, with the permission mode;
- the schedule's ceiling, its max seconds, and your rates;
- the network mode;
- every granted tool, with the absolute binary it runs, the repositories it may
  touch, and the account it acts as;
- the backend and file paths, and the exact command the scheduler will execute;
- the linger status;
- the limits.

The same card appears in `keryx shell` for `/schedule` and for the agent's
`schedule_create` tool.

**What the scheduled run is, and what it may do.** An `agent-task` runs one
unattended agent turn on your prompt. The unattended posture and the text floor are
exactly those of a dispatched `flow-next` (see [trigger](#trigger)). The differences:

- there is no flow, task, worktree branch, commit or health gate;
- the agent's working directory is a scratch directory, and the project is bound
  **read-only**;
- the roster is `get_cwd`, `list_dir`, `read_file`, `shell_exec` (inside the hardened
  sandbox) and the granted tools. There is no `apply_patch`, web, MCP, subagents or
  `ask_user`.

`--mode ask` (the default) makes every shell command an approval request, and an
unattended run denies every approval request. Granted tools still run under `ask`,
because they are read-only. `--mode trust` lets non-destructive shell commands run
inside the sandbox, and refuses to start without one. `auto` is never accepted.
The floor additionally refuses `keryx schedule add|remove|pause|resume|run`,
`keryx trigger schedule`, `systemctl … enable|disable|start|stop|daemon-reload`,
`crontab`, `launchctl` and `loginctl`. It also refuses any write to the schedule
store or the reports. **No grant lifts any of it.**

**Grants.**

- **Network:** `off` (default: `--unshare-net`), `full` (the host's whole network,
  always shown with the NETWORK ON warning), or `allowlist` (Linux only). `allowlist`
  still runs `--unshare-net` — the sandbox's netns has only its own private loopback,
  and the host's real loopback stays unreachable from inside it — plus a UNIX socket
  bind-mounted in for a domain-allowlisting proxy keryx runs OUTSIDE the sandbox. A
  keryx-shipped forwarder inside the sandbox bridges `HTTP(S)_PROXY` to that socket
  (most tools cannot speak to a unix-socket proxy directly). `--domain` (repeatable,
  or comma-separated) names every reachable domain — an exact name or a `*.domain`
  wildcard; at least one is required. The proxy allows plain HTTP by `Host` and HTTPS
  `CONNECT` by authority ONLY for listed domains, refuses a bare IP-literal target
  outright, and after resolving an allowed name refuses a loopback, private,
  link-local, CGNAT, unique-local or cloud-metadata address — connecting to the exact
  address it checked, never a fresh lookup, so a name that resolves differently on a
  second (DNS-rebinding) lookup cannot slip through. HTTPS is a blind `CONNECT` relay
  by default (no TLS termination), so the proxy cannot see SNI or an in-tunnel `Host`.
  **`allowlist` governs ONLY the agent's own `shell_exec` commands inside the
  sandbox** — the model call and every granted tool already run OUTSIDE the sandbox,
  on your own network, and are unaffected by this grant. A client that ignores
  `HTTP(S)_PROXY` gets no network at all (the sandbox's netns has no other route out).
  macOS, and any host without a working bwrap, refuses `allowlist` with the reason —
  it never silently falls back to `off` or `full`. Every allow/deny decision (host,
  port, allowed, reason, time) is recorded in the run's report and its ledger entry,
  and is part of the operator-confirmed, signed schedule content — changing the
  domain list after confirmation refuses the run with `grants-changed`, the same as
  changing anything else about it.
- **Granted tools:** a fixed, reviewed catalogue: `gh.pr.list`, `gh.pr.view`,
  `gh.pr.checks`, `gh.issue.list`, `gh.issue.view`, `gh.run.list`. It includes no
  `gh api` and no free-form argv. **keryx runs a granted tool itself, outside the
  sandbox, with your credentials**, via `execFile`:
  - there is no shell;
  - the argv is fixed;
  - parameters are pattern-checked, and none may start with `-`;
  - the repository must be one listed with `--repo`;
  - each call has a 30-second timeout and a 64 KB output cap.

  The model only ever receives the tool's output, after the secret detector has run
  over it and the exact value of every credential-looking environment variable has
  been scrubbed. Your token is never in the sandbox, the model context, the provider
  request or the report. A granted tool's output (PR bodies, comments) is marked
  untrusted: under `trust`, a later write that follows it asks, and so is denied.

**Security.**

- **Signed by this machine.** Every stored schedule is signed with an HMAC-SHA256.
  The key is a per-machine secret in keryx's user-global directory
  (`schedule-hmac.key`, 0600), created the first time you confirm a schedule. The key
  lives outside the project and is hidden from every sandboxed run. A committed or
  hand-written store entry cannot carry a valid signature, so it never runs. A missing
  or group-readable key refuses every stored schedule (`schedule-key-unavailable`).
- **Never committed.** A schedule store tracked by git is refused whole.
- **Timers only, never git hooks.** A stored schedule can only be `on.kind:
  "schedule"`. It is never a git-event trigger and never gets a git hook.
- **Your own name wins.** A committed `triggers.json` entry with the same name as a
  local schedule is refused, and the local schedule wins. The installed timer runs
  `keryx trigger run --schedule <name>`, which resolves only local schedules.
- **Granted binaries are pinned.** Each granted program is recorded with its
  realpath and sha256, and both are signed. Its basename must equal the program
  (`bins.gh` is a program named `gh`), and it must resolve outside the project. A
  swapped binary or a repointed symlink refuses the run with `grants-changed`.
- **Scrubbed output.** Output is scrubbed first and capped after, and the trailing
  partial line is dropped. The scrubber removes:
  - the exact value of every `*TOKEN*`/`*SECRET*`/`*KEY*`/`*AUTH*` variable;
  - the exact value of `gh auth token`, which keryx reads once per run, outside the
    sandbox, and never logs or shows;
  - classic `gh?_` and fine-grained `github_pat_` tokens;
  - `Authorization: token|bearer` header values.
- **No shortcut around the card.** In any agent's shell, including `auto` mode, these
  always ask, are never remembered, and are refused as allowlist patterns:
  - `keryx schedule add|remove|pause|resume|run`;
  - `keryx trigger schedule|install`;
  - `crontab`, `launchctl` and `loginctl`;
  - `systemctl` with `enable|link|start|restart|daemon-reload|edit|disable|stop|…`;
  - any write into `~/.config/systemd/user` or `~/Library/LaunchAgents`;
  - starting an interactive keryx (`keryx`, `keryx shell` without `-p`), a terminal
    driver around one (`script`, `screen`, `tmux`, `unbuffer`), or typing into a
    running session (`tmux send-keys`, `screen -X stuff`).

  `keryx schedule add|remove|pause|resume|run` also refuse outright inside an agent's
  shell (`KERYX_TOOL_CALL=1`). So do a nested keryx's `/schedule`, `schedule_create`,
  and the `/schedules` pause, resume, run-now and delete keys, because an agent can
  type into a keryx it started through a pseudo-terminal.
- **Clean cards.** Model-supplied text on the card has ANSI and control characters
  removed, and newlines are shown as `⏎`.
- **Operator-only storage.** `schedule_create` stores only the draft whose card the
  operator confirmed. That draft is bound to a one-time token and dropped when the
  operator declines.
- **Isolated runs.** One run cannot read another run's scratch directory. The scratch
  parent is `$XDG_RUNTIME_DIR/keryx-agent-tasks`, or `<tmpdir>/keryx-agent-tasks-<uid>`
  when that variable is unset. It must be a real directory you own with mode 0700, or
  the run is refused.
- **A terminal is required.** `keryx schedule add`, `resume` and `run` need an
  interactive terminal on stdin and stdout, `--yes` included. `remove` and `pause` do
  not, because they only reduce what runs. The shell's `/schedule` card and the
  `schedule_create` tool are the in-shell paths.
- **Granted programs run from an empty directory.** Granted programs, `gh auth token`
  and the account lookup on the card all run from an empty keryx-owned directory, never
  from the project, so a committed `.tool-versions`/`.mise.toml`/`.envrc` cannot steer
  them. Drafting refuses a version-manager shim (`…/shims/gh`) and suggests the real
  binary (`mise which gh`, `asdf which gh`).
- **Script wrappers are pinned.** A `#!` script wrapper outside the project (for example
  a `~/.local/bin/gh` that picks an account) is allowed. Its sha256, inode and mtime are
  pinned and signed, and so is its interpreter: for `#!/usr/bin/env X`, X is resolved on
  PATH. The run re-checks both, and resolves the interpreter again on the run's PATH.
  The card shows `gh: script wrapper … (interpreter …) — pinned`.
- **The config directory is hidden and pinned.** keryx's config directory (auth.json,
  provider keys, the signing key) is always hidden inside the unattended sandbox, even
  when `XDG_DATA_HOME` is outside `$HOME`. A config directory inside the project is
  refused. The installed timer pins `XDG_DATA_HOME` when you have it set, so the
  scheduler finds the same key.
- **Binaries are re-checked before each exec.** A granted binary's inode, size and mtime
  are re-checked before every exec, not only at the start of the run.
- **The timer runs the keryx you confirmed.** The card's `runs:` line is the exact
  command, quoted as the unit carries it. That command and the pinned environment are
  signed with the entry, so resume and reinstall never swap in another keryx. A keryx
  running from inside the project (for example `bun src/cli.ts`) is refused when the
  schedule is drafted: install keryx globally for schedules.
- **Reports are read only from their own place.** The Report tab and the notices read
  only `.metaproject/data/trigger/reports/<name>/<runId>.md`: a regular file (never a
  link or a FIFO), under a size cap, with control characters removed. A `reportPath`
  in `runs.jsonl` that points anywhere else is ignored.
- **Honest limit.** The shell floor is text analysis, and a same-user shell in `trust`
  mode can get past it with a variable or a script. The terminal requirement, the
  nested-keryx refusal and the signing key are the gates behind it.

**Where things live.**

- The schedules are stored in `.metaproject/data/trigger/schedules.json`. The file
  is per machine and never committed: `.metaproject/data/trigger/.gitignore` lists
  it and the reports. Only keryx writes it, and only after a confirmation.
- A schedule is never read from the committed `triggers.json`. An `agent-task` there
  is refused on load.
- Each entry carries the hash of the content you confirmed: name, cadence, prompt,
  runner, budget and grants. `keryx trigger run` refuses an entry whose content no
  longer matches that hash (`dispatch-refused`, refusal `grants-changed`) and calls
  no model, so an edit behind an installed timer never runs.
- Reports are written by the dispatcher, never by the agent, to
  `.metaproject/data/trigger/reports/<name>/<runId>.md`. Each report has a header
  (outcome, cost, granted calls, denials) and keeps the last 20 per schedule.
- Every run, including a refusal, is a line in `.metaproject/data/trigger/runs.jsonl`.
  The line carries `agentTask: { runId, reportPath, grantedCalls, denials, refusal? }`
  and the cost, so `keryx trigger status` and `keryx governance report` see it.

**Spend.** Before the first model call, a run reserves spend under the project-wide
spend lock. The reservation is the smaller of the project ceiling and the schedule's
own `--ceiling`. At or over either ceiling it records `budget-refused` and calls no
model. The run's closing record carries the runId, tokens and USD, and closes the
reservation.

**In `keryx shell`:**

- `/schedule` creates a schedule from the shell, with the same card.
- The sidebar's **Schedules** section (after Triggers) shows one compact row per
  schedule: name, next run time (or `paused`, or `not installed` when the timer files
  are gone), and last outcome with its cost (`ok`, `failed`, `refused`; a hand-resolved
  run shows `resolved` in the attention colour). A click on a row opens that schedule's
  detail.
- `/schedules` opens the list: `↑/↓` to select, `Enter` to open, `Esc` to close.
  `/schedules <name>` opens one schedule directly.
- The detail modal has four tabs: **Overview** (cadence, next runs in local time, last
  run, installed timer, its unit, the linger state, whether the entry still verifies,
  runner, budget, prompt), **Grants** (network, account, repos, granted tools, and each
  program's pinned realpath and short sha256, with a wrapper's interpreter), **Runs**
  (the last 12 outcomes with cost and refusal; reservations do not count),
  and **Report** (the latest report, scrollable). The first line of every tab lists its
  keys:
  - `p` pauses or resumes, in one step;
  - `r` then `y` runs it now, as `keryx trigger run --schedule <name>` in a detached
    child process with its own log;
  - `d` then `y` deletes it (uninstalls the timer and removes the entry);
  - any other key cancels an armed action.

  These actions call the same functions as `keryx schedule pause|resume|remove`.
- When a scheduled run finishes in the background (another process), the section and
  an open modal update on the next check, without a restart. Each new report is
  announced once in the transcript.
- The agent's `schedule_create` tool creates a schedule from plain language. It
  **always asks**, in every permission mode including `auto`, is never remembered,
  and never offers "always". The model can propose a schedule; only you confirm it.

### Honest limits

- **The machine must be on.** A suspended laptop misses runs. systemd
  (`Persistent=true`) and launchd run **one** catch-up run on the next boot or
  wake, not one per missed slot. cron catches up nothing.
- **Linger.** Without linger (`loginctl show-user $USER -p Linger`), a systemd
  `--user` timer does not run while you are logged out. keryx reads and shows
  the linger state and never runs `loginctl enable-linger` for you.
- **The hardened sandbox is Linux-only.** On macOS, `trust` refuses, so a
  schedule there is `ask` with granted tools only.
- **Pinned paths.** The installed timer bakes in the absolute interpreter and
  script that created it, and the absolute path of each granted program. After a
  version-manager switch, remove the schedule and add it again.
- **Report text from third parties.** Granted tools return text anyone can
  write (PR bodies). Under `ask` it cannot cause a write, but it can mislead the
  summary.

---

## governance

One report over what is already recorded — spend, confirmations, signatures
and gate outcomes, unified across flows and (optionally) across projects.
Read-only: it never re-runs a gate, never calls a model or a network service,
and the only files it writes are its own report artifacts. A figure nobody
recorded is reported as "not recorded", never as zero — the same rule
`keryx review budget`'s `spend_status: not-recorded` and `keryx trigger
status`'s `cost: not recorded (<reason>)` already follow.

```
keryx governance report [--flow <id>] [--owner <name>] [--since <iso>] [--until <iso>] [--all-projects] [--json]
keryx governance show [--json]
```

| Subcommand | Description |
|---|---|
| `report` | Build the report from what is on disk right now, write `.metaproject/data/governance/artifacts/latest.md` and `latest.json`, and print it. |
| `show` | Reprint the most recently written report without regenerating it. Prints "No governance report yet" if `report` has never run. |
| `--flow <id>` | Narrow to one flow, by its bare id (e.g. `291`). |
| `--owner <name>` | Narrow to flows whose owner's identity value matches exactly. A flow with no owner set is excluded. |
| `--since <iso>` / `--until <iso>` | Narrow to flows whose own `updatedAt` falls in the range, and trigger runs whose own `at` falls in the range. |
| `--all-projects` | Also cover every project in the user-global registry (`keryx projects`), not only the current one. A registered project whose path is missing or unreadable is listed with a `state: "skipped"` reason instead of failing the whole report. |
| `--json` | Print the report as JSON instead of markdown. |

### What it reads, and what it never does

Per flow (`.metaproject/flows/<id>/flow.json` and its `reviews/*/manifest.json`):

- **Review-round spend** (input tokens, output tokens, USD), summed across
  every round's `manifest.json` `cost` field. A figure is a number only when
  at least one round reported it; a flow with partial coverage (some rounds
  recorded cost, some did not) reports the sum together with a
  `rounds_with_cost`/`rounds_total` count, never silently dropping the gap.
- **Confirmations and signatures** — who confirmed each acceptance criterion
  and who signed completion, joined from `acConfirmed` and `signatures`
  (flow 289), with each identity's basis (`stated`, `derived`, `unknown`)
  shown beside the name. A `derived`/`unknown` identity is never presented as
  a verified confirmation. A flow with no `signatures` field at all — every
  flow completed before flow 289 — reports `confirmations: not recorded
  (predates signing)`.
- **Gate outcomes** — every `flow complete` attempt's gate results (pass,
  fail, skipped), from `FlowState.completionAttempts` (flow 291). Absent on
  every completion attempt made before flow 291, which reports `gate
  outcomes: not recorded` rather than inferring anything.

Per project (`.metaproject/data/trigger/runs.jsonl`):

- **Trigger spend** — USD summed over every fired-trigger run whose cost was
  recorded, plus the count of CLOSED runs whose cost was not recorded (never
  folded into the sum as `$0`), plus — since flow 300 — the open spend
  reservations (`openReservations`, `openReservedUsd` in the JSON; "N open
  reservation(s) totaling $X (reserved, not spent …)" in the markdown). An open
  reservation is a run whose dispatch reserved spend and has no closing record
  and no `keryx trigger resolve` yet; it counts in `runsTotal` ("M run(s) total
  (K open)") but never in the not-recorded count and never in `spentUsd` — the
  same name and the same rule the per-flow "Open reservations" below use. An
  operator's `reservation-resolved` is the killed run's closing record, and
  belongs to the flow the reservation was opened for. This is the project's TRUE total, project-wide across
  every trigger and every action kind, whether or not the run named a flow.
  `attributedToFlowsUsd` says how much of that total is ALSO shown under a
  flow's own "Dispatch runs" section below (`spentUsd` there); it is a SUBSET
  of the project total, never an amount on top of it — **do not add the
  project's `spentUsd` to any flow's `dispatch.spend.spentUsd`, that
  double-counts every dispatch dollar.** The markdown says so in place, with
  "of which $X is shown under flows below (not additive)". An absent ledger
  reports a demonstrated `$0` (nothing has ever fired); an unreadable one
  reports `not recorded` with the reason.
- **Policy decisions** — an INTERACTIVE session's own allow/ask/deny decisions
  have no durable record in this build, so this section always reads `not
  recorded` with that reason. An UNATTENDED dispatch run is different: flow 290
  records every such run's denials, and this report reads them — see "Dispatch
  runs" below, not this line.

Per flow, also from `runs.jsonl` (flow 297):

- **Dispatch runs** — every unattended `flow-next` dispatch run that named
  this flow (`TriggerDispatchRecord.flow`), joined by `runId`: the trigger,
  the time, the outcome (`ok`, `failed`, `dispatch-refused`, `budget-refused`,
  or an operator's `reservation-resolved`), the cost, and every call its
  unattended approval gate denied — the tool and the reason, timed by the
  run's own `at`. Spend is summed only over these CLOSED runs, the same
  "never folded into `$0`" rule trigger spend keeps. This `spentUsd` is
  **included in** the project's trigger spend above, not additional to it —
  `includedInProjectTriggerSpend: true` in the JSON, and the markdown line
  says "(included in the project's trigger spend above — not additive)".
- **Open reservations** — a spend reservation this flow's dispatch opened
  (`keryx trigger run`, before its first model call) that no closing record —
  and no `keryx trigger resolve` — has closed yet: a killed run. Shown as
  "reserved, not spent", on its own line, never added into the spend figure
  above. A reservation recorded before this change carries no flow reference
  and stays out of every flow's section — it is still counted at the
  project-wide trigger-spend line, as an open reservation.
- A report-only `flow-next` entry (no `dispatch` block — it only reports the
  next task, no model call) writes no `dispatch` record at all, so it never
  appears in either list here; it is still counted at the project-wide
  trigger-spend line, exactly as before this change.

The report never re-runs `flow complete`, `review ingest`/`budget`, `health
run`, or any security scan, and never calls a model or a network service. The
only files a run writes are its own two artifacts, below.

### Artifacts

`report` writes both files on every run, following the same convention
`keryx health run` uses:

- `.metaproject/data/governance/artifacts/latest.md` — the human-readable
  report, the same text printed to the terminal.
- `.metaproject/data/governance/artifacts/latest.json` — schema-versioned
  (`schemaVersion: 1`), machine-readable. `show`'s reader is shape-guarded: a
  missing or malformed stored file is treated as "no report yet", never a
  crash and never silently read as an empty-but-valid report.

---

## hooks

```
keryx hooks list [--json]
keryx hooks validate [--json] [--ci]
keryx hooks test <id> [--event <name>] [--payload-file <path>] [--json] [--profile <id>]
keryx hooks enable <id> [--user]
keryx hooks trust [--yes]
keryx hooks untrust
keryx hooks disable <id> [--user] [--acknowledge-gate-risk]
```

Project command hooks run only after `keryx hooks trust`; changing the file
revokes trust. A project file cannot disable a built-in gate; `--user
--acknowledge-gate-risk` can.

The CLI over `keryx shell`'s lifecycle hook runtime (W6): ten named events
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `PreCompact`, `Stop`, `SubagentStart`, `SubagentStop`,
`SessionEnd`), a config-file pair merged over Keryx's five built-in
registrations: **built-in < user (`~/.keryx/hooks.json`) < project
(`.metaproject/hooks.json`, version-controlled, highest precedence)**.

| Subcommand | Description |
|---|---|
| `list` | Print the merged, resolved registration set — id, event(s), matcher, class, scope, enabled, appliesToChildAgents, timeoutMs, and the command/argv or `builtin` name. A built-in registered on several events (e.g. `keryx.learning-observer`) is one row with an `events` array. With no config files present, exactly the five built-ins (`keryx.ctx-guard`, `keryx.security-check-input`, `keryx.security-check-output`, `keryx.learning-observer`, `keryx.impact-evidence`), all `enabled: true`. A config error prints diagnostics and exits non-zero. |
| `validate` | Validate both `.metaproject/hooks.json` and `~/.keryx/hooks.json` against `hook-config.schema.json`: schema conformance, a project/user id colliding with a built-in (`hook-id-collides-with-builtin`), a duplicate id, and — best-effort, no execution — that each hook command's `argv[0]` resolves (an absolute path exists, or is found on `PATH`; `keryx` always resolves). An unresolved `argv[0]` is a warning, never a reason to fail. Exit is non-zero on any diagnostic; `--ci` is accepted for a machine-friendly pipeline invocation and changes no exit-code semantics beyond what `--json` already gives. |
| `test <id>` | Run one registered hook once, through the real runner (`createRealHookRunner`), against a synthetic payload for its event — or the JSON in `--payload-file` — and report its decision (parsed through the same codec the runtime uses), exit code, stdout/stderr (truncated), duration, failure class, and what the failure-semantics effect would be under `--profile` (default `monitored-trusted-local`). The two in-process built-ins (`keryx.learning-observer`, `keryx.impact-evidence`) report their port's result instead of a process exit code. `--event <name>` picks which event to run under when the id is registered on more than one (e.g. the observer). Exit is `0` whenever the hook ran — even when it denied, timed out or crashed — and non-zero only when the id is unknown or the config fails to load. |
| `enable <id>` / `disable <id>` | Flip a registration's enabled state in the project file by default, or `~/.keryx/hooks.json` with `--user`, creating it with `{schemaVersion:"1.0.0", hooks:{}}` if absent. For a built-in id: `disable` writes a disable-only override (`{id, enabled:false}`) into every event list the built-in is registered on, and `enable` removes exactly that Keryx-managed override — refusing (non-zero, no write) if the override present is not one `_keryxManaged.managedHookIds` records, since that means a person wrote it by hand. For a project/user hook defined in that file: `disable`/`enable` flips its own `enabled` field, without deleting or reordering any other entry. Every write is atomic (temp file + rename) and the resulting document is re-validated against the schema before it lands — an invalid result is refused with nothing written. Unknown id: non-zero, nothing written. |

### `_keryxManaged`

`hooks enable`/`disable` record what THEY added or changed in
`_keryxManaged: {tool: "keryx", version: <cli version>, managedHookIds: [...]}`,
so a later call — or a person reading the file — can tell a Keryx-written
entry from a hand-authored one and never silently overwrites the latter. This
is the same discipline as the host-config installers `keryx orient
install-hook`/`keryx security hooks install` already use for `.claude/settings.json`
and friends, applied to Keryx's own two files.

---

## bundle

```
keryx bundle export --scope <project|team|user> [--include <glob>]... [--kind <k,...>] [--id <id>] [--target-harness <h,...>] <out> [--json]
keryx bundle import <bundle> [--target-scope <scope>] [--render-for <h,...>] [--force <path>]... [--allow-hooks] [--dry-run] [--json]
keryx bundle import <catalog-dir> --external [--dry-run] [--json]
keryx bundle inspect <bundle> [--target-scope <scope>] [--json]
keryx bundle verify <bundle> [--json]
keryx bundle verify --external-imports [--json]
keryx bundle uninstall <bundleId> --target-scope <scope> [--dry-run] [--json]
```

Flow 313 (W4 portability): move skills, rules, agents, memory entries,
learned patterns and hook config between scopes and machines as a single
sha256-content-addressed, manifest-described bundle — a directory (with
`bundle.json` at its root) or a deterministic `.tar.gz`. This command never
prints file contents, only paths/sha256/counts, and every write goes through
one lifecycle: **plan -> W8 audit -> apply**, all-or-nothing. A refusal at any
stage means zero bytes were written; `applyBundlePlan` itself re-checks every
target's checksum immediately before writing (a TOCTOU guard) and rolls back
every write it already made if any single one fails.

**Scope roots.** `project`/`team` share `.metaproject/` at the project root
(`team` is a labeling discipline over the same tree, not a separate
directory); `user` resolves to `~/.keryx/` (`KERYX_HOME`, or an explicit
`--home-dir`-style override in tests, wins over the real home directory —
the same resolution `keryx hooks` uses for `~/.keryx/hooks.json`).

| Subcommand | Description |
|---|---|
| `export` | Collect every matching skill/rule/agent/memory-entry/learned-pattern/hook-config under `--scope`'s root, filtered by `--include` glob(s) and/or `--kind`, and write a bundle to `<out>` (a `.tar.gz`/`.tgz` path, or an empty/absent directory). `--id` overrides the default deterministic `bundleId`: for `project`/`team` with a git remote, a hash of that remote's normalized identity (`keryx-<scope>-<hash>`); for `user` scope, or `project`/`team` with no remote, a hash of the export's own sorted `path\tsha256` content list instead — so two unrelated exports never collide on id, and the same content always reproduces the same id. Because that default id changes whenever content changes, re-exporting the SAME logical bundle across its lifetime should pass the SAME `--id` every time (persist it alongside the bundle) — that is what keeps `bundle import`'s ownership tracking (see `import` below) recognizing a re-export as an update from the same bundle rather than a takeover requiring `--force`. `--target-harness` records advisory harness ids in the manifest's `compat.targetHarnesses`, checked back against the capability matrix by `bundle inspect`. Refuses (no bytes written) on any invalid `hook-config`/`learned-pattern` content, an unparseable agent frontmatter, a source file/directory name that is not portable (`path-escape` — ASCII letters/digits/`.`/`_`/`-` only, no leading `.`), a match set of zero entries (`empty-bundle`), or an `<out>` that already exists non-empty. |
| `import` | **Plan**: verify every entry's checksum against the bundle first (any mismatch refuses before anything else runs). An entry whose `scope` differs from the bundle's own `provenance.sourceScope` is refused (`scope-mismatch`) unless `--target-scope` is passed, so a bundle cannot silently write into a different scope than the one it claims to be from — e.g. a "project" bundle smuggling a `scope: user` `hooks.json` into `~/.keryx/`. A `hook-config` entry additionally requires `--allow-hooks`, or it is refused (`hooks-require-opt-in`). Each surviving entry is then diffed against the target scope's disk state and applied-state ledger into a bucket — `new`, `identical`, `update` (Keryx wrote the current bytes last time, AND this same bundleId owns that ledger record), or `conflict` (the current bytes match neither the incoming nor the ledger — a hand edit, an unmanaged pre-existing file, or content unchanged since a DIFFERENT bundleId last wrote it — `owned-by-other-bundle`, so one bundle can never silently take over a file another bundle still owns). Ownership is not decided by a matching `bundleId` alone — a hand-crafted bundle can declare any `bundleId` string it likes. When the ledger record for a target carries a `provenance.sourceProject` (recorded from the bundle that last wrote it) and this import's own manifest `provenance.sourceProject` differs from it — including either side simply lacking the field while the other has one — the target is `owned-by-other-bundle` too, even though the `bundleId` itself matches. `sourceProject` is trust-on-first-use, not a forgery barrier: it is a plain sha256 hash of the source project's normalized git remote identity, computed at export time, carried in cleartext in every `bundle.json`, and reproducible by anyone who knows (or can guess) that remote — a hand-crafted bundle can trivially populate it to match a prior record. What it protects against is *accidental* cross-project clobbering — two unrelated projects that happen to reuse the same `bundleId` — not a deliberate attacker who has seen an exported bundle or knows the source repository's remote. When NEITHER the recorded entry NOR the incoming manifest has ever declared a `sourceProject` (no git remote at either bundle's export time), the two cannot be distinguished this way and the plain `bundleId` match alone decides `update` vs `new` — this is the same trust-on-first-use: the FIRST bundle to write a path under a given `bundleId` is trusted, and Keryx has no way to later prove a same-`bundleId` re-import (with or without a matching `sourceProject`) is the same producer rather than a spoof. A `conflict` entry blocks the whole import unless its `targetRelative` or `displayId` (`scope:path`) is named in `--force`; forcing an `owned-by-other-bundle` conflict transfers ownership of that path to this import's `bundleId` (recorded in the ledger, and printed with its `(owned-by-other-bundle)` reason). Every such forced takeover is also reported as its own `transferred` entry — `{displayId, from: <previous bundleId>, fromSourceProject?: <previous sourceProject>}` in `--json`, a `transferred <path> from <bundleId>` line in human output — not merged into an ordinary `written`/`+` line. `--target-scope` retargets every entry to one scope, EXCEPT a `learned-pattern`, whose scope is immutable: a `project`-scope pattern may only import at `project` or `team` scope, a `user`-scope pattern only at `user` scope (any other target refuses `learned-pattern-scope`); every imported pattern is also rewritten to `status: "candidate"` regardless of what it carried in the bundle (`keryx learn accept` is the only command that may mark one `accepted`). `--dry-run` prints the plan grouped by kind, with each entry's bucket, and stops — no audit, no write, exit `0` only when the plan itself has no unresolved refusal. Otherwise: **W8 audit** stages every entry that would be written into a temp dir and runs `runHarnessAudit`'s `imported-bundles` surface; a `high`/`critical` unsuppressed finding refuses the whole import. **Apply**: atomic per-file writes (temp + rename) with a TOCTOU re-check (checksum and symlink chain) and full rollback — files, directories `mkdir -p` created, and a newly-created private-dir `.gitignore` — on any single write or ledger-update failure. Updates the target scope's applied-state ledger (`.metaproject/data/bundles/applied-state.json` or `~/.keryx/bundles/applied-state.json`) for every WRITTEN entry unconditionally, and for an `identical` entry only when the ledger already records that exact path as owned by this same `bundleId` AND `sourceProject` — an `identical` match against a user's own pre-existing file, against a file another bundle's ledger record already owns, or against a same-`bundleId` record whose `sourceProject` differs (including one side omitting it), is left completely untouched, so this bundle's own later `uninstall` cannot delete a file it never wrote, and identical bytes alone can never relabel or erase a recorded `sourceProject`. After a successful apply that wrote at least one `rule` entry into project scope, renders the canonical rules library into `--render-for`'s harnesses, or — when `--render-for` is omitted — every harness that already has the `rules-export` surface installed (`installedRulesExportHarnesses`); per-harness `installed`/`unchanged`/`failed`/`unsupported` is reported, and the command exits `1` (not `0`) if any harness's render failed even though the import itself wrote files. |
| `import --external` | Vets an Agent-Skills-standard catalog directory (`<catalog-dir>`, not a Keryx bundle) instead: a candidate is the directory itself or an immediate subdirectory holding a `SKILL.md`. Every regular file under a candidate is read once into an in-memory snapshot; that same snapshot is both hashed (for the registry) and audited — `SKILL.md` and every other markdown/text file are scanned for secrets, prompt-injection and auto-run directives, not just script files, and a markdown-only skill (with no script files at all) is accepted rather than rejected as inapplicable. Rejects a candidate containing a symlink anywhere, or that is itself a symlink (`symlink-refused`); with invalid frontmatter — `name` must match `^[a-z0-9]+(-[a-z0-9]+)*$` (≤64 chars) and `description` must be non-empty (≤1024 chars) — (`invalid-skill-frontmatter`); a name shared with another candidate in the same batch, where BOTH are rejected (`duplicate-name`) rather than the later one silently winning; a scout `use`/`fork` decision against the project's own skill catalog (`scout-duplicate`/`scout-overlap` — fail closed; author a fork through the normal path instead); a name already recorded with different file hashes (`already-imported`); or a failing/inapplicable W8 audit (`audit-failed`/`audit-not-applicable`). An accepted candidate is recorded **by reference only** in `~/.keryx/skills/external-imports.json` (source directory + per-file sha256, plus an HMAC integrity tag keyed by a per-user secret at `~/.keryx/skills/.external-imports.key`) — no skill file is ever copied into `.metaproject/skills/`, `~/.keryx/skills/<name>/`, or any bundle. Reading the registry recomputes and checks that HMAC, and also refuses a case-variant sibling file (e.g. `External-Imports.json` next to `external-imports.json`) — both fail closed as `corrupt-external-imports-registry`, so a bundle cannot plant a forged, "pre-vetted" registry directly. `--dry-run` vets and prints without recording. Exit `1` only when every candidate was rejected. |
| `inspect` | Read-only: verifies the bundle and runs the same plan diff `import` would (against `--target-scope`, or each entry's own recorded scope), without writing anything — no ledger touch, no temp files, no audit. Also warns, per `compat.targetHarnesses`, when the capability matrix does not report that harness `native`/`adapter` (advisory only). |
| `verify` | Recomputes every `contents[].sha256`/`sizeBytes` in the manifest against the bundle's actual bytes; reports any file present in the bundle but not listed in the manifest (`unlisted`) too. Exit `0` only when every entry is `ok` and nothing is unlisted. |
| `verify --external-imports` | Re-checks every entry in `~/.keryx/skills/external-imports.json` (after the same HMAC integrity/case-variant checks `import --external` applies on read) against its live source: `unresolvable` (the source directory or a recorded file is gone), `checksum-mismatch` (a recorded file's bytes changed upstream), or `unlisted-file` (a file now present under the source that was not part of the recorded set) — each a distinct status, never folded into a generic failure. |
| `uninstall` | Removes only the files `<bundleId>`'s applied-state ledger for `--target-scope` records AND whose current sha256 still equals what Keryx last wrote — a file a person has since hand-edited is left in place and reported `kept` (reason `user-modified`), never overwritten or deleted. Every ledger key is re-validated (path normalization, containment under the scope root, and a symlink-chain check) before it is read or unlinked, so a tampered or corrupt ledger entry refuses (`corrupt-ledger`) instead of deleting outside the scope root. Removes now-empty parent directories up to (not including) the scope's fixed kind roots (`skills/`, `rules/`, `agents/`, `memory/`, `learning/`, `data/learning/`). `--dry-run` reports `removed`/`kept`/`missing` without writing; the ledger is updated only on a real run. |

`--json` on any subcommand prints a structured result matching the table
above, with a fixed, subcommand-specific set and order of top-level fields —
NOT alphabetically key-sorted — but stable (the same fields, in the same
order, for a given subcommand and outcome). A usage error (a missing
required flag, or an invalid `--scope`/`--target-scope`/`--kind` value) exits
`2` with a one-line reason on stderr, independent of `--json`. Every other
refusal from bundle export/import/inspect/verify/uninstall (checksum
mismatch, unresolved conflict, audit failure, a private-dir `.gitignore`
conflict, a scope mismatch, an unrecorded hook-config opt-in, a corrupt
ledger, …) is one of `src/bundle/types.ts`'s named `BUNDLE_REFUSAL` reasons
and exits `1`. `import --external`/`verify --external-imports` use one
additional reason outside that set, `corrupt-external-imports-registry`,
for a tampered, unverifiable, or case-shadowed external-imports registry.

---

## learn

```
keryx learn observe [--hook claude]
keryx learn extract [--domain <d>] [--since <YYYY-MM-DD>] [--json]
keryx learn list [--status <s>] [--domain <d>] [--scope <s>] [--json]
keryx learn review [<id>] [--scope <s>]
keryx learn accept <id> [--scope user] [--refresh]
keryx learn reject <id> [--scope user]
keryx learn apply <id> --skill <module/name> [--dry-run]
keryx learn promote <id>
keryx learn graduate [--domain <d>]
keryx learn graduate apply <proposal-id>
keryx learn prune [--dry-run] [--json]
```

The self-learning loop's consent CLI (flow 312, W3): passive observation
(`observe`), deterministic extraction (`extract`) into `status: candidate`
`learned-pattern` records, human review and consent (`review`/`accept`/
`reject`), and the bounded paths onward from an accepted record (`apply`,
`promote`, `graduate`).

| Subcommand | Description |
|---|---|
| `observe --hook claude` | Reads one host-hook payload from stdin (bounded), maps it to the same observation-event shape the built-in `keryx.learning-observer` hook writes, and appends it under `.metaproject/data/learning/observations/<date>.jsonl`. Always exits `0` and prints nothing to stdout — invalid JSON on stdin is simply not written, never a failure. This is the command an opt-in Claude Code hook runs. |
| `observe` (no `--hook`) | Manual/offline use: reports today's observation file's line count. Nothing to flush — the writer is unbuffered. |
| `extract` | Runs the deterministic signals (repeated correction, reverted edit, failing→passing test, reviewer comments, health regression) — and, only when no deterministic signal fired and the capability is enabled, the optional model-backed extractor — over the observation window, creating or reinforcing `status: candidate` records. Also decays existing candidate/accepted records. Never writes `status: "accepted"`. |
| `list` | Lists records, filterable by `--status`, `--domain`, `--scope`. Also prints an integrity warning for any `accepted` record with no matching `accept` decision on record (`auditAcceptedRecords`). |
| `review [<id>]` | Prints one candidate (by id) or every candidate, with trigger, action, confidence, confidenceLevel and evidence references, for a human to read before deciding. |
| `accept <id>` | `status: candidate → accepted`. The ONLY command that produces `accepted` — refuses outside a real interactive terminal, with no bypass flag or environment variable. For a `scope: project` record, also writes (or, with `--refresh`, overwrites only the current project's) entry in `~/.keryx/learning/index.json` (see "Cross-project evidence" in the W3 spec). Never writes a skill, rule, agent or memory entry. |
| `reject <id>` | `status: candidate → rejected`. No terminal requirement. |
| `apply <id> --skill <module/name>` | For a `domain` other than `review-conventions`: renders the accepted record as a `LearningProposal` and applies it through the existing `applyLearningProposal` — still the only writer. |
| `promote <id>` | Promotes a `scope: project`, `status: accepted` record backed by `>=2` distinct project identities (each at indexed confidence `>=0.8`) to a new `scope: user`, `status: candidate` record. Interactive-only: refuses outside a terminal, with no bypass flag, and prompts you to type the pattern's id back to confirm. |
| `graduate [--domain <d>]` | Clusters accepted records by domain and trigger-keyword overlap and writes a graduation **proposal** — never a `SKILL.md`, agent definition, or rule file directly. |
| `graduate apply <proposal-id>` | Applies one graduation proposal. Interactive-only, same as `promote`: refuses outside a terminal, no bypass flag, and prompts you to type the proposal's id back to confirm. |
| `prune` | Deletes observation files more than 30 days past their own date, and expires `status: candidate` records past their `ttl.expiresAt` with no decision (`status: expired`). `--dry-run` reports without writing or deleting anything. |

`accept`, `promote` and `graduate apply` never take a `--yes`/`--force`/
`--non-interactive` flag: this mirrors `keryx schedule add`/`keryx flow
confirm`'s own rule that an action a human must consciously approve gets no
unattended path. None of the three is reachable through MCP — `src/mcp/
tools.ts` is a hand-curated allowlist and carries no entry for `learn`.

---

## commands

The agent-facing command registry: each described keryx command as a
machine-readable descriptor, with the natural-language intents that resolve to
it. This is the surface `.metaproject/index.md` points an agent at so it can
pick the right command from a phrase instead of guessing, and it is the source
of truth the curated intent table in that file is derived from.

**Which verbs it covers, and which it does not.** The registry is *not* the full
CLI surface, and the difference is deliberate rather than incidental. A verb
earns a descriptor when it is a **single callable operation with a
machine-consumable result**. Verbs are excluded when they are:

- *interactive or long-running* — `shell`, `sessions`, `serve`, `harness`;
- *lifecycle rather than operation* — `init`, `update`, `rules`, `orient`,
  `sync`, `mcp`, `review`;
- *aimed at a human or a maintainer* — `dashboard`/`dash`, `standard`,
  `metrics`, `skills`;
- *held back behind a security boundary* — `workspace`, whose offline SAC
  registry mutation is intentionally local-CLI-only for now, because a
  descriptor makes a verb eligible for later remote/MCP projection;
- *the registry itself* — `commands`.

The exclusions are not a comment: `src/standard/command-registry.coverage.test.ts`
derives the verb list from `CLI_ROUTES` and fails when a new verb is neither
described nor excluded **with a stated reason**, because an exclusion without a
reason is indistinguishable from an oversight. The guard is verb-level; a new
subcommand inside an already-described verb is not detected, which that file
states rather than leaves to be discovered.

Consumers treat the registry as exhaustive over what it covers — the remote
maintenance surface projects it and refuses to invoke anything absent from it —
so a silent gap is a command an operator cannot reach.

```
keryx commands                        # Markdown registry
keryx commands --json                 # machine-readable descriptors (harness / MCP)
keryx commands --module <name>        # filter to one module
keryx commands --intent "<phrase>"    # resolve a phrase to the matching command(s)
keryx commands --intents              # the intent → command table
```

| Flag | Description |
|---|---|
| `--json` | Stable descriptor payload: module, command, summary, intents, arguments, output shape, whether it uses a model. |
| `--module <name>` | Restrict the output to one module. |
| `--intent "<phrase>"` | Print the best-matching command(s). Exits `1` when nothing matches, so a caller can branch on it. Combines with `--json`. |
| `--intents` | Emit the full intent → command table. |
| `--help`, `-h` | Print `commands` usage and exit. |

---

## dashboard (and `dash`)

Build or open the self-contained project admin dashboard, a single HTML file at
`.metaproject/keryx-dashboard.html` embedding health, graph, testing, wiki,
and memory snapshots.

```
keryx dashboard build      # rebuild the HTML, print its path
keryx dashboard open       # rebuild, then open in the default browser
keryx dash [build|open]    # bare `dash` defaults to `open`
```

| Subcommand | Description |
|---|---|
| `build` | Rebuild `keryx-dashboard.html` and print its relative path. |
| `open` | Rebuild then open the file (platform-aware: `open` / `start` / `xdg-open`). |

`dash` is a shortcut for `dashboard`; with no subcommand it defaults to `open`.
Requires an initialized workspace; an unknown subcommand exits `1`.

---

## gdgraph

Build a deterministic intra-project import/dependency graph and optionally enrich
it with tree-sitter symbols and resolved call edges. Structural queries operate
from persisted graph artifacts and degrade to the file graph when the symbol
layer is disabled or unavailable.

```
keryx gdgraph build
keryx gdgraph query <cycles|orphans>
keryx gdgraph find "<terms>"
keryx gdgraph symbol "<name>" [--impact] [--depth N]
keryx gdgraph symbols <enable|disable|status>
keryx gdgraph path "<A>" "<B>"
keryx gdgraph affected <file-or-symbol> [--depth N] [--ranked] [--json]
keryx gdgraph repomap [--budget N] [--seed <path>...] [--changed]
keryx gdgraph context
keryx gdgraph assets list | verify [<id>] | pull <id>
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `build` | — | Scan the tree, build the graph, write JSONL storage + `summary.md`/`module-map.json`, print node/edge counts. Takes the project's maintenance lock (see [trigger](#trigger) → **Locking**): waits up to `KERYX_MAINTENANCE_LOCK_WAIT_MS` (default 120 s) when another keryx run holds it, then exits `75` naming the holder's pid. |
| `query cycles` | — | Print dependency cycles (`a -> b -> a`), or "No cycles found." |
| `query orphans` | — | Print modules with no resolved inbound or outbound edges. |
| `find "<terms>"` | — | Rank file paths and available symbols by concept/name match. Directs content searches to `ctx rg`. |
| `symbol "<name>"` | `--impact`, `--depth <N>` | Print exact definitions, callers, callees, and wiki pages that document the defining files. Loose matches across different symbol names require disambiguation. `--impact` adds transitive callers (default depth `3`). |
| `symbols` | `enable`, `disable`, or `status` | Toggle the tree-sitter capability in the manifest or report capability/symbol/call counts. Enabling is explicit and never downloads assets implicitly. |
| `path "<A>" "<B>"` | — | Resolve file or symbol endpoints and print the shortest path across import and call edges. |
| `affected <file-or-symbol>` | `--depth <N>`, `--ranked`, `--json` | Resolve a file or symbol, print dependencies/dependents, and optionally walk/rank the transitive blast radius. |
| `repomap` | `--budget <N>`, `--seed <path>...`, `--changed` | Write a token-budgeted repo map artifact. `--budget` caps the token estimate, `--seed` biases toward one or more paths (repeatable), and `--changed` seeds from locally changed files (`git diff --name-only HEAD`). |
| `context` | — | Emit the bounded graph portion of the turn-start orientation block, ending in a freshness line: `working tree clean`, or `N uncommitted code file(s) may not be reflected`. |
| `assets list \| verify [<id>] \| pull <id>` | — | Manage declared assets from `assets.lock.json`: `list` shows resolved/missing state, `verify` checks checksums (exit `1` on mismatch), `pull` fetches and verifies one asset (the only networked verb). |

Only the exact queries `cycles` and `orphans` are accepted; anything else exits
`1`. `affected` with no file argument prints usage and exits `1`.

**Freshness.** Every query answers from the last `build`, never from the working
tree, and a stale answer is shaped exactly like a fresh one. Adding, renaming,
deleting or moving a file invalidates the node set; adding or removing an import
invalidates the edge set, so `affected` under-reports. An edit inside a file with
unchanged imports leaves the file graph correct and the symbol layer stale.
Rebuild with `build` — before relying on an answer, not once per question — and
let the gdgraph post-commit hook cover the committed half. The full contract is
in `.metaproject/modules/gdgraph.md` (Freshness & Refresh).

---

## ctx

Token-aware wrapper that runs common developer commands and reads files, printing
a compact Markdown summary while persisting the full raw output under
`.metaproject/data/gdctx/`.

```
keryx ctx status
keryx ctx diff [git-diff-args...]
keryx ctx rg "<pattern>" [path]
keryx ctx read <file> [--mode outline|compact|full]
keryx ctx run -- <command...>
keryx ctx show [latest|<name>] [--raw]
keryx ctx install-hook [--runtime <id|all>]
keryx ctx uninstall-hook [--runtime <id|all>]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | — | Report metaproject/manifest/config/data presence and whether gdctx is enabled. |
| `diff` | git-diff args (e.g. `--staged`, `--stat`) | Run `git diff <args>` and summarize (files, risk hints, hunks, errors). |
| `rg` | `"<pattern>" [path]` | Run ripgrep and summarize top files + example matches. Requires ≥1 arg. |
| `read` | `<file>`, `--mode outline\|compact\|full` | Read and summarize a file. Default mode `compact`. |
| `run` | `-- <command...>` | Run an arbitrary command after `--` and summarize its output. Errors if empty. |
| `show` | `[latest\|<name>]`, `--raw` | Print a saved artifact summary (`.md`), or the raw `.log` with `--raw`. |
| `install-hook` | `--runtime <id\|all>` | Install an opt-in routing guard that blocks broad raw search/read/diff commands and points the agent to the bounded `ctx` equivalent. |
| `uninstall-hook` | `--runtime <id\|all>` | Remove only the managed routing-guard integration for the selected runtime(s). |

---

## wiki

Manage the local, Markdown-on-disk project knowledge base under
`.metaproject/wiki/` (architecture, domain models, business rules, decisions, and
more), including auto-collected drafts from other modules' data.

```
keryx wiki status
keryx wiki new <type> <slug> --title "<title>" [--force]
keryx wiki collect [--force] [--changed [--since <ref>]] [--limit <n>]
keryx wiki index
keryx wiki check-links
keryx wiki validate
keryx wiki ask "<question>" [--k <n>] [--rerank]
keryx wiki enrich [<page>|--all] [--force] [--list] [--resume] [--limit <n>] [--concurrency <n>]
                  [--provider <p>] [--model <m>] [--dry-run] [--json]
keryx wiki context
keryx wiki backlinks <wiki-page-or-code-file>
keryx wiki freshness
keryx wiki refresh
keryx wiki verify --page <path> | --baseline
keryx wiki migrate-markers
keryx wiki sections list [--json]
keryx wiki sections resolve <section-ref> [--json]
keryx wiki sections sync [--dry-run] [--accept-reoccupation <ref>[,<ref>...]] [--json]
keryx wiki sections migrate [--dry-run]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | — | Show enabled state, root, total pages, per-type counts, last index/link-check state, and any pages carrying a leaked `<think>`/`<thinking>` tag outside a fenced code block or inline code span — one shown as documentation (e.g. a fenced example) is never flagged (with a hint to re-run `enrich --force` on each). |
| `sections list` | `--json` | List every indexed section with its identity, its stability, and the page it belongs to. |
| `sections resolve` | `<section-ref>`, `--json` | Resolve a section reference. Answers found, page-found, tombstoned, reoccupied, pending-tombstone, stale-locator, registry-unreadable or unknown, and never redirects a deleted identity to a same-named section elsewhere. A `found` identity that was once removed also prints its removal history and the basis on which its tombstone was lifted — `byte-identical` (a genuine restoration) or `accepted-substitution` (an operator accepted a different document at that address). Exits `0` when live, `1` for any answer about a dead identity, `2` when the registry cannot be read. |
| `sections sync` | `--dry-run`, `--accept-reoccupation <ref>[,<ref>...]`, `--json` | Rebuild the section index from the pages on disk: register the current stable identities and tombstone the ones that disappeared. The only command in this area that writes. Exits `1` when any identity is *reoccupied* — removed, then re-minted at the same address by a different document — because a tombstone and a live document claiming one address is a contradiction, not a completed sync. `--accept-reoccupation` is the only exit from that state: it lifts the named tombstones and records permanently that the content was substituted rather than restored, which `sections resolve` then reports on every read. Accepting a page ref also accepts the sections inside that page. |
| `sections migrate` | `--dry-run` | Insert versioned identity markers into pages that have none. Content is preserved byte for byte apart from the markers, and the round trip is asserted before anything is written. |
| `new` | `<type> <slug>`, `--title "<t>"`, `--force` | Scaffold a page from template. Refuses to overwrite unless `--force`. |
| `collect` | `--force`, `--changed`, `--since <ref>`, `--limit <n>` | Generate a hierarchical, full-coverage draft scaffold from graph/health/testing data, rebuild the index, and report the remaining draft-enrichment work front. `--changed` can scope collection to changes since a ref. |
| `index` | — | Rebuild the managed page-index block in `wiki/index.md`. |
| `check-links` | — | Validate internal Markdown links; write a report. Exits `1` if any broken. |
| `validate` | — | Metadata + link + index-staleness checks (superset of `check-links`). Exits `1` on issues. |
| `ask "<question>"` | `--k <n>`, `--rerank` | Answer a question from the local wiki with a deterministic, citation-backed retrieval pass over the pages. `--k` caps the number of retrieved passages; `--rerank` applies the extra reranking step. |
| `enrich [<page>]` | `--all`, `--force`, `--list`, `--resume`, `--limit <n>`, `--concurrency <n>`, `--provider <p>`, `--model <m>`, `--dry-run`, `--json` | **Needs a model credential.** Fill draft pages with model-written prose; defaults to drafts only, validates, and marks pages accepted. Strips a complete `<think>`/`<thinking>` block out of model output before it reaches a page, and rejects (does not write) content that still carries a stray, unclosed tag — both checks ignore a tag shown inside a fenced code block or inline code span, so a page documenting this guard with a `<think>` example keeps it intact instead of having it stripped or the whole page rejected. Supports optional RLM mode via `.metaproject/wiki.config.json` (set `rlm.enabled: true`): classifies pages as skip/light/deep based on staleness and graph metrics; deep pages receive a graph-aware model call; batching and staleness-skipping apply automatically; budget-exhausted pages fall back to the template. The exception among the model commands: without a credential it exits `0` and marks the affected pages skipped rather than failing. |
| `context` | — | Emit the bounded wiki-index portion of the turn-start orientation block. |
| `backlinks <target>` | — | For a wiki page or code file, print wiki pages linking to the target and graph dependents when the target is a graphed code file. |
| `freshness` | — | Read-only backlog: which pages the code has moved under since each was last verified, classified and ordered by how far behind. Writes only its own report, never a page. Always exits `0` — a report, not a gate. |
| `refresh` | — | **Writes pages.** Deterministic, model-free regeneration of the managed `## Reference` blocks from the graph. Prose is never touched. |
| `verify` | `--page <path>` \| `--baseline` | Stamp provenance (`VerifiedAt`, `VerifiedScope`) without touching content. Refuses to run bare: stamping every page silently would assert a review that did not happen, so the whole-corpus form must be asked for by name. |
| `migrate-markers` | — | One-off, idempotent: wrap pre-existing `## Reference` sections in the managed markers `refresh` needs. Authors no content. |

`VerifiedAt` records **that the code in a page's scope has not moved since that
revision** — not that the page was ever correct. A page can be wrong from the day
it was written and nothing here notices. The
[freshness guide](./guides/keep-the-wiki-current.md) is the operator-level tour.

Page types: `architecture`, `domain-model`, `business-rule`, `user-scenario`,
`component`, `service`, `integration`, `decision`.

When the `security` module is enabled, `collect` runs an advisory security check
before writing each draft. Advisory (the default) reports and writes anyway;
`enforced`/`ci`/`gateway` mode can suppress a draft's write with a masked reason.

---

## skills

Manage the working-skills subsystem: a bundled catalog of skills and per-project
skill packages, plus routing, verification, learning, export, and JSON contracts.

```
keryx skills status
keryx skills list
keryx skills inspect <project-skill>
keryx skills route <query-or-target>
keryx skills catalog [--profile recommended]
keryx skills install [--profile recommended]
keryx skills install --profile <manifest-profile> [--with <component>]... [--without <component>]...
    [--target <harness>] [--include-deprecated] [--dry-run] [--json] [--force]
keryx skills doctor [--target <harness>] [--json]
keryx skills uninstall --target <harness> [--module <module-id>] [--force] [--json]
keryx skills create <target> --module <module> --name <skill-name>
keryx skills import --from <dir|SKILL.md|https-url> [--module <module>] [--name <name>]
keryx skills update [<module>/<name>|--all] [--from <origin>]
keryx skills verify <skill-or-target>
keryx skills verify --bundled [--root <dir>] [--json]
keryx skills learn --from-review <path> --skill <module>/<skill>
keryx skills learn apply <proposal.json>
keryx skills export <project-skill> --runtime codex|claude|plugin
keryx skills sync --runtime codex|claude --target <dir>
keryx skills contracts validate <file> --schema <name>
keryx skills scout <name-or-description> [--record <pack-dir>] [--include-imports] [--candidate <dir>] [--scope bundled|all]
    [--origin learned --source-ref <id>] [--json]
keryx skills eval <skill-id> [--strictness low|medium|high] [--trials N] [--runner <provider>[:<model>]]
    [--judge <provider>[:<model>]] [--scope bundled|all] [--model-grader] [--json]
keryx skills judge-check <skill-id> --judge <provider>[:<model>] [--scope bundled|all] [--samples <n>] [--record] [--json]
keryx skills stocktake [--scope bundled|all] [--quick] [--json]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | `--json` | Print the local gdskills install status summary. |
| `list` | `--json` | List registered project skills as a table. |
| `inspect <project-skill>` | `--json` | Inspect one project skill: metadata + file presence. Missing target exits `1`. |
| `route <query-or-target>` | `--json` | Score/rank registry entries against a free-text query or path. |
| `catalog` | `--profile minimal\|recommended\|full\|custom` | Print the bundled catalog for a profile. |
| `install` | `--profile <profile>` | Install bundled skills, catalog, manifest, and contracts. Requires `.metaproject/`. |
| `install --profile <manifest-profile>` | `--with <component>` (repeatable), `--without <component>` (repeatable), `--target <harness>`, `--include-deprecated`, `--dry-run`, `--json`, `--force` | Flow 325 (W1): resolve and apply a profile→modules/components install-manifest plan instead of the legacy profile copy. Triggered by any manifest flag, or a non-legacy `--profile` id (e.g. `core`, `react`, `nestjs`, `python`) — the four legacy ids (`minimal\|recommended\|full\|custom`) with no manifest flags still run the pre-309 behavior above. `--dry-run` prints the resolved plan without writing. Reads `.metaproject/data/stack/stack.json` (from `keryx stack detect`) when present to bias module selection; absent or unreadable fails open. `--force` overwrites drifted files; without it, a drifted/unrecorded existing file is skipped, not overwritten. v1 install destinations exist only for `--target claude` and `--target keryx-shell`. |
| `doctor` | `--target <harness>`, `--json` | Compare the recorded install-state for a target against disk: `ok`/`drifted`/`missing`/`orphaned` per path. Exits `1` if anything is not `ok`. |
| `uninstall` | `--target <harness>` (required), `--module <module-id>`, `--force`, `--json` | Remove only the paths recorded in install-state for a target, optionally scoped to one module. A drifted file is refused unless `--force`. |
| `create <target>` | `--module <m>`, `--name <n>`, `--format auto\|single\|package`, `--dry-run` | Create and register a project-skill package. (`generate` is an alias.) |
| `import --from <src>` | `--module <m>`, `--name <n>`, `--dry-run`, `--force`, `--json` | Copy a SKILL.md (directory, file, or https GitHub blob/raw URL) into `.metaproject/project-skills/<module>/<name>/`, recording Origin. `--module review` is the only module `review-orchestrator` auto-dispatches. Other hosts and GitHub tree URLs are refused. A bundled name is skipped unless `--force`. |
| `update [<module>/<name>]` | `--all`, `--from <origin>`, `--dry-run`, `--json` | Re-read Origin and overwrite SKILL.md when the source moved on. Name one skill, or `--all`. A skill with no Origin is skipped. |
| `verify <skill-or-target>` | `--dry-run`, `--json` | Verify a project skill against evidence; write a report. `--all` verifies every registered skill. |
| `verify --bundled` | `--root <dir>`, `--json` | Structurally validate the **shipped** skill tree (the 65 `SKILL.md` files copied into every install), not this project's project-skills. Exits `1` on any finding and on an empty tree. |
| `learn --from-<source> <path> --skill <m>/<s>` | `--from-review\|--from-test\|--from-failure\|--from-health\|--from-memory <path>`, `--skill`, `--dry-run`, `--json` | Create an auditable learning proposal (does not mutate SKILL.md). |
| `learn apply <proposal.json>` | `--dry-run`, `--json` | Apply a reviewed proposal to SKILL.md + changelog; bump patch version. |
| `export <project-skill>` | `--runtime codex\|claude\|plugin`, `--dry-run`, `--json` | Export a project skill to a runtime artifact. The `plugin` runtime (alongside `codex` and `claude`) emits a Claude Code plugin package. |
| `sync` | `--runtime codex\|claude`, `--target <dir>`, `--dry-run`, `--json` | Sync exported runtime skills to an explicit target dir. Requires both `--runtime` and `--target`. |
| `contracts list` | — | Print name/path/description for all contract schemas. |
| `contracts validate <file>` | `--schema <name>` | Validate a JSON file against a named contract schema. Exits `1` on failure. |
| `scout <name-or-description>` | `--record <pack-dir>`, `--include-imports`, `--candidate <dir>`, `--scope bundled\|all`, `--json` | Flow 325 (W1): pre-creation dedupe gate — does an existing skill already cover this? Scores the query against the catalog (bundled by default, `--scope all` includes project-skills); `--candidate` vets a not-yet-created skill directory; `--record` persists the scout result under a pack directory. `--include-imports` (flow 313, W4) additionally scores the query against every recorded entry in `~/.keryx/skills/external-imports.json` (see [bundle import --external](#bundle)), with the same lexical scorer, reporting `searched: false` and a named reason when the registry is absent or corrupt rather than a silently empty match list. |
| `eval <skill-id>` | `--strictness low\|medium\|high`, `--trials N`, `--runner <provider>[:<model>]`, `--judge <provider>[:<model>]`, `--scope bundled\|all`, `--model-grader`, `--json` | Flow 325 (W1): behavioral compliance eval — trigger accuracy + scenario pass rate. Scenarios that need a runner capability are reported `not-run`, not failed, when none is configured. `--runner` splits at the first `:` into provider and optional model (e.g. `--runner deepseek:deepseek-chat`, `--runner ollama:llama3.1:latest`); flow 314 wires this through `src/commands/model-eval-runner.ts`, dispatching each scenario as a single-turn call with the skill's `SKILL.md` as the system prompt. `--scope` (default `all` for `eval`, unlike `scout`/`stocktake`/`judge-check`, which default to `bundled`) selects which catalog the skill id resolves against and the triggers are scored against — a stack-pack eval gate document requires `--scope bundled` explicitly; the pack gate refuses a report recorded with `scope: "all"`. Flow 316: `--judge <provider>[:<model>]` (same `provider[:model]` split as `--runner`, via `src/commands/model-eval-judge.ts`, called at `temperature: 0` for the closest a provider gets to deterministic scoring) grades every `"grader": "judge"` behavior scenario with a live LLM judge instead of leaving it `skipped`; the judge is a separate build and separate calls from the runner under test, even when both name `deepseek:deepseek-chat`. Building either an unknown `--runner`/`--judge` provider, or one with no credential, fails closed before any scenario runs. With `--judge`, the report gains `judge` (provider), `judgeModel`, and `judgePromptVersion` (the judge prompt version that produced the recorded verdicts); every report also gains `catalogDigest` (the bundled catalog the trigger scenarios were scored against, kept as informational context only — trigger scenarios are always re-scored live against the current catalog, never trusted from the report) and, per ran behavior scenario, `trialRecords` — one entry per trial (`output`, `outputSha256`, `deterministic` results, `judge` verdict, `passed`) so the report can be re-derived (`regradeRecordedReport`) without re-running the model. The stable-pack gate (`checkSkillReportForPackGate`) requires the report's `(runner, model)` and, when any scenario carries a judge expectation, its `(judge, judgeModel)` to both be in the gate's allowlisted set (`STACK_PACK_GATE_POLICY`, pinned to `deepseek`/`deepseek-chat` for both roles), `judgePromptVersion` to match the current judge prompt, and the recorded `passes`/`passRate`/trial counts to match what the trial records themselves show — a report from an unlisted runner or judge, a stale prompt version, or counts that disagree with its own records, never clears the gate. **What this proves, and what it does not:** the gate proves internal consistency — the recorded outputs, deterministic results, counts and pass rates are re-derived from the trial records, and trigger results are re-scored live, not re-declared from the report. It does not prove provenance: the trial outputs, judge verdicts, and runner/judge labels are self-declared by whoever ran the eval, and the gate never re-runs the judge model against them ("re-derive"/"re-grade" here means recomputing from what was recorded, not re-judging). The control for provenance is review of the committed `eval.json` / recording diff in the pull request. |
| `eval --reverify <pack-dir>` | `--judge <provider>[:<model>]` (required), `--sample <n>` (default `10`), `--json` | Flow 317 (FU3): the live re-judge sampler. Re-judges a RANDOM SAMPLE of `<pack-dir>`'s already-recorded trial outputs (`governance/eval.json`, every ran behavior scenario's `trialRecords` that carry a judge verdict) against the CURRENT live judge, matched against the skill's current `evals.json` by scenario id, and reports where the live verdict disagrees with what was recorded. Read-only — never rewrites `governance/eval.json`. **Threat model:** `eval`'s own stable-pack gate (above) proves a recorded report is internally consistent (`regradeRecordedReport`) and re-scores triggers live, but it cannot prove a recorded JUDGE verdict was ever a genuine live grading rather than, say, a hand-edited recording — nor can it catch the judge PROVIDER's own weights drifting under a pinned model name over time. `--reverify` is the closest available check for exactly those two gaps: a diagnostic a human (or a scheduled job) runs and acts on, not something the gate itself enforces automatically. Exits `1` when the sampled disagreement rate exceeds `REVERIFY_DISAGREEMENT_THRESHOLD` (20%, `src/gdskills/governance/eval.ts`) — deliberately generous, since a live judge is not perfectly deterministic on identical input (flow 316 review round 1) and a single flaky call among a handful of samples is expected noise, not drift. |
| `judge-check <skill-id>` | `--judge <provider>[:<model>]` (required), `--scope bundled\|all` (default `bundled`), `--samples <n>` (default `3`), `--record`, `--json` | Flow 316: proves a skill's judge-graded scenarios are hard to game. For every scenario carrying a `"grader": "judge"` expectation, runs the canned answer set — `empty`, `echo`, `vague`, `known-wrong`, `subtle-wrong`, `injection`, `stuffed`, `known-right` (eight kinds; fix 1 / R1-4, R1-11 added `vague` and `subtle-wrong`, authored per scenario from the required `calibration.vague`/`calibration.subtle_wrong` fields) — through the live judge named by `--judge`, using the same grading function `eval`'s own trial loop uses. Each non-`empty` canned answer is graded `--samples` times (default 3) rather than once, because the live judge is not deterministic on identical input; a canned answer is a match only when every sample agrees with the expected verdict and none errored — the recordings this command writes (with `--record`) store all of a canned answer's samples, not a single verdict. Exits `1` if any canned answer's verdict does not match what it should be (`empty`/`echo`/`vague`/`known-wrong`/`subtle-wrong`/`injection`/`stuffed` must all FAIL, `known-right` must PASS). `--record` writes the recorded samples to `src/gdskills/governance/judge-recordings/<pack>__<skill>.json`, keyed by a digest of the exact judge prompt — the integrity guard replays these offline, and a stale recording (an edited rubric, a bumped judge prompt version) is detected rather than silently reused. A recording is a hand-writable file like any other committed artifact: it proves the anti-gaming set was checked against a live judge at record time, not that nobody could have edited it afterward — the same threat model as `eval`'s report, above. |
| `stocktake` | `--scope bundled\|all`, `--quick`, `--json` | Flow 325 (W1): periodic catalog health check — buckets each skill `keep\|improve\|update\|retire\|merge`. `--quick` skips the slower checks. |

Profiles: `minimal`, `recommended` (default), `full`, `custom`. Contract schemas:
`subagent-result`, `subagent-dispatch`, `agent-event`, `orchestrator-state`,
`review-finding`.

### What `verify --bundled` checks, and what it does not

`--bundled` is **layer one of three** and only layer one. It runs the checks that
can be decided by reading files:

| Check | Rule |
|---|---|
| `frontmatter:block` / `:name` / `:description` / `:metadata` | Required fields are present, non-empty, and `metadata` carries a `version`. |
| `frontmatter:name-unique` | No two skills declare the same `name`; a harness registers by that name. |
| `catalog:registered` | `BUNDLED_GDSKILLS` names the directory, so `skills install` actually copies it. |
| `model:concrete-declaration` | No skill names a model id where a `model_tier` belongs. |
| `persona:name` / `persona:marker` / `path:personal-home` | No shipped file names a particular person or points into their home directory. |
| `xref:skill` / `xref:path` | Every skill and every `skills/`, `rules/`, `scripts/` path a skill names actually exists in the shipped tree. |

It does **not** judge whether a skill's instructions are correct, useful, or
followed. That is layer two (a model judging across named dimensions) and layer
three (reliability over repeated runs), and neither is built. A clean report from
`--bundled` is not a quality claim, and the command's own output says so.

The identical sweep runs in CI as `src/gdskills/bundled-eval.test.ts`, over the
same `evaluateBundledTree` predicate, so the guard and the command cannot
disagree.

---

## skill-verify-skill

Top-level alias for `skills verify` — verify a project skill against current repo
evidence and write a verification report.

```
keryx skill-verify-skill <skill-or-target>
```

Accepts the same flags as `skills verify` (`--dry-run`, `--json`, `--all`).

---

## health

Aggregate code-quality signals from multiple tools (ESLint, TypeScript, tests,
dependency audit, SonarQube, plus built-in complexity/coverage/churn) into
per-scope health scores, compare against a baseline, and evaluate a pass/warn/fail
quality gate.

```
keryx health run [--strict] [--scope <sel>] [--changed [--since <ref>]] [--source <list>]
keryx health status
keryx health gate [--strict-warn]
keryx health sources
keryx health explain <file-or-module> [--narrate] [--provider <p>] [--json]
keryx health baseline update [--scope <sel>]
keryx health trend [--scope <key>] [--limit <n>]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `run` | `--strict`, `--scope project\|module:<name>\|file:<path>`, `--changed`, `--since <ref>`, `--source eslint,typescript,...` | Run the full pipeline, write `latest.json`/`latest.md` + history, print gate + score. Exit `1` if gate = fail. |
| `status` | — | Read the last report: enabled, last run, gate, project score, regressed scopes, per-source status, trend. |
| `gate` | `--strict-warn` | Re-read the last report's gate (no re-run). Exit `1` on fail, or on warn with `--strict-warn`. |
| `sources` | — | Detect and list each source's mode/required/status without running the tools. |
| `explain <file-or-module>` | `--narrate`, `--provider <p>`, `--json` | Print a scope's metrics + its first 20 findings from the last report. `--narrate` adds a model-written explanation and **needs a credential** — without one it exits `1`. Note it returns `0` before reaching the model when the scope has no metrics yet; run `keryx health run` first. |
| `baseline update` | `--scope <sel>` | Write current scores into the baseline (all scopes, or those matching the selector). Runs health first if no report exists. |
| `trend` | `--scope <scope-key>`, `--limit <n>` | Print a scope's health-score trend over history. Defaults: scope `project`, limit `20`. |

---

## test

Discover the project's test context and run its existing test runner, normalizing
output into JSON + Markdown reports under `.metaproject/data/testing/`.

```
keryx test init
keryx test analyze
keryx test run [--changed] [--since <ref>] [--strict] [--scope <path>] [--kind <k>]
keryx test status
keryx test context
keryx test report latest [--json]
keryx test related <file>
keryx test suggest <file> [--provider <p>] [--model <m>] [--json]
keryx test explain <file-or-scope>
keryx test coverage-map build|status
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `init` | — | Alias of `analyze` (same code path). |
| `analyze` | — | Scan the tree, detect the test stack, write `context.{json,md}` + `recommendations.md`. |
| `run` | `--changed`, `--since <ref>`, `--strict` (alias `--gate`), `--scope <path>`, `--kind unit\|integration\|e2e\|smoke` | Select tests, run the runner, parse output, write the report. Exit `1` on fail/error. |
| `status` | — | One-line summary: enabled, frameworks, test-file count, last run + status. |
| `context` | — | Print saved context + recommendations (hints to run `analyze` if absent). |
| `report latest` | `--json` | Print the latest normalized report (Markdown, or raw JSON with `--json`). |
| `related <file>` | — | List tests related to a source file by naming/directory heuristics. |
| `suggest <file>` | `--provider <p>`, `--model <m>`, `--json` | **Needs a model credential.** Propose a test plan for the file, matching the frameworks already detected in the project. Exits `1` without a credential. |
| `explain <file-or-scope>` | — | Frameworks + related tests + latest failures filtered by the target. |
| `coverage-map build` | — | Build the test-impact coverage map (source → covering tests) and write the artifact. Prints the source strategy and entry count. |
| `coverage-map status` (default) | — | Report the coverage-map capability + config state, whether a map is present, its `gitRef`, and whether it is stale (a stale map falls back to static selection). Bare `coverage-map` defaults to `status`. |

`--changed` selects tests for changed files (via `git`); with `--strict` and no
matched tests, the run fails — this drives the pre-push gate.

When the opt-in testing coverage-map TIA capability is enabled (see
`init --testing-tia`) and a fresh map exists, `run --changed` prefers the
coverage map to pick precisely the tests that cover the changed sources; it falls
back to the static naming/directory heuristics when the map is missing or stale.
The `smoke` tier (`--kind smoke`) selects the fast smoke subset.

When the `security` module is enabled, `run` runs an advisory security check on the
captured raw log before persisting it. Advisory (the default) reports and still
writes the log; `enforced`/`ci`/`gateway` mode can suppress raw-log persistence
with a masked reason (the run itself is never broken).

---

## stack

Deterministic, offline stack detection (flow 325, W1). Reads manifest files
(`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …), marker files
(`Dockerfile`, `.github/workflows/*.yml`, `*.tf`, `*.sql`, …) and runs a
bounded extension scan — no network, no model call — and writes
`.metaproject/data/stack/stack.json`.

```
keryx stack detect [--cwd <dir>] [--json] [--no-write]
```

| Subcommand | Flags | Notes |
|---|---|---|
| `detect` (only subcommand) | `--cwd <dir>`, `--json`, `--no-write` | Detects the repository's stack tags. Writes `.metaproject/data/stack/stack.json` by default; `--no-write` detects and prints without writing. `--json` prints exactly the persisted document. `--cwd` points detection at another directory instead of the current one. |

Every failure mode (an unreadable/unparseable manifest, a workspace root with
no leaf dependency, a bounded scan that hits its file cap) marks `uncertain:
true` for only the tags that signal's family covers — never every tag —
matching `src/review/stack.ts`'s existing fail-open discipline, generalized.
Re-running `detect` on an unchanged tree writes a byte-identical file: the
persisted `detectedAt` is kept whenever the content fingerprint
(`inputsSha256`) is unchanged.

---

## metrics

Provenance-aware execution observability: per-run evidence, active-time
accounting, and baseline-aware comparison.

```
keryx metrics status
keryx metrics collect --events <events.json> [--run-id <id>] [--skill <name>]
keryx metrics validate <run.json>
keryx metrics latest
keryx metrics show <run-id>
keryx metrics compare <run-a> <run-b> [--json]
keryx metrics rebuild --source <events.json>
keryx metrics plan --profile lightweight [--changed <file,...>]
keryx metrics benchmark init --tasks <task-a,task-b,task-c> --out <manifest.json>
keryx metrics benchmark validate <manifest.json>
```

| Subcommand | Description |
|---|---|
| `status` | Whether metrics collection is configured, and what has been recorded. |
| `collect` | Fold an events file into a durable run record. |
| `validate <run.json>` | Check a run record against the schema. |
| `latest` / `show <run-id>` | Print the most recent run, or a named one. |
| `compare <run-a> <run-b>` | Diff two runs. `--json` for the machine-readable form. |
| `rebuild --source` | Regenerate run records from an events file. |
| `plan --profile lightweight` | Plan a low-overhead collection profile, optionally scoped with `--changed`. |
| `benchmark init \| validate` | Create and check a paired-comparison manifest. |

> **No performance claim has been made about keryx.** The benchmark harness
> exists so that a paired Keryx/no-Keryx comparison can be run and reported
> honestly, not to support a number that has already been published.

---

## memory

Long-term, typed project memory: durable Markdown entries (lessons, decisions,
constraints, known mistakes, patterns, …) under `.metaproject/memory/`, with
deterministic (non-LLM) search, dedup, and consolidation.

```
keryx memory new <type> [slug] --title "<title>" [--force]
keryx memory index [--embeddings]
keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>] [--as-of <YYYY-MM-DD>] [--class <semantic|episodic|procedural>] [--semantic] [--save-report]
keryx memory transition <path> --to <draft|accepted|conflict|deprecated> [--reason <text>]
keryx memory supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]
keryx memory assets list | verify [<id>] | pull <id>
keryx memory ingest --from-<source> <path>
keryx memory check
keryx memory reflect [--narrate] [--provider <p>]
keryx memory handoff --from <harness> --target <harness> [--scope project|user] [--json]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `new <type> [slug]` | `--title "<t>"`, `--force` | Scaffold a new draft entry; print possible duplicates. |
| `index` | `--embeddings` | Build an optional disposable catalog at `data/memory/index/index.json`; `--embeddings` additionally builds a disposable vector cache when the capability is available. Search scans canonical Markdown directly and does not consume either generated output. |
| `search "<query>"` | `--module <m>`, `--entity <e>`, `--status <s>` (e.g. `accepted`), `--limit <n>` (1–100), `--as-of <YYYY-MM-DD>`, `--class <semantic\|episodic\|procedural>`, `--semantic`, `--save-report` | Filesystem-pure ranked retrieval by default; validates status/class/date/limit before reading. `--save-report` explicitly publishes one bounded immutable report under ignored `.metaproject/runtime/memory/search/<run-id>/`; without it neither text nor `--json` writes artifacts. |

Generated memory catalogs and embedding caches under `.metaproject/data/memory/`
are disposable and ignored. Existing legacy `data/memory/artifacts/latest.*`
files receive an advisory during init/update; migration is maintainer-owned and
never deletes files or changes the Git index automatically.
| `transition <path>` | `--to <draft\|accepted\|conflict\|deprecated>`, `--reason <text>` | Explicit validated lifecycle transition through the guarded atomic write seam; invalid or terminal edges fail without changing bytes. |
| `supersede <old-path>` | `--by <new-path>` (required), `--date <YYYY-MM-DD>` | Mark one entry as superseded by another. Non-destructive and git-diffable — both entries stay on disk. A blocking security gate can abort the write. |
| `assets list \| verify [<id>] \| pull <id>` | — | Manage declared assets from `assets.lock.json` (`list`/`verify`/`pull`; `pull` is the only networked verb). |
| `ingest` | `--from-review\|--from-health\|--from-job\|--from-skill-verifier <path>` | Extract candidate insights from a source artifact into ADD/UPDATE entries. |
| `check` | — | Integrity/lint pass (metadata, links, dedup, conflicts, index). Exit `1` on issues. |
| `reflect` | `--narrate`, `--provider <p>` | Cluster entries by tag and create `pattern` drafts for clusters ≥ min size. `--narrate` adds a model-written summary of the memory and **needs a credential** — without one it exits `1`. |
| `handoff` | `--from <harness>`, `--target <harness>` (both required), `--scope project\|user` (default `project`), `--json` | Explicit cross-harness memory read: entries whose `Source-Harness` matches `--from` and whose `Target-Harnesses` is unset or includes `--target`. Fails closed on an unreadable folder, unreadable file, or malformed entry — the result reports `status: "incomplete"` (exit `1`) rather than silently returning a partial set as if it were complete; a clean scan reports `status: "complete"` (exit `0`). An unknown harness id or scope exits `2` with a named reason. |

Entry types: `lesson`, `decision`, `constraint`, `known-mistake`,
`historical-context`, `pattern`, `task-note`, `review-note`, `incident`,
`migration-note`, `integration-note`.

When the `security` module is enabled, `ingest` runs an advisory security check
before writing each accepted entry. Advisory (the default) reports and writes;
`enforced`/`ci`/`gateway` mode can skip an entry's write with a masked reason.

---

## flow

Agent-first work lifecycle ("Task Manager"; manifest module id `tasks`). Each unit
of work is a self-contained package under `.metaproject/flows/`, driven through a
strict status state machine with hard completion gates. The CLI is the sole writer
of flow state.

```
keryx flow init (--issue <url> | --title "<t>") [--slug <s>] [--base <branch>] [--owner "<name>"]
keryx flow list
keryx flow status <id>
keryx flow freeze <id>
keryx flow plan <id> [--provider <p>] [--json]
keryx flow start <id>
keryx flow next <id> [--json]
keryx flow task add <id> --title "<t>" [--kind <k>] [--depends T1,T2]
keryx flow task done <id> <taskId> [--disposition <d>] [--reason "<why>"]
keryx flow task attempt <id> <taskId> --outcome started|failed|blocked [--detail "<what>"]
keryx flow task depends <id> <taskId> --on T1,T2|none --reason "<why>"
keryx flow owner set <id> --owner "<name>" --reason "<why>"
keryx flow ac confirm <id> <ACn> [--note "<evidence>"] [--signed-by "<name>"]
keryx flow ac update <id> --reason "<why>"
keryx flow ac update <id> --criterion ACn --text "<criterion>" --reason "<why>"
keryx flow ac reseal <id> --reason "<why>"
keryx flow check-ac <id> [--diff <ref>|--pr <n>] [--json] [--refresh]
keryx flow implemented <id> --pr <url>
keryx flow complete <id> [--comment] [--merged <commit>] [--signed-by "<name>"] [--confirm-token <token>]
keryx flow confirm <id> [--merged]
keryx flow recover <id> --reason "<why>"
keryx flow block <id> --reason "<why>"
keryx flow unblock <id>
keryx flow check
keryx flow renumber <dir> --to <id> --reason "<why>"
keryx flow repair-reviews
keryx flow schema [--out <path>]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `init` | `--issue <url>` \| `--title "<t>"`, `--slug <s>`, `--base <branch>`, `--owner "<name>"` | Scaffold a flow package. Requires a title or issue URL. Writes four default tasks (T1 context, T2 implement, T3 test, T4 review), each marked `origin: "scaffold"` — see [the default task scaffold](#the-default-task-scaffold). `--owner` names the human accountable for the flow (see [the owner and completion signatures](#the-owner-and-completion-signatures)) — never inferred, so an omitted `--owner` leaves the flow with no owner rather than a guessed one. |
| `list` | — | List all flows with status + task counts. |
| `status <id>` | — | Print one flow: status, source, AC state, PR, owner, latest signature, tasks, recent history. |
| `freeze <id>` | — | Record the AC checksum; transition `initializing → ready`. |
| `plan <id>` | `--provider <p>`, `--json` | **Needs a model credential.** Break the flow's frozen acceptance criteria into a proposed task breakdown. Exits `1` without a credential. |
| `start <id>` | — | Transition `ready → in-progress`. |
| `next <id>` | `--json` | The first task that is not `done` and whose declared `dependsOn` are all `done` — the resume decision, computed from the record rather than re-derived from prose. Exits `1` when work remains and nothing can start (an unsatisfiable dependency or a cycle); `keryx flow check` names which. Also reports the task's **resume state** — `never-started`, `ended` (a prior attempt reported how it finished), or `unresolved` (an attempt was opened and no end was recorded, so whether its work landed cannot be told from the record) — plus every other not-done task carrying an unresolved attempt. `--json` carries this as `resume` and `unresolved`. |
| `task add <id>` | `--title "<t>"` (required), `--kind context\|implement\|test\|review\|docs`, `--depends T1,T2` | Append a task. `--depends` is read by `flow next` and validated by `flow check`. |
| `task done <id> <taskId>` | `--disposition completed\|blocked\|failed\|skipped`, `--reason "<why>"` | Mark a task `done`. A `failed` or `blocked` close **records an attempt automatically** — those two dispositions are attempts by definition, and requiring a second command is why the counter read zero across seven flows. |
| `task attempt <id> <taskId>` | `--outcome started\|failed\|blocked` (required), `--detail "<what happened>"` | Record one execution attempt explicitly. Appends to the same append-only log `task done` writes to. |
| `task depends <id> <taskId>` | `--on T1,T2\|none` (required), `--reason "<why>"` (required) | Rewrite one task's `dependsOn` — the repair for the three unsatisfiable shapes `flow check` reports. Until this existed, `--depends` wrote the field once at creation and nothing could rewrite it, so the only remedy was editing `flow.json` by hand; flow 178 carried a self-dependent `T10` for two weeks because the check was right and the operator had nowhere to go. Ids are normalised, so `t1`, `T1` and ` t1 ` are one edge. The change is validated against the same `dependencyIssues` the check uses and **refused if it would introduce an issue that was not already there** — deliberately narrower than "the graph must end clean", because a flow with two broken tasks has to be repairable one task at a time. A refused change leaves the record exactly as it was found. `--on none` clears the field. |
| `owner set <id>` | `--owner "<name>"` (required), `--reason "<why>"` (required) | Set or change the flow's owner — the human accountable for it. **Never inferred**, and a `--reason` is required even for the first assignment. Every change is kept, not overwritten: it appends a `history` event naming the previous owner, the new owner, the reason and the time, so no earlier owner is ever lost. See [the owner and completion signatures](#the-owner-and-completion-signatures). |
| `ac confirm <id> <ACn>` | `--note "<evidence>"`, `--signed-by "<name>"` | Confirm one acceptance criterion. Appends an append-only signature recording who confirmed it (see [the owner and completion signatures](#the-owner-and-completion-signatures)) — a repeated confirmation of the same criterion adds a new signature rather than replacing the last one. |
| `ac update <id>` | `--reason "<why>"` (required); or `--criterion ACn --text "<criterion>"` together with `--reason` | Re-freeze the AC checksum **and void every prior confirmation** — right when the criteria changed, because a criterion nobody confirmed in its current wording has not been confirmed. Wrong when only the seal is stale; use `ac reseal` for that. Without `--criterion`/`--text`, re-freezes the file exactly as an operator already edited it (the only behaviour before flow 293). With both, rewrites that one `ACn` line's text itself — **only when the criterion is genuinely a single line**, the format the file's own Rules section prescribes — or appends it, when `ACn` is the **next unused number** (highest existing `ACn` + 1; a gap in the numbering, e.g. AC1/AC2/AC4 with AC3 missing, can never be filled this way — the refusal names the gap and says to edit the file directly and re-freeze with `--reason` alone). If the target criterion has ANY indented, non-blank line following it before the next `- ACn:` line, a blank line, or a heading — a criterion wrapped across two lines, a sub-bullet evidence note, a fenced code block, anything — the command **refuses**, naming the criterion, and writes nothing; there is no way to tell "this is the criterion continuing" from "this is unrelated content under it" from the file alone, so it never guesses at either. Edit the file directly and re-freeze with `--reason` alone instead. `--text` and `--reason` must each be non-empty, fit on one line, and (for `--text`) not repeat its own `- ACn:` prefix. `--criterion` and `--text` must be given together; either alone is refused. The flow's `history` records the criterion, its (single-line) previous text and its new text alongside the reason. The write itself preserves the rest of the file's bytes exactly: an untouched line keeps its own original line ending (even in a file with mixed `\n`/`\r\n` endings), and an appended line takes the ending of the line it follows. |
| `ac reseal <id>` | `--reason "<why>"` (required, one line) | Re-seal a stale checksum over a file that did **not** change, keeping the confirmations. Refuses unless git reports the criteria file tracked and unchanged against HEAD, and refuses when git cannot answer at all — no evidence must not read the same as clean. It proves the file being sealed now is the file committed now; it cannot prove the old checksum was ever right. Exists because the only other repair destroys the record: flow 002 carries ten dated confirmations against a criteria file byte-identical to its first commit, with a checksum sealed against content predating the squashed `0.1.0` import. |

Every `ac` subcommand refuses an argument it does not use — an extra positional, an unrecognised flag, or `--text` without `--criterion` (or the reverse) — rather than dropping it silently and reporting success. `ac update <id> AC1 --text "…" --reason "…"` (the syntax before flow 293) is refused: `AC1` is not a positional `ac update` accepts. Every value flag (`--note`, `--signed-by`, `--reason`, `--criterion`, `--text`) consumes the very next token as its value even when that value itself starts with `--` (e.g. `--note "--dry-run mode was used"`), unless that next token is itself one of the subcommand's own flag names — then it is refused as a missing value (`missing value for --note`) rather than silently swallowing the next flag as text.
| `check-ac <id>` | `--diff <ref>`, `--pr <n>`, `--json`, `--refresh` | **ADVISORY.** Jev checks the flow's change against its FROZEN acceptance criteria; never changes flow state and never confirms an AC. `--refresh` bypasses a cached result even when the diff and criteria checksum match. See [check-ac](#flow-check-ac) below. |
| `implemented <id>` | `--pr <url>` (required) | Transition `in-progress → implemented`; record the draft PR. |
| `complete <id>` | `--comment`, `--merged <commit>`, `--signed-by "<name>"`, `--confirm-token <token>` | Run completion gates; on pass `→ done` (optionally comment the issue) and append a completion signature, on fail `→ in-progress`. Every outcome but a dead process leaves the flow in `in-progress` or `done`, never in `completing`: a gate that throws, or a criteria file changed mid-run, is recorded as a failed attempt. See [the owner gate](#the-owner-gate), [the owner and completion signatures](#the-owner-and-completion-signatures) and [the confirmation token](#the-confirmation-token). |
| `confirm <id>` | `--merged` | Mint a completion confirmation token for a flow that requires one. Refuses unless stdin and stdout are terminals, the flow is `implemented` (or `in-progress` with `--merged`), and its criteria are frozen and unchanged. Shows what is being confirmed, asks for a random code typed back on `/dev/tty`, then prints the token once. See [the confirmation token](#the-confirmation-token). With `--merged` the token binds only `merged`, not a commit: the commit is named later, at `flow complete --merged <commit>`, so the token does not pin which commit that is. `--merged` is accepted on an `implemented` flow that records a PR too, matching `flow complete --merged` being allowed from `implemented`; the token then binds `merged`, and a PR completion with it fails as `token_target_mismatch`. |
| `recover <id>` | `--reason "<why>"` (required) | Move a flow left in `completing` (by a process that died mid-`complete`) back to `in-progress`, recording the reason, the last event before the interruption, and whether the criteria file is intact. Refuses from any other status and while another process holds the flow's lock. `flow status` and the TUI's `/flows` view label such a flow `interrupted` and name this command. |
| `block <id>` | `--reason "<why>"` (required) | Transition any status `→ blocked`, saving the previous status. |
| `unblock <id>` | — | Restore the saved previous status. |
| `check` | — | Consistency audit across all flows: structure, checksums, schema, duplicate ids, plus every `dependsOn` that can never be satisfied (unknown id, self-reference, cycle) and every task recorded `failed`/`blocked` with no attempt behind it. |
| `renumber <dir>` | `--to <id>` (required), `--reason "<why>"` (required) | Repair a duplicate flow id. |
| `repair-reviews` | — | Re-point review records (`manifest.json`, `scope.md`, `findings.json`, review-note links) of flows renumbered before `renumber` rewrote them, by replaying `id-map.json` against each flow's current directory. Idempotent. |
| `schema` | `--out <path>` | Emit the flow JSON schema. |

Statuses: `initializing`, `ready`, `in-progress`, `implemented`, `completing`,
`done`, `blocked`. `task` and `ac` are command groups — the atomic verbs are
`task add`, `task done`, `task attempt`, `ac confirm`, `ac update`.

When the `security` module is enabled, `complete` adds a `security` completion
gate. Advisory (the default) makes it informational (`pass`, never blocks);
`enforced`/`ci`/`gateway` mode can fail the gate and hold the flow in
`in-progress`. The gate is omitted entirely when the module is disabled.

### `flow check-ac`

Jev checks a flow's change against its FROZEN acceptance criteria (flow 328). **Always
advisory**: it never changes flow state, never confirms an AC, and its own errors
never fail a caller command.

```
keryx flow check-ac <id> [--diff <ref>|--pr <n>] [--json] [--refresh]
```

The change defaults to the flow worktree's diff against its base branch (or
`origin/main`), against their MERGE BASE — same reasoning `review floor`'s
`--ref` uses. `--diff <ref>` diffs against another ref's merge base instead;
`--pr <n>` reads the pull request's diff via `gh pr diff <n>` (repo inferred
from the checkout's `origin` remote) instead of local git.

Results are cached per flow, keyed on (criteria checksum, diff hash) — a
repeat call against an unchanged diff and unchanged frozen criteria reads the
cache instead of asking Jev again. `--refresh` bypasses that cache even when
both match, forcing a fresh Jev call — the same "the cache exists, ask
anyway" shape as `keryx providers status --refresh` and `keryx learn accept
--refresh`.

For every criterion in `acceptance-criteria.md`:

1. **Deterministic facts first (AC2).** Backticked tokens, file paths and
   `keryx <cmd>` names named IN the criterion's own text are checked against
   the diff and the changed-file list, and any changed TEST file mentioning
   one is noted — computed with no model call, and placed above the diff in
   Jev's `state`.
2. **`not-checkable`, without a model (AC3).** A criterion about a live
   check, CI green, `keryx health run`, docs being published, or a manual/
   human-process step is recognised by an explicit, documented marker list
   and never sent to Jev — always listed, never dropped.
3. **One `noul` question per remaining criterion (AC4).** Batched under the
   vendor's 64k `state`+`questions` budget (packed to half that, with a cap
   on criteria per batch — a real large diff can make a few generic tokens
   match far more hunks than the documented ceiling actually affords), with
   only the diff regions the criterion's own tokens matched — redacted via
   `src/security/service.ts` — or, when nothing matched, the changed-file
   list and that fact. Opt-in per project:
   `{"review":{"jev":{"ac_check":true}}}` in `.metaproject/tasks.config.json`.
   Without the opt-in, or without an OpenRouter credential, the command
   still prints every criterion's deterministic evidence and says plainly
   that Jev was not asked — nothing is silently skipped.

Each checkable criterion is reported `likely-met` or `not-evident` (Jev's
probability against a 0.5 threshold), alongside its probability, facts and
matched evidence paths.

**Cached (AC8).** Results are cached per flow under `.metaproject/data/ac-check/`
(gitignored, mode 0600), keyed by (criteria checksum, diff hash) — an
unchanged diff against unchanged criteria reads the cache rather than asking
Jev again.

**Advisory notices (AC5).** `flow implemented` and `flow complete` print a
one-line summary (counts, and which criteria are not evident) when the
opt-in is on — never blocking, and a check failure is one line, not a
command failure.

**Review attachment (AC6).** `keryx review ingest` for a flow with the
opt-in attaches the latest CACHED result as `ac-check.md` in the review
package, so reviewers see which criteria are in doubt — this never triggers
a fresh Jev call itself. The cache is attached only when its key (criteria
checksum + diff hash) matches THIS round's own diff (the merge-base of
`--ref`/the recorded `--head`, the same shape `check-ac` itself diffs
against); a cache that exists but does not match gets a short STALE note
instead (naming when it WAS checked, and that `--refresh` re-checks it),
never a report that reads as current when it is not.

**Shell (AC7).** `/flows`' modal carries an "AC" tab with per-criterion
markers (met / not evident / not checkable / not run); `c` re-runs the check
for the selected flow, and `/ac` opens the modal straight to that tab.

### The default task scaffold

`flow init` writes four tasks into every new package — T1 collect context, T2
implement, T3 test, T4 self-review — each carrying `origin: "scaffold"` so a
generated row is a recorded fact rather than a title match. They are a default
checklist, not a plan: add your own with `flow task add`, and close any scaffold
row your plan supersedes with a stated reason:

```
keryx flow task done <id> T1 --disposition skipped --reason "<why this flow did not need it>"
```

Measured over the 206 packages that existed when this was last reviewed: no flow
has ever *replaced* the scaffold (flows extend it), 91.5% of scaffold rows reach
`done`, and 43% of flows record no task beyond these four — so for nearly half
of all flows this scaffold is the entire task list. Removing it would leave those
flows with an empty task list, and an empty list passes the task gate vacuously
(`0 task(s) terminal`), which is weaker than the four rows it replaced.

**Scaffold rows never expire.** Nothing closes them on a timer, at completion or
anywhere else. `disposition: "skipped"` means somebody judged the work
unnecessary; "nobody looked for N days" is the absence of that judgement, and
recording it as one is the defect the task gate exists to prevent. What the tool
does instead is make the debt visible and cheap to clear: when the task gate
fails, it names the scaffold rows that were never started separately from the
flow's own open work, and prints the command above. The `--reason` stays yours.

### The `review` completion gate

`complete` also runs a `review` gate over the flow's managed review packages
(`.metaproject/flows/<flow>/reviews/`). It passes only when all five of these
hold, and the failure names which one did not:

1. **A managed review record exists, and every round in it is readable.** A round
   whose `manifest.json` or `findings.json` is missing cannot be cited — nothing
   durable records what it found — and a round that cannot be read is not a
   round that found nothing: it fails this condition rather than being skipped
   over. Whatever of it *can* be read still counts towards condition 2.
2. **No finding is left without a terminal disposition**, at or above the
   severity floor. "Terminal" is defined positively, per finding: `acted-on`
   needs a commit SHA *and* a verifier `refuted` verdict citing that SHA;
   `dismissed-incorrect` needs a verifier `refuted` verdict with a method and
   evidence; the three "correct, but not now" dismissals need a recorded human
   decision; `answered-disagree` needs a reply (`external_ref.reply_url`, or one
   named in the evidence) — refuting somebody else's comment is not answering
   it. A finding that simply stops appearing in later rounds is **not** cleared —
   the check runs over the latest state of every finding ever raised, so absence
   never reads as a fix.
3. **The latest round ran against the PR head commit.** A clean round against a
   stale SHA proves nothing about what will merge. The round records this as
   `manifest.target.head`, written by `review start|attach|ingest` from
   `git rev-parse HEAD` (or from `--head`); a round that recorded none is
   *unobserved*, which fails.

   On `flow complete --merged <sha>` there is no PR head, and the merged commit
   stands in for it. The test there is **containment, not equality**: the round
   passes when its head is an ancestor of (or the same commit as) the merged
   commit, which is what a merge commit gives you. A **squash or rebase** merge
   rewrites the branch commit, so the reviewed SHA can never appear in the merged
   history and this condition cannot be satisfied by re-running the round — the
   failure says so and names the two things that do work: ingest a round with
   `--head <merged-sha>`, or record the pull request on the flow so the round is
   compared against the PR head instead.
4. **No external PR comment is unanswered, and the collection that says so is
   current.** Answered from the durable record `keryx review comments
   collect|reply` writes
   (`.metaproject/reviews/pr-comments/<owner>__<repo>__<n>.json`), not from a
   reviewer name in `manifest.coverage` — that is written straight from
   `--reviewers` and collects nothing. A flow with a PR and no such record is
   *unobserved*: "nobody commented" and "nobody looked" are different facts.

   A record that exists is not enough. It carries `collected_sha` — the head
   `comments collect --sha` read — and the gate compares it with the PR head the
   same way it compares the round's. A collection made before the comments
   arrived is *unobserved*, as is a record with no `collected_sha` at all
   (written by a keryx older than the field): a count of rounds is not a date,
   and an undated collection cannot be shown to be current.
5. **The verifier ran and its stats are on the record** (`verification_mode` in
   the round's `scope.md`). `off` fails; so does a mode with
   `claims_received: 0` when the round retained a finding at or above the
   severity floor — the mode names an intention, the claim count is what was
   actually read, and `annotate` is the default while `--verifications` is
   optional. A round with no `claims_received:` line is *unobserved*. A round
   that retained nothing blocking passes on zero claims: there was nothing to
   verify.

A condition that could not be *observed* fails the gate just as a violated one
does — the two are reported differently because the fixes differ, but neither
passes. Reaching the review round cap with the gate unsatisfied leaves the flow
`in-progress` and reports the blocker; it never force-completes.

Like the `tasks` gate, `review` is **opt-in per package** (`gates.review`,
written by `flow init`), so packages created before it existed report `skipped`
rather than being retroactively invalidated.

Optional per-project configuration, in `.metaproject/tasks.config.json`:

```json
{
  "completion": {
    "severity_floor": "minor",
    "require_clean_round": true
  }
}
```

`severity_floor` is `blocker`, `major` or `minor` (default `minor`); `info`
never blocks and is clamped to `minor` with a note. `require_clean_round: false`
turns the gate off, and says so in the gate list rather than disappearing.

### The owner gate

Like `tasks` and `review`, the owner gate is **opt-in per package** (`gates.owner`,
written by `flow init`): every flow created after this landed carries the flag;
flows created before it report the gate `skipped` and are never retroactively
blocked by a concept they predate.

For an opted-in flow, `complete` fails the owner gate — with the reason
`no owner set; run \`keryx flow owner set <id> --owner "<name>" --reason "<why>"\``
— while `flow.owner` is absent, and passes it once one is set (`flow init --owner`
or `flow owner set`).

### The owner and completion signatures

A flow can name an **owner** — the human accountable for it — and `ac confirm`/
`complete` each record a **signature**: who acted, when, and what exactly was
signed (the AC id and the frozen acceptance-criteria checksum for a confirmation;
that checksum plus, for a completion, **the head commit the pull-request gate
observed** — read from that gate's own `prStatus()` call, not re-fetched for
the signature). `complete()` runs several gates that each read the PR head
independently (the pull-request gate, the base-branch gate, the review gate);
a push landing mid-`complete()` can make them observe different commits, and
the signature names only the one the pull-request gate saw — not a guarantee
that every gate agreed on the same head. Signatures are append-only:
reconfirming a criterion, or completing a flow more than once, adds a new
signature rather than replacing the last one.

**The owner is never inferred.** It is set only by an explicit `--owner "<name>"`
on `flow init` or `flow owner set <id> --owner "<name>" --reason "<why>"` — never
read from git, an environment variable, or anywhere else. A flow nobody named an
owner for reports `owner: not set` in `flow status`, never a guessed name, and
every change is recorded as history rather than as an overwrite (`flow owner set`
requires a reason even the first time, and each call appends the previous value,
the new value, the reason and the time).

**A signature's signer is a claim, not proof.** `--signed-by` names the signer
explicitly. Missing that, `ac confirm`/`complete` fall back to the `KERYX_ACTOR`
environment variable, then to `git config user.email` in the checkout, then to
`unknown`. Every recorded identity carries a `basis` — `stated` (an explicit flag
or environment variable), `derived` (read from something like the local git
configuration — **never promoted to `stated`**), or `unknown` — and a `source`
naming exactly where it came from. None of `--signed-by`, `KERYX_ACTOR`, or a
local git identity is proof a human, rather than an agent running the same
commands, made the assertion; `keryx flow complete` says so in its own output,
and this reference says so here rather than overclaiming. See
[TM-02: Flow Owner and Signed Completion](https://github.com/MrCipherSmith/keryx/blob/main/docs/decisions/keryx-harness/TM-02-flow-owner-and-signed-completion.md)
for the full design, the JSON Schema shape, and why a stronger (structural,
not just claimed) human-presence guarantee was considered and deferred.

Every pre-existing `flow.json` with no `owner` or `signatures` field keeps
loading, validating, passing `flow check`, and completing exactly as before —
these fields are additive and optional, like every Task Manager v2 field, and
reading an old file never rewrites it on disk.

### The confirmation token

A flow can require a **confirmation token** before it completes. It opts in when
it is created, with `flow init --require-confirmation`, or with
`completion.require_confirmation: true` in `.metaproject/tasks.config.json`.
`flow init` stamps the answer into the new flow as `gates.confirmation`, so
changing the config later never alters an existing flow. Every other flow, and
every flow created before this existed, reports the `confirmation` gate as
`skipped`.

```
keryx flow confirm <id>                              # in a terminal: review, type the code back, get a token
keryx flow complete <id> --confirm-token <token>     # the confirmation gate passes; the token is spent
```

`flow confirm` refuses to mint unless all of these hold:
- stdin and stdout are both terminals;
- the flow is `implemented` (or `in-progress`, with `--merged`);
- the criteria are frozen and unchanged;
- a random code is typed back on `/dev/tty`, so a pipe on stdin cannot answer.

It stores only the token's sha256, in `confirm-token.json` inside the flow
directory, bound to the flow, the completion, the criteria checksum, and the
**target** you were shown: the PR URL, or `merged` for `--merged`. A token
minted while looking at one PR fails as `token_target_mismatch` if the flow is
later pointed at another PR, or completed with `--merged` instead (and the
reverse). Only
the latest mint is valid. A token lives for ten minutes. `flow complete` checks
it when the attempt starts, so a slow health gate cannot expire it midway. It is
spent only on a passing completion, so a failed attempt can be fixed and retried
with the same token. An expired, spent, other-flow, superseded or
pre-criteria-change token each fails the gate with its own named reason.

The completion signature keeps its `identity` exactly as before and gains a
`confirmation` field: `mechanism: "terminal-token"`, a `tokenRef` (a prefix of
the stored hash, never the token), `mintedAt`, `consumedAt` and `boundTo`.
`flow status`, `flow complete` and `keryx governance report` show it.

What the token does **not** prove, stated rather than implied:

- **What it does prove.** A step that no agent tool can perform ran within the
  TTL, for exactly this criteria checksum. Not that a human ran it, and not who.
- **The command-text floors can be evaded.** keryx's own agent loop, its ACP
  classifier and its supervised-codex path ask a human before running any
  command that contains the words `flow confirm`, in every permission mode. No
  session pattern or remembered grant answers that prompt, and "always" is
  never offered for it. Unattended
  trigger runs refuse it outright. But these checks match text: a variable, a
  script file or `bun -e` spells the same thing without the words.
- **A pseudo-terminal can be faked.** `script -qc '…' /dev/null` gives any
  command a terminal with no person present. So an agent with an unrestricted
  shell can run `flow confirm` and type the code itself.
- **The hash store can be forged.** It is a plain file. An agent that can write
  files can write the hash of a token it chose. The harness and ACP refuse to
  edit it, but a shell redirect is not path-classified.
- **Agents outside keryx supervision are not gated at all.** An editor's own
  shell tool, for example, never passes through keryx's approval prompt.
- **The opt-in lives in `flow.json`.** A shell-capable agent can hand-edit
  `gates.confirmation` away.
- **Handing the token to an agent delegates the completion.** That is the
  intended handoff, and all the record can show is that someone completed the
  interactive step.

The same limits apply to SAC's `keryx workspace confirm-review` token. See
[TM-03: Terminal Confirmation Token](https://github.com/MrCipherSmith/keryx/blob/main/docs/decisions/keryx-harness/TM-03-terminal-confirmation-token.md).

### Completion attempts (gate outcomes)

Every `flow complete` invocation — pass or fail — appends one entry to
`FlowState.completionAttempts`: the outcome (`pass`, `fail`, or `skipped`) and
detail of every gate that attempt evaluated, whether the attempt passed
overall, and the acceptance-criteria checksum in force at the time. Unlike
`gates.owner`/`gates.review`/`gates.tasks`, this is not opt-in — it is written
on every attempt from every flow, starting the moment this field shipped — and
it does not bump `schemaVersion`. A `flow.json` written before this field
existed simply has no `completionAttempts`; `keryx governance report` reads
that absence as `gate outcomes: not recorded`, never as "every gate passed".

The record is written **before** the attempt's final state transition, not
after — specifically so that an acceptance-criteria file edited out-of-band
while a later gate (health, review, security, …) is still running cannot cost
the attempt its record. If that race is caught, the attempt is persisted as
**failed**, with an extra `acceptance-criteria` gate entry naming the tamper,
alongside whatever the earlier gates already decided — not silently dropped
by the exception the stale criteria file still throws a moment later.

**Growth is unbounded, on purpose — the same choice `signatures` already
makes.** Every entry costs one `flow complete` invocation, made by a human or
an agent that decided to attempt completion; nothing amplifies it (a single
gate re-run inside one attempt is not a second entry). A flow that has been
completed and reopened repeatedly might carry a few dozen attempts over its
whole lifetime — nowhere near the volume that would make truncation worth the
honesty cost of a record captioned "the last N attempts" instead of "every
attempt". If a pathological retry loop ever makes this a real concern, the fix
belongs beside `flow.json`'s general size (which every field here already
affects), not as a special case for this one array.

---

## rules

Keep the root agent entrypoints (`AGENTS.md`, `CLAUDE.md`) in sync with the
`.metaproject/` workspace by importing them as high-priority project rules and
injecting a managed routing block. Requires an initialized workspace.

```
keryx rules sync
keryx rules distill
```

| Subcommand | Description |
|---|---|
| `sync` | Import each root entrypoint into `.metaproject/rules/<slug>.md`, inject/upgrade the managed Metaproject routing block, and refresh the index. |
| `distill` | Superset of `sync`: additionally split large entrypoints into typed artifacts (project rules, project skills, root-only sections) and rewrite the trimmed root file. |

Only `sync` and `distill` are accepted; the only recognized flag is `--help`/`-h`.
An unknown subcommand prints an error and exits `1`.

---

## job

Agent-first job packages: the durable state a `job-orchestrator` run writes as
it moves through its steps, so a job survives a process restart and a reader can
tell what stage it reached without re-running anything. Distinct from `flow` —
a flow is the managed work lifecycle with frozen acceptance criteria and
completion gates; a job is the orchestrator's own step/document record.

```
keryx job init --name <slug> [--intent implement|analyze|review|custom] [--project <path>]
keryx job list [--json]
keryx job status <name> [--json]
keryx job step <name> <step-id> --status pending|in-progress|completed|skipped|failed [--reason "<text>"]
keryx job document <name> --type analysis|implementation-report|review|verification-report --file <path>
keryx job complete <name>
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `init` | `--name <slug>`, `--intent implement\|analyze\|review\|custom`, `--project <path>` | Scaffold a job package. `--project` targets a root other than the cwd. |
| `list` | `--json` | List job packages in the project. |
| `status` | `<name>`, `--json` | Print one job's state: its steps, their statuses, and the documents attached. |
| `step` | `<name> <step-id>`, `--status pending\|in-progress\|completed\|skipped\|failed`, `--reason "<text>"` | Move one step. `--reason` records why for the non-completed dispositions, so a skipped or failed step carries its own explanation rather than leaving a reader to infer one. |
| `document` | `<name>`, `--type analysis\|implementation-report\|review\|verification-report`, `--file <path>` | Attach a typed document to the job. |
| `complete` | `<name>` | Close the job package. |

---

## sandbox

Report OS sandbox launcher availability and the per-capability containment
matrix. **A report, not a gate** — it never runs a contained command and always
exits `0`. The containment it describes is enforced by
[`harness exec`](#harness), which is where a missing launcher actually refuses.

```
keryx sandbox status [--json]
```

For the current platform it states whether the launcher (bubblewrap on Linux,
Seatbelt on macOS) is installed, and then, for each capability — filesystem
containment, network-off, domain allowlist, credential masking — whether it is
available, blocked only on the missing launcher, or **not implemented on this
platform at all**. Those last two are different findings and are deliberately
never worded the same way: "install bubblewrap and this works" and "this does
not exist on Linux" lead to different actions, and collapsing them into one
message is how an operator ends up installing something that was never going to
help. `keryx init` prints the same matrix once, up front.

---

## standard

Validate the workspace against the built-in Metaproject Standard
v0.1 and report its declared capabilities. The checks and schemas are bundled
into the CLI (`src/standard/`), so no network or `docs/` access is needed at
runtime.

```
keryx standard validate
keryx standard doctor
keryx standard capabilities
keryx standard emit llms [--stdout]
```

| Subcommand | Description |
|---|---|
| `validate` | Check required files/dirs, the `metaproject.json` schema (`metaproject.schema.json` + per-module `module.schema.json`), declared `paths.*`, enabled-module manifests, and that root `AGENTS.md`/`CLAUDE.md` link `.metaproject/index.md`. Prints a `PASS`/`FAIL` report and exits `1` on failure. |
| `doctor` | Same findings as `validate`, rendered as actionable diagnostics with a concrete fix hint per issue. Exits `1` when unresolved issues remain. |
| `capabilities` | Print the standard version, declared and satisfied profiles, and each enabled module with its commands/capabilities, sourced from `metaproject.json`. Exits `0`. |
| `emit llms` | Generate a deterministic `llms.txt` from the manifest + artifact index. Writes the file by default (validating the result), or streams it to stdout with `--stdout`. Exits `1` if the generated file is not valid `llms.txt`. |

`validate` and `doctor` also emit profile warnings when the manifest's declared
`profiles` array drifts from the profiles the workspace actually satisfies
(`minimal`, `agent`, `ci`, `full`). `keryx init` and `keryx update`
keep `standardVersion`, `profiles`, and `updatedAt` current in the manifest, so a
freshly generated workspace validates cleanly.

The only recognized flag is `--help`/`-h`. An unknown subcommand prints an error
and exits `1`.

---

## agents

Four unrelated surfaces share this noun: `bootstrap` manages global instruction
files for coding agents, `external` inspects the vendor CLIs keryx can host as
child agents, `monitor` reads a recorded subagent-fleet event log, and
`list`/`show`/`export`/`verify` (flow 310) work the agent-definition catalog
described below under "agents catalog".

(It said "two" until 2026-09-05, while the router dispatched three, then
"three" while it dispatched four — each time the sentence counting the
surfaces was itself the thing that had drifted, which is why the coverage
test at `src/cli-reference-coverage.test.ts` now derives this from the router
instead of trusting the prose.)

`bootstrap` is not project initialization: it only writes a small managed block
into the selected global `AGENTS.md` / `CLAUDE.md` file. The block tells agents to
look for `.metaproject/index.md` in the current directory or ancestors and route
through Metaproject when present. It also contains an explicit guard: when no
metaproject is installed, ignore the block and continue normally.

```
keryx agents bootstrap status --runtime <claude|opencode|zcode|codex|antigravity|all>
keryx agents bootstrap install --runtime <claude|opencode|zcode|codex|antigravity|all> [--dry-run]
keryx agents bootstrap uninstall --runtime <claude|opencode|zcode|codex|antigravity|all> [--dry-run]
keryx agents bootstrap print
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `bootstrap status` | `--runtime <id\|all>` | Show whether each runtime's global instruction file has the current managed Metaproject bootstrap block and print the install command when missing/outdated. |
| `bootstrap install` | `--runtime <id\|all>`, `--dry-run` | Merge-safe install/update. Inserts the managed block near the top of the global instruction file, after frontmatter and the H1 when present, preserving user content. |
| `bootstrap uninstall` | `--runtime <id\|all>`, `--dry-run` | Remove only the managed Metaproject bootstrap block, preserving all user-authored content. |
| `bootstrap print` | — | Print the managed block for manual installation. |
| `monitor <events-file>` | `--json` | Offline fleet report over a recorded subagent event log: what each child was dispatched to do, what it spent, and how it ended. Reads the file and starts nothing. |

Runtime ids: `claude` (`~/.claude/CLAUDE.md`), `opencode`
(`~/.config/opencode/AGENTS.md`), `zcode` (`~/.zcode/AGENTS.md`), `codex`
(`~/.codex/AGENTS.md`), `antigravity`
(`~/.config/antigravity/AGENTS.md`; alias `antigravuty`), or `all`.

### agents external

Inspect the registry of vendor coding CLIs keryx can host as child agents, or
drive one ACP agent. `list` and `probe` are read-only and neither spends
subscription quota: the only process either starts is the registry entry's own
`--version`. `run` starts a real agent and spends the operator's quota.

```
keryx agents external list [--json] [--no-probe]
keryx agents external probe <id> [--json]
keryx agents external run <id> --task "<text>" [--unattended] [--write] [--timeout <ms>] [--json]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `list` | `--json`, `--no-probe` | Print every registered agent with its detected availability, transport (`line-stream` or `acp`), sandbox modes, and streaming/resume/cost facts, plus the capability gate's verdict. `--no-probe` skips detection entirely and reports every entry as `not probed`. |
| `probe` | `<id>`, `--json` | The same report for one agent id (`codex-cli`, `claude-cli`, `gemini-acp`). An unknown id lists the known ones and exits `1`. |
| `run` | `<id>`, `--task`, `--unattended`, `--write`, `--timeout`, `--json` | Drive one registry agent whose transport is `acp` (today `gemini-acp`, which starts `gemini --experimental-acp`), with keryx as its ACP **client**, in a disposable git worktree. Guarded by the same `externalAgents` capability (hard-disabled in CI and under a remote transport) and per-agent config as every external run. Without a TTY, or with `--unattended`, every permission that would need a human is refused. `--write` advertises `fs.writeTextFile`: writes land in the worktree only and leave as a patch artifact that is never applied. Prints the status, the permission mode (always `ask` — `trust`/`auto` are lowered for a foreign agent), whether keryx's MCP server was offered, the permission and fs counts, the cost (or `missing`), the patch path and the session id. Exits `1` unless the run is `Completed`. A line-stream agent is refused: delegate to it from `keryx shell`. See the [ACP client guide](guides/acp-client.md). |

Availability has **three** states, and the third is not a placeholder:

| Marker | State | What the line says |
|---|---|---|
| `●` | available | installed, the detected version, how it compares to the recorded range, and *"login not verified — keryx cannot know"* |
| `○` | binary missing | not installed; the binary it looked for is not on `PATH` |
| `?` | not probed | not probed, plus the `probe` command that would answer |

There is no tick and no "ready". keryx never reads a vendor credential store — not
even to check whether a login exists — so a found binary proves a binary and
nothing more. A version outside the range this build's fixtures were recorded
against is a warning, never a refusal.

```text
# agents external

capability: unavailable — the external agent runtime is disabled; set
`externalAgents.enabled` to true in the keryx user config to opt in

  ● codex-cli  Codex
      installed, 0.147.0 (within the recorded range); login not verified — keryx cannot know
      sandbox: read-only, worktree-write  streaming: false  resumable: true  reports cost: false
```

The `capability:` line is the gate's own verdict and always names its reason when
unavailable. The runtime is **off by default**: it needs
`externalAgents.enabled: true` in the user config
(`~/.local/share/keryx/auth.json`), plus `keryx init --external-agents` when the
cwd is a `.metaproject/` workspace. It is hard disabled regardless of
configuration on a remote transport or under CI.
`sandbox` lists what each CLI itself supports; only
`read-only` is implemented in this release. See
[the harness page](./harness.md#external-children-a-vendor-cli-as-a-child-agent)
for the runtime this registry feeds.

Exit code is `0` for a successful report — including one where the capability is
disabled or a binary is missing, both of which are answers rather than failures.

### agents catalog

Flow 310 (W2): `list`/`show`/`export`/`verify` are a fourth surface under this
noun — the agent-definition catalog (`.metaproject/agents/*.md`, plus keryx's
own bundled definitions), compiled into either `spawn_subagent` dispatch
inputs (`keryx-shell`) or a host's own native/adapter subagent file
(`claude`/`codex`/`kiro`/`opencode`). See the
[agent catalog guide](guides/agent-catalog.md) for the definition schema,
export-support levels, the content-hash sentinel `export` writes, and what
`verify`'s named problem reasons mean.

```
keryx agents list [--stack <id>] [--json]
keryx agents show <name>
keryx agents export --runtime <claude|codex|kiro|opencode|keryx-shell> <name> [--force] [--dry-run] [--json]
keryx agents verify [<name>] [--json]
keryx agents generate --stack <id> [--check] [--json]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `list` | `--stack <id>`, `--json` | List every catalog definition (bundled and project-local), optionally filtered to one stack pack. Read-only. |
| `show` | `<name>` | Print one definition's fields and its resolved export-support level for every runtime. Read-only. |
| `export` | `--runtime <id>`, `<name>`, `--force`, `--dry-run`, `--json` | Compile one definition for one runtime and write its managed file (or, for `keryx-shell`, print the compiled dispatch input — nothing is written for that runtime). A file with no keryx-managed sentinel for this agent at all is never overwritten, even with `--force`. A managed file whose content-sha256 no longer matches its own recorded hash (hand-edited since export) is refused unless `--force` is passed. A managed, unedited file from an older source version is updated with no flag needed. |
| `verify` | `[<name>]`, `--json` | Validate every definition (or just `<name>`) against the schema, tool/skill vocabularies, `policy_profile`, origin/sourceRef rules, and the baseline-in-body guard, and resolve its export support for every runtime. Also reports `stack-pack-not-gate-cleared` for a generated pair whose source stack pack is no longer gate-cleared, and `generated-drift` when a bundled generated file no longer matches a fresh run of the generator. |
| `generate` | `--stack <id>`, `--check`, `--json` | Flow 314: write the `<stack>-code-auditor` (read-only review) and `<stack>-build-fixer` (build/lint/type/test-failure resolution, worktree-isolated) pair for one stack pack, derived from that pack's `pack.json`. Refuses a pack that is not gate-cleared (`stability: stable` and a passing stable-pack gate check). `--check` reports drift without writing, exiting non-zero if either generated file differs from what is on disk. |

To export the whole catalog for one harness at once, use
`keryx integrations install --runtime <id> --surface agents` (opt-in — the
default install does not write agent files).

---

## orient

Emit or install a compact turn-start orientation block. When the launch cwd has
`.metaproject/index.md`, the block contains a bounded excerpt of that exact
project-root file, then the current graph map, wiki index, and freshness
information. It does not search ancestors. The excerpt instructs the model to
read the full index; it is precedence guidance, not an enforced runtime gate.
Orientation is separate from the gdctx routing guard: orientation supplies
context, while the routing guard controls which shell/search commands an agent
may run directly.

```text
keryx orient [<runtime>]
keryx orient install-hook [--runtime <id|all>] [--dry-run]
keryx orient uninstall-hook [--runtime <id|all>] [--dry-run]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| default emit | optional runtime id | Build the bounded project-root Metaproject + graph + wiki orientation and format it for the selected runtime (`claude` by default). |
| `install-hook` | `--runtime <id\|all>`, `--dry-run` | Merge-safely install the runtime's turn-start/prompt hook. Supported hook runtimes are `claude`, `codex`, and `cursor`. `--dry-run` reports the file it would write and changes nothing. |
| `uninstall-hook` | `--runtime <id\|all>`, `--dry-run` | Remove only the managed orientation integration. `--dry-run` reports what it would strip and changes nothing. |

Windsurf and Zed do not expose a compatible context-injection hook; use their
rules or memories instead. Unknown runtimes exit `1` without modifying config.

---

## review

Create and manage durable review packages. Managed reviews preserve target
identity, reviewer coverage, findings, decisions, learning candidates, and an
optional flow relationship instead of leaving review state only in chat output.

```text
keryx review attach --flow <id> --target <kind> --ref <ref> [--head <sha>]
                    [--reviewers a,b] [--report <path>]
keryx review start --target <kind> --ref <ref> [--head <sha>] [--reviewers a,b] [--report <path>]
keryx review ingest --report <path> [--flow <id>] --ref <ref> [--head <sha>]
                    [--verifications <file|->] [--verification-mode off|annotate|filter]
                    [--scope <scope.json>] [--blast-radius <blast-radius.json>]
                    [--refuted <file|->]
                    [--max-findings <n>] [--spent <usd>] [--spend-ceiling <usd>]
                    [--parallel <n>] [--outstanding <n>]
keryx review budget [--spent <usd>] [--ceiling <usd>]
                    [--reviewers a,b] [--parallel <n>] [--outstanding <n>]
keryx review tier [--scope <scope>] [--fix-attempt <n>] [--forced-strategy-change]
                  [--findings <n>] [--diff-lines <n>]
                  [--verifier execution|site-check|reasoning] [--security]
                  [--session-provider <id>] [--session-model <id>]
                  [--catalog <file|->] [--json]
keryx review comments collect --repo <owner/repo> --pr <n> --sha <head-sha>
                              [--self <login>] [--round <n>]
                              [--out <findings.json>] [--json] [--fixtures <dir>]
keryx review comments reply --repo <owner/repo> --pr <n> --outcomes <file|->
                            --review <review-id> --sha <head-sha> --final [--round <n>] [--dry-run]
                            [--max-replies <n>] [--max-sentences <n>] [--max-chars <n>]
                            [--flow-link <url>] [--fixtures <dir>] [--allow-closed-pr]
keryx review ci-triage --run <id> [--job <name>] [--test <name>] [--repo <owner/repo>]
                       [--model <jev-1.13|jev-latest>] [--fixtures <dir>] [--json]
keryx review conform --ref <doc> (--pr <n> | --report <dir> | --diff <ref>)
                     [--repo <owner/repo>] [--explain] [--threshold <0..1>]
                     [--model <jev-1.13|jev-latest>] [--fixtures <dir>] [--json]
                     [--max-hunks <n>] [--max-hunk-calls <n>] [--detail]
keryx review learn --pr <n> [--dry-run] [--json]
keryx review learn --reviewer <id> [--dry-run] [--json]
keryx review loop --flow <flow-id> [--task <Tn>]
keryx review status <review-id-or-path>
keryx review complete <review-id-or-path>
                      [--finding <id> --disposition <state> --evidence <ref>]...
keryx review lightweight
keryx review reviewers [--json]
keryx review import --from <dir> [--dry-run] [--force] [--json]
keryx review scope [--ref <base>] [--diff <file|->] [--path a,b] [--context <n>] [--json|--scoped-diff] [--append <file>]
keryx review floor [--ref <base>] [--diff <file|->] [--context <n>] [--json] [--report-only]
keryx review blast-radius [--ref <base> | --changed a,b] [--depth <n>] [--max-files <n>]
                          [--no-related-tests] [--final] [--previous <blast-radius.json>]
                          [--json|--brief] [--out <file>]
```

**An unrecognised option is refused, not ignored**, and the command exits 1. A
flag that is silently dropped writes nothing and still reports success.

`--head <sha>` is the commit the round ran against, written to
`manifest.target.head` and read by the `review` completion gate — which refuses
to complete a flow whose last round cannot say which tree it read. Omitted, it
is `git rev-parse HEAD`: the tree the reviewers actually read, preferred over a
`pr` target's own head so that a round run against something other than what
will merge *fails* the gate instead of passing it. With no checkout to ask and a
`pr` target, the pull request's head is used instead; with neither, the head is
left off and the gate reports it as unobserved.

| Subcommand | Description |
|---|---|
| `attach` | Create a managed package linked to an existing Task Manager flow. |
| `start` | Create a standalone managed review package. |
| `ingest` | Convert an existing report into a managed package, optionally linked to a flow. |
| `status` | Print mode, status, target, flow link, coverage count, and `filter_stats`. Exits 1 when `filter_stats` does not hold together. |
| `complete` | Validate the package, record what became of its findings, write the learning note for anything dismissed as incorrect, and mark it complete only when required artifacts exist. See below. |
| `lightweight` | Confirm report-only mode; creates no managed artifacts. |
| `scope` | Build the bounded review scope deterministically. See below. |
| `floor` | Report the edits in a diff that lower the bar: a threshold moved the weakening way, a disabled test, a test region that checks fewer things, a new suppression. Exits 1 when it finds any. See below. |
| `blast-radius` | Compute what the change can **break**, as opposed to whether it is correct. See below. |
| `budget` | The spend and concurrency gate, run **before** dispatch. Exits 1 when the spend ceiling is reached. See below. |
| `tier` | The `model` block a dispatch document carries, computed from signals the orchestrator already holds. See below. |
| `loop` | Loop detection over a flow's review rounds. Exits 1 when repetition escalates. See below. |
| `stack` | Which reviewers this repository's declared stack calls for. Fails toward **including** a reviewer: an unreadable, workspace-only or dependency-less manifest runs everything. |
| `comments` | Collect comments left on the PR by anyone else, and answer them — once, at the end. See below. |
| `ci-triage` | Advisory-only flaky/infra/real-regression triage for one failed CI run's job, scored by Jev (TypeSafe System One). See below. |
| `conform` | Check a PR, a review report, or a diff against a reference document's clauses, scored by Jev. See below. |
| `learn` | Turn collected PR comments from the authors this project configured into a learning proposal for its own local review skill. Reads the collected record; never fetches. See below. |
| `reviewers` | List bundled and project-local reviewers (`keryx review reviewers [--json]`). The project half is `.metaproject/project-skills/review/<name>/`; each entry carries `paths` + `pathsSource`, `flags`, `stackRequires` and `unresolvedRules` for the orchestrator's filters. |
| `import` | Alias for `keryx skills import --module review` with a `review-vantage-*` name filter (`keryx review import --from <dir>`). Also copies the `core/*.mdc` rules the skills cite from the overlay's `rules/` when the project lacks them; re-run it over an existing import to fetch only the rules. |

Target kinds are validated by the runtime. Review packages are stored under the
linked flow when attached, or in the managed standalone review location selected
by the review service.

### `review comments`

Comments left on the pull request by other people — and by other bots — are
collected every round and **answered once, at the end**. Not per round: a bot
that replies on every round turns one review thread into six, and the reviewer
reads the noise before the answer. The work happens continuously; the speaking
happens once, after the final round and before the completion gate, so every
reply states a settled outcome rather than an intention.

All three sources are read: inline review comments, review submissions, and
PR-level discussion. **Bot authors are handled identically to humans** — a bot
reviewer is a reviewer. Only our own identity is excluded, and the collector
refuses to run without knowing it, because a set that includes our own replies
would have the reply pass answering itself every round.

Each comment becomes a finding with `source: "external"`. Severity is
**classified, never invented**: a comment on a `CHANGES_REQUESTED` review starts
at `major`, everything else at `minor`, and a comment that cannot be classified
takes the `minor` floor with the reason recorded rather than a guess.

Two rules that are not conveniences:

- **The verifier cannot refute an external finding on its own.** A human asked a
  question; a machine deciding the question was invalid is not an answer. The
  disposition becomes `answered-disagree`, and it still owes a reply.
- **A thread we did not open is never resolved or hidden.** Replying is ours;
  resolving belongs to whoever wrote the comment. Auto-resolving is how a bot
  silences a person.

| Flag | Sub | Description |
|---|---|---|
| `--repo <owner/repo>`, `--pr <n>` | both | The pull request. Required. |
| `--sha <head-sha>` | both | **Required.** On `collect` it is the head the pass READ, written to the record as `collected_sha`; on `reply` it is the head the answers are true of, recorded on every handled comment — and it must BE the pull request's head (equal, or a 7+ character prefix), or the pass is refused. 7–40 hex characters on both. `collect` prints the PR's state and head and warns on a mismatch. |
| `--self <login>` | both | The identity we are acting as. Resolved from `gh api user` when omitted, and **required** with `--fixtures`. On `reply` the login recorded at collection time wins. |
| `--round <n>` | both | The review round. Default `1`. |
| `--out <file>` | collect | Write the external findings (`source: "external"`) as JSON. |
| `--json` | collect | Machine-readable result, including the state that was written. |
| `--outcomes <file\|->` | reply | One disposition and one reply sentence per collected comment. Required — the judgement is the model's; this command enforces the budget, the threading and the once-at-the-end rule. |
| `--final` | reply | Required. Without it the pass refuses: replying per round turns one thread into six. |
| `--review <review-id-or-path>` | reply | The managed review package this pass answers for; its target must be this pull request. Posting requires it or `--result` — a lightweight review is report-only and answers nobody. Not needed with `--dry-run`. |
| `--dry-run` | reply | Print the exact requests; post nothing, write nothing. |
| `--max-replies <n>` | reply | Individual replies before the overflow summary. Default **30**. `0` is legal and means one summary stands for everybody. |
| `--max-sentences <n>` | reply | Sentence budget per reply. Default **2**. Below `1` is refused. |
| `--max-chars <n>` | reply | Character ceiling per reply. Default **600**. Below `1` is refused. |
| `--flow-link <url>` | reply | The flow artifact the overflow summary points at. |
| `--fixtures <dir>` | both | Answer every read from JSON on disk and record writes without sending them. `pull.json` is the pull request (`state`, `merged`, `merged_at`, `head.sha`); without it the state is unknown and `reply` refuses. |
| `--allow-closed-pr` | reply | Post to a closed or merged pull request. Off by default: `reply` refuses a pull request that is not open, and one whose state could not be read. The head must still match `--sha`. |

`collect --sha` is what makes the record **datable**, and the review gate depends
on it: `rounds_collected` is a count, `--round` defaults to `1`, and nothing else
in the record carries a timestamp, so a state file written at the start of round
1 against a pull request nobody had commented on was indistinguishable from one
written after the last round. Comments posted in between were invisible and the
gate completed the flow over them. The gate now compares `collected_sha` with the
PR head and reads a mismatch — or a record with no `collected_sha` — as
*unobserved*.

Replies are **at most two sentences and at most 600 characters**, enforced rather
than advised: the over-long version is not reachable from the function that
produces the reply, and a truncation with no link to point at is refused
outright. Both bounds are needed — a 4,000-character reply with one full stop is
one sentence, and a sentence budget alone waves it through. Whole sentences are
dropped first; a lone sentence over the ceiling is cut at a word boundary, with
an ellipsis and the link. The `Re <url>:` anchor on a top-level reply sits
outside both bounds, because it is an address rather than an explanation.

The sentence counter masks URLs, inline code, markdown link targets and
abbreviations before splitting — but only an abbreviation that is **not
sentence-final**, i.e. one followed by a lowercase word. `etc. Also updated the
docs.` is two sentences; `etc. and the docs.` is one. Masking a sentence-final
abbreviation under-counted, and under-counting is the direction that posts the
wall of text: over-counting only costs a truncation, which is recorded and
carries a link.

Every collected comment ends with exactly one reply and one disposition — silence
is not an acceptable outcome, and neither is answering twice.

**Idempotent across a kill, not just across a clean restart.** The durable record
is written *around* each POST rather than after it: a marker goes down before the
request leaves, and is replaced by the settled entry when it returns. A process
killed in that window leaves a marker saying which reply was in the air, and the
next run resolves it against the pull request itself — the reply is either
visible in the thread, in which case GitHub is the record and the entry is
completed from it, or it is not, in which case it is sent. Writing only after the
post bounds the loss to one comment; it does not close the window.

A record with no `reply_url` is a comment **nobody answered**, and all three
readers agree on that: the collector re-offers it, the completion gate counts it
unanswered, and the reply pass posts it. The pass used to skip on row existence
instead, which put a settled row with no `reply_url` into a state nothing could
clear — offered for ever, never answered, gate violated for good. A row reaching
the pass with no reply is now resolved against the pull request itself before
anything is sent, so the repair cannot answer a reviewer twice. Being past the reply cap
changes how a comment is answered — one summary comment stands for the backlog —
never what was decided about it: each backlogged comment keeps the disposition
the orchestrator reached for it.

The trade-off, stated: a reviewer who comments early waits until the end. That
is deliberate — answering with a work-in-progress state that later changes is
worse. A comment that *blocks* progress rather than reporting a problem is
escalated to the operator immediately instead.

### `review learn`

The join between the comments a pull request collected and this project's own
review skill. Keryx ships the mechanism and no people: **which reviewers teach a
project is a decision that lives in that project**, and what they teach never
travels back into keryx.

```console
$ keryx review learn --pr 412
Created learning proposal: frontend-orders-review-20260830T101500
Skill: frontend/orders-review
Source: .metaproject/data/gdskills/learning-sources/acme__web__412.json
Record: .metaproject/data/gdskills/learning-sources/acme__web__412.md
Authors: dana-reviews
Comments: 4 used, 7 excluded as unconfigured, 0 with no recorded body
Confidence: high
Proposal: .metaproject/data/gdskills/proposals/frontend-orders-review-20260830T101500.json
...
Nothing was written to the skill. Apply with: keryx skills learn apply <path>
```

Configuration is `.metaproject/review-learning.config.json`, and it names the
three things the join needs and nothing else:

```json
{
  "schemaVersion": 1,
  "skill": "frontend/orders-review",
  "repo": "acme/web",
  "authors": ["dana-reviews", "sam-architecture"]
}
```

| Field | Meaning |
|---|---|
| `skill` | `<module>/<skill>` — a project skill under `.metaproject/project-skills/`, registered with `keryx skills create`. |
| `repo` | `owner/repo` whose collected comments teach this skill. |
| `authors` | The GitHub logins whose comments count. Matching is case-insensitive and otherwise exact — a prefix of a configured login is a different person. |

| Flag | Description |
|---|---|
| `--pr <n>` | The pull request to learn from. Its comments must already have been collected. |
| `--reviewer <id>` | Sibling mode (W3): apply an accepted `domain: review-conventions` learned-pattern record to `.metaproject/rules/reviewers/<id>.mdc` instead of the `--pr` path above. `--pr` is not read in this mode. |
| `--dry-run` | Compute the proposal (or, with `--reviewer`, the rendered profile) and write nothing. |
| `--json` | Machine-readable result, including the selection counts. |

**There is no `--authors`, `--skill` or `--repo` flag, deliberately.** A flag
would make the configured list a default, and one invocation could teach a
project from somebody it never named.

**`--reviewer <id>` applies a per-reviewer profile, not a per-skill proposal.**
The source is an accepted `keryx learn` record (`domain: review-conventions`,
`reviewerProfile.reviewerId` set) — a human already ran `keryx learn accept`
on it. This mode writes `.metaproject/rules/reviewers/<id>.mdc` directly: a
semver header comment, the generalized conventions, and a changelog entry.
`<id>` is always the opaque `rv-`-prefixed hash `keryx learn` records —
never the reviewer's literal login, which the rendered file is refused from
ever containing.

**A project with no config file does not learn.** That prints one line and exits
`0`. It is a supported state, not a warning — a tool that warns about the normal
case teaches people to skip warnings. A config that is *present and wrong* is a
different answer and is refused.

**It reads; it never fetches.** The source is the record
`keryx review comments collect` wrote, which carries each comment's author and,
since this command existed, its text. A learning pass that called GitHub again
would be learning from a pull request that has moved on since the round it claims
to describe. Learning a pull request nobody collected is refused rather than
reported as an empty pass.

Two files are written per pull request, under
`.metaproject/data/gdskills/learning-sources/`:

- `<owner>__<repo>__<n>.json` — the lessons, and nothing else. Every string in it
  becomes a candidate lesson, so it carries no prose of its own; a "generated by"
  line in that file would end up in somebody's `SKILL.md`.
- `<owner>__<repo>__<n>.md` — the provenance: which record, which commit it was
  true of, who was configured, and how many comments were excluded. The excluded
  comments are counted there and quoted nowhere.

**The proposal writes nothing.** `keryx skills learn apply` remains the only
writer, and it refuses any target outside `.metaproject/project-skills/` — so a
misconfigured project cannot write learned conventions into the shipped templates
under `src/gdskills/bundled/`. That refusal is in `applyLearningProposal`, not in
this document.

#### Seeding a local skill from conventions you already have

A team that already keeps a review rule — in a personal rules directory, a wiki
page, a `CONVENTIONS.md`, a rule file from an older keryx install — does not have
to wait for a pull request to accumulate one.

**The content comes from your own copy, outside this repository.** Keryx ships no
conventions and keeps none: nothing was migrated into it and nothing can be
recovered from it. Paste from the file you already hold.

```bash
# 1. Create the local skill. It lands under .metaproject/project-skills/,
#    which is the only place a learned lesson may ever be written.
keryx skills create src/features/orders --module frontend --name orders-review

# 2. Paste the conventions you already have into its `## Review Lessons`,
#    `## Review Checklist` and `## Anti-patterns` sections, and record where
#    they came from in `skill-changelog.md`. This step is a copy, by hand, on
#    purpose: keryx will not read a path outside the project to do it for you.

# 3. Name the skill and the reviewers who will keep it current.
cat > .metaproject/review-learning.config.json <<'JSON'
{
  "schemaVersion": 1,
  "skill": "frontend/orders-review",
  "repo": "acme/web",
  "authors": ["dana-reviews"]
}
JSON

# 4. From here the skill maintains itself, one pull request at a time.
keryx review comments collect --repo acme/web --pr 412 --sha "$(git rev-parse HEAD)"
keryx review learn --pr 412
keryx skills learn apply .metaproject/data/gdskills/proposals/<id>.json
```

Point a second project at different reviewers and its skill diverges from the
first. That is the intended behaviour, not drift: there is no single correct
review checklist, and shipping one would mean shipping one team's opinions to
everybody.

### `review scope`

The scope a review is dispatched over, computed rather than eyeballed. Dropping
a lockfile from a review needs no judgement, so it is not left to a model: this
is a pure function of the diff and its configuration, with no model call, no
network, and no filesystem access beyond reading the diff.

It drops generated, lockfile, snapshot, minified, binary and vendored paths;
drops whitespace-only and comment-only hunks; and narrows what remains to the
changed hunks plus a context window (default 20 lines, configurable). Hunk-level
scope is the point rather than a nicety — review comments anchored to a hunk are
acted on several times more often than comments anchored to a whole file.

| Flag | Description |
|---|---|
| `--ref <base>` | Diff against this base instead of the default merge-base. |
| `--diff <file\|->` | Read a unified diff from a file or stdin instead of running git. |
| `--path a,b` | Path mode: scope these paths rather than a diff. |
| `--context <n>` | Context lines kept around each retained hunk. |
| `--json` | Machine-readable scope, including `.files` for reviewer auto-detection. |
| `--scoped-diff` | Emit the retained diff itself, ready to hand to a reviewer. |
| `--reviewers a,b` | Not used for scoping — it is how the cost estimate knows the fan-out. |
| `--append <file>` | Write the scope **and the drop list** into a review package's `scope.md`, replacing a `## Pre-filter scope` block already there rather than adding a second. |

The human-readable output ends with an estimate of what the round will cost,
before any of it is spent:

```text
### Estimated cost

- ≈ 26,655 prompt tokens of scoped diff per reviewer (characters ÷ 4 — an estimate, not a measurement)
- ≈ 106,620 across 4 reviewers, before their own prompts, tools and any verifier wave
```

It multiplies by `--reviewers` because every reviewer receives the scoped diff,
so a per-round figure that ignored the fan-out would understate the one thing
the estimate is printed for. It is labelled an estimate wherever it appears, and
it is deliberately absent from `--json` and `--scoped-diff`: those are read by
programs and by reviewers, and neither is a place for prose about money.

**Every drop is recorded with its reason**, its granularity, and the lines it
covered. A scope that silently truncated would read as "we reviewed everything"
when it did not, which is the failure this command exists to make impossible.

Keep the `--json` output and hand it to `review ingest --scope`: that is the
supported route from the pre-filter to the review record, and unlike `--append`
it does not depend on two commands hitting the same file in the right order.

Deliberately not detected, so the omission is stated rather than implied:
`build/` is reviewed (it is as often hand-written tooling as output), `*.d.ts`
is reviewed, and `package.json` / `go.mod` / `Cargo.toml` are reviewed — those
are dependency *decisions*, which is exactly what a reviewer wants beside the
lockfile churn that is dropped. Comment-only detection covers a fixed set of
extensions; an unrecognised extension is always reviewed, detection switches off
entirely for hunks containing a template literal, triple-quoted string or
heredoc, and a comment carrying a tool directive (`@ts-expect-error`,
`eslint-disable`, `go:build`, `noqa`) is never treated as comment-only, because
it changes behaviour.

### `review floor`

A review asks whether the change is correct. It does not ask whether the change
made the *checks* weaker, and that is a different question: a coverage minimum
moved from 80 to 70, an `it.skip` added to a flaky test, an assertion deleted
from a test that still passes, a `// @ts-expect-error` above the line that would
not compile. Each is individually defensible, each is invisible in a green
suite, and together they are how a suite rots.

This makes those four edits visible **in the diff that introduces them**. Pure,
no model call, over the same scoped regions `review scope` builds.

| Flag | Description |
|---|---|
| `--ref <base>` | Widen the diff to the **merge base** of `HEAD` and this ref. Uncommitted work is still scanned — this adds committed history to the window, it does not replace the working tree with it. Without it, only uncommitted changes are scanned. |
| `--diff <file\|->` | Read a unified diff from a file or stdin instead of running git. |
| `--context <n>` | Context lines around each change, as for `review scope`. Default **20**. |
| `--json` | Machine-readable report: `outcome`, `findings`, `counts.byKind`, and `scanned`. |
| `--report-only` | Print the same report and exit **0**. The adoption path: measure the rate before the guard starts refusing. |

Exit codes, per `rules/core/cli-interface-design.mdc`: **0** clean, **1** a
finding, **2** the guard could not look. A finding is a *question the diff has
not answered*, and a question asked with exit 0 is a question nobody answers —
the same choice `review budget` and `review loop` make. The command does not
claim any finding is wrong; it claims the diff should say why.

**2** is the one a script must not fold into 1. A ref that will not resolve, a
`--diff` file that will not open and a shallow clone with no merge base all mean
the guard never ran, which is not a pass and not a finding. Under `--json` that
answer is *data on stdout*, not prose on stderr:

```json
{ "schemaVersion": 1, "outcome": "cannot-scan", "error": "…" }
```

A clean or finding-bearing run carries `"outcome": "scanned"` alongside its
`scanned` counts, so a reader tells the two apart by a field rather than by
parsing English. Getting the *invocation* wrong — an unknown flag, a `--context`
that is not a number — stays **1**; that is a validation error, not an inability
to tell.

`--ref`, `--base`, `--diff` and `--context` are also refused when their value is
**missing or empty**: `keryx review floor --diff --json`, which is what an
unquoted empty variable expands to in CI, used to read as "no `--diff`", scan the
working tree instead and report `"outcome": "scanned"` with exit **0**. That is
the one answer this command must never give by accident, so a value-taking flag
whose next token is another flag, absent, or empty exits **1** and scans nothing.

In a `--depth 1` clone (which is what `actions/checkout` gives you by default)
`--ref` has no merge base to resolve against. The command says so and names the
fix: `git fetch --unshallow`, or `fetch-depth: 0` on the checkout step.

What each detection requires, because a guard that fires on the repair as well
as the damage gets switched off:

- **Threshold lowered.** The removed and added lines must be identical once
  every number is erased (a trailing **comment** is ignored on both sides, so
  "lower it and explain on the same line" is not an escape), and the identifier
  *directly in front of each moved number* must name a floor (`coverage`,
  `minimum`, `threshold`, `precision`, …) that moved **down**, or a ceiling
  (`max`, `limit`, `timeout`, `retries`, `tolerance`, …) that moved **up**. Only
  that identifier is read, not the whole line: `5.` → `6.` in a renumbered
  markdown list is silent even though the sentence contains the word `allowed`.
  Finding it is a short walk left from the number rather than one token, so a
  type annotation (`const minCoverage: number = 80`), an enclosing key
  (`thresholds: { global: 80 }`) and a constant index (`minScores[0] = 80`) all
  still name their number — but a comma is not an opener, so `f(scores, 80)`
  borrows nothing from `f`. A coverage minimum raised is silent, a timeout
  shortened is silent, and a bare `rows: 50` → `rows: 10` is silent in both
  directions: nothing names it. An unnamed number beside a named one no longer
  silences it, but must move the same way. A
  *ceiling* in resource units (`maxOutputTokens`, `maxRows`) is a budget and is
  silent; a *floor* in the same units (`minItems: 3` → `0`) is a demand removed
  and does fire. Residual noise, accepted: `limit` and `max` are ordinary words,
  so a pagination `limit` raised does fire.
- **Test disabled.** `.skip`, `.only`, `.todo`, `.failing`, vitest's `.skipIf` /
  `.runIf`, `xit`/`xdescribe`, `@pytest.mark.skip`, `t.Skip(` and friends, on an
  **added** line, in statement position, **called**. Chained modifiers are
  allowed on either side of the keyword and may carry a paren-free argument list,
  so `test.concurrent.skip(…)`, `describe.skip.each(table)(…)` and
  `describe.each(cases).skip(…)` all fire; a computed table,
  `describe.each(build(x)).skip(`, does not. `.only` counts: it disables every
  other test in the file. A `.skip` being *removed* never fires, and neither does
  a marker inside a string, mid-expression, or in a sentence that merely mentions
  it — the required `(` is what keeps prose about skipped tests out.
- **Assertion removed.** A count, not a parse: a region of a **test file** that
  ends with fewer assertion-carrying lines than it started with. An assertion
  moved a few lines nets to zero; an assertion *weakened in place*
  (`toBe(3)` → `toBeDefined()`) is invisible, and is stated as invisible rather
  than implied to be covered.
- **Suppression added.** `eslint-disable`, `@ts-expect-error`, `@ts-ignore`,
  `# type: ignore`, `# noqa`, `//nolint`, `@SuppressWarnings`, `#[allow(` and
  the rest — on an added line, after a comment opener, with no quote before it.
  A marker listed in a string array is not a suppression, a suppression being
  *deleted* is not a finding, and a suppression that merely **moved** — removed
  and re-added byte-identical inside the same region — is not "added". That
  forgiveness is counted: each removal pays for exactly one identical addition,
  so a region that deletes one marker and adds three reports two.

It sees only what the pre-filter retained, so a threshold lowered inside a
vendored or generated path is invisible by construction — and it depends on
`review scope` never dropping a comment that carries a tool directive, which is
why that carve-out exists.

### `review blast-radius`

`review scope` bounds **the change**, and a review of it answers *is this change
correct?* It does not answer *did this change break something that was working*.
That is a second scope, and it is computed rather than browsed: `gdgraph
affected` walked outward from every changed file, ranked by edge distance, cut at
a depth and a file cap, closest first.

| Flag | Description |
|---|---|
| `--ref <base>` | Take the changed-file list from `git diff --name-only` against this base. |
| `--changed a,b` | Use this changed-file list instead of asking git. |
| `--depth <n>` | Edge distance kept. Default **2**. |
| `--max-files <n>` | File cap, closest first. Default **40**. |
| `--no-related-tests` | Skip the naming-related tests of the changed files. |
| `--previous <file>` | The previous round's `--json` record; decides whether this round must recompute. |
| `--final` | This is the final round, so recompute regardless of what the changed-file set did. |
| `--json` | Machine-readable record: the set, the drops, the unresolved changed files. |
| `--brief` | The dispatch text a scope-B reviewer is given. |
| `--out <file>` | Write the record. A `.json` path writes the JSON; anything else upserts a `## Blast radius` block. |

The bounds are not a guess. Measured over 80 commits of this repository against a
1,041-node graph: the depth-2 dependent set is a median of 19 files (p90 65),
depth 3 adds eight in the median and doubles the p90, and depth 4 is
indistinguishable from depth 3 because the graph saturates. The 40-file cap fires
on 25% of those commits and removes only hop-2 entries on all but two of them, so
it almost never costs a direct dependent.

**Bounded on purpose.** Reviewing the whole repository every round is
unaffordable *and* harmful — review quality decays as context grows, and an
unbounded second scope makes later rounds worse than earlier ones.

**The set is under regression check, not under review**, and that is refused in
code rather than discouraged in prose. Three rules, and every one of them is a
fact about the claim rather than about who made it: `outside-set` (the file is in
neither the computed set nor the changed set), `non-regression-severity` (below
the `major` floor — under the canonical rubric `minor` states that the code
behaves correctly and `info` names neither a trigger nor an outcome), and
`no-link-to-change` (nothing in the finding, its anchor included, names a changed
file, module or symbol). There is deliberately **no rule that reads the
reviewer's name**: one existed, and because it ran after the severity floor it
could only ever refuse `major` and `blocker` findings — including a genuine
broken-build regression, on the grounds that the reviewer who spotted it usually
asks a different question. Rejections are recorded with their reason, never
deleted.

**Every file the cap removed is recorded**, with its hop and its dependency path
back to the change. A truncation nobody can see reads afterwards as "we checked
everything".

**An empty radius is not a clean one.** The graph indexes code, so a changed
Markdown, JSON or shell file has no dependents to walk; those are reported under
`unresolved` with the reason, because "the graph could not answer" and "nothing
depends on this" are different facts. Runtime edges — a spawned process, a file
one module writes and another reads, a string-keyed registry — are invisible to
it, and so is the reverse direction: `affected` walks dependents, not
dependencies.

Requires a built graph; run `keryx gdgraph build` first. An absent graph is
refused rather than reported as an empty radius.

### Caps — findings, spend, concurrency

Nothing in the review pipeline was capped: `budget.max_findings` was required by
the schema with no default anywhere, there was no cost ceiling, and reviewers
were dispatched in parallel with no wave size while `review-orchestrator` itself
runs nested under `flow-orchestrator` and `job-orchestrator`.

The defaults are in code (`src/review/caps.ts`), so a caller that says nothing
still gets a bound.

| Cap | Default | Flag | What it does |
|---|---|---|---|
| Findings | **10 per reviewer**, blockers exempt | `--max-findings <n>` | Truncates a reviewer's ordinary findings. `blocker` and `blocking_merge` findings are exempt and do not consume the budget. |
| Spend | **3.00 USD** per round | `--spent <usd>`, `--spend-ceiling <usd>` | Stops and asks rather than proceeding. |
| Concurrency | **4** reviewers in flight | `--parallel <n>`, `--outstanding <n>` | Splits the reviewer set into dispatch waves. |

**Every cap records what it dropped**, in the package's `scope.md` under
`## Caps` and on the terminal — a count, and for the findings cap the id of every
truncated finding. A cap that truncates in silence reads as "there was nothing
more". A cap that did not run prints `not recorded`, never `0`: "dropped nothing"
and "never ran" are different facts.

The findings cap runs over the reported findings only, never over the dismissal
records reaching the package through `--refuted` or through a `refuted` verdict.
Those are the record of what was raised and then dismissed; truncating them would
rebuild a corpus of triage survivors, which measures 100% precision whatever the
reviewers got right.

**The spend cap is currency, not tokens.** A token count is not comparable across
models — the same 200k tokens differ by more than an order of magnitude in cost
between the cheapest and the most capable model in one vendor's line-up — so a
token ceiling is either inert or ruinous depending on an unrecorded model choice.
Currency is the unit the decision is made in and the unit the operator's budget
is denominated in, and token counts convert to it while the reverse does not.
3.00 USD follows SWE-agent's $3/instance cap; a keryx review round is one target
and one reviewer fan-out, the analogue of one instance.

**The concurrency cap does not bind the nested total on its own, and says so.**
keryx is a CLI invoked once per command: it cannot observe subagents running in
another orchestrator's process, and there is no lease between the three
orchestration levels. `--outstanding <n>` is an enclosing orchestrator declaring
what it already has in flight, which shrinks the effective wave; it is a
declaration, not an observation, and nothing verifies it. The record therefore
carries `holds_across_nesting: yes (against the declared count)` or `no`, rather
than implying a guarantee that does not exist.

### `review ci-triage`

Advisory-only triage for a failed CI run's job(s): flaky, infra, or real
regression, scored by Jev (TypeSafe System One) over a redacted, bounded
excerpt of the job's own log **plus a small block of deterministic signals**
computed before Jev is ever asked. Flow 306 (Jev client, opt-in gate,
advisory rendering); flow 307 (signals, every-failed-job default, the
evaluation harness, this section's measured-accuracy numbers).

```bash
keryx review ci-triage --run 36095133327 --json
```

| Flag | Description |
|---|---|
| `--run <id>` | Required (unless `--eval`). The CI run id (e.g. a GitHub Actions run id). |
| `--job <name>` | Narrows to one of the run's jobs (reaches it directly even when it is beyond the `MAX_JOBS_TRIAGED` cap below). Omitted, **every job whose conclusion is `failure` is triaged** (flow 307, AC3), up to the cap — one verdict each. |
| `--test <name>` | Override the failing test name instead of the best-effort extraction from the log excerpt. Only applied when exactly one job is in scope. |
| `--repo <owner/repo>` | Passed to the live `gh` adapter; omitted, `gh` resolves the repository from the current checkout. |
| `--model <jev-1.13\|jev-latest>` | Overrides the default Jev model. |
| `--fixtures <dir>` | Answers BOTH the CI read and the Jev call from files on disk (`ci-run-info.json`, `ci-failed-log.txt`, optional `ci-history.json`, `ci-attempts.json`, `ci-changed-files.json`, `ci-runs-by-head-sha.json`, `ci-related-runs.json`, `jev-response.json`) — no real `gh` call, no real network call. |
| `--json` | Prints `{results, notTriaged}`: `results` is an array, one entry per triaged job, each `{runId, job, testName, verdict, usage}`; `notTriaged` names any failed jobs beyond the `MAX_JOBS_TRIAGED` cap (empty when nothing was skipped). |
| `--eval <file>` | Flow 307 (AC5/AC6). Replays a labelled evaluation manifest (JSON, `{cases: [{id, runId, job, truth, fixturesDir}]}`) and reports **before** (flow 306: log only) and **after** (flow 307: log + signals) accuracy and cost, plus a per-case line. Offline (fixtures) by default. See below. |
| `--live` | Only with `--eval`: replay against the real `gh`/Jev instead of each case's `fixturesDir` — the opt-in gate and credential check both apply, same as a plain `--run`. |

**A bounded number of jobs per run (flow 307 review, `MAX_JOBS_TRIAGED = 10`).**
Without `--job`, at most 10 failed jobs of one run are triaged — each job costs
one Jev call and (with signals) a bounded number of extra `gh` reads, so an
unbounded number of failed jobs no longer means an unbounded number of calls.
Jobs beyond the cap are listed rather than silently triaged or silently
dropped: `notTriaged` in the `--json` output, and a
`not triaged (cap 10; use --job)` line in the text output. `--job <name>`
still reaches any one of them directly. The failed-step log and the
run-level signals (`priorAttempts`/`changedFiles`/`runsForHeadSha`) are each
read once per run and reused across every job triaged, rather than
re-fetched per job.

### `review conform`

Reference-document conformance mode (flow 308): a rules file, a skill, or a
project skill is split deterministically into clauses (no model call), each
tagged `state_kind: pr|report|hunk` and `checkable`. Every checkable clause is
scored by Jev against DETERMINISTIC FACTS keryx computes first — PR body
sections present/non-empty and hand-written size (via `src/review/scope.ts`)
for `pr`; a report's section order and whether every finding records the
fields the document requires (e.g. severity, evidence, a file anchor) for `report`; the hunk itself for `hunk` —
placed above the redacted state. A `not-checkable` clause (a live/manual step,
or a reviewer-process obligation no artefact records) is always listed, never
sent to Jev.

```bash
keryx review conform --ref docs/pipeline-contribution-policy.md --pr 999 --json
```

| Flag | Description |
|---|---|
| `--ref <doc>` | Required. Path to the reference document (a rules file, a skill, or a project skill). |
| `--pr <n>` | Score `pr`-kind clauses against that pull request's title/body, and `hunk`-kind clauses against its diff. Exactly one of `--pr`/`--report`/`--diff` is required. |
| `--report <dir>` | Score `report`-kind clauses against an existing review package's own `report.md`/`findings.json` — no new artifact format. |
| `--diff <ref>` | Score `hunk`-kind clauses against `git diff <ref>`. |
| `--repo <owner/repo>` | Passed to the live `gh` adapter for `--pr`; omitted, `gh` resolves the repository from the current checkout. |
| `--explain` | Sends every clause scored below `--threshold` to the model the routing table assigns the `review` category (the session model when unset), citing the clause id and the evidence. Labelled ADVISORY; never written to the PR or to `findings.json`. |
| `--threshold <0..1>` | Below this Jev probability a clause is `likely-violated` (and, with `--explain`, explained). Default `0.5`. |
| `--model <jev-1.13\|jev-latest>` | Overrides the default Jev model. |
| `--fixtures <dir>` | Answers the pr-kind read (`pr.json`), every Jev call (`jev-response.json`), and (with `--explain`) the explanation pass (`explain-response.json`) — no real `gh` call, no real network. |
| `--json` | Prints `{ref, target, threshold, clauses, usage, hunkBudget?}` instead of the human-readable report. Each `clauses[]` entry carries `clause_id`, `state_kind`, `status`, and (hunk-kind only) `hunksJudged`/`hunksBelowThreshold` and, only when `--max-hunk-calls` cut that clause down to fewer hunks than the diff has, `hunksTotal` (the "N" in "judged on K of N"). `hunks` (the full per-hunk detail) is present only for hunk-kind clauses — a pr/report-kind clause is never scored per-hunk, so it no longer carries an always-empty `hunks: []` (flow 326). `hunkBudget` (`{maxHunkCalls, totalHunks, hunksJudged, hunksSkipped, truncatedClauses}`) is present only when `--max-hunk-calls` actually truncated something this run. See the example below. |
| `--max-hunks <n>` | Flow 326. How many further violating hunk locations a hunk-kind clause's row shows, beyond the single worst one. Default `3`. |
| `--max-hunk-calls <n>` | Flow 326. Caps hunk × clause Jev questions for the WHOLE run. With enough budget for every hunk-kind clause to get at least one full share (`--max-hunk-calls >= hunk-kind-clause-count`), every clause gets the same `floor(--max-hunk-calls / hunk-kind-clause-count)` region budget, and the hunks kept are the FIRST that many, in diff order, per clause. With a SMALLER budget than the clause count, the per-clause floor takes over: while the budget allows, each clause (in the order its `[state:hunk]` line appears in the reference document) gets 1 judged hunk before any clause gets a 2nd — so `--max-hunk-calls 1` with 2 hunk-kind clauses judges the FIRST clause on its first hunk and leaves the second at 0, rather than rounding both down to 0. At `--max-hunk-calls 0`, every hunk-kind clause gets 0 judged hunks. A clause left at 0 this way is never dropped from the report — it appears with `status: "not-evaluated"` and a reason naming the budget (`"skipped by --max-hunk-calls (0 of N hunks judged)"`); a clause judged on a subset keeps its usual status but carries the `hunksTotal`/"judged on K of N hunks" marker described above (text, JSON, and the `/conform` TUI). Default `40`. |
| `--detail` | Flow 326. Prints the full per-hunk breakdown (every judged hunk's status/location/probability) under each hunk-kind clause's row in the TEXT report. `--json` always nests this detail, with or without `--detail`. |

**One row per clause, not one row per hunk × clause (flow 326).** A live run
of `keryx review conform` against PR #712 of this repository, before this
flow, printed 271 rows — one per (hunk, hunk-kind clause) pair, unreadable
for any PR with more than a handful of hunks. The report is now aggregated
per clause: a hunk-kind clause's row names how many hunks were judged and how
many fell below `--threshold`, the single worst hunk (its location and Jev
probability), and up to `--max-hunks` further violating hunk locations —
`likely-violated` when ANY judged hunk falls below threshold, `satisfied`
only when EVERY judged hunk is at or above it. A pr/report-kind clause (which
was already one verdict, not one per hunk) is unaffected. The full per-hunk
detail — every judged hunk, not just the worst and the further violations
shown — always stays available: nested under each clause's `hunks` field in
`--json`, or printed inline with `--detail` in the text report.

```text
## hunk

- [likely violated] hunks-1
    hunks judged: 12, below threshold: 12
    worst hunk: src/invented/module1.ts:1-3 (20%)
    further violating hunks:
      - src/invented/module2.ts:1-3 (20%)
      - src/invented/module3.ts:1-3 (20%)
      - src/invented/module4.ts:1-3 (20%)
```

**`--json` with `--max-hunk-calls 1` in effect** (2 hunk-kind clauses against
a 12-hunk diff — a budget smaller than the clause count, the per-clause floor
case). `hunks-1` (the first `[state:hunk]` clause in the reference document)
got the single available hunk, so it carries `hunksJudged`/`hunksTotal` (the
"1 of 12" marker, present only because this clause was actually cut short)
and its usual `hunks`/`worst` detail. `hunks-2` got none of the budget — it
is `not-evaluated` with a reason naming why, not dropped from `clauses[]`.
The pr-kind `change-limits-1` clause is unaffected by the hunk budget at all,
and has no `hunks` field (flow 326 nit: a pr/report-kind clause is never
scored per-hunk):

```json
{
  "ref": "docs/pipeline-contribution-policy.md",
  "target": { "kind": "pr", "label": "PR #998 — ..." },
  "threshold": 0.5,
  "clauses": [
    {
      "clause_id": "change-limits-1",
      "state_kind": "pr",
      "status": "satisfied",
      "probability": 0.91,
      "evidence": ["..."]
    },
    {
      "clause_id": "hunks-1",
      "state_kind": "hunk",
      "status": "likely-violated",
      "evidence": [],
      "hunksJudged": 1,
      "hunksBelowThreshold": 1,
      "hunksTotal": 12,
      "worst": { "location": { "path": "src/invented/module1.ts", "startLine": 1, "endLine": 3 }, "probability": 0.2 },
      "hunks": [{ "status": "likely-violated", "probability": 0.2, "location": { "path": "src/invented/module1.ts", "startLine": 1, "endLine": 3 }, "evidence": [] }]
    },
    {
      "clause_id": "hunks-2",
      "state_kind": "hunk",
      "status": "not-evaluated",
      "reason": "skipped by --max-hunk-calls (0 of 12 hunks judged)",
      "evidence": []
    }
  ],
  "hunkBudget": { "maxHunkCalls": 1, "totalHunks": 12, "hunksJudged": 1, "hunksSkipped": 11, "truncatedClauses": ["hunks-1", "hunks-2"] },
  "usage": { "jevCalls": 2 }
}
```

**Opt-in, and named as a privacy decision.** Disabled by default. The
document's clauses, PR text, report and diff are sent to Jev after secret
redaction, and nothing leaves the machine unless `review.jev.conform` is on.
A project turns it on with `review.jev.conform: true` in
`.metaproject/tasks.config.json`. Sending the reference document's own clause
text to Jev is the feature, not a leak — checking a clause requires the model
to read it — and it is opt-in the same way the rest of this command is: only
SECRETS inside that text (and inside the PR/report/diff state) are stripped
first, by the same `redactSensitiveText` pass every other piece of state sent
to Jev already gets. With the setting off, or with no OpenRouter credential,
the command refuses before any read and makes no network call.

**A checkable clause whose kind has no target this run is `not evaluated`**,
never silently dropped — the same discipline `not-checkable` clauses get.
This also covers a hunk-kind clause `--max-hunk-calls` left with 0 judged
hunks (flow 326, AC3): it is `not-evaluated` with a reason naming the budget
(`"skipped by --max-hunk-calls (0 of N hunks judged)"`), distinct from a
target that supplied no state for that kind at all. The `/conform` TUI runs
the identical budget (fixed at the default `--max-hunk-calls`, not
configurable there) and shows the same "hunk budget:" line and per-clause
"judged on K of N" marker.

**Honest limits.** This mode is the least mechanical use of Jev in this
repository: deciding whether a PR body names an out-of-scope list is closer
to judgement than a styling checklist bullet. Measured against real pull
requests and a real review package: Jev's `noul` scores hedge low rather than
confidently discriminating (no score reached 0.8+ probability across a
115-question live check, and only a handful crossed the 0.5 default
threshold on ordinary small maintenance PRs) — read `likely-violated` as
"worth a human glance," not a confirmed finding. See flow 308's own journal
(`.metaproject/flows/308-*/journal.md`) for the full measurement.

**Opt-in, and named as a privacy decision.** Disabled by default. A project
enables it with `review.jev.ci_triage: true` in
`.metaproject/tasks.config.json` — the log excerpt leaves the machine to
OpenRouter/TypeSafe, so the mere presence of an `OPENROUTER_API_KEY` never
implies consent. With the setting off, or with no OpenRouter credential
(`OPENROUTER_API_KEY`, or a saved `openrouterKey`), the command refuses and
makes **no network call** — neither the CI read port nor the Jev client is
ever reached in that state. (`--eval` without `--live` needs neither: nothing
it reads ever leaves the machine.)

**Advisory only, by construction.** The CI read port (`src/review/ci-port.ts`)
has exactly six read methods (three from flow 306, three flow 307 added for
signals) and no write method at all — there is no rerun, status-check, or
merge call anywhere on this path to call. The printed verdict is always
labelled `ADVISORY ONLY`.

**Per-option probability, not a single `choice` answer.** OpenRouter's own
TypeSafe SDK guide documents no shape for a `choice` answer that carries a
probability per option — only the chosen option. So this command asks one
`noul` question per bucket (`flaky`, `infra`, `real-regression`) instead of
one `choice` question, and reports the three probabilities together.

**Deterministic signals, computed before Jev is asked (flow 307, AC1/AC2).**
For every failed job, through `CiPort` and `git show` only — never a write:

- **rerun** — did the SAME job pass on an EARLIER attempt of this SAME run
  (a "re-run failed jobs"/"re-run all jobs" rerun)?
- **history** — of a bounded window of this workflow's other recent runs
  (last 50, at most 8 actually inspected, at most 5 logs actually fetched),
  how many failed the SAME test on ANOTHER branch, and how many of those
  later passed on that branch?
- **diff proximity** — does this commit change the failing test file itself,
  a file in its own directory, or (best-effort, via `git show <sha>:<path>`)
  a file the test imports?
- **log markers** — timeout/runner-lost/network/OOM/dependency-install-
  corruption phrases in the log text itself.
- **same head, later** — did a LATER run of the exact same commit (a manual
  re-trigger, not a new push) have THIS SAME JOB conclude success? A later
  run that is merely green AT RUN LEVEL does not prove this specific job
  passed (the run could have skipped, dropped, or renamed it, or another job
  in it could be the one still failing) — this is verified by reading that
  later run's own job list through `CiPort.runInfo` and requiring a job of
  the same name to have concluded `success`. When a later run is green at
  run level but this job cannot be confirmed there, no deterministic
  override is applied; the run is still mentioned as an advisory-only
  evidence line.

These are placed in Jev's `state` as a labelled block above the log excerpt
(redacted the same as everything else, and counted against the same 64k
budget), and the questions are rewritten to point at that block explicitly.
Printed evidence lines mirror `state`'s signals block exactly.

**Deterministic override (AC8).** When the rerun or same-head signal alone
answers the question — the same job/test passed on another attempt, or a
later run of the same commit passed — the verdict says `DETERMINISTIC` and
names the reason, and **Jev's probabilities are still shown beside it**, not
replaced: the signals decide `top`, not the numbers under it.

**A known signal gap, found while building the evaluation set:** the
cross-branch history signal matches candidate runs by JOB NAME. The SAME test
failing under a DIFFERENT job-matrix leg (e.g. `opentui native (darwin-x64)`
vs. `opentui native (linux-x64)` — the real `schedules-sidebar.test.ts` AC11
flake did exactly this across two of this evaluation set's cases) is not
picked up by that signal today. Diff proximity is also a heuristic that can
point the wrong way on a PR whose OWN diff is the flakiness fix landing in
the same commit as the failure (also observed in the evaluation set).

**Another known signal gap, found in post-merge review:** the same-head
job-level check above matches the later run's job by NAME too, and a later
run can have more than one job sharing that name (a matrix leg, a reused
workflow). When that happens the deterministic override is withheld — which
one of them is "this job" cannot be told apart from the name alone — and the
run is only mentioned as an advisory-only evidence line, the same degrade
path a missing, skipped, or unreadable job already gets.

**A third known signal gap (flow 326, AC6): pagination can hide the triaged
run's own entry from the same-head list it is compared against.**
`runsForHeadSha` is bounded/paginated (`-L 10` in the live `gh run list`
adapter) and can come back without an entry for the run actually being
triaged at all — just missing from that one page. The old comparison read
that as "every success in the list is later than this run", which could
credit a run that in fact ran BEFORE the triaged one (only missing from this
particular page) as same-head rerun evidence. With no baseline timestamp for
the triaged run, "later" cannot be answered honestly, so the whole same-head
signal is skipped rather than guessed whenever this happens — no override,
no advisory evidence line from a later-passed run, only a dedicated
`same head: other run(s) ... were found, but this run's own entry was not
among them (pagination) — cannot tell whether they are later, so no override
applied.` line. This is a gap in COVERAGE, not correctness: a triaged run
that genuinely did have a later, verified same-head pass can go unrecognized
if pagination happens to drop its own entry from the page fetched, exactly
the same shape the job-name-ambiguity gap above has (the signal degrades to
"no evidence" rather than to a wrong answer).

**Measured accuracy (flow 307, AC6) — honestly, whatever it is.** A live run
of `--eval` against the real runs of the eight cases in
`src/commands/fixtures/ci-triage-eval/` (`gh`/Jev, not fixtures; 2026-09-25):

| | accuracy | cost |
|---|---|---|
| before (flow 306: log only) | **4/8 = 50%** | $0.00077 |
| after (flow 307: log + signals) | **4/8 = 50%** | $0.00083 |

Raw top-1 accuracy did not move. Signals fixed one case (a thin log excerpt
that Jev alone read as `infra`; the diff-proximity and cross-branch-history
evidence correctly pointed at `real-regression`) and broke a different one
(a job whose log said `timed out after 5000ms` — about as clear an `infra`/
`flaky` marker as a log gets — that Jev alone got right and got wrong once
the signals block and its more pointed question wording were added). The two
runs of the identical underlying regression in this set (same test, same
root cause, different CI runs) also got different verdicts from Jev BEFORE
any signal was added, which is a reminder that the model's own answer is not
perfectly stable run-to-run holding the failure fixed. **This classifier
remains a hint, not a diagnosis** — treat a non-`DETERMINISTIC` verdict
accordingly regardless of `--top`. See the flow 307 journal
(`.metaproject/flows/307-*/journal.md`) for the full per-case breakdown and
the evidence behind each of the eight labels.

### `review ci-triage --eval`

```bash
keryx review ci-triage --eval src/commands/fixtures/ci-triage-eval/manifest.json
keryx review ci-triage --eval src/commands/fixtures/ci-triage-eval/manifest.json --live --repo MrCipherSmith/keryx
```

The committed evaluation set
(`src/commands/fixtures/ci-triage-eval/manifest.json` + `cases/`) is eight
labelled failed CI jobs from this repository's own history (four real
regressions, three flaky, one infra), each with the real run id, job name,
head sha and head branch, and a truth label checked against `gh run view
--json jobs` and the job's own `--log-failed` text before being recorded.
Log excerpts are authored to be representative rather than a byte-exact copy
(the same discipline `src/commands/fixtures/ci-triage/` already follows); no
secret appears in any fixture file.

Offline (the default) replays every case from its own `fixturesDir` — a
canned `jev-response.json`, so `before`/`after` differ only where a case's
fixtures carry deterministic evidence (none of the eight do today: every real
fix in this set landed as a new commit, never an actual CI rerun, which is
itself an honest finding about this repository's CI history). `--live`
replays the SAME run/job pairs against the real `gh` and the real Jev
endpoint instead, and is where `before` and `after` can actually differ,
since the two passes ask Jev different questions.

### `review budget`

The gate to run **before** dispatching reviewers, where stopping is still
possible. `review ingest --spent` can only record that a round went over; by then
the money is spent.

```bash
keryx review budget --spent 2.10 --reviewers review-logic,review-style --outstanding 1
```

Exits 1 when spend has reached the ceiling, with a message naming the overage and
asking the operator. Prints the dispatch waves, the queue size, and whether the
concurrency cap holds across the nesting.

| Flag | Description |
|---|---|
| `--spent <usd>` | Spend so far. Omitted, the record reads `not recorded` — which is **not** `under`: staying inside the ceiling was never demonstrated. |
| `--ceiling <usd>` | Override the 3.00 USD default. |
| `--reviewers a,b` | The reviewer set to plan into waves. |
| `--parallel <n>` | Override the wave size (default 4). |
| `--outstanding <n>` | Subagents the caller already has in flight. The only thing that makes the cap mean anything across the orchestration nesting. |

### `review tier`

Which model a dispatch is worth, **computed** — the `model` block the subagent
dispatch contract expects, printed ready to paste.

```bash
keryx review tier --scope blast-radius --findings 12 --diff-lines 340 --json
```

It sits beside `review scope`, `review blast-radius` and `review budget` for the
same reason those exist: all four are *compute this mechanically, before
dispatching, instead of eyeballing it*. The rule used to say an orchestrator
"calls `decideDispatchModel`" — but an orchestrator is an agent following prose
and cannot call a TypeScript function, so what actually happened was a model
reading a table of signals and doing the arithmetic in its head. This is the
entry point that removes that step.

| Flag | Description |
|---|---|
| `--scope <scope>` | The round's scope. `blast-radius` floors the tier at `deep`. |
| `--fix-attempt <n>` | 1-based attempt at the **same** finding. `>= 2` raises one tier. |
| `--forced-strategy-change` | A strategy change forced by hitting the loop cap. Floors at `deep`. |
| `--findings <n>` | Findings in scope for this dispatch. |
| `--diff-lines <n>` | Changed lines in the diff under review. `<= 3` findings **and** `<= 50` lines allow `light`. |
| `--verifier <method>` | `execution`, `site-check` or `reasoning`. The first two allow `light`: the evidence comes from running something. An unrecognised method is refused, not ignored. |
| `--security` | Any security finding in scope. Never below `standard`. |
| `--session-provider <id>`, `--session-model <id>` | The session's own provider/model. Omitted, they come from `KERYX_SESSION_PROVIDER`/`KERYX_SESSION_MODEL`; with neither, the block is adaptive. |
| `--from-shell-config` | Use the selection `keryx shell` persisted as the session. Off by default: it is `keryx shell`'s last choice, not the caller's model. |
| `--catalog <file\|->` | The candidate set, in the `detectProviders()` shape `[{"name": …, "models": [ … ]}]`. Omitted, providers are detected live. |
| `--json` | Print the `{"model": …}` block alone. |

Floors are applied after downgrades, so *at least `deep`* means at least: a
blast-radius round over a twelve-line diff is still a blast-radius round. The
output carries the ordered rule ids that produced the tier, so the answer can be
explained afterwards rather than re-derived.

**No model name exists in this command, and there is no `--tier` flag.** The
session's provider/model and the candidate set are both discovered at runtime;
`src/gdskills/model-tier.ts` places the tier relative to the session's own model
using size words in model names (`mini`, `haiku`, `pro`, `opus`, …), never a list
of models that exist. Accepting a hand-written tier would put the arithmetic
back in the caller's head, which is the defect.

**A model is named only when discovery found a different one; otherwise the block
is adaptive, and exits 0.** With no session named, an unrankable catalogue, a
session model carrying no size marker, or a tier that resolves to the session
model, the block carries `inherit: true` with the tier instead of
`provider`/`model`, and the host dispatches on its own model for that tier
(`standard`: the session model). Never a downgrade, never a failure — degrading
capability because discovery failed is the worst of the three outcomes. Detection
is skipped entirely when the session names neither provider nor model, because
ranking is refused without an anchor whatever the catalogue holds.

### `review loop`

Loop **detection**, not counting. The round bound fires on attempt count alone,
so an agent producing the identical failing output three times spends the whole
budget before anything notices — a counter cannot tell "converging slowly" from
"stuck".

```bash
keryx review loop --flow 203 --task T4
```

Escalates (exit 1) when the same finding recurs in two rounds, or two consecutive
rounds produce identical review output. **Regardless of the remaining round
budget**, which it deliberately never reads: a detector handed the remaining
budget is a detector that can be argued out of firing.

It reads real persisted state — the flow's review packages on disk, ordered by
`manifest.createdAt`, and `tasks[].attempts.count` from `flow.json` — never a
session's own memory. A resumed orchestrator's context starts at zero while the
real count does not.

A finding's identity is its `dedupe_key`, then its `global_id`, then a derived
key over reviewer, file, symbol, line and problem text. Never the display `id`:
`F-001` denotes a different finding in every round, so a detector keyed on it
would fire on the second round of every flow whatever happened.

### Verification — `--verifications`, `--verification-mode`

`attach`, `start` and `ingest` accept the output of the `review-verifier` skill
and merge it into the package. **The merge can only delete.** It cannot raise a
severity, add a finding, or change a finding's text: the merged record is built
from the finding as reported, and only the verdict is taken from the claim. A
claim that carries anything else is discarded whole and the attempt is recorded
in `scope.md`.

This replaced `review-strict`, which re-read consolidated findings and adjusted
their severity with no new evidence. That operation is measured to make accuracy
worse — GPT-4 on GSM8K falls 95.5 → 91.5 → 89.0 across self-correction rounds and
GPT-3.5 on CommonSenseQA falls 75.8 → 38.1 (Huang et al., ICLR 2024,
arXiv:2310.01798) — so it was removed rather than improved.

| Flag | Description |
|---|---|
| `--verifications <file\|->` | The verifier's result: an array of claims, or `{verifier, verifications}`. |
| `--verification-mode <mode>` | `off`, `annotate` (default), or `filter`. |
| `--scope <scope.json>` | The **whole** `--json` output of `keryx review scope`, so the record carries what the pre-filter dropped and why. Handing over only its `counts` object is refused: eight integers carry no reason for any individual drop. |
| `--tokens-in <n>`, `--tokens-out <n>` | What the round actually used. Recorded on the package; absent means **nobody reported**, which is not zero. |

### A finding points at the code it quotes

A finding does not report a line number. It reports `quote` — the code it is
about, copied out of `file` — and `review ingest` locates that quote at the
commit the round records, writing the line the match started on. `line` is
therefore **output**, and a number a reviewer puts there is overwritten.

The reason is the failure it replaces: nothing compared a reported line to
anything, so a number that had drifted travelled into `findings.json`, into the
report, and into the disposition somebody later recorded against it. On a fix
round the file has moved under the finding by construction, which is when the
reported number is least trustworthy and most acted upon.

Matching is exact first, then with whitespace collapsed, then it stops — nothing
fuzzy. Three outcomes, all recorded in `locator`:

| Outcome | What it means |
|---|---|
| `derived` | The quote was found; `line` is where, and `reported_line` keeps whatever the reviewer claimed. |
| `unlocatable` | It was not, and `line` is `null` rather than a number nobody checked. The `reason` says which: the file is absent at that commit, the quote does not appear, or it appears in more than one place. |
| absent | The finding carries no quote — one about the round rather than a site. Its `line` is reported-only, and says so by carrying no locator. |

A quote matching twice is `unlocatable` rather than anchored to the first hit:
choosing between them would be a guess wearing a line number. Files are read at
the round's recorded commit, contained to that tree with `realpath` on both
sides, and bounded in size; the quote is bounded in length. A round is a claim
about a commit, and locating it anywhere else answers a question nobody asked.

### What the ingest fills in, and what it refuses

Two fields are supplied when a report omits them, because both are typing rather
than judgement: `id`, from the finding's position in the report, and `problem`,
from the finding's own `title`. Whatever was supplied is recorded in
`manifest.repairs` — the field, the finding, and where the value came from — so
a later reader can tell a statement the reviewer made from one carried across.

Everything else stays refused. `class_scope` is an enumeration somebody has to
perform, `evidence` is something somebody has to have run, a disposition is an
outcome somebody has to have observed. A repair is accepted only if it
introduces no property the contract does not define, removes none, and preserves
the number of findings — so widening it fails a test rather than passing a
review.

Each claim is `{finding, verdict, method, evidence, verifier}` and nothing else.
`verdict` is `confirmed`, `refuted` or `unverifiable`; `method` is `execution`,
`site-check` or `reasoning`. Rules enforced in code, not by instruction:

- **A verdict reached by reasoning alone is capped at `unverifiable`.** It can
  never be `confirmed`, and it can never be `refuted` either — `refuted` is the
  only verdict that removes a finding, and giving it to the method that produces
  no new evidence would reinstate the pass that was just removed.
- **A finding is never verified by the reviewer that raised it.** A claim whose
  `verifier` names the finding's `reviewer` is discarded. The two names are
  compared after normalising case, surrounding whitespace, `_`/`-` and a trailing
  `(model)` annotation, so `review-logic `, `Review-Logic` and
  `review-logic (sonnet)` are all the same actor. The comparison deliberately
  over-matches: a refused claim costs a verdict, a missed self-verification costs
  the finding.
- **Two claims for one finding cancel only when they disagree**, because there
  the outcome would otherwise be decided by claim order. Two verifiers reaching
  the same verdict record it, naming both and carrying both pieces of evidence —
  each claim was already admitted on its own evidence, so this is not voting.
- **Every rejection retains the finding.** A malformed, anonymous, disagreeing or
  mutation-carrying claim can cost a verdict, never a finding.

Modes:

| Mode | Effect |
|---|---|
| `off` | Nothing is verified. Supplied claims are refused rather than silently ignored. |
| `annotate` | **Default.** Verdicts are recorded on the findings; nothing is removed. A refuted finding is still reported, marked refuted. |
| `filter` | An applied `refuted` verdict removes the finding from the reported set and records it as `dismissed-incorrect`, carrying the verification evidence. |

`annotate` is the default so the drop rate is measured for a release before it
costs a real finding.

Every package's `scope.md` carries the **stage counts** — dropped by the
pre-filter, refuted by the verifier, retained — and the same numbers are printed
on creation. Without `--scope`, a `## Pre-filter scope` block already in the
package is carried forward verbatim; with neither, the pre-filter half reads
`not recorded` rather than `0`, because "dropped nothing" and "never ran" are
different facts. State results as these counts and never as a precision
improvement; the pipeline has no precision baseline to improve on.

### `filter_stats` — the machine-readable copy

`scope.md` is prose. `manifest.json` carries the same numbers as `filter_stats`,
written by the code that does the filtering rather than re-derived from the
markdown, so a claim about what a round dropped can be checked afterwards by
something other than a person reading a file.

```json
"filter_stats": {
  "schema_version": 1,
  "total": 5,
  "dropped_prefilter": 2,
  "dropped_low_confidence": null,
  "dropped_refuted": 1,
  "dropped_scope_b": null,
  "dropped_findings_cap": 1,
  "retained": 3,
  "dismissed_by_round": null,
  "by_reason": { "prefilter:lockfile": 1, "prefilter:generated": 1, "refuted:verifier-refuted": 1 },
  "not_measured": [{ "stage": "low_confidence", "reason": "…" }, { "stage": "scope_b", "reason": "…" }]
}
```

**`null` always means the stage did not run. It never means zero.** Every `null`
count has a matching row in `not_measured` giving the reason, and the two are
written together — there is no path that omits one. `dropped_low_confidence` is
`null` on every record: `confidence` is recorded on each finding and no stage in
this pipeline filters on it, so the field is carried unmeasured rather than
reported as a threshold that never fired.

`dropped_prefilter` counts **diff material** — whole files and change blocks
removed before any reviewer read them. Every other count is findings, and only
the finding counts are summed: `total` minus the measured finding-stage drops
must equal `retained`.

`keryx review status` reads it back off disk and **refuses** — exit 1 — when the
arithmetic does not hold or when a `null` count has no stated reason. A package
written before `filter_stats` existed carries none; that is reported and exits 0.

### Recording what became of a finding — `--refuted`, `review complete`

A review package that records only what a round *reported* keeps the survivors
of an unlogged triage, and precision measured over survivors is 100% whatever the
reviewers actually got right. Two commands write the other half.

| Flag | Command | Description |
|---|---|---|
| `--refuted <file\|->` | `ingest` | Findings this round **raised and then dismissed**, in the same finding shape, each carrying `disposition: {state, evidence}` with a `dismissed-*` state. `acted-on` and `unknown` are refused on this channel. |
| `--finding <id>` | `complete` | The finding a disposition is about, by `global_id` or display `id`. Repeatable: each `--finding` opens a new record. |
| `--disposition <state>` | `complete` | `unknown`, `acted-on`, `dismissed-incorrect`, `dismissed-wont-fix`, `dismissed-out-of-scope`, `dismissed-deprioritised`. |
| `--evidence <ref>` | `complete` | Where the outcome is written down: the commit, the test, the decision. Required for every state except `unknown`. |

Only `acted-on` and `dismissed-incorrect` say anything about whether a reviewer
was **right**; the three other dismissals say the finding was correct and not
worth doing now. They are separate states rather than one `dismissed` bucket
because collapsing them makes a dismissal rate unreadable.

A recorded state **and its citation** cannot be overwritten by a later close —
record a correction as a new round. Closing with no disposition flags is allowed
and leaves every finding reading `unknown`, which means "nobody wrote down what
happened", never "the finding was correct".

`review complete` also prints what the round cost against what survived it:

```text
tokens: 552,502
retained findings: 6
per retained finding: 92,084 tokens
```

This is the first moment both halves are known, which is why it is printed here.
A round nobody reported a cost for prints `cost: not recorded` and says that is
not zero. A round that retained nothing prints the bill rather than a
per-finding figure — an infinity dressed as a metric is worse than the plain
fact. And a per-finding figure that rounds down to nothing prints `< 1 token`
rather than `0`, because in these records a zero means somebody measured one.

#### The learning note — `.metaproject/memory/review-notes/`

A finding recorded as `dismissed-incorrect` — and only that state — writes a
`review-note` memory entry naming the finding, the reviewer, why it was
dismissed, and the round and commit it came from. Both writers do it: `ingest`,
when a `refuted` verdict is applied in `filter` mode, and `complete`, when a
person records the disposition. The path is
`.metaproject/memory/review-notes/<review-id>__<finding-id>.md`, so re-running
either command overwrites its own note rather than accumulating one per run. The
entry is written `Status: draft`; only `accepted` entries influence skills.

**A note is written only when the dismissal is attested.** The record must carry
either a named human decision in the disposition evidence (`human: <who>`,
`decided-by: <who>`, and the other forms the completion gate accepts) or an
independent verifier's `refuted` verdict with a method and evidence. An
unattested `dismissed-incorrect` is still recorded in `findings.json` and writes
no note; the command prints `review-note NOT written for <id>` with the reason.
The orchestrator does not get to file a finding as its own error, teach a skill
from it, and move on with nobody having looked.

`bun run baseline:review-precision` recomputes the figure from the packages on
disk, joining on `global_id`.

---

## security

Policy-based scanning, redaction, guardrails, and audit reports for agent
input/output and `.metaproject/` artifacts. The engine is deterministic (rule +
entropy detectors, no model backend) and local-first: config lives at
`.metaproject/security.config.json`, data under `.metaproject/data/security/`,
and the local-only HMAC key under `data/security/raw/` (gitignored). This is
Phase 1+2+3 of the spec — the engine, the CLI below, and the write-seam
integrations (an advisory-by-default guard at `memory ingest`, `wiki collect`,
`test run`, `gdctx`, and `flow complete`) are shipped. `mode: "gateway"`
already blocks exactly like `enforced`/`ci` — the write seam, the flow
completion gate, and the exit code of `scan`, `report`, `check-input`, and
`check-output` — it is not a report-only mode. Model/API backends and
`gateway`'s own Phase-4 proxy behaviour are not implemented.

```
keryx security status
keryx security scan <path> [--json] [--source <kind>]
keryx security scan-mcp <manifest.json|dir> [--json] [--pin <manifest>] [--strict]
keryx security audit-harness [path] [--json] [--ci] [--fix-proposals] [--baseline <file>] [--severity-floor <level>]
keryx security audit-harness apply --proposal <id> [path]
keryx security audit-harness baseline add --finding <id> --justification <text> [--expires YYYY-MM-DD] [--author <name>] [--reseal] [--json]
keryx security impact-evidence status [--json]
keryx security impact-evidence test <file...> [--json]
keryx security impact-evidence hook [--runtime claude] [--profile <name>]
keryx security check-input [--source <kind>] [--file <path>] [--json]
keryx security check-output [--target <kind>] [--file <path>] [--json]
keryx security redact <path> [--out <path>]
keryx security report [--since <ref>] [--json]
keryx security policy validate
keryx security incidents [--limit <n>]
keryx security hooks install|uninstall --runtime <claude|cursor|windsurf|generic-mcp|all>
keryx security eval [--corpus <name|all>] [--with-model] [--json]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | — | Print the effective config: mode, raw-retention, gate (`failOn` + `minConfidence`), config-checksum state, and each policy with its action. |
| `scan <path>` | `<path>`, `--json`, `--source <kind>` | Scan a file, resolve findings into a decision, and write committable artifacts (`data/security/artifacts/latest.{md,json}`). Prints the gate, action, and findings (or raw JSON with `--json`). |
| `scan-mcp <manifest\|dir>` | `--json`, `--pin <manifest>`, `--strict` | Scan one MCP tool manifest (or every `*.json` under a directory, recursively) for MCP threats. Findings are leak-safe (category + policy id only). `--pin` records a rug-pull baseline instead of scanning; `--strict` exits `1` when any threat is found, or when the scan could not read a manifest or the pinned baseline (`coverage: incomplete`). Pure and network-free. |
| `audit-harness [path]` | `<path>`, `--json`, `--ci`, `--fix-proposals`, `--baseline <file>`, `--severity-floor <level>` | Read-only sweep of harness-configuration surfaces, computing a security score over harness fixtures and vulnerabilities. Outputs a summary report with surface coverage, findings by severity, and a pass/fail gate (score formula: `100 - (25*critical + 10*high + 4*medium + 1*low)`, grades A 90–100 / B 75–89 / C 60–74 / D 40–59 / F <40, any critical caps at C). `--ci` sets process exit code from the gate; `--fix-proposals` includes fix recommendations (never writes anything); `--baseline <file>` uses a project suppression file `.metaproject/security-audit-baseline.json` with required justification and checksum; `--severity-floor <level>` filters findings below that severity. A suppression's `expiresAt` (`YYYY-MM-DD`) is inclusive THROUGH the end of that day in UTC — an entry expiring today still suppresses today, and stops the instant the next day begins. |
| `audit-harness apply` | `--proposal <id>`, `[path]` | Apply a specific fix proposal by id, against `[path]` (defaults to the project root). Fix proposals never self-apply; they are generated by `audit-harness` and applied by the operator. Refuses a `path` that does not already exist as a directory rather than creating it. |
| `audit-harness baseline add` | `--finding <id>`, `--justification <text>`, `--expires YYYY-MM-DD` (opt), `--author <name>` (opt), `--reseal` (opt), `--json` (opt) | Record a suppression for a specific finding with required justification and optional expiration date (inclusive through the end of that day, UTC — see above). Suppressed findings are excluded from scoring and the gate. Adding to a baseline whose checksum does not match its contents (tampered or unreadable) is refused unless `--reseal` is passed explicitly; a reseal backs up the pre-reseal file to `<file>.bak-<timestamp>` before overwriting it, and reports (on stdout, or in the `--json` object) which finding ids from the old file were carried over into the new one vs discarded (lost because the old file could not be read at all). |
| `impact-evidence status` | `--json` | Print the effective impact-evidence config (enabled, strict, exemptGlobs, dampenAfter), declared state, config-checksum match, kill-switch status (`impactEvidence.enabled` and `KERYX_DISABLE_IMPACT_GATE` both logged), host delivery readiness per adapter, and recent log records. `--json` for the machine-readable form. |
| `impact-evidence test` | `<file...>`, `--json` | Dry-run computation of impact evidence for specified files. Writes nothing — no session state, no log — unlike `hook`, which is the live path. `--json` for machine-readable output. |
| `impact-evidence hook` | `--runtime claude` (opt), `--profile <name>` (opt) | Live hook entry for pre-tool-context injection at the agent runtime level. `--runtime` (defaults to `claude`); `--profile` accepts `monitored-trusted-local`, `read-only-review`, or `unattended-untrusted` (defaults to `monitored-trusted-local`). Reads and processes JSON from stdin; outputs decision JSON to stdout. |
| `check-input` | `--source <kind>`, `--file <path>`, `--json` | Evaluate incoming content (defaults source `untrusted-external`). Reads from `--file` or stdin. Prints the decision. |
| `check-output` | `--target <kind>`, `--file <path>`, `--json` | Evaluate outgoing/generated content (defaults source `generated`, target `unknown`). Reads from `--file` or stdin. Prints the decision and, when applicable, the redacted preview. |
| `redact <path>` | `<path>`, `--out <path>` | Apply fixed-width masks to detected sensitive spans. Writes to `--out`, else prints the redacted content to stdout. Reads from the path or stdin. |
| `report` | `--since <ref>`, `--json` | Aggregate the latest scan artifact (never re-scans) into a summary: gate, mode, and finding counts by category. |
| `policy validate` | — | Validate the config against its schema and verify the config checksum. Exit `1` on schema errors or a checksum mismatch. |
| `incidents` | `--limit <n>` | List the append-only incident trail (mode downgrades, disabled policies, checksum mismatches). Newest first; `--limit` caps the count. |
| `hooks install\|uninstall` | `--runtime <id>` | Merge-safe install/uninstall of the agent security hooks for one or more runtimes. `--runtime` takes a runtime id, a comma-separated list, or `all` (defaults to `claude`); after install the rendered settings are validated. |
| `eval` | `--corpus <name\|all>`, `--with-model`, `--json` | Run the labeled security corpora through the detectors and print a deterministic per-detector false-negative-rate report, exiting `1` when a detector breaches its committed threshold. `--corpus` defaults to `all` (or a comma list of corpus names); `--with-model` also exercises the opt-in model backends, warning once and falling back to the pure path when the model asset is absent. |

Runtime ids (`--runtime`): `claude`, `cursor`, `windsurf`, `generic-mcp`, or
`all`. Eval corpora (`--corpus`): `injection`, `exfil`, `structured-pii`,
`secret`, or `all`.

Source kinds (`--source`): `trusted-project`, `trusted-user`,
`untrusted-external`, `tool-output`, `generated`. Target kinds (`--target`):
`model`, `memory`, `wiki`, `report`, `external`, `task`, `unknown`.

**Exit behavior.** `scan`, `check-input`, `check-output`, and `report` all honor
the config `mode` through the same fold (`exitCodeFor`/`reportExitCode`,
`src/commands/security.ts`): in **advisory** mode (the default) they always
exit `0` after reporting; in **enforced**, **ci**, or **gateway** mode they
exit `1` on any gate other than **pass** — that is, on **fail**,
**needs-approval**, **incomplete**, or an unrecognized stored gate value.
`report` never re-scans; it reads the gate from the last stored scan artifact
and applies the identical fold. `policy validate` exits `1` on schema or
checksum failure. `scan-mcp` exits `1` only with `--strict`, when a threat is
found or when the scan could not read a manifest or the pinned baseline
(`coverage: incomplete`); `eval` exits `1` when any detector breaches its threshold; `hooks` exits
`1` on an unknown runtime or a post-install validation error. `status`, `redact`,
and `incidents` do not gate. An unknown subcommand prints an error and exits `1`.

---

## serve-mcp

Run keryx as an [MCP](https://modelcontextprotocol.io) server, exposing read-only
Metaproject services to an editor or agent.

<!-- retired-spellings-ok: line — names the retired spelling to tell a reader who knows it where it went; this is not an instruction to run it -->
This is the spelling `keryx mcp serve` used to have; that spelling still works
and prints a deprecation line.

```
keryx serve-mcp [--cwd <project-root>]     # stdio JSON-RPC (default transport)
keryx serve-mcp --http [--cwd <root>]      # HTTP/SSE, localhost only, opt-in
keryx serve-mcp --read-only [--cwd <root>] # hide every tool marked mutating
keryx serve-mcp --harness <id> [--cwd <root>] # bind a cross-harness memory identity (flow 313 / W4-AC6)
```

`--cwd` names the project root whose `.metaproject` workspace is exposed; it
defaults to the process working directory. `--http` requires
`capabilities.http.enabled` in the workspace. `--read-only` drops every tool
the registry marks `mutating` from `tools/list`, and a call to one by name
answers "Unknown or unavailable tool." `--harness <id>` (or the `KERYX_HARNESS`
env var, when `--harness` is absent) binds this server process's harness
identity once at launch — never per tool call — for `memory.search` filtering,
`memory.handoff`, and the `Source-Harness` stamped on `memory.propose` writes.
An unrecognised id refuses to start the server. keryx launches its own server this way
when it hands it to a foreign agent it drives over ACP (see
[agents external](#agents-external) and the
[ACP client guide](guides/acp-client.md)): that agent's MCP calls go straight
to this server and never pass keryx's permission bridge.

Under stdio, stdout is the JSON-RPC channel — diagnostics go to stderr, and so
does the deprecation notice when the retired spelling is used.

See [mcp](#mcp) for what is exposed and why it is opt-in.

## integrate

Wire this project into an editor or agent, so that tool can reach keryx over MCP.
It writes a client config belonging to *that* tool — nothing is installed.

```
keryx integrate <editor>[,<editor>…] [--dry-run]
keryx integrate --remove <editor>[,<editor>…]
```

Editors: `cursor`, `claude`, `opencode`, `vscode`, `generic`, `all`. Omitting the
editor means `all`, which is `cursor,claude,opencode` — `vscode` is opt-in and not
included. `generic` writes nothing and prints a pasteable snippet instead.

| editor | file written |
|---|---|
| `cursor` | `.cursor/mcp.json` |
| `claude` | `.mcp.json` |
| `opencode` | `opencode.json` |
| `vscode` | `.vscode/mcp.json` |

`--dry-run` prints the planned change and writes nothing. `--remove` deletes only
the managed `keryx` entry and leaves other servers in the file untouched.

<!-- retired-spellings-ok: line — past tense, so a reader who knows the old names can find the new ones; not an instruction -->
These were `keryx mcp install --runtime <editor>` and `keryx mcp uninstall
--runtime <editor>`. Both still work and print a deprecation line.

## integrations

Install, remove, and audit Keryx's own hooks and standing-instructions files
in ANOTHER coding agent/IDE's config (the harness adapter registry —
`src/integrations/`), and print or check the generated capability matrix.
This is a distinct namespace from `keryx integrate` (MCP client
configuration, above) and from `keryx harness` (Keryx's own agent runtime,
below). Full details, per-harness notes, and the legacy-alias table are in
[integrations.md](./integrations.md).

```
keryx integrations install --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]
keryx integrations uninstall --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]
keryx integrations doctor --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--json]
keryx integrations matrix [--check] [--write] [--json] [--file <path>]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `install` | `--runtime <id>`, `--surface <flag\|id>...`, `--dry-run`, `--json` | Resolve every surface for `<id>` (or only the named ones), apply each surface's merge in deterministic order, and record what it wrote to install-state. `all` targets every adapter with at least one surface; `keryx-shell` (no surfaces yet) is reported as unsupported rather than silently skipped. `--dry-run` reports what it would write and changes nothing; `--json` prints the structured result objects only. |
| `uninstall` | `--runtime <id>`, `--surface <flag\|id>...`, `--dry-run`, `--json` | Remove only the sentinel-tagged entries Keryx itself installed, leaving every other entry (including the operator's own) untouched. Same `--runtime`/`--surface`/`--dry-run`/`--json` shape as `install`. The `agents` surface additionally never deletes a managed export file that was hand-edited since it was exported (its content-sha256 no longer matches) — it is kept, and reported as a warning; there is no `--force` override for this on uninstall. |
| `doctor` | `--runtime <id>`, `--surface <flag\|id>...`, `--json` | Re-validate every surface recorded in install-state against the live settings file and report drift. `--surface` is additive here, unlike `install`/`uninstall`: it names an opt-in surface (e.g. `agents`) to doctor on top of the runtime's normal (non-opt-in) surfaces, even before it has ever been installed — it never narrows what gets checked. For a single explicit `--runtime`, an unknown selector errors the same way it does for `install`/`uninstall`. For a multi-runtime selection (`--runtime all` or a comma list) combined with `--surface`, a selector a given runtime does not declare is simply dropped for that runtime (that runtime is still fully doctored over its own surfaces, never skipped) rather than erroring it — same lenient matching `install`/`uninstall` use — and the command only errors if NO selected runtime declares any of the requested selectors, in which case every runtime is annotated `<id> declares none of the requested surface(s): ...`. Exits 1 when any requested runtime's doctor result is not ok, or when every selected runtime declared none of the requested selectors. |
| `matrix` | `--check`, `--write`, `--json`, `--file <path>` | With no flags, prints the generated capability matrix as a table (id, state, confidence, supported flags); `--json` prints the full document. `--check` regenerates and diffs against the checked-in artifact, exiting 1 on drift, writing nothing — this is what CI runs. `--write` regenerates and overwrites the artifact. `--file` overrides the artifact path (default `docs/integrations/harness-capability-matrix.json`). |

`--runtime` accepts a comma-separated list or `all`; `--surface` is
repeatable and also accepts a comma-separated value, matching either a
`SurfaceFlag` (`block`, `prompt-gate`, `inject-context`, `instructions`, …)
or a surface id (`ctx-guard`, `orient`, `security-check-input`,
`security-check-output`, …) — a flag can match more than one surface on the
same runtime, an id matches exactly one.

`keryx ctx install-hook`, `keryx orient install-hook`, and `keryx security
hooks install` are legacy aliases that already delegate to this same
installer core (see [integrations.md](./integrations.md#legacy-command-aliases)).

## mcp

Expose read-only Metaproject services (code graph, gdctx, security, flow status,
memory, health, testing, wiki, standard, SAC) over the
[Model Context Protocol](https://modelcontextprotocol.io). A thin protocol adapter —
it defines no new module logic and routes every tool result through the security
redaction seam before transport. Opt-in: the module is off by default; enable it with
`keryx init --mcp`. Confirmed working live with Claude Code, Cursor, the `codex` CLI,
and the `opencode` CLI — codex and opencode both connect and call tools headlessly,
not just interactively.

```
keryx serve-mcp [--cwd <project-root>]          # stdio JSON-RPC MCP server (default transport)
keryx serve-mcp --http [--cwd <project-root>]   # isolated HTTP/SSE opt-in (localhost only)
keryx mcp                  # alias for `serve-mcp`
keryx integrate <cursor|claude|opencode|vscode|generic|all> [--dry-run]
keryx integrate --remove <cursor|claude|opencode|vscode|generic|all>
```

| Command | Flags / args | Description |
|---|---|---|
| `serve-mcp` | `--http`, `--cwd <project-root>`, `--harness <id>` | Start the MCP server over stdio (the default). `--cwd` selects the project root whose `.metaproject/` workspace is exposed; this is what makes editor/client launches independent from their process cwd. `--http` switches to the isolated localhost-only HTTP/SSE transport, which additionally requires `http.enabled=true` in the module's manifest entry. `--harness <id>` (or `KERYX_HARNESS`) binds a cross-harness memory identity once at launch; an unrecognised id refuses to start. Bare `mcp` is an alias for `serve-mcp`. |
| `integrate` | `<cursor\|claude\|opencode\|vscode\|generic\|all>` (comma-separated; default `all`), `--dry-run` | Merge-safely wire this project into an editor/agent's MCP client config: `cursor` → `.cursor/mcp.json`, `claude` → `.mcp.json`, `opencode` → `opencode.json` (all project root), `vscode` → `.vscode/mcp.json`, `generic` prints a ready snippet and writes no file. `all` targets cursor + claude + opencode only — `vscode` is deliberately opt-in and must be named explicitly. `cursor`/`claude` add `mcpServers.keryx = { command: "keryx", args: ["mcp","serve","--cwd","<absolute-project-root>"] }`; `opencode`'s shape differs — `mcp.keryx = { type: "local", command: ["keryx","mcp","serve","--cwd","<absolute-project-root>"], enabled: true }`; `vscode`'s shape differs again — VS Code's native MCP config uses a top-level `servers` key (not `mcpServers`), each entry requiring `"type": "stdio"`: `servers.keryx = { type: "stdio", command: "keryx", args: ["mcp","serve","--cwd","<absolute-project-root>"] }`. Every runtime's entry is marked with a managed sentinel, preserving existing servers/keys and staying idempotent. Also sets `modules.mcp.enabled=true` in `metaproject.json` and probes the optional SDK (printing `bun add @modelcontextprotocol/sdk` when absent — it never auto-installs or opens a network connection). `--dry-run` prints the planned change and writes nothing. |
| `integrate --remove` | `<cursor\|claude\|opencode\|vscode\|generic\|all>` (default `all`) | Remove ONLY the managed `keryx` server (and its sentinel) from each runtime's client config, leaving other servers and user content intact. A no-op when nothing is installed. |

### Retired spellings

The publisher surface was renamed so that `mcp` means one direction only
(D-04, `docs/requirements/keryx-mcp-servers/decisions.md`). Every retired
spelling still runs and prints one line naming its replacement — nothing was
removed, so existing scripts keep working:

| retired | current |
|---|---|
| `keryx mcp serve` | `keryx serve-mcp` |
| `keryx mcp install --runtime <editor>` | `keryx integrate <editor>` |
| `keryx mcp uninstall --runtime <editor>` | `keryx integrate --remove <editor>` |

**codex CLI** is not an `integrate` target here — its client config is a single GLOBAL
`~/.codex/config.toml`, not a project-local file, and it already ships its own safe,
native installer for it: run `codex mcp add keryx -- keryx serve-mcp --cwd
<project-root>` once (`codex mcp remove keryx` to undo). `modules.mcp.enabled=true`
still needs one `keryx integrate <any>` run, since codex's own installer
has no notion of the keryx manifest. Headless codex needs `codex exec
--approve-for-me` — plain `codex exec` silently cancels MCP tool calls without it.

`init` also offers to enable the MCP server interactively (default **No**); the
`--mcp` / `--no-mcp` flags set it non-interactively (`opencode` is also offered as a
runtime choice at that prompt). The default non-interactive `init` never enables MCP
nor writes a client config.

## mcp (consumer) — connecting keryx TO other MCP servers

Everything above is keryx **as** an MCP server. This is the other direction:
third-party MCP servers that `keryx shell` connects to, so the model can use
their tools.

```
keryx mcp list [--json]
keryx mcp add <name> [-e KEY=value]… [--scope user|project] [--force] -- <command…>
keryx mcp add --transport http|sse <name> <url> [--header "K: V"]…
keryx mcp remove <name> [--scope user|project]
keryx mcp enable | disable <name>
keryx mcp trust | untrust <name>
keryx mcp doctor [name] [--json]
keryx mcp auth <name>
keryx mcp logout <name>
```

| Command | Description |
|---|---|
| `list` | Every configured server with its source tag (`user`, `project`) and whether it is disabled. `--json` adds the resolved entry, with `env` and `headers` reduced to `set`/`unset` — never the values. An empty list names the two files that were read, because "no servers" and "your config is somewhere keryx does not look" are different problems. |
| `add` | Writes a native entry. The stdio form REQUIRES `--` before the server's command: without it, `keryx mcp add fs -- npx pkg --json` could not tell whose `--json` that is. `-e` is repeatable. `--scope user` (default) writes `mcp-servers.json` in the keryx config dir, owner-only; `--scope project` writes `<root>/.keryx/mcp-servers.json`, which is meant to be committed. An existing name is refused unless `--force`. |
| `add --transport http\|sse` | A remote server by URL, with repeatable `--header "Name: value"`. `sse` is an alias of `http` — streamable HTTP negotiates it, so it is not a separate transport. |
| `remove` | Deletes a native entry. With `--scope` omitted it resolves which file actually defines the name, and refuses when both do rather than guessing which one you meant. |
| `enable` / `disable` | A personal overlay in the keryx config dir, never an edit to the config file. Disabling a server your project committed produces no diff for your colleagues; enabling one the project disabled works for the same reason. |
| `trust` / `untrust` | Approve (or withdraw approval for) a PROJECT-scoped server. See "Project servers need approval" below. Prints the command it would launch before recording anything. |
| `doctor` | Config problems, a real connection attempt, the tool count, and every tool that had to be skipped with the reason why. `--json` for the machine-readable form. Exits non-zero when anything needs you. |
| `auth` | Runs a remote server's OAuth flow in your browser and stores the result owner-only. The only command that opens a browser — see "Servers that need a login" below. |
| `logout` | Forgets a stored credential. Needed because a revoked refresh token cannot be repaired by re-running `auth`, and because a server removed from the config leaves its credential behind. |

**Config files.**

| File | Role |
|---|---|
| `<keryx config dir>/mcp-servers.json` | User-global. Owner-only (0600) — `env` values are often tokens. |
| `<project>/.keryx/mcp-servers.json` | Project-scoped, meant to be committed. Wins over the user file for the same name (replace, not field-merge). |
| `<keryx config dir>/mcp-servers-disabled.json` | Your personal enable/disable overlay. Wins over both, in either direction. |
| `<keryx config dir>/mcp-credentials.json` | OAuth tokens from `keryx mcp auth`. Owner-only (0600), never committed, never printed. |

`${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url` and
`headers` at load time.

**What the model sees.** Two tools, `search_tool` and `use_tool` — not one
registered tool per MCP tool, however many servers you connect. The model
searches for a tool by description, then calls it by qualified name
(`server__tool`). The trade this buys is a tool surface whose cost does not
grow with your server list; the cost is that the model cannot see a tool it
has not searched for.

**Project servers need approval.** A server in `<project>/.keryx/mcp-servers.json`
is committed, which means it is a command *someone else wrote* the moment you
clone the repository. keryx will not start one until you have said so:

```
$ keryx mcp list
docs (project) (needs approval) stdio — npx -y some-docs-mcp

1 project server(s) are not started until approved — a committed config is code someone else wrote.
Read what it launches above, then: keryx mcp trust <name>
```

The approval is bound to the exact command, so a later commit that changes
what `docs` runs needs approving again. It is stored in your own config
directory, never in the repository. Your own `keryx mcp add` servers
(user scope) need none of this.

**Remote servers and their credentials.** A `url` server is dialled over
streamable HTTP and is otherwise identical to a local one: same catalog,
same `search_tool`/`use_tool`, same approval gate, same result cap, same
trust rule for project scope.

Credentials come from the environment, two ways:

```bash
keryx mcp add linear --transport http https://mcp.linear.app/mcp \
  --header 'Authorization: Bearer ${LINEAR_TOKEN}'

# or, equivalently
keryx mcp add linear --transport http https://mcp.linear.app/mcp \
  --header 'X-Whatever: v'   # plus, in the config file: "bearer_token_env_var": "LINEAR_TOKEN"
```

If the variable is **unset**, keryx does not dial. It does not send
`Bearer ` and let the server reject it — a hollow credential produces a 401
that reads as the server being broken, and on a server that treats an empty
bearer as anonymous it may be accepted as the wrong identity. Instead:

```
$ keryx mcp doctor linear
linear [user] http: needs_auth — header "Authorization" needs LINEAR_TOKEN, which is unset
  unset: Authorization
```

An explicit `Authorization` header wins over `bearer_token_env_var` if you
somehow write both.

**Servers that need a login: `keryx mcp auth`.** A remote server that has no
header and no `bearer_token_env_var` may want OAuth instead. One command:

```
$ keryx mcp auth linear
Opening your browser to authorise "linear"…
Authorised "linear" — stored credential, valid for about 60 more minute(s).
Stored owner-only in /home/you/.config/keryx/mcp-credentials.json.
```

Four things about it are deliberate:

| | |
|---|---|
| **Only this command opens a browser.** | Starting `keryx shell` never does. A session that launched a consent screen you did not ask for, or blocked on a headless box waiting for a click nobody will make, are both worse than a refusal that names the command. |
| **It exits non-zero without a terminal.** | In CI or over a pipe it refuses immediately rather than hanging for five minutes. |
| **Tokens live in one file.** | `mcp-credentials.json`, owner-only (0600), keyed by server name **and** URL — repointing a server at a different host does not send it the credential issued to the first one. Nothing is written to `mcp-servers.json`, and no command prints a token. |
| **The callback is loopback-only.** | `127.0.0.1` on an ephemeral port, `state` validated, one request served, then closed. |

`doctor` reports a server that needs this as `needs_auth` and names the
command — including when a stored credential has expired beyond refresh or
the authorisation server has revoked it:

```
$ keryx mcp doctor linear
linear [user] http: needs_auth — no stored credential; run `keryx mcp auth linear`
```

If the server has a header or a `bearer_token_env_var`, `keryx mcp auth`
says so and changes nothing: it would be starting a flow that cannot help.

Optional, in the config entry:

| Field | Effect |
|---|---|
| `"oauth": {"clientId": "…"}` | Use a client you registered yourself; keryx then registers none dynamically. |
| `"oauth": {"scopes": ["read"]}` | Request specific scopes at registration. Without it you get whatever the server issues by default. |
| `"oauth": {"callbackPort": 8765}` | A fixed loopback port, for an authorisation server that pre-registered one exact redirect URI. Ephemeral otherwise, so two flows cannot collide. |
| `"oauth": false` | This server is public; never diagnose it as needing a login. |

`keryx mcp logout <name>` forgets the stored credential. Re-running
`keryx mcp auth` does **not** repair a revoked refresh token — the
authorisation server rejects it before any browser opens — so forgetting
it first is the way back.

**Three things keryx refuses on purpose.** Each of these is a working
configuration elsewhere and a refusal here, so `doctor` names it rather
than reporting a generic failure:

| Refused | Why |
|---|---|
| A **redirect** (`3xx`) | `fetch` follows up to twenty hops and only strips `Authorization` across origins — a custom credential header, which is the common MCP pattern, follows all the way. Configure the final URL. |
| A **username or password in the URL** (`https://user:pw@host/mcp`) | It appears in every message that names the URL, and the HTTP client drops it anyway: you would get the secret on screen and an unauthenticated connection. Put it in a header or `bearer_token_env_var`. |
| An **unset `${VAR}` in the `url`** | `https://api.example/${TENANT}/mcp` with `TENANT` unset is a *valid* URL addressing the wrong path, which otherwise reports as "nothing is listening" and sends you to check a server that is fine. |

**What `doctor` tells apart.** For a remote server, "failed" is not one
thing: nothing listening, a host that does not resolve, a rejected TLS
certificate (including the self-signed one a corporate TLS-intercepting
proxy presents), an HTTP error by status, credentials the server refused, a
handshake that never completed, a redirect, and a URL that serves a web
page rather than MCP each get their own message. `doctor` exits non-zero whenever something needs
you — including a server awaiting `trust` or a variable you have not set.

**In a session: `/mcp`.** Inside `keryx shell`, `/mcp` lists the servers
keryx is connected to — status, tool count, why a failed one failed, and
the exact `keryx mcp trust <name>` a held one is waiting for. It reads the
session's live state and never dials anything itself, so opening it is
free.

Do not confuse it with `/integrate`, which is the opposite direction:
that is where keryx ITSELF is registered into an editor's MCP config. (The
CLI `integrations` verb, one letter different, is a separate command: it
installs Keryx's own hooks/instructions into another coding agent, not MCP
wiring.)
`/mcp` meant the installer before this release and now means the
consumer, matching what `keryx mcp` has meant on the command line since
the rename.

**Approval of tool calls.** Every `use_tool` call goes through the same approval gate as
`shell_exec` and `apply_patch`. Under `--trust` a call still asks, and with no
approver present (headless) it is denied rather than allowed. A server's own
"this tool is read-only" annotation is shown to the model as a hint and is
never allowed to skip the prompt.

The prompt for an MCP call names the **server** and the **tool** on their
own lines, above the arguments, and never offers "always allow". Both are
deliberate: a tool call's arguments are written by the model, so nothing
in them may be able to push the tool's identity out of view, and an
"always" grant would store a pattern the model chose in your permission
file.

**Environment.** A server is spawned with your environment minus two things,
stripped independently and for independent reasons — the same strip, built
once in `buildMcpChildEnv` and used by every surface that launches an MCP
server (`keryx shell`, `keryx mcp doctor`, and an ACP client's own servers
under `keryx acp`; see "MCP servers from the client" above):

- **Anything credential-SHAPED**, by name or by value: provider keys
  (`ANTHROPIC_*`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …), forge and cloud
  tokens (`GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*`), agent sockets
  (`SSH_AUTH_SOCK`), credential-file pointers (`NETRC`, `KUBECONFIG`, …), the
  whole `KERYX_*` namespace, any variable whose name says it holds a token,
  key, password or credential, and any value shaped like
  `scheme://user:pass@host` wherever it turns up.
- **Every variable your saved config (`auth.json`) declares**, removed by the
  exact NAME it is saved under — whatever that name is. This catches what
  the shape rule cannot: the "add custom provider" wizard saves an API key
  under whatever env-var name it is given, which may carry none of
  KEY/TOKEN/SECRET (`MY_LLM_GATEWAY`, say). That name would otherwise reach
  every server you launch, indistinguishable from a variable you exported
  yourself — and it holds whether or not THIS run has actually loaded the
  key into its own process yet: `keryx mcp doctor` and `keryx shell --print`/
  `--no-tui`/non-TTY never call the function that would, but the strip reads
  the same saved names straight off disk, so it applies there too, not only
  on a path that happened to load them first.

A server that genuinely needs one of these takes it explicitly — `-e` for a
stdio server, its own `env` entry either way — which is a decision you made
rather than a default you inherited; an explicit entry always wins over both
strips, even for a name your saved config declares. Its stderr is captured,
not inherited, so it cannot write to your terminal.

```
$ keryx mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/notes
Added "fs" to /home/you/.local/share/keryx/mcp-servers.json (created).
Run `keryx mcp doctor fs` to check it connects.

$ keryx mcp doctor fs
fs [user] stdio: connected
  file: /home/you/.local/share/keryx/mcp-servers.json
  tools: 14
```

Not yet in this release: OAuth, importing servers you already configured in
Cursor/Claude/`.mcp.json`, and a TUI view. See
`docs/requirements/keryx-mcp-servers/`.

Tool and resource exposure is filtered by the manifest's `expose.modules` list — a
disabled module is hidden from `tools/list` and `resources/list`.

Unlike every other opt-in command, `mcp serve` **hard-fails** (prints an actionable
message and exits `1`) when the optional `@modelcontextprotocol/sdk` dependency is
not installed — this is the one sanctioned exception to graceful degradation. An
unknown subcommand prints an error and exits `1`.

SAC tools registered in `src/mcp/tools.ts` (`sac.overview`, `sac.read`,
`sac.collaboration`, `sac.propose`, `sac.review`) refuse HTTP with
`{ code: "sac_transport_denied" }` before workspace discovery. See
[Shared Agent Context](./guides/shared-agent-context.md).

Slate tools, registered in the same file, are the external hand onto the
task-local scratchpad keryx's own shell/TUI/`harness run` already keep:
`slate.open`, `slate.writeSeed` and `slate.close`. All three mutate, all three
are `externalSessionId`-scoped and never reachable through a different id, and
all three refuse HTTP with `{ code: "slate_transport_denied" }` before storage
is touched — the same local-stdio-only boundary as `sac.*`. A closed slate with
a bound workspace dispatches its Seeds into the ordinary SAC propose/review
pipeline, so the human `confirm-review` gate above still stands between an
external Seed and real project knowledge; a slate that never bound loses
nothing, and surfaces at the next `keryx workspace catch-up` as an
`unbound-candidate`. There is no CLI verb — the surface is these three tools
only. See [Slate for external agents](./guides/slate.md).

---

## retention

Bounds stores that grow with every routed command or refused write and that
nothing else prunes: `.metaproject/data/gdctx/raw` and `artifacts` (one file
per `keryx ctx rg`/`ctx read`/`ctx run` invocation — see [`ctx`](#ctx)), and
the per-refused-write conflict sidecars each SAC owner writer leaves under
`.metaproject/workspaces/<id>/<owner>-write-conflicts/` when a proposal's base
version no longer matches the target (see [`workspace`](#workspace) `review`).
Neither store had any retention logic before this command shipped, and gdctx's
was measured at over 300 MiB and growing across two flow reports taken hours
apart.

```
keryx retention status [--json]
keryx retention sweep [--apply] [--target <id>]... [--max-age-days <n>] [--max-bytes <n>] [--json]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | `--json` | Read-only inventory: for each target, its directory, entry count, bytes on disk, and what the policy would remove right now. Touches nothing. |
| `sweep` | `--apply`, `--target <id>` (repeatable), `--max-age-days <n>`, `--max-bytes <n>`, `--json` | Applies the retention policy. **Dry run by default** — without `--apply`, nothing is removed and the report shows exactly what would go. `--target` restricts the run to one or more target ids from `status`. `--max-age-days`/`--max-bytes` override every target's own cap uniformly for this run only. |

**Policy.** Two axes, oldest-first, the same shape the [wiki freshness
queue](#wiki) already caps a single growing file by (lines + bytes) — adapted
here for a directory of many small immutable files instead of one log:

- **Age** is primary. gdctx raw logs and artifacts are the evidence behind
  routed-search summaries an agent may still want to open, so retention
  trades recoverability against size deliberately: 14 days by default for
  gdctx, 30 days for owner write-conflict sidecars (an actual refused write an
  operator may want to reconcile, not routine search chatter).
- **Total bytes** is the backstop, applied only after the age cutoff, evicting
  the oldest remaining entries until the target is back under its cap. Age
  alone does not bound a burst — a single day of heavy `ctx rg` use can add
  gigabytes inside the age window regardless of how old anything else is.
  Defaults: 200 MiB for `gdctx-raw`, 50 MiB for `gdctx-artifacts`, 20 MiB per
  discovered `owner-write-conflicts` directory.

Entry count is deliberately not its own axis — for these stores it never fires
before the byte cap already would.

**Unreachable stores.** A target directory that cannot be listed, an entry
that cannot be sized, or an entry that cannot be removed marks that target
`incomplete` with the specific reason — never folded into a clean success. A
problem discovering targets at all (e.g. `.metaproject/workspaces/` itself
unreadable) is reported separately as a discovery issue and also folds the
whole report to `incomplete`, since a target that was never found is not the
same thing as a target with nothing in it. Either way the command then exits
`1`.

**Scope.** This sweeps the local stores named above only. Content already
relayed to an agent, copies exported elsewhere, and git history are out of
scope and are never touched or promised erased by it — this command bounds
size, it does not implement AC-29's tombstone/forget semantics.

---

## forgetting

Read the deletion trail at `.metaproject/data/forgetting/journal.jsonl` — what
was removed, when, at whose request, and on what basis. Read-only; this command
never writes to the trail. `keryx sync --apply` is the only thing that appends
to it.

```bash
keryx forgetting trail [--limit <n>] [--json]
keryx forgetting lookup "<ref-or-path>" [--layer <layer>] [--search] [--json]
```

`trail` prints the records newest first, with the coverage measured from the
file itself: how many records exist, which layers have ever had a removal
recorded, and which layers every record names as untouched.

`lookup` answers one identity. By default the match is exact on a removal's
`ref` or `page` — there is no fuzzy fallback, because a lookup that silently
answers with an adjacent record is worse than one that says it has none.
`--search` is the separate phrase-matching mode (over `ref`, `page` and
`title`); every hit reports which field matched and which layer it came from.
`--layer` narrows an identity lookup to one knowledge layer.

**Verdicts.**

| Verdict | Meaning | Exit |
|---|---|---|
| `recorded-removed` | the trail names this as removed, with when/who/why | 0 |
| `no-removal-recorded` | the trail was read and names no removal of it | 0 |
| `trail-absent` | nothing has ever been appended to the trail here | 0 |
| `trail-unreadable` | the trail exists and could not be read — removed and never-recorded cannot be told apart | 2 |

**The bound on a negative answer.** The trail records removals a reconcile
*observed*. An entry deleted with `rm` and never reconciled leaves no record, and
neither does any layer the reconcile does not write for. So
`no-removal-recorded` means exactly "nothing here records a removal" and never
"this never existed"; every rendering of it carries that caveat plus the
coverage that bounds it.

**Who else reads this trail.** `keryx memory search` (when a search returns
nothing), `keryx wiki check-links` (for each broken link) and `keryx gdgraph
affected` (for a target that is not a node) all consult the same module, so the
trail is read whether or not this verb is typed.

---

## workspace

Shared Agent Context operator surface. Thin argv adapter over `src/sac/`
(`src/commands/workspace.ts`). JSON on stdout; `--explain` human text on
stderr. Actor is always the local OS user — there is no `--actor`. Full help:
`keryx workspace --help`. **`keryx commands` omits this verb.**

```
keryx workspace create --title <title> [--component <workspace-relative-ref>]
keryx workspace list [--include-archived]
keryx workspace show <workspace-id>
keryx workspace add-resource <workspace-id> --kind <kind> --uri <workspace-relative-ref> [--revision <revision>]
keryx workspace remove-resource <workspace-id> --uri <workspace-relative-ref>
keryx workspace rename <workspace-id> --title <title>
keryx workspace archive <workspace-id>
keryx workspace overview <workspace-id> [--max-items N] [--max-tokens N] [--explain]
keryx workspace read <workspace-id> <item-id> [--max-items N] [--max-tokens N] [--explain]
keryx workspace propose <workspace-id> --kind <decision|wiki-update|memory-entry|follow-up|contract-change|risk> --session <session-id> [--note <one-line>]
keryx workspace list-proposals [<workspace-id>]
keryx workspace review <workspace-id> <proposal-id> --decision <accepted|rejected|dismissed> [--reason <reason>] [--idempotency-key <key>] [--confirm-token <token>]
keryx workspace confirm-review <workspace-id> <proposal-id> [--acknowledge-security]
keryx workspace catch-up [--workspace <workspace-id>] [--json] [--include-lifecycle-flags]
keryx workspace dismiss-candidate <evidence-path|session-id> [--reason <reason>] [--evidence <path>]
keryx workspace handoff <workspace-id> --to <subject> --artifact <ref>
keryx workspace collaboration <workspace-id>
keryx workspace policy-readiness
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `create` | `--title`, `--component` | Create `.metaproject/workspaces/<id>/workspace.json`. |
| `list` | `--include-archived` | List workspaces visible to the local actor. Archived ones are hidden unless asked for. |
| `show` | `<workspace-id>` | Print the manifest. |
| `add-resource` | `--kind`, `--uri`, `--revision` | Attach a workspace-relative typed ref. |
| `remove-resource` | `<workspace-id>`, `--uri` | Detach a resource by its ref. |
| `rename` | `<workspace-id>`, `--title` | Change the workspace title. |
| `archive` | `<workspace-id>` | Archive a workspace. `list` hides archived ones unless `--include-archived` is passed. |
| `overview` | `--max-items` (default 32), `--max-tokens` (default 4096), `--explain` | Bounded FWK overview + access receipt. Mandatory overflow → `context_overflow` and no receipt. |
| `read` | `<item-id>`, `--max-items` (default 1), `--max-tokens` (default 4096), `--explain` | Progressive read of one overview item. |
| `propose` | `--kind`, `--session`, `--note` | Immutable `proposed` record from a completed session wrap-up. |
| `review` | `--decision`, `--reason`, `--idempotency-key`, `--confirm-token` | Terminal review. `accepted` goes through real wiki/memory/skill owner writers and requires `--confirm-token`, minted only by `confirm-review`. Same idempotency key replays. A `wiki-update`/`memory-entry` accept also returns a dedup/conflict hint (duplicates/conflicts against already-accepted entries) and, when non-empty, an optional model-judge annotation — both informational only. |
| `list-proposals` | `[<workspace-id>]` | List proposals — for one workspace, or across all of them when the id is omitted. |
| `confirm-review` | `<workspace-id>`, `<proposal-id>`, `--acknowledge-security` | Mint the `--confirm-token` a `review --decision accepted` call needs. Run this yourself in a real, approval-gated shell — no tool call (MCP or `keryx-shell`) can mint one. **When the proposal's security gate is `needs-approval`, it prints what the scan found and in which evidence, and then refuses unless `--acknowledge-security` is passed** — the flag is the record that a human read the findings, and the token carries that fact to `review`. A clean proposal claims no acknowledgement; a proposal whose gate cannot be read is refused rather than assumed to have passed. Before 0.2.75 the flag did not exist and a `needs-approval` proposal could not be accepted by any route; 0.2.74 briefly passed the acknowledgement unconditionally, which made the gate unfirable. |
| `dismiss-candidate` | `<evidence-path\|session-id>`, `--reason`, `--evidence` | Dismiss an `unbound-candidate` that `catch-up` surfaced — a wrap-up whose session never bound to a workspace. Takes either the evidence path directly or a session id, which resolves to that session's newest slate archive. |
| `catch-up` | `--workspace`, `--json`, `--include-lifecycle-flags` (default on) | Pull-based `cwd`-scoped digest: pending proposals, blocked runs, unbound-candidate wrap-ups, sessions of unknown fate, and a lifecycle-flags section for any workspace/memory-entry/wiki-decision whose recorded module no longer resolves in the code graph. Report-only — never writes. |
| `handoff` | `<workspace-id>`, `--to`, `--artifact` | Record that work moved to another participant. The recorded `from` is always the subject the authorization server resolved for the caller — there is no flag that sets it (`--from` is refused by name), so `handoff.from` can never be a string a caller typed; a payload missing `to` or `artifact` is refused rather than written empty. |
| `collaboration` | `<workspace-id>` | Read-only collaboration overview: references, plus the handoffs `handoff` recorded. An empty `activity` means none were recorded — before `handoff` existed it meant none could be. |
| `policy-readiness` | — | Diagnose the opt-in policy-experiment chain. Exit `1` when `!integrityReady`. |

Unknown options are rejected. Propose/review use
`createHarnessProposalLifecycleService` (real owner writers). There is no
session↔workspace auto-bind — except in `keryx shell`/TUI/`harness run`,
where an action-intent turn resolves-or-creates one automatically by agent
judgment (`/goal <text> [--workspace <id>] [--auto [N]]`, or `harness run
--goal ... [--workspace <id>]`); a completed attempt dispatches its own
wrap-up proposal without a manual `propose` call. Operator guides:
[Shared Agent Context](./guides/shared-agent-context.md),
[`/goal`](./guides/goal.md).
