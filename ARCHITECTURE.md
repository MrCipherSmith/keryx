# Architecture

This is a map of the Keryx codebase for someone who wants to change it. It names
the parts and how they connect; it does not describe every command. For the
user-facing explanation, start at the
[documentation site](https://mrciphersmith.github.io/keryx/), and see the
[Architecture](https://mrciphersmith.github.io/keryx/architecture/),
[Metaproject](https://mrciphersmith.github.io/keryx/concepts/metaproject/) and
[Security model](https://mrciphersmith.github.io/keryx/concepts/security-model/)
pages for depth.

## What Keryx is

Keryx is a Bun and TypeScript command-line tool that keeps a project's working
knowledge in version control, in a `.metaproject/` directory: a code dependency
graph, an architecture wiki, long-term memory, test-impact context, quality
signals, skills and rules, and task flows with frozen acceptance criteria. The
same state is served to any coding agent through plain files, a CLI, hooks, and
an MCP server. On top of that deterministic core sits an optional agent shell
(`keryx shell`) that runs a model turn loop with tool policy, permission modes,
and an OS sandbox. The core is local and offline; model providers, the network
and remote entry points are opt-in clients layered above it.

## Codemap

Everything lives in one package under `src/`. The directories fall into four
zones, declared in `src/lib/import-zones.ts` and enforced by import-policy
tests: **adapter** (transports), **client** (the model runtime), **core**
(deterministic owners) and **shared** (primitives). Core never imports adapter
or client code.

### Entry points

| Path | Role |
| --- | --- |
| `src/cli.ts` | Process entry: startup safety guard, `main()`, error to exit-code mapping. |
| `src/cli-registry.ts` | `CLI_ROUTES` (every top-level verb mapped to its handler), the flat usage text, per-group help. |
| `src/lib/group-subcommands.ts` | The real subcommand vocabulary of each command group; a test compares it with the CLI reference. |
| `src/core.ts` | The package's one library door (`exports["."]`): the owner facades, with no provider, credential or model call behind it. |
| `src/commands/` | One handler per verb. Handlers parse arguments and call the owners; they hold little logic. |

### Core zone: the `.metaproject/` owners

| Directory | Owns |
| --- | --- |
| `src/gdgraph/` | Code dependency graph: build, query, affected set, repo map. |
| `src/wiki/` | Architecture wiki: pages, links, freshness pins, section search. |
| `src/memory/` | Long-term project memory: records, lifecycle, lexical search, handoff. |
| `src/ctx/` | Compact command and file output with a raw log; per-runtime hook installers. |
| `src/testing/`, `src/health/` | Test-impact context, quality signals and the gate. |
| `src/flow/`, `src/job/` | Task-flow lifecycle and state machine (`flow/machine.ts`), job packages. |
| `src/review/` | Managed review packages, dispositions, the review gate. |
| `src/gdskills/`, `src/agents/`, `src/learning/`, `src/bundle/` | Bundled skills, the agent catalog, the learning loop, portable bundles. |
| `src/security/` | Secret, PII and injection scanning, redaction, the structural command guard. |
| `src/sac/` | Shared Agent Context across workspaces (opt-in). It declares a model-turn port and holds no provider. |
| `src/sync/`, `src/retention/`, `src/forgetting/`, `src/trigger/`, `src/governance/`, `src/product/`, `src/stack/`, `src/standard/`, `src/metrics/`, `src/eval/`, `src/integrations/`, `src/capability/` | Bookkeeping owners: reconciliation, store bounds, deletion trails, declared triggers, reports, stack detection, the Metaproject Standard, run metrics, fixtures, host-harness surfaces. |

### Client zone: the agent runtime

| Directory | Owns |
| --- | --- |
| `src/harness/` | The turn loop and everything it needs. `run/run.ts` runs a turn; `provider/` holds the adapters and `make-provider.ts`; `policy/engine.ts` decides tool calls; `tool/` the tool registry; `process/` real subprocess execution and `process/sandbox/` the OS sandbox; `session/`, `resume/`, `branch/`, `child/`, `parallel/` sessions and subagents; `routing/` category-to-model routing; `external/` external agent CLIs; `hooks/` lifecycle hooks; `search/` web search backends. |
| `src/tui/` | The terminal UI for `keryx shell` (OpenTUI, with a readline fallback). |
| `src/session/`, `src/rewind/` | Per-project session store, per-turn file snapshots for `/rewind`. |
| `src/bus/` | Agent bus: presence, leases and an inbox across worktrees of one clone. |
| `src/mcp-servers/`, `src/mcp-client/` | The consumer side of MCP: third-party servers put in front of the model. |

### Adapter zone and shared

| Directory | Role |
| --- | --- |
| `src/mcp/` | The publisher side of MCP: `.metaproject/` over stdio or loopback HTTP. |
| `src/acp/` | Agent Client Protocol server over stdio, for editors. |
| `src/lib/` | Shared primitives: config directory resolution, owner-only file helpers, the serve server, OAuth, import policy. |
| `src/contracts/`, `src/assets/` | Contract registry and validator, embedded assets. |
| `src/rules/` | Rule sync and entrypoint writers (`AGENTS.md`, `CLAUDE.md`); shared, so core and client both import it. |

## Main flows

### CLI routing

```text
keryx <verb> ...  ->  cli.ts main()  ->  CLI_ROUTES[verb]  ->  commands/<verb>.ts
                                                       |
                                                       +-> core owners (src/gdgraph, src/wiki, ...)
```

`main()` runs a startup guard, resolves the verb in `CLI_ROUTES`, and hands the
remaining arguments to the handler. A handler reads and writes
`.metaproject/` through the owner for that area, prints a compact result, and
returns an exit code. Help for a group is generated from
`group-subcommands.ts`, so the vocabulary the CLI accepts and the vocabulary the
docs list come from one place.

### The `.metaproject/` workspace

`keryx init` creates `.metaproject/` with one directory per enabled module.
Eleven modules exist (graph, ctx, wiki, skills, health, testing, memory,
tasks, security, MCP, shared agent context); nine are on by default, and
`keryx modules` toggles them. Each module separates three kinds of files:
hand-curated sources (wiki pages, rules, project skills, flow packages),
generated artifacts that are committed (graph summary, wiki index), and
reproducible output that is git-ignored (raw logs, caches). Agents start at
`.metaproject/index.md`, which routes to the right module instead of loading
everything.

### The shell turn loop

```text
user input -> tui / readline -> harness run
   -> provider (anthropic | openai | gemini | ollama | compat | fake)
   -> model emits tool calls
   -> policy engine: allow | ask | deny, by permission mode and tool risk
   -> tool registry -> process executor -> OS sandbox (Seatbelt | bubblewrap)
   -> result and evidence appended to the session log -> next model turn
```

The provider is built by `harness/provider/make-provider.ts`. The policy engine
sits between the model and every tool. The sandbox sits below the policy: policy
decides whether a command may start, the sandbox limits what the running process
can reach. Sessions are append-only logs with resume and fork; `/rewind`
restores files from the shadow snapshots in `src/rewind/`. Subagents and
parallel waves run under a narrower policy and credential scope than their
parent.

### MCP, ACP and integrations

- `keryx serve-mcp` exposes `.metaproject/` as an MCP server: stdio by default,
  loopback HTTP and a `--read-only` mode that hides every mutating tool.
- `keryx integrate <editor>` registers that server in an editor's MCP config.
- `keryx mcp ...` is the opposite direction: it manages third-party MCP servers
  the shell consumes. The old `mcp serve|install|uninstall` spellings still work
  but are retired.
- `keryx acp` runs the Agent Client Protocol server for editors.
- `keryx integrations` installs hooks and instruction blocks into the host
  harnesses listed in `src/integrations/registry.ts`, described by a capability
  matrix that CI checks for drift.
- `keryx serve` is an authenticated HTTP entry for remote turns that binds to loopback by
  default. It is off until configured.

## Invariants

Each statement below is enforced in code or by a test, not only by convention.
Absences matter most: they are what users rely on.

- **No hard runtime dependencies.** `package.json` has `"dependencies": {}`.
  The MCP SDK, the TUI library and tree-sitter are optional dependencies,
  loaded lazily. A missing one degrades the feature rather than failing the
  CLI.
- **Selecting a provider never touches the network.** `makeProvider` only
  constructs an adapter. A hosted provider with no credential resolves to the
  offline fake provider instead of attempting a call, and a child agent sees
  only the credentials its policy grants.
- **Core has no model.** The published library door (`src/core.ts`) re-exports
  owner facades only. `src/core-package.test.ts` builds it with the release
  flags and fails if a provider registry, credential read or model call becomes
  reachable. Core code needing a model turn goes through a port the CLI fills.
- **Core never imports client or adapter code.** The zone table and the
  import-policy tests fail the build on that direction.
- **Flow state is written only through the CLI.** `flow.json` is edited by
  `keryx flow` commands. The agent harness's policy engine denies a write
  that targets a flow state file, even under profiles that otherwise allow
  writes.
- **A requested sandbox is refused, not downgraded.** When the sandbox
  launcher is missing or a requested containment cannot be applied, the run
  fails instead of silently falling back to the host; running unsandboxed takes
  a named override. Real subprocesses from `harness exec` also require an
  explicit flag.
- **Remote and network surfaces are off by default and loopback-first.**
  `serve` binds loopback unless the operator acknowledges otherwise;
  `serve-mcp --http` needs a capability switch; the MCP publisher module is
  disabled until `integrate` enables it.
- **State outside the project lives in three user-level places.** The CLI
  keeps credentials, the project registry, and shell preferences in a single
  keryx config directory, written owner-only (mode 0600) through one resolver
  (`src/lib/config-dir.ts`), and source-level tests fail on code that writes or
  reads there by another route. Personal skills, agents, memory and learned
  patterns live in the user store `~/.keryx/` (or under `$KERYX_HOME`), and
  downloaded assets are cached in `~/.cache/keryx/assets` (or
  `$KERYX_ASSET_CACHE`). Everything else it writes is inside the project's
  `.metaproject/` or the files you ask it to install. Installers
  that put hooks into an editor's settings run only on explicit commands.
- **Bounded output.** Search, read and command output goes through `keryx ctx`,
  which compacts it and keeps the raw log, so an agent's context is not flooded
  and the full text stays recoverable.

## Cross-cutting concerns

**Security scanning.** `src/security/` scans inputs, outputs and `.metaproject/`
artifacts for secrets, personal data and prompt injection with deterministic
rules and entropy analysis; there is no bundled ML classifier. A structural
command guard classifies shell commands before the policy engine sees them.
CI runs `keryx security eval --corpus all` as a false-negative gate.

**Retired spellings.** Renamed commands keep working, which lets docs drift back
to the old names. `scripts/check-retired-cli-spellings.ts` (run as
`bun run check:retired-spellings`) fails when documentation teaches a retired
spelling outside an explicit history row or a declared exemption.

**Documentation checks.** `bun run check:doc-links` verifies Markdown links, and
tests compare the CLI reference with `group-subcommands.ts` so a new subcommand
without documentation fails.

**Tests.** Tests are `*.test.ts` files beside the code they cover. CI splits
them into a model-free core gate (`bun run check:core`: lint, typecheck, core
tests) and a client matrix (terminal, streaming, cancel and resume, runtime).
`bun run check` runs lint, typecheck, script typecheck and the full suite; the
release workflow runs it before publishing.

**Releases.** A `v*` tag on `main` publishes to npm with provenance and builds
standalone binaries for macOS and Linux. Versions are pre-1.0 and change
frequently; see [ROADMAP.md](ROADMAP.md) and the
[changelog](CHANGELOG.md).

## Where to go next

- Contributing a change: [CONTRIBUTING.md](CONTRIBUTING.md).
- Reporting a vulnerability: [SECURITY.md](SECURITY.md).
- Command-level detail: the
  [CLI reference](https://mrciphersmith.github.io/keryx/cli-reference/).
- Design intent for individual features: `docs/requirements/` (historical; may
  differ from shipped behaviour).
