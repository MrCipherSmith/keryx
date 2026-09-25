# Onboarding

Welcome to **keryx** — a CLI-first toolkit (Bun/TypeScript) that installs and maintains a local `.metaproject/` workspace inside any codebase. That workspace is a file-based "agent operating system": durable Markdown + JSON artifacts (a code graph, a knowledge wiki, health scores, test reports, memory, and agent skills) that let AI agents and developers share the same structured project context. Everything is local-first and offline — no server, no database, and external tools (git, gh, eslint, tsc) are optional and degrade gracefully.

The public command is `keryx`. This guide gets you from zero to a running workspace.

## Requirements

Which of these you need depends on how you install — see the table below. In
the common case (`npm install -g`) it is `bun >= 1.3.14`, plus `git` for hooks
and `--changed` scopes.

- `git` — required for git hooks, `--changed` scopes and the managed installer; the core runs without it
- `bun` (>= 1.3.14) — required for every path except the standalone binary; see [Bun version](#bun-version)

External tools like `gh` (GitHub CLI), `eslint`, and `tsc` are used opportunistically by some modules but are never hard dependencies.

## Bun version

keryx needs **Bun 1.3.14 or newer**. Check it with `bun --version` and update
with `bun upgrade`.

The floor is not arbitrary. Bun 1.2.22 through 1.3.13 can close a terminal's
`process.stdin` while another native stream is being read in the same process
([oven-sh/bun#29787](https://github.com/oven-sh/bun/issues/29787),
[#30565](https://github.com/oven-sh/bun/issues/30565)). In `keryx shell` this
shows up as a frozen screen: the spinner and timer keep running, but no key,
Esc or Ctrl+C gets through. It typically happens when subagents start. keryx
0.2.123+ detects the closed input and reopens the terminal, but only a current
Bun removes the cause. `keryx shell --debug` records the event as
`stdin.dead.end` followed by `stdin.reopened`.

The standalone binary bundles its own Bun and is not affected by the Bun
installed on the machine.

## Environment isolation

`keryx` does not read a project's `.env` file, and does not run a project's
`bunfig.toml`. Left to Bun's own defaults, both are auto-loaded from the
CURRENT WORKING DIRECTORY on every launch — which means a cloned repository
could set environment variables (including `KERYX_HOME`, provider base
URLs/keys, `KERYX_HOOKS=off`) or, through `bunfig.toml`'s `preload`, run
arbitrary code, before `keryx` itself ever starts. Since cloning a repository
is not consent to run its code, `keryx` starts with `--no-env-file
--config=/dev/null` (baked into its shebang, and into every place it spawns
itself) so neither happens by default.

If you rely on a project `.env` for provider keys or other settings, you now
have to opt in explicitly — either export the variables in your shell before
running `keryx`, or run it with Bun's own flag:

```bash
bun --env-file=.env $(which keryx) shell
```

For provider API keys specifically, you likely do not need a project `.env`
at all: `keryx auth` (and the shell's `/connect`, below) save a key to an
owner-only file in your keryx config directory, which every session reads
regardless of `cwd`.

### What "protected" actually covers

The globally installed `keryx` (npm, the standalone binary, or a `keryx`
resolved via `PATH`) always launches through the safe shebang above, so
this is the normal case and needs no thought. Two invocation shapes bypass a
shebang entirely — `bun src/cli.ts …` (running from a source checkout) and
`bun dist/cli.js`/`bunx keryx` (running the built bundle directly instead of
through its shebang) — and for those, a second, weaker layer applies
instead: a startup guard that re-execs itself once, under the same two safe
flags, the moment it notices `--no-env-file`/`--config` are missing.

That guard cannot undo everything. Two limits, so the boundary is stated
rather than assumed:

- **A `bunfig.toml` `preload` script in the bypassing invocation's cwd still
  runs, once, before the guard gets a chance to act.** Bun runs `preload`
  before any user code, full stop — there is no "undo" for code that has
  already executed. Only the shebang (the normal, shipped path) actually
  prevents `preload` from running at all. Treat `bun src/cli.ts` in an
  untrusted checkout as unsafe for this reason alone.
- **Every ES module `import` in `src/cli.ts` is evaluated before the guard's
  own code runs**, including ones written textually below it — JavaScript
  hoists imports ahead of a file's top-level statements, so import order in
  the source does not change this. A top-level side effect in an imported
  module that reads `process.env` before the guard has had a chance to
  re-exec can still observe a cwd-`.env`-poisoned value.

What the guard DOES do, once it runs: it strips every environment variable
whose NAME appears in any `.env*` file in the bypassing invocation's cwd
(regardless of that file's exact syntax, and regardless of the variable's
current value — a real shell export sharing that name is dropped too, a
deliberate fail-safe trade-off), plus `BUN_OPTIONS`, `NODE_OPTIONS` and every
`BUN_CONFIG_*`/`BUN_INSTALL_*` variable unconditionally (Bun honours
`BUN_OPTIONS`, e.g. `--preload=…`, even under `--no-env-file
--config=/dev/null` — it is not one of the two things those flags stop). If
you export one of these in your own shell (not through a project `.env`) and
need it to reach a bypassing invocation, use the `bun --env-file=…` form
above, or export it as part of the safe re-exec's OWN environment rather than
relying on it surviving the strip.

Two platform gaps, so they are documented rather than silently unhandled:
BusyBox `env` (Alpine, some minimal containers) does not implement the `-S`
shebang-splitting flag the shipped `bin` relies on — on that platform the
guard above is what actually protects the invocation, not the shebang.
Windows has no shebang mechanism at all — an npm install's generated
`.cmd`/`.ps1` shim decides how `dist/cli.js` is launched, and the guard is,
again, what actually protects it there.

## Install

There are four ways in. They install the same CLI; they differ in what has to be
on the machine first and in what ends up on disk.

| Path | Needs | Installs to | Use it when |
|---|---|---|---|
| **npm package** (default) | node/npm, `bun` at runtime | your global npm prefix | You have node and want the published, versioned package. |
| **Standalone binary** | nothing — no bun, git or node | `~/.local/bin/keryx` | The machine has no toolchain, or you want one self-contained file. |
| **Managed clone** | `git`, `bun` | `~/.keryx/keryx` + a wrapper in `~/.local/bin` | You want to track `main` and update by re-running one command. |
| **Project-local clone** | `git`, `bun` | `.metaproject/runtime/keryx` in the project | You do not want a global command at all. |

The same four are summarised in the [README](https://github.com/MrCipherSmith/keryx#readme),
which leads with the npm package.

### npm package (the default)

```bash
npm install -g @mrciphersmith/keryx
```

> **The package is scoped, and the scope matters.** The unscoped name `keryx` on
> npm belongs to [an unrelated project](https://github.com/actionhero/keryx).
> Install `@mrciphersmith/keryx`; the executable it installs is called `keryx`.

Upgrade with `npm install -g @mrciphersmith/keryx@latest` — the same command
`keryx version check` prints when a newer release is available.

### Standalone binary (no runtime dependency)

Compiled binaries are attached to every GitHub Release for macOS (arm64, x64)
and Linux (x64, arm64). The script detects platform and architecture and
installs the matching one:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install-binary.sh | bash
```

It installs to `~/.local/bin/keryx` by default (`KERYX_BIN_DIR` overrides,
`KERYX_RELEASE_TAG` pins a tag instead of `latest`). Nothing else is required —
this is the path to use when there is no bun, git or node on the machine.

The download is verified against the sha256 digest GitHub records for that
release asset, and a mismatch refuses the install rather than warning about it.
Where the digest cannot be read, or the machine has neither `sha256sum` nor
`shasum`, the script **refuses** — `KERYX_ACKNOWLEDGE_NO_CHECKSUM=1` installs
anyway, as an explicit choice rather than a silent degradation.

Be precise about what that buys, because it is easy to overstate: the expected
digest comes from the GitHub API and the binary comes from the same GitHub
release, so this catches a corrupted or truncated download and a tampered CDN
copy. It does **not** defend against a compromised GitHub account or API — both
halves would then come from the same attacker. An independently published
digest would be a stronger claim, and this does not make it.

### Managed clone

Clones into `~/.keryx/keryx` and writes `~/.local/bin/keryx`.
Re-run either short command to update:

```bash
# curl (short)
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install | bash

# bun (short) — pipe into bun (Bun cannot run remote https://…/file.ts as entrypoint)
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install.ts | bun -
```

Pure Bun without the `curl` binary:

```bash
bun -e 'await Bun.spawn(["bash","-s"],{stdin:await fetch("https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install"),stdout:"inherit",stderr:"inherit"}).exited'
```

Both are thin wrappers around `scripts/install.sh --global`.

Private repository (through GitHub CLI):

```bash
gh auth setup-git
gh api repos/MrCipherSmith/keryx/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --global
```

Make sure `~/.local/bin` is on your `PATH` — this applies to the standalone
binary too, which installs to the same directory:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then:

```bash
keryx init
```

### Project-local clone

Use this when you do not want a global command. It clones the runtime into the current project under `.metaproject/runtime/keryx` and immediately runs `init`.

Public/raw:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install.sh | bash -s -- --project
```

Non-interactive:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install.sh | bash -s -- --project --yes
```

Private repository:

```bash
gh auth setup-git
gh api repos/MrCipherSmith/keryx/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --project
```

### Local development (from a clone of this repo)

Run the CLI directly from source with Bun — no build step required:

```bash
bun ./src/cli.ts init
bun ./src/cli.ts init --yes
bun ./src/cli.ts status
```

Run tests, build the distributable, and run the full quality gate:

```bash
bun test                 # run the co-located *.test.ts suite
bun run build            # bundle src/cli.ts -> dist/cli.js (the published bin)
bun run check            # quality gate: tsc --noEmit && bun test
```

`bun run typecheck` (`tsc --noEmit`) is available on its own, and `bun run keryx` is a shortcut for `bun ./src/cli.ts`.

#### Running the suite concurrently (several worktrees at once)

The suite is safe to run concurrently — several agent sessions routinely run
`bun test` at the same time from different worktrees. That only holds because
**every test fixture root is unique per run**. A fixture rooted at a fixed path
is not private to one run: `tmpdir()/keryx-foo` resolves to the same directory
for every checkout on the machine, and `<repo>/.tmp-foo` for every process in
one worktree. One run's `rm -rf` then deletes another run's fixture mid-test.

So when you add a test that needs a directory on disk, build its root with
`uniqueTestRoot(parent, prefix)` from `src/lib/test-tmp.ts` — never
`path.join(tmpdir(), "fixed-name")`. The same applies to any other externally
visible identity a test claims: ports (`listen(0)`), and artifact run ids, which
are only safe because they live under a root that is already unique.

Collisions are silent and look like unrelated bugs, so they are worth
recognising: an `ENOENT` for a file the test just wrote, an
`immutable … run already exists` error from another run's leftover artifact, or
`ENOENT: no such file or directory, posix_spawn 'git'` — which reports the
*binary* but actually means the spawn's **cwd** was deleted underneath it.

To verify concurrency safety after a change, run the stress harness:

```bash
bun scripts/stress/concurrent-suite-stress.ts --runs 6 --repeat 2
```

It runs N full suites at once and reports per-run tallies plus failing test
names; transcripts of failing runs are kept in `.tmp-stress-logs/`. It exits
non-zero if any run failed.

One known residual, unrelated to shared state: the live-loopback TLS tests in
`src/harness/process/sandbox/proxy-tls.test.ts` do real TLS handshakes and
shell out to `openssl`, so they are load-sensitive and can time out on a
saturated machine (observed once in 48 concurrent runs). They use ephemeral
ports and an `mkdtemp` CA workspace, so this is machine load, not a collision.

## First-run walkthrough

### Step 1 — Initialize the workspace

From the root of the project you want to instrument:

```bash
keryx init
```

`init` is interactive by default. The first question is a shortcut — *"Install everything with recommended defaults?"* (default **Y**) — answering yes enables all 9 optional modules with their recommended settings and skips every question after it, equivalent to passing `--yes`. Answering no falls through to the per-module questions: `gdgraph`, `gdctx`, `gdwiki`, `gdskills`, `health`, `testing`, `memory`, `tasks`, and `security` (all default on), and, for `gdskills`, which install profile to use. It also offers one opt-in module, the MCP server, which defaults **off** (see [Wiring the workspace into an editor/agent](#wiring-the-workspace-into-an-editoragent-mcp) below). Pass `--yes` on the command line to accept defaults non-interactively, skipping the shortcut question too.

It scaffolds `.metaproject/` with:

```text
.metaproject/
  index.md                    # agent entrypoint: module / rules / skills / data map
  keryx-dashboard.html   # self-contained human dashboard
  metaproject.json            # authoritative runtime manifest
  README.md
  core/  data/  rules/  skills/  modules/  reports/  templates/
  hooks/post-update.d/
```

It also connects your repo's agent entrypoints — importing an existing `AGENTS.md`/`CLAUDE.md` into `.metaproject/rules/` (or creating `AGENTS.md` if none exists) and injecting a managed routing block that points agents at `.metaproject/index.md` first. Each enabled module adds its own `core/`, `data/`, and `skills/` subtrees. On a project with `.git`, opt-in git hooks (post-commit graph/skills/health reminders, dashboard rebuild) can be installed.

`init` is idempotent — re-running it refreshes managed files but never clobbers your hand-edited files or anything under `.metaproject/data/`.

Useful `init` flags:

```bash
keryx init --yes                 # non-interactive, accept defaults
keryx init --no-gdgraph          # disable a module (also --no-gdctx, --no-gdwiki,
                                      #   --no-gdskills, --no-health, --no-testing,
                                      #   --no-memory, --no-tasks, --no-security)
keryx init --gdskills-profile <v>
keryx init --yes --no-gdgraph-hook   # skip a specific git hook
```

### Step 2 — The typical loop

Once the workspace exists, this is the usual cycle for producing and refreshing project knowledge. Modules are loosely coupled through files under `.metaproject/data/` — later steps read what earlier steps wrote, so ordering matters (each is a no-op-friendly read if upstream data is missing).

```bash
keryx gdgraph build      # 1. build the import/dependency graph
keryx wiki collect       # 2. draft wiki pages from graph/health/testing data
keryx health run         # 3. aggregate code-health signals into scored reports
keryx test analyze       # 4. detect the test stack and build testing context
keryx dashboard build    # 5. regenerate the self-contained HTML dashboard
keryx status             # 6. print which modules are enabled
```

Notes on each:

- **`gdgraph build`** writes `data/gdgraph/storage/{nodes,edges}.jsonl` plus a summary and module map. Use `gdgraph find` for concepts, `affected` for blast radius, `path` for relationships, and the optional `symbol --impact` surface when tree-sitter symbols are enabled.
- **`wiki collect`** reads the graph, latest health report, and testing context (all optional), emits a hierarchical full-coverage draft scaffold, updates backlinks, and reports how many component pages still need prose enrichment. Run it *after* `gdgraph build` / `health run` to get the richest drafts.
- **`health run`** scores code quality from tsc, tests, audit, complexity, coverage, and lint signals. Add `--changed` to scope to changed files.
- **`test analyze`** inspects your existing test stack and writes testing context; `keryx test run --changed` runs the project's own test runner scoped to changes.
- **`dashboard build`** rebuilds `.metaproject/keryx-dashboard.html` from current service files and data snapshots. Use `keryx dashboard open` (or bare `keryx dash`) to build and open it. The dashboard reads data only — it never runs analyzers or writes under `data/`.
- **`status`** reads the manifest and reports `enabled`/`disabled` per module (or tells you the workspace is not initialized / incomplete).

Three other modules round out the loop as you work:

```bash
keryx memory search "decision"   # long-term typed project memory
keryx flow init --title "..."    # agent-first task lifecycle (the `tasks` module)
keryx security status            # policy-based scanning, redaction, guardrails, audit
```

Optional integrations improve agent startup and review traceability:

```bash
keryx orient install-hook --runtime codex
keryx ctx install-hook --runtime codex
keryx review start --target branch --ref feature/example
```

The orientation hook injects a bounded project-root Metaproject excerpt, graph
map, and wiki index at turn start. The gdctx
routing guard keeps broad raw shell/search output out of the agent context.
Managed review packages preserve coverage, findings, decisions, and learning
candidates for standalone or flow-attached reviews.

The `security` module is enabled by default, so `init` asks whether to enable it (and, on a git repo, whether to install a pre-push guard and project-local `.claude/settings.json` agent hooks). Once the workspace exists, check its state with `keryx security status` and scan a path for secrets/policy findings with `keryx security scan <path>`. Disable the module entirely with `keryx init --no-security`.

Every command exposes more subcommands and flags — run `keryx <command> --help`, or `keryx` with no arguments for the full usage block.

### Step 3 — Your first `keryx shell` session

The workspace and the agent harness are separate things: `init` (above) sets
up `.metaproject/`, and `keryx shell` is the interactive agent that reads it.
Start it from the project root:

```bash
keryx shell
```

#### Connect a provider

`keryx shell` needs one configured model provider before it can run a turn.

- **No provider configured yet.** The first run opens a picker: choose a
  built-in provider (Anthropic, Ollama, OpenRouter, DeepSeek, Z.AI, Cerebras,
  Groq, Moonshot, Grok, or the offline `fake` provider for deterministic
  runs) or select "add custom provider" to register any OpenAI-compatible
  endpoint. If the provider needs a key, you are prompted for it before the
  model list loads (so a gateway that 401s without one still shows a real
  model list, not a stale fallback). Pick a model and the session starts.
- **Set one up before the first run, or add another later**, from outside the
  shell:

  ```bash
  keryx providers list         # every provider you already have configured,
                                # and its model family
  keryx providers test <name>  # run its live model-list probe; ok + count,
                                # or the failure reason
  keryx providers remove <name> [--yes]  # disconnect it: remove the saved
                                # key/grant/custom entry (asks first)
  keryx auth login <provider>  # subscription login (device code / OAuth,
                                # where the provider supports it) or API key
  keryx auth status <provider> # is this provider currently authorized
  keryx auth logout <provider> # delete a stored OAuth grant, LOCALLY —
                                # no vendor revoke call is made
  ```

- **Inside a running session**, `/connect` switches between providers you
  already configured (no key/URL prompts). Since flow 304, each row in that
  list also carries two buttons, drawn and reachable the same way the queue
  dock's Force/Edit/Delete are: `[Test]` runs the same live model-list probe
  `keryx providers test` does and shows the result on the row; `[Disconnect]`
  asks for confirmation, then removes that provider's saved credential the
  same way `keryx providers remove` does. Reach both without a mouse: ↑/↓
  picks a row, ←/→ picks Label, Test or Disconnect, Enter fires it, Esc backs
  out. Disconnecting the provider the CURRENT session is using does not
  switch it or interrupt a turn — the session keeps its already-loaded
  credential until you `/connect` another provider or restart. `/provider`
  opens the same add/reconfigure wizard the startup picker used (no row
  buttons there), so it also covers a provider you have not set up yet.
  `/model` opens a model picker for the current provider; in chat mode
  (`--no-tui --chat`) it instead takes an argument (`/model <name>`) and
  `/models` lists what is available as a numbered menu.

#### Pick a theme

```
/theme
```

opens the theme picker in the running session; `/theme <name>` applies one
directly. The choice applies immediately — prose, headings, diffs and code
fences repaint in the new palette without restarting the session.

#### Choose a permission mode

Every session starts in `ask` mode: a mutating tool call (shell, write,
destructive) is confirmed before it runs. Switch it for the rest of the
session with:

```
/mode
```

with no argument, `/mode` shows the current mode and what it means; `/mode
trust` auto-approves safe calls but still asks before anything destructive or
credential-touching; `/mode auto` skips confirmation for everything except a
credential-touching command, which no mode ever auto-approves. This is a
session-level control only — `keryx harness run`/`exec`, `keryx serve` and MCP
sit above it, unconditionally policy-gated either way. See the
[permission modes guide](guides/permission-modes.md) for the full picture,
including `keryx shell --trust`/`--auto` to start in a given mode.

#### Slash-command basics

Every interactive command starts with `/`. `/help` lists what is available in
the current mode (agent mode has tools and a TUI; chat mode is a plain
conversation with no tools), grouped by task — in the TUI it opens a tabbed
modal, arrow keys to move between groups and commands, Enter for a command's
detail. A few you will reach for early, beyond the ones above:

- `/status` — session identity, context window and limits, workspaces, flows.
- `/compact [focus]` — compact the model context, keeping the full transcript
  on disk.
- `/interrupt` — stop the running main turn without losing the session.

`keryx help` groups the full CLI surface the same way, outside the shell
(`keryx <command> --help`, or bare `keryx`, for the flat list); the same
table is also a generated reference page: [Commands by
task](commands-by-task.md).

#### Sessions

Sessions are durable JSONL transcripts per project, so closing a session never
loses it:

- `/resume` — resume a prior session in this project (also `keryx shell -r
  [id]`, or `-c`/`--continue` for the most recent one).
- `/sessions` — open the session list and switch to one.
- `/new` (or `/clear`) — start a new session; the old one stays on disk.

From outside the shell, `keryx sessions list` shows the same sessions for the
current project, `keryx sessions fork <id>` branches one into a new session
that keeps its ancestry, and `keryx sessions export <id>` writes its
transcript out.

## After pulling changes

When you pull updates to the toolkit or your teammates' workspace changes, refresh the managed runtime and service layer:

```bash
keryx update
```

`update` refreshes managed scripts, skills, module manifests, hook definitions, and the dashboard. It does **not** run analyzers and does **not** write `.metaproject/data/**` — your accumulated project knowledge is left untouched (it reports "Data artifacts were left untouched"). By default it also self-refreshes the runtime from `origin/main` before updating service files.

```bash
keryx update --skip-runtime   # skip the network runtime refresh
keryx update --no-tasks       # skip auto-backfilling the tasks module
keryx update --hooks          # run executables in hooks/post-update.d/
```

Workspaces created before the `tasks` module existed are automatically backfilled by `update` (opt out with `--no-tasks`).

After updating, confirm the workspace still conforms to the Metaproject Standard:

```bash
keryx standard validate    # PASS/FAIL report, non-zero exit on violations
keryx standard doctor      # actionable fix hints
keryx standard capabilities # standard version, profiles, enabled modules
```

## Wiring the workspace into an editor/agent (MCP)

The MCP server module exposes the `.metaproject/` workspace to editors and agents (Cursor, Claude Code, or any generic MCP client) over the Model Context Protocol. It is the one module that defaults **off** — `init` asks whether to enable it, and you can always wire it up later.

```bash
keryx integrate cursor    # write .cursor/mcp.json
keryx integrate claude    # write .mcp.json (Claude Code)
keryx integrate generic   # print a config snippet to paste anywhere
keryx integrate all       # cursor + claude (the default)
```

`integrate` writes a project-local MCP client config, sets `modules.mcp.enabled=true` in `.metaproject/metaproject.json`, and prints a snippet for `generic`. Pass `--dry-run` to preview the change without writing anything, and use `keryx integrate --remove <...>` to remove just the managed keryx entry.

The server itself runs over stdio by default:

```bash
keryx serve-mcp                # stdio JSON-RPC MCP server (what clients launch)
keryx serve-mcp --http         # isolated localhost HTTP/SSE transport (opt-in)
```

Serving requires the optional `@modelcontextprotocol/sdk`; `integrate` only probes for it and never installs it or opens a network connection.

## TTY / CI behavior

`keryx` is safe to run in pipelines and non-interactive shells:

- **Non-interactive prompts** — pass `--yes` to `init` to accept all defaults without prompting. When stdin is not a TTY, prompts fall back to their defaults automatically, so piped/CI runs never hang.
- **Color output** — color is gated on the terminal. Set `NO_COLOR` to disable ANSI color, or `FORCE_COLOR` to force it on; when output is not a TTY, color is off by default so logs stay clean.

## Where things live

- **Workspace layout, the `.metaproject/` contract, and the init/update lifecycle:** see [workspace-and-lifecycle.md](./workspace-and-lifecycle.md).
- **Every command, subcommand, and flag:** see [cli-reference.md](./cli-reference.md).
