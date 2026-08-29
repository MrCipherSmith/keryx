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
| `shell` | Start the interactive TUI agent shell (sessions are per-project). |
| `version` | Check whether the installed Keryx version has a newer npm release. |
| `sessions` | List, fork, export, or locate agent sessions for the current project. |
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

## shell

Start the interactive agent shell. This is the TUI agent harness; bare `keryx`
prints CLI usage and does **not** start it. Sessions are per-project.

```
keryx shell [-c|--continue] [-r|--resume [id]] [--provider <p>] [--model <m>]
            [--base-url <url>] [--agent|--chat] [--tui|--no-tui]
```

| Flag | Description |
|---|---|
| _(default)_ | Full-screen OpenTUI renderer plus the agent, whenever `stdout` is a TTY. |
| `-c`, `--continue` | Resume the most recent session for this project. |
| `-r`, `--resume [id]` | Resume a specific session; without an id, pick one interactively. |
| `--provider <p>`, `--model <m>` | Skip the provider/model picker. |
| `--base-url <url>` | Point the provider at a custom endpoint. |
| `--agent` / `--chat` | Agent mode with tools, or chat without them. |
| `--tui` / `--no-tui` | Force the full-screen renderer, or fall back to the line-based readline shell. |

The renderer falls back to readline gracefully when the TUI cannot start, and
off a TTY the shell is non-interactive by default.

---

## sessions

Inspect the append-only agent sessions recorded for the current project.

```
keryx sessions list | fork <id> | export <id> | path
```

| Subcommand | Description |
|---|---|
| `list` | Print the sessions recorded for this project, newest first. Forks are marked `↳`. |
| `fork <id>` | Branch a session: a new session with the same history and `parentSessionId` set to the original. `--title "<t>"` names it, `--json` prints the result as JSON. Writing to the fork never touches its source. |
| `export <id>` | Emit one session in full, for archiving or review. |
| `path` | Print the directory sessions are stored under. |

`session` is accepted as a singular alias. Sessions are per-project — isolated by
git root, or by absolute cwd outside a repository — so `list` never shows another
project's work. The [harness page](./harness.md#sessions) covers what a session
holds and what forking copies.

## shell behavior

### Interactive behavior

- `/help` lists every slash command available in the current mode
  (`agent` vs `chat`). The registry is `AGENT_SLASH_COMMANDS`.
- `/status` (chat and agent) opens a read-only inspector. The TUI modal
  always has **Status** and **Context** (last-turn tokens plus a labelled
  estimate — never a guessed window). **Workspaces** and **Flow** tabs
  appear only when the session actually referenced a SAC workspace or a
  flow (`runLink.sessionId` or an explicit `flow 154` / `/flows 154`
  mention). `c` copies the session id. Readline / `--no-tui` prints the
  same rows. `/session-info` and `/info` are **not** aliases.
- `/flows` lists project flows, newest first (highest id, then `updatedAt`).
  In the TUI, the List tab uses `↑/↓` to move the selection; Enter or `→`
  opens Detail. On Detail, `↑/↓` scroll the body instead — `[`/`]` (or
  `p`/`n`) switch to the adjacent flow. `/flows 154` (id, padded id, or slug)
  opens one package directly. Readline prints the list, or one package when
  given an argument. `/status` and `/flows` remain usable even while the main
  turn is busy.
- `/sessions` opens an interactive session picker in the TUI and switches the
  live shell to the chosen session.
- `/theme` (chat and agent) with no argument opens a picker modal: a theme
  list on the left, a live preview (assistant markdown, a code block, tool/
  side/chip/ok/error samples) on the right. Arrow keys move the highlight and
  repaint the preview instantly; the palette itself only applies on Enter or
  a click on `[ Apply ]` — Esc/close leaves the current theme untouched.
  `/theme <name>` still applies immediately without opening the picker.
  Readline / `--no-tui` supports only the immediate-apply form.
- `/search-provider` configures and tests web search providers for `web_search`:
  run with no arguments to open a 3-step interactive wizard (select provider →
  enter fields/credential/active-toggle → test connection); pass `provider id`
  plus `key=<value>` (for keyed providers) to configure and validate one
  directly, unchanged.
- `/search-connect` selects which configured and tested web search provider is
  active: run with no arguments to open a picker over already-connected
  providers, or pass an ID to switch directly, unchanged.
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
writes this file for you (name → URL → key → models). A custom name colliding
with a built-in provider is rejected. Custom providers may target private LAN
hosts (RFC1918/CGNAT) — an explicit opt-in that built-in providers never get;
loopback and link-local metadata addresses stay denied regardless.

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
| `--no-gdgraph-hook` | gdgraph post-commit hook. |
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
and blocks the push only in `enforced`/`ci` mode; it coexists with the testing
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
| `--apply` | Rebuild each stale artifact incrementally and record the new provenance. An artifact with no provenance yet is built as a baseline. |
| `install-hooks` | Install `post-merge` and `post-checkout` git hooks that run the advisory report. Prints that nothing was installed when there is no `.git`. |
| `uninstall-hooks` | Remove them. |
| `--help`, `-h` | Print `sync` usage and exit. |

Outside a git repository the command reports that there is nothing to sync and
returns. When `--apply` updates the wiki and files were deleted, orphaned pages
are pruned; a human-owned page whose module disappeared is reported rather than
deleted.

---

## commands

The agent-facing command registry: every keryx command as a machine-readable
descriptor, with the natural-language intents that resolve to it. This is the
surface `.metaproject/index.md` points an agent at so it can pick the right
command from a phrase instead of guessing, and it is the source of truth the
curated intent table in that file is derived from.

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
| `build` | — | Scan the tree, build the graph, write JSONL storage + `summary.md`/`module-map.json`, print node/edge counts. |
| `query cycles` | — | Print dependency cycles (`a -> b -> a`), or "No cycles found." |
| `query orphans` | — | Print modules with no resolved inbound or outbound edges. |
| `find "<terms>"` | — | Rank file paths and available symbols by concept/name match. Directs content searches to `ctx rg`. |
| `symbol "<name>"` | `--impact`, `--depth <N>` | Print exact definitions, callers, callees, and wiki pages that document the defining files. Loose matches across different symbol names require disambiguation. `--impact` adds transitive callers (default depth `3`). |
| `symbols` | `enable`, `disable`, or `status` | Toggle the tree-sitter capability in the manifest or report capability/symbol/call counts. Enabling is explicit and never downloads assets implicitly. |
| `path "<A>" "<B>"` | — | Resolve file or symbol endpoints and print the shortest path across import and call edges. |
| `affected <file-or-symbol>` | `--depth <N>`, `--ranked`, `--json` | Resolve a file or symbol, print dependencies/dependents, and optionally walk/rank the transitive blast radius. |
| `repomap` | `--budget <N>`, `--seed <path>...`, `--changed` | Write a token-budgeted repo map artifact. `--budget` caps the token estimate, `--seed` biases toward one or more paths (repeatable), and `--changed` seeds from locally changed files (`git diff --name-only HEAD`). |
| `context` | — | Emit the bounded graph portion of the turn-start orientation block. |
| `assets list \| verify [<id>] \| pull <id>` | — | Manage declared assets from `assets.lock.json`: `list` shows resolved/missing state, `verify` checks checksums (exit `1` on mismatch), `pull` fetches and verifies one asset (the only networked verb). |

Only the exact queries `cycles` and `orphans` are accepted; anything else exits
`1`. `affected` with no file argument prints usage and exits `1`.

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
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | — | Show enabled state, root, total pages, per-type counts, last index/link-check state. |
| `new` | `<type> <slug>`, `--title "<t>"`, `--force` | Scaffold a page from template. Refuses to overwrite unless `--force`. |
| `collect` | `--force`, `--changed`, `--since <ref>`, `--limit <n>` | Generate a hierarchical, full-coverage draft scaffold from graph/health/testing data, rebuild the index, and report the remaining draft-enrichment work front. `--changed` can scope collection to changes since a ref. |
| `index` | — | Rebuild the managed page-index block in `wiki/index.md`. |
| `check-links` | — | Validate internal Markdown links; write a report. Exits `1` if any broken. |
| `validate` | — | Metadata + link + index-staleness checks (superset of `check-links`). Exits `1` on issues. |
| `ask "<question>"` | `--k <n>`, `--rerank` | Answer a question from the local wiki with a deterministic, citation-backed retrieval pass over the pages. `--k` caps the number of retrieved passages; `--rerank` applies the extra reranking step. |
| `enrich [<page>]` | `--all`, `--force`, `--list`, `--resume`, `--limit <n>`, `--concurrency <n>`, `--provider <p>`, `--model <m>`, `--dry-run`, `--json` | **Needs a model credential.** Fill draft pages with model-written prose; defaults to drafts only, validates, and marks pages accepted. Supports optional RLM mode via `.metaproject/wiki.config.json` (set `rlm.enabled: true`): classifies pages as skip/light/deep based on staleness and graph metrics; deep pages receive a graph-aware model call; batching and staleness-skipping apply automatically; budget-exhausted pages fall back to the template. The exception among the model commands: without a credential it exits `0` and marks the affected pages skipped rather than failing. |
| `context` | — | Emit the bounded wiki-index portion of the turn-start orientation block. |
| `backlinks <target>` | — | For a wiki page or code file, print wiki pages linking to the target and graph dependents when the target is a graphed code file. |

Page types: `architecture`, `domain-model`, `business-rule`, `user-scenario`,
`component`, `service`, `integration`, `decision`.

When the `security` module is enabled, `collect` runs an advisory security check
before writing each draft. Advisory (the default) reports and writes anyway;
`enforced`/`ci` mode can suppress a draft's write with a masked reason.

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
keryx skills create <target> --module <module> --name <skill-name>
keryx skills verify <skill-or-target>
keryx skills learn --from-review <path> --skill <module>/<skill>
keryx skills learn apply <proposal.json>
keryx skills export <project-skill> --runtime codex|claude|plugin
keryx skills sync --runtime codex|claude --target <dir>
keryx skills contracts validate <file> --schema <name>
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | `--json` | Print the local gdskills install status summary. |
| `list` | `--json` | List registered project skills as a table. |
| `inspect <project-skill>` | `--json` | Inspect one project skill: metadata + file presence. Missing target exits `1`. |
| `route <query-or-target>` | `--json` | Score/rank registry entries against a free-text query or path. |
| `catalog` | `--profile minimal\|recommended\|full\|custom` | Print the bundled catalog for a profile. |
| `install` | `--profile <profile>` | Install bundled skills, catalog, manifest, and contracts. Requires `.metaproject/`. |
| `create <target>` | `--module <m>`, `--name <n>`, `--format auto\|single\|package`, `--dry-run` | Create and register a project-skill package. (`generate` is an alias.) |
| `verify <skill-or-target>` | `--dry-run`, `--json` | Verify a project skill against evidence; write a report. `--all` verifies every registered skill. |
| `learn --from-<source> <path> --skill <m>/<s>` | `--from-review\|--from-test\|--from-failure\|--from-health\|--from-memory <path>`, `--skill`, `--dry-run`, `--json` | Create an auditable learning proposal (does not mutate SKILL.md). |
| `learn apply <proposal.json>` | `--dry-run`, `--json` | Apply a reviewed proposal to SKILL.md + changelog; bump patch version. |
| `export <project-skill>` | `--runtime codex\|claude\|plugin`, `--dry-run`, `--json` | Export a project skill to a runtime artifact. The `plugin` runtime (alongside `codex` and `claude`) emits a Claude Code plugin package. |
| `sync` | `--runtime codex\|claude`, `--target <dir>`, `--dry-run`, `--json` | Sync exported runtime skills to an explicit target dir. Requires both `--runtime` and `--target`. |
| `contracts list` | — | Print name/path/description for all contract schemas. |
| `contracts validate <file>` | `--schema <name>` | Validate a JSON file against a named contract schema. Exits `1` on failure. |

Profiles: `minimal`, `recommended` (default), `full`, `custom`. Contract schemas:
`subagent-result`, `subagent-dispatch`, `agent-event`, `orchestrator-state`,
`review-finding`.

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
writes the log; `enforced`/`ci` mode can suppress raw-log persistence with a masked
reason (the run itself is never broken).

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

Entry types: `lesson`, `decision`, `constraint`, `known-mistake`,
`historical-context`, `pattern`, `task-note`, `review-note`, `incident`,
`migration-note`, `integration-note`.

When the `security` module is enabled, `ingest` runs an advisory security check
before writing each accepted entry. Advisory (the default) reports and writes;
`enforced`/`ci` mode can skip an entry's write with a masked reason.

---

## flow

Agent-first work lifecycle ("Task Manager"; manifest module id `tasks`). Each unit
of work is a self-contained package under `.metaproject/flows/`, driven through a
strict status state machine with hard completion gates. The CLI is the sole writer
of flow state.

```
keryx flow init (--issue <url> | --title "<t>") [--slug <s>]
keryx flow list
keryx flow status <id>
keryx flow freeze <id>
keryx flow plan <id> [--provider <p>] [--json]
keryx flow start <id>
keryx flow task add <id> --title "<t>" [--kind <k>]
keryx flow task done <id> <taskId>
keryx flow ac confirm <id> <ACn> [--note "<evidence>"]
keryx flow ac update <id> --reason "<why>"
keryx flow implemented <id> --pr <url>
keryx flow complete <id> [--comment]
keryx flow block <id> --reason "<why>"
keryx flow unblock <id>
keryx flow check
keryx flow renumber <dir> --to <id> --reason "<why>"
keryx flow schema [--out <path>]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `init` | `--issue <url>` \| `--title "<t>"`, `--slug <s>` | Scaffold a flow package. Requires a title or issue URL. |
| `list` | — | List all flows with status + task counts. |
| `status <id>` | — | Print one flow: status, source, AC state, PR, tasks, recent history. |
| `freeze <id>` | — | Record the AC checksum; transition `initializing → ready`. |
| `plan <id>` | `--provider <p>`, `--json` | **Needs a model credential.** Break the flow's frozen acceptance criteria into a proposed task breakdown. Exits `1` without a credential. |
| `start <id>` | — | Transition `ready → in-progress`. |
| `task add <id>` | `--title "<t>"` (required), `--kind context\|implement\|test\|review\|docs` | Append a task. |
| `task done <id> <taskId>` | — | Mark a task `done`. |
| `ac confirm <id> <ACn>` | `--note "<evidence>"` | Confirm one acceptance criterion. |
| `ac update <id>` | `--reason "<why>"` (required) | Re-freeze the AC checksum; void prior confirmations. |
| `implemented <id>` | `--pr <url>` (required) | Transition `in-progress → implemented`; record the draft PR. |
| `complete <id>` | `--comment` | Run completion gates; on pass `→ done` (optionally comment the issue), on fail `→ in-progress`. |
| `block <id>` | `--reason "<why>"` (required) | Transition any status `→ blocked`, saving the previous status. |
| `unblock <id>` | — | Restore the saved previous status. |
| `check` | — | Consistency audit across all flows. |
| `renumber <dir>` | `--to <id>` (required), `--reason "<why>"` (required) | Repair a duplicate flow id. |
| `schema` | `--out <path>` | Emit the flow JSON schema. |

Statuses: `initializing`, `ready`, `in-progress`, `implemented`, `completing`,
`done`, `blocked`. `task` and `ac` are command groups — the atomic verbs are
`task add`, `task done`, `ac confirm`, `ac update`.

When the `security` module is enabled, `complete` adds a `security` completion
gate. Advisory (the default) makes it informational (`pass`, never blocks);
`enforced`/`ci` mode can fail the gate and hold the flow in `in-progress`. The gate
is omitted entirely when the module is disabled.

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

Two unrelated surfaces share this noun: `bootstrap` manages global instruction
files for coding agents, and `external` inspects the vendor CLIs keryx can host
as child agents.

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

Runtime ids: `claude` (`~/.claude/CLAUDE.md`), `opencode`
(`~/.config/opencode/AGENTS.md`), `zcode` (`~/.zcode/AGENTS.md`), `codex`
(`~/.codex/AGENTS.md`), `antigravity`
(`~/.config/antigravity/AGENTS.md`; alias `antigravuty`), or `all`.

### agents external

Inspect the registry of vendor coding CLIs keryx can host as read-only child
agents. Both subcommands are read-only and neither spends subscription quota: the
only process either starts is the registry entry's own `--version`.

```
keryx agents external list [--json] [--no-probe]
keryx agents external probe <id> [--json]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `list` | `--json`, `--no-probe` | Print every registered agent with its detected availability, sandbox modes, and streaming/resume/cost facts, plus the capability gate's verdict. `--no-probe` skips detection entirely and reports every entry as `not probed`. |
| `probe` | `<id>`, `--json` | The same report for one agent id (`codex-cli`, `claude-cli`). An unknown id lists the known ones and exits `1`. |

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
keryx review attach --flow <id> --target <kind> --ref <ref> [--reviewers a,b] [--report <path>]
keryx review start --target <kind> --ref <ref> [--reviewers a,b] [--report <path>]
keryx review ingest --report <path> [--flow <id>] --ref <ref>
                    [--verifications <file|->] [--verification-mode off|annotate|filter]
                    [--scope <scope.json>]
keryx review status <review-id-or-path>
keryx review complete <review-id-or-path>
keryx review lightweight
keryx review scope [--ref <base>] [--diff <file|->] [--path a,b] [--context <n>] [--json|--scoped-diff] [--append <file>]
```

| Subcommand | Description |
|---|---|
| `attach` | Create a managed package linked to an existing Task Manager flow. |
| `start` | Create a standalone managed review package. |
| `ingest` | Convert an existing report into a managed package, optionally linked to a flow. |
| `status` | Print mode, status, target, flow link, and coverage count. |
| `complete` | Validate the package and mark it complete only when required artifacts exist. |
| `lightweight` | Confirm report-only mode; creates no managed artifacts. |
| `scope` | Build the bounded review scope deterministically. See below. |

Target kinds are validated by the runtime. Review packages are stored under the
linked flow when attached, or in the managed standalone review location selected
by the review service.

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
| `--append <file>` | Append the scope **and the drop list** to a review package's `scope.md`. |

**Every drop is recorded with its reason**, its granularity, and the lines it
covered. A scope that silently truncated would read as "we reviewed everything"
when it did not, which is the failure this command exists to make impossible.

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
| `--scope <scope.json>` | The `--json` output of `keryx review scope`, so the record carries what the pre-filter dropped too. |

Each claim is `{finding, verdict, method, evidence, verifier}` and nothing else.
`verdict` is `confirmed`, `refuted` or `unverifiable`; `method` is `execution`,
`site-check` or `reasoning`. Rules enforced in code, not by instruction:

- **A verdict reached by reasoning alone is capped at `unverifiable`.** It can
  never be `confirmed`, and it can never be `refuted` either — `refuted` is the
  only verdict that removes a finding, and giving it to the method that produces
  no new evidence would reinstate the pass that was just removed.
- **A finding is never verified by the reviewer that raised it.** A claim whose
  `verifier` equals the finding's `reviewer` is discarded.
- **Every rejection retains the finding.** A malformed, anonymous, duplicated or
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
on creation. Without `--scope`, the pre-filter half reads `not recorded` rather
than `0`: "dropped nothing" and "never ran" are different facts. State results as
these counts and never as a precision improvement; the pipeline has no precision
baseline to improve on.

---

## security

Policy-based scanning, redaction, guardrails, and audit reports for agent
input/output and `.metaproject/` artifacts. The engine is deterministic (rule +
entropy detectors, no model backend) and local-first: config lives at
`.metaproject/security.config.json`, data under `.metaproject/data/security/`,
and the local-only HMAC key under `data/security/raw/` (gitignored). This is
Phase 1+2+3 of the spec — the engine, the CLI below, and the write-seam
integrations (an advisory-by-default guard at `memory ingest`, `wiki collect`,
`test run`, `gdctx`, and `flow complete`) are shipped. Model/API backends and
gateway mode (Phase 4) are not implemented.

```
keryx security status
keryx security scan <path> [--json] [--source <kind>]
keryx security scan-mcp <manifest.json|dir> [--json] [--pin <manifest>] [--strict]
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
| `scan-mcp <manifest\|dir>` | `--json`, `--pin <manifest>`, `--strict` | Scan one MCP tool manifest (or every `*.json` under a directory, recursively) for MCP threats. Findings are leak-safe (category + policy id only). `--pin` records a rug-pull baseline instead of scanning; `--strict` exits `1` when any threat is found. Pure and network-free. |
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

**Exit behavior.** `scan`, `check-input`, and `check-output` honor the config
`mode`: in **advisory** mode (the default) they always exit `0` after reporting;
in **ci** mode they exit `1` on a gate **fail**; in **enforced** mode they exit
`1` on a gate **fail** or **needs-approval**. `report` exits `1` only under `ci`
mode when the aggregated gate is `fail`. `policy validate` exits `1` on schema or
checksum failure. `scan-mcp` exits `1` only with `--strict` when a threat is
found; `eval` exits `1` when any detector breaches its threshold; `hooks` exits
`1` on an unknown runtime or a post-install validation error. `status`, `redact`,
and `incidents` do not gate. An unknown subcommand prints an error and exits `1`.

---

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
keryx mcp serve [--cwd <project-root>]          # stdio JSON-RPC MCP server (default transport)
keryx mcp serve --http [--cwd <project-root>]   # isolated HTTP/SSE opt-in (localhost only)
keryx mcp                  # alias for `mcp serve`
keryx mcp install --runtime <cursor|claude|opencode|vscode|generic|all> [--dry-run]
keryx mcp uninstall --runtime <cursor|claude|opencode|vscode|generic|all>
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `serve` (default) | `--http`, `--cwd <project-root>` | Start the MCP server over stdio (the default). `--cwd` selects the project root whose `.metaproject/` workspace is exposed; this is what makes editor/client launches independent from their process cwd. `--http` switches to the isolated localhost-only HTTP/SSE transport, which additionally requires `http.enabled=true` in the module's manifest entry. Bare `mcp` is an alias for `mcp serve`. |
| `install` | `--runtime <cursor\|claude\|opencode\|vscode\|generic\|all>` (comma-separated; default `all`), `--dry-run` | Merge-safely wire this project into an editor/agent's MCP client config: `cursor` → `.cursor/mcp.json`, `claude` → `.mcp.json`, `opencode` → `opencode.json` (all project root), `vscode` → `.vscode/mcp.json`, `generic` prints a ready snippet and writes no file. `all` targets cursor + claude + opencode only — `vscode` is deliberately opt-in and must be named explicitly. `cursor`/`claude` add `mcpServers.keryx = { command: "keryx", args: ["mcp","serve","--cwd","<absolute-project-root>"] }`; `opencode`'s shape differs — `mcp.keryx = { type: "local", command: ["keryx","mcp","serve","--cwd","<absolute-project-root>"], enabled: true }`; `vscode`'s shape differs again — VS Code's native MCP config uses a top-level `servers` key (not `mcpServers`), each entry requiring `"type": "stdio"`: `servers.keryx = { type: "stdio", command: "keryx", args: ["mcp","serve","--cwd","<absolute-project-root>"] }`. Every runtime's entry is marked with a managed sentinel, preserving existing servers/keys and staying idempotent. Also sets `modules.mcp.enabled=true` in `metaproject.json` and probes the optional SDK (printing `bun add @modelcontextprotocol/sdk` when absent — it never auto-installs or opens a network connection). `--dry-run` prints the planned change and writes nothing. |
| `uninstall` | `--runtime <cursor\|claude\|opencode\|vscode\|generic\|all>` (default `all`) | Remove ONLY the managed `keryx` server (and its sentinel) from each runtime's client config, leaving other servers and user content intact. A no-op when nothing is installed. |

**codex CLI** is not a `--runtime` here — its client config is a single GLOBAL
`~/.codex/config.toml`, not a project-local file, and it already ships its own safe,
native installer for it: run `codex mcp add keryx -- keryx mcp serve --cwd
<project-root>` once (`codex mcp remove keryx` to undo). `modules.mcp.enabled=true`
still needs one `keryx mcp install --runtime <any>` run, since codex's own installer
has no notion of the keryx manifest. Headless codex needs `codex exec
--approve-for-me` — plain `codex exec` silently cancels MCP tool calls without it.

`init` also offers to enable the MCP server interactively (default **No**); the
`--mcp` / `--no-mcp` flags set it non-interactively (`opencode` is also offered as a
runtime choice at that prompt). The default non-interactive `init` never enables MCP
nor writes a client config.

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

---

## workspace

Shared Agent Context operator surface. Thin argv adapter over `src/sac/`
(`src/commands/workspace.ts`). JSON on stdout; `--explain` human text on
stderr. Actor is always the local OS user — there is no `--actor`. Full help:
`keryx workspace --help`. **`keryx commands` omits this verb.**

```
keryx workspace create --title <title> [--component <workspace-relative-ref>]
keryx workspace list
keryx workspace show <workspace-id>
keryx workspace add-resource <workspace-id> --kind <kind> --uri <workspace-relative-ref> [--revision <revision>]
keryx workspace overview <workspace-id> [--max-items N] [--max-tokens N] [--explain]
keryx workspace read <workspace-id> <item-id> [--max-items N] [--max-tokens N] [--explain]
keryx workspace propose <workspace-id> --kind <decision|wiki-update|memory-entry|follow-up|contract-change|risk> --session <session-id> [--note <one-line>]
keryx workspace review <workspace-id> <proposal-id> --decision <accepted|rejected|dismissed> [--reason <reason>] [--idempotency-key <key>] [--confirm-token <token>]
keryx workspace confirm-review <workspace-id> <proposal-id>
keryx workspace catch-up [--workspace <workspace-id>] [--json] [--include-lifecycle-flags]
keryx workspace collaboration <workspace-id>
keryx workspace policy-readiness
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `create` | `--title`, `--component` | Create `.metaproject/workspaces/<id>/workspace.json`. |
| `list` | — | List workspaces visible to the local actor. |
| `show` | `<workspace-id>` | Print the manifest. |
| `add-resource` | `--kind`, `--uri`, `--revision` | Attach a workspace-relative typed ref. |
| `overview` | `--max-items` (default 32), `--max-tokens` (default 4096), `--explain` | Bounded FWK overview + access receipt. Mandatory overflow → `context_overflow` and no receipt. |
| `read` | `<item-id>`, `--max-items` (default 1), `--max-tokens` (default 4096), `--explain` | Progressive read of one overview item. |
| `propose` | `--kind`, `--session`, `--note` | Immutable `proposed` record from a completed session wrap-up. |
| `review` | `--decision`, `--reason`, `--idempotency-key`, `--confirm-token` | Terminal review. `accepted` goes through real wiki/memory/skill owner writers and requires `--confirm-token`, minted only by `confirm-review`. Same idempotency key replays. A `wiki-update`/`memory-entry` accept also returns a dedup/conflict hint (duplicates/conflicts against already-accepted entries) and, when non-empty, an optional model-judge annotation — both informational only. |
| `confirm-review` | `<workspace-id>`, `<proposal-id>` | Mint the `--confirm-token` a `review --decision accepted` call needs. Run this yourself in a real, approval-gated shell — no tool call (MCP or `keryx-shell`) can mint one. |
| `catch-up` | `--workspace`, `--json`, `--include-lifecycle-flags` (default on) | Pull-based `cwd`-scoped digest: pending proposals, blocked runs, unbound-candidate wrap-ups, sessions of unknown fate, and a lifecycle-flags section for any workspace/memory-entry/wiki-decision whose recorded module no longer resolves in the code graph. Report-only — never writes. |
| `collaboration` | `<workspace-id>` | Read-only collaboration overview. No public `record` writer. |
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
