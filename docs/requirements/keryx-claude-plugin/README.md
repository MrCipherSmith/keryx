# A Claude Code plugin as a fourth connection interface

**Status.** Assessment. Nothing implemented; one prototype built and validated,
then discarded.
**Date.** 2026-09-04, against `main` at `630c634b` and Claude Code `2.1.220`.
**Question asked.** How the Claude Code plugin system works, and whether keryx
should offer a plugin alongside its existing ways of connecting.

## Method

Everything below that describes plugin behaviour was checked against the CLI on
this machine (`claude 2.1.220`), not only against the documentation. A prototype
keryx plugin was assembled — manifest, `.mcp.json`, `hooks/hooks.json`, one
skill — and run through `claude plugin validate`. keryx itself was probed in a
directory with no `.metaproject` to see what a globally enabled plugin would
actually do there. Two findings below come from those runs and from nothing else.

What was **not** done: no live Claude Code session was started with the plugin
loaded. So `${CLAUDE_PROJECT_DIR}` substitution inside MCP `args` is documented
and structurally valid here, and **unproven at runtime**. That is the first thing
to verify if this is built.

## What a plugin can carry

A plugin is a directory with an optional `.claude-plugin/plugin.json` manifest
and components at the plugin **root** (never inside `.claude-plugin/` — that is
the documented common mistake):

| Directory / file | Carries |
|---|---|
| `skills/<name>/SKILL.md` | Skills, namespaced `/<plugin>:<skill>` |
| `commands/` | Flat-file commands (legacy shape; `skills/` preferred) |
| `agents/` | Subagent definitions |
| `hooks/hooks.json` | Hook handlers, same JSON shape as `settings.json` |
| `.mcp.json` | MCP servers, started when the plugin is enabled |
| `.lsp.json` | Language servers |
| `monitors/monitors.json` | Background watchers that push events into a session |
| `bin/` | Executables added to the Bash tool's `PATH` |
| `settings.json` | Defaults applied when enabled (`agent`, `subagentStatusLine`) |

Three substitutions are available, and one of them is the crux of this whole
assessment:

| Variable | Resolves to |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | the plugin's own install directory |
| `${CLAUDE_PLUGIN_DATA}` | a persistent per-plugin directory that survives updates |
| **`${CLAUDE_PROJECT_DIR}`** | **the project root of the current session** |

Substitution works in MCP `command`/`args`/`env`, hook and monitor command
fields, LSP fields, and skill/agent content.

Distribution is by marketplace: a `marketplace.json` naming plugins and where to
fetch each from — relative path, GitHub, git URL, git subdirectory, npm package,
zip archive, or a command. Install is `/plugin install <name>@<marketplace>`;
local development is `claude --plugin-dir ./path`, which also accepts a `.zip`.

## What keryx has today

Four connection interfaces, all of them **writers into somebody else's file**:

1. `keryx mcp install --runtime claude` → writes `.mcp.json` in the project root.
2. `keryx ctx hook` and `keryx security hooks install` → merge entries into
   `.claude/settings.json`, marked with a `_keryxManaged` sentinel.
3. `keryx orient install-hook` → the turn-start context block, same mechanism.
4. `keryx rules sync` / `keryx agents bootstrap install` → managed blocks inside
   `AGENTS.md` / `CLAUDE.md`, project-local and global respectively.

There is also a fifth, half-built: `keryx skills export --runtime plugin` already
emits a plugin package — but for **one project skill at a time**
(`src/gdskills/export-plugin.ts`). It is a skill exporter that happens to use the
plugin format, not a keryx plugin.

## The case for a plugin — one argument survived, one did not

The first draft rested on two defects this repository already had, both said to
be structural consequences of writing into other people's files. One of the two
turned out to be fixable without a plugin. Both are kept below, because a
document that quietly drops its own failed argument is worth less than one that
shows which arguments held.

### The absolute path — and why this argument does NOT survive checking

**Corrected after the first draft. The claim below was the strongest argument in
this document and it is wrong; it is left in with its correction because the
correction is the finding.**

The draft argued: `keryx mcp install` writes
`"args": ["mcp","serve","--cwd","<absolute path>"]`, which is correct on exactly
one machine — ours carried a macOS path from 2026-08-13 and sat dead on Linux
until 2026-09-02 — and only a plugin can fix that, because only a plugin has
`${CLAUDE_PROJECT_DIR}`.

The second half is false — but **not for the reason the documentation gives**,
and the difference matters.

The documentation says variable expansion works in a project-level `.mcp.json`
across `command`, `args`, `env`, `url` and `headers`, with `${VAR:-default}`
syntax, so `"--cwd", "${CLAUDE_PROJECT_DIR:-.}"` would be the portable form.

Measured against Claude Code 2.1.220, by pointing the server at a wrapper that
logs its own `argv`, `pwd` and environment before `exec`ing keryx:

| Written in the config | What the server actually received |
|---|---|
| `"${CLAUDE_PROJECT_DIR}"` | the literal string `${CLAUDE_PROJECT_DIR}`, unexpanded |
| `"${CLAUDE_PROJECT_DIR:-.}"` | `.` — expanded, but to the **fallback** |

So argv expansion of that variable did not happen. The same probe showed why the
fix is available anyway: `CLAUDE_PROJECT_DIR` **is** present and correct in the
spawned server's environment, and the process cwd is the project root too.

The runtime does hand over the project root. It just hands it over through the
environment rather than through argv. Reading it there is the fix, and it is
better than a portable placeholder: the generated config can drop `--cwd`
altogether, so nothing machine-specific is written at all.

A control kept this from being read wrong. `claude mcp get` reports
`✔ Connected` for a server pointed at `/nonexistent/path/that/is/not/a/project`,
so "Connected" proves nothing about which root was resolved. The discriminating
observable is the tool count: serving a directory with no `.metaproject` exposes
**0 tools**, serving this repository exposes **39**.

So the defect that motivated untracking `.mcp.json` in #446 is fixable **today,
without any plugin**. It is independent of every decision below and should be
done whether or not a plugin is ever built.

### The merge into a file we do not own

The hook installer merges into `.claude/settings.json` and must therefore own
install, uninstall, drift detection and idempotency — for six runtimes, in two
shapes (flat and nested). That machinery produced real defects: `validate`
reported five under-covering shapes as clean, its drift branch could not fire in
production because the installer merged before validating, and ownership was
decided in two places that disagreed (#435). Every one of those is a cost of
editing a file somebody else also edits.

A plugin ships `hooks/hooks.json`. Nothing merges, nothing drifts, uninstall is
"disable the plugin". The entire class disappears.

## The finding that decides the shape

**In a directory with no `.metaproject` at all, `keryx ctx hook claude` still
blocks the command.** Probed directly: exit code `2`, with the routing refusal
telling the operator to use `keryx ctx rg` — in a project that has no keryx
workspace to route into.

The MCP server is the opposite. In the same directory it initializes cleanly and
reports **0 tools** — it degrades to silence, exactly as it should.

So the two halves have opposite readiness for a globally enabled plugin. Enabled
at user scope today, the hooks half would block `grep` in every repository on the
machine, keryx or not. That is not a reason against the plugin; it is a
prerequisite that has to land first, and it is small: the hook must no-op when
the session's project root has no `.metaproject`.

It is also worth fixing regardless of the plugin, because the same hook is
installable globally today.

## What a plugin does not solve

- **It does not install keryx.** The manifest can only declare `command: "keryx"`;
  the binary still has to be on `PATH`. A plugin whose MCP server cannot start
  shows up in `/plugin` under Errors, which is at least visible — better than the
  current silence, but not self-installing.
- **It does not replace `keryx init`.** A plugin can read a `.metaproject/`; it
  cannot create one, and should not.
- **It is a fourth interface, not a replacement.** Codex, Cursor, opencode and
  VS Code do not read Claude plugins. The existing installers stay.
- **Two sources of truth for hooks.** With a plugin enabled AND
  `keryx security hooks install` having written `.claude/settings.json`, hooks run
  twice. Whatever ships must detect and refuse or clean up the other.

## What the plugin is actually worth, after the correction

The honest accounting, once the `${CLAUDE_PROJECT_DIR}` argument is removed:

| Claimed benefit | Holds? |
|---|---|
| Machine-independent MCP config | **No** — available today in a project `.mcp.json` |
| Hooks without merging into `.claude/settings.json` | Yes, but the merge machinery already exists and is now tested; the saving is future maintenance, not a present defect |
| Namespaced skills as `/keryx:<skill>` | Yes — not reachable otherwise except by copying files into `.claude/skills/` |
| One install covering every project | Partly — a user-scoped plugin wires every project, but `keryx init` is still per-project, so it removes the wiring step, not the setup |
| Discoverability in the plugin marketplace | Yes, and this is the one nobody else can substitute |

The engineering case is **weak**. Everything the plugin does technically, keryx
can already do or could do with small changes to its existing installers, and it
still cannot install the binary or create a workspace.

The distribution case is the real one, and it is a product decision rather than
an engineering one: a marketplace listing is a channel where people find keryx by
browsing, install it with one command, and get every surface at once. Whether
that channel is worth maintaining a fifth interface for is a question about who
keryx is for, not about the code.

## Options

**A. Leave it, and fix the `.mcp.json` string.** The cheap win above, independent
of everything else. Cost: the merge machinery stays, and every new runtime
multiplies the installer matrix.

**B. Ship a keryx plugin, project-scoped.** One package carrying the MCP server
(`${CLAUDE_PROJECT_DIR}`), the routing/security/orientation hooks, and the
bundled skills. Committed to the repository under `.claude-plugin/` or offered by
`keryx mcp install --runtime plugin`. Enabled per project, so the
no-`.metaproject` case is rare — but must still be fixed first.

**C. Ship it to a marketplace.** B plus a marketplace manifest so
`/plugin install keryx@...` works from any project, and the plugin follows the
npm release. This is where the interface actually pays off: install keryx once,
get it in every project, with no per-project installer run at all. It also raises
the stakes on the global-enable problem, because that becomes the normal case.

**Recommendation, revised after the correction.** Do the `.mcp.json` fix from A
now — it is one string and it retires a real defect. Do **not** build the plugin
for engineering reasons; there are not enough of them left. Build it only if the
answer to "do we want keryx findable and installable from the plugin
marketplace?" is yes, in which case go straight to C, because B on its own buys
almost nothing that the current installers do not already provide.

The hook no-op stays a blocking prerequisite for C, and is worth doing regardless
since the hook is globally installable today.

## Two smaller findings from the same probing

1. **`keryx skills export --runtime plugin` emits `marketplace.json` inside
   `.claude-plugin/`, and that makes `claude plugin validate` validate the wrong
   file.** Run against the exported package, the CLI prints "Validating
   marketplace manifest" and never checks `plugin.json`. Removing
   `marketplace.json` makes it print "Validating plugin manifest" and pass. The
   package is not broken — it works as a self-referencing marketplace — but its
   plugin manifest is never checked by the tool the ecosystem uses. Splitting the
   two, or dropping the marketplace file from a single-plugin export, restores
   that check.

2. **`claude plugin validate` should be in CI** if any of this ships. It is a
   single command over a directory, it exits non-zero, and it is exactly the kind
   of check that catches a package shape drifting away from what the runtime
   accepts — the class of defect this repository has spent two days removing.

## Verification performed

- `claude plugin validate` on a prototype carrying manifest + `.mcp.json` +
  `hooks/hooks.json` + one skill → **passed**.
- `claude plugin validate` on the current `--runtime plugin` export → passed, but
  as a *marketplace* manifest; with `marketplace.json` removed it validated as a
  plugin and passed.
- `keryx mcp serve --cwd <dir with no .metaproject>` → initializes, `tools/list`
  returns **0 tools**.
- `keryx ctx hook claude` in the same directory → **exit 2, command blocked**.

- A wrapper script recording `argv`, `pwd` and `CLAUDE_PROJECT_DIR` before
  `exec`ing keryx, driven by `claude mcp get` → the argv results in the table
  above, and the variable present in the environment.
- A control server pointed at a nonexistent path → also `✔ Connected`, which is
  why the tool count and not the status line is used as evidence.
- `CLAUDE_PROJECT_DIR` set to an empty directory while the process cwd was this
  repository → **0 tools**; unset → **39**. That is the resolver changing which
  root is served, observed rather than inferred.

Not performed: a live session with the plugin loaded, which is what would prove
the hooks fire from a plugin rather than from `settings.json`, and whether argv
expansion behaves differently for plugin-provided MCP config than it does for
the local and project scopes measured here. The documentation says it does; this
assessment has already been wrong once about what that documentation implies.
