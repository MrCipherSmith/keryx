# Troubleshooting

Start with `keryx doctor`. It checks the version, the Bun floor, ripgrep, the OS
sandbox, providers, MCP servers, agent integrations, the workspace and the
freshness of the graph and wiki, and prints a `fix:` command under every
warning.

```bash
keryx doctor
```

`keryx doctor --json` prints the same checks for a script or an agent. If
`doctor` itself cannot run, the problem is the install; start at
[Install problems](#install-problems).

## Install problems

### `keryx: command not found`

The installers put `keryx` in `~/.local/bin` (standalone binary and managed
clone) or in your global npm prefix (npm package). Add the directory to your
`PATH` and open a new shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v keryx
```

### `bun: command not found`

The npm package and both clone installers run on Bun. Install Bun, or add its
default location to your `PATH`:

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

The [standalone binary](install.md#standalone-binary) needs no Bun at all.

### `keryx` is a different program

If `keryx --version` does not print a version like `0.3.46`, you installed the
unscoped `keryx` package from npm, which is an unrelated project. Remove it and
install the scoped one:

```bash
npm uninstall -g keryx
npm install -g @mrciphersmith/keryx
```

### The shell freezes and ignores keys

The spinner runs but no key, Esc or Ctrl+C gets through. This is a known bug in
Bun 1.2.22 through 1.3.13. Update Bun (`bun upgrade`) to 1.3.14 or newer; see
[Bun version](install.md#bun-version). To recover a stuck shell from another
terminal, send it `SIGUSR2`:

```bash
kill -USR2 <keryx pid>
```

## Workspace problems

### `.metaproject` is missing or incomplete

`keryx status` reports whether the workspace exists and which modules are on.
Create it with `keryx init --yes`. `init` is safe to re-run: it refreshes
managed files and never overwrites your edits or anything under
`.metaproject/data/`.

`keryx setup` prints a step-by-step preparation guide for three cases (`init`,
`refresh`, `repair`) without running anything:

```bash
keryx setup repair
```

### The graph answer looks out of date

Graph answers come from the last `keryx gdgraph build`, not from the working
tree. A command that notices the difference says so:

```text
note: repo moved since the last graph build — `keryx gdgraph build` to refresh.
```

Rebuild after you add, move or delete files:

```bash
keryx gdgraph build
```

`keryx sync` reports which derived layers (graph, wiki, memory) are behind the
code; `keryx sync --apply` rebuilds the stale ones.

### Symbol commands find no symbols

The symbol layer is optional and needs its grammars. Check and enable it, then
rebuild:

```bash
keryx gdgraph symbols status
keryx gdgraph symbols enable
keryx gdgraph assets list
keryx gdgraph build
```

Without grammars the file graph still works.

### Wiki links or the index are stale

```bash
keryx wiki collect --force
keryx wiki index
keryx wiki check-links
keryx wiki validate
```

`collect --force` refreshes generated drafts only. Pages a person has edited or
accepted are kept.

### Workspace validation fails

```bash
keryx standard validate
keryx standard doctor
```

`validate` prints a pass or fail report; `doctor` prints a fix for each failure.

## Command problems

### `keryx ctx rg` fails

`keryx ctx rg` and the agent's code search need ripgrep on `PATH`. They exit
non-zero instead of falling back to a slower scan.

```bash
brew install ripgrep      # macOS
apt install ripgrep       # Debian/Ubuntu
```

### `No credential for provider`

A few commands add model-written text and need a provider:
`test suggest`, `flow plan`, `memory reflect --narrate` and
`health explain --narrate` exit with status 1 without one, and `wiki enrich`
skips the affected pages. Connect a provider with `keryx shell` (`/connect`) or
an API key in the environment; see
[Connect a model provider](../guides/connect-a-provider.md).

### The `fake` provider answers with an error

```text
[error] FakeProvider: no transcript matches request hash …
```

`fake` only replays recorded test transcripts. It proves the shell starts, but
it cannot answer a new prompt. Connect a real provider.

### `keryx serve-mcp` says the MCP SDK is not installed

The MCP server needs the optional `@modelcontextprotocol/sdk` package. The
error prints the install command. Every other command runs without it.

### A contained run is blocked

```text
Contained spawn failed: OS sandbox launcher unavailable on linux …; failing closed
```

On Linux the OS sandbox needs `bubblewrap`. Install it (for example
`apt install bubblewrap`) and run `keryx sandbox status`. On Windows there is
no OS sandbox, so contained runs always fail closed. See the
[security model](../concepts/security-model.md#os-sandbox).

## Environment problems

### Variables from the project `.env` are not used

Keryx does not load a project's `.env` or `bunfig.toml`, because a cloned
repository could otherwise set your provider keys or run code before Keryx
starts. Export the variables in your shell, or opt in for one run:

```bash
bun --env-file=.env $(which keryx) shell
```

For provider keys you usually do not need `.env` at all: keys entered with
`/connect` in the shell are stored in your per-user config directory and read
from any project. See [Environment isolation](../concepts/security-model.md#environment-isolation).

### `keryx` refuses to start with exit code 78

This happens only when Keryx runs from a source checkout (`bun src/cli.ts …`)
in a directory whose `.env` file is larger than 16 MiB or cannot be read. Keryx
then cannot tell which variables to strip, so it refuses. The message names the
file. Move or shrink it, or run the installed `keryx` instead, which never reads
`.env` files.

## Reference

- [`doctor`](../cli-reference.md#doctor), [`version`](../cli-reference.md#version) and [`update`](../cli-reference.md#update) in the CLI reference.
- [Reference index](../reference/index.md): configuration and every other reference page.

## Still stuck

Search the [FAQ](../project/faq.md), then open an issue with the output of
`keryx doctor --json` and the command that failed. See
[Contributing and support](../project/contributing.md).
