# Complete Installation, Project Setup, and Agent Workflow Guide

This guide takes a new user from prerequisites and global installation through a
fully initialized project, optional integrations, verification, daily operation,
and copy-ready prompts for controlling keryx through an AI coding agent.

For an autonomous, parameterized Gherkin workflow, use the
[Agent Installation Playbook](./agent-installation-playbook.md).

All commands assume a Unix-like shell. Run project commands from the repository
root unless a section says otherwise.

## 1. Prerequisites

Required:

- Git.
- Bun 1.1.0 or newer.
- A project directory, preferably a Git repository.

Optional:

- GitHub CLI (`gh`) for pull-request and issue integrations.
- Ripgrep (`rg`) for `keryx ctx rg`.
- An agent runtime such as Codex, Claude Code, Cursor, OpenCode, Zed, or
  Antigravity.

### Check prerequisites

```bash
git --version
bun --version
gh --version
rg --version
```

If Bun is not installed, follow the current instructions at
<https://bun.sh/docs/installation>. The standard Unix installer is:

```bash
curl -fsSL https://bun.sh/install | bash
```

Restart the shell and verify Bun:

```bash
bun --version
```

## 2. Global keryx installation

The global installer clones keryx into `~/.keryx/keryx`, installs pinned
dependencies when available, and creates `~/.local/bin/keryx`.

### Install globally

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install.sh \
  | bash -s -- --global
```

### Add keryx to `PATH`

For the current shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Persist it for zsh:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
source "$HOME/.zshrc"
```

Persist it for bash:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
source "$HOME/.bashrc"
```

### Verify the installation

```bash
command -v keryx
keryx --version
keryx --help
```

### Install a specific Git ref

Use a release tag or commit instead of `main` when reproducibility matters:

```bash
export KERYX_REF="v0.1.0"
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install.sh \
  | bash -s -- --global
```

Replace `v0.1.0` with the release version approved for the project.

### Alternative Bun global installation

```bash
bun install -g github:MrCipherSmith/keryx
```

Use the repository installer when you want the managed self-update layout under
`~/.keryx`.

## 3. Project-local installation alternative

Use this mode when the project must carry a dedicated runtime under
`.metaproject/runtime/keryx` instead of relying on the global wrapper.

```bash
cd /absolute/path/to/project
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install.sh \
  | bash -s -- --project --yes
```

The project installer clones or refreshes the runtime and immediately runs
`keryx init`. It accepts `--no-gdgraph` and `--no-gdctx` for a reduced setup.

## 4. Initialize a project

### Recommended default initialization

```bash
cd /absolute/path/to/project
keryx init --yes
```

`--yes` accepts recommended non-interactive defaults. The default setup enables:

- gdgraph
- gdctx
- gdwiki
- gdskills
- health
- testing
- memory
- tasks/flow
- security

MCP, tree-sitter symbols, and coverage-map Test Impact Analysis remain opt-in.

### Interactive initialization

```bash
cd /absolute/path/to/project
keryx init
```

Interactive mode asks which modules, hooks, and gdskills profile to enable.

### Fully enabled initialization

```bash
cd /absolute/path/to/project
keryx init --yes --mcp --treesitter --testing-tia
```

This enables manifest capabilities but does not silently download optional assets
or wire MCP clients. Complete those steps in the optional setup sections below.

### Initialization options

| Option | Effect |
|---|---|
| `--yes`, `-y` | Accept recommended defaults without prompts. |
| `--no-gdgraph` | Disable the code graph module. |
| `--no-gdctx` | Disable compact command/search/read output. |
| `--no-gdwiki` | Disable the project wiki. |
| `--no-gdskills` | Do not install bundled agent skills. |
| `--gdskills-profile <profile>` | Select `minimal`, `recommended`, `full`, or `custom`. |
| `--no-health` | Disable Code Health. |
| `--no-testing` | Disable the Testing Module. |
| `--no-memory` | Disable project memory. |
| `--no-tasks` | Disable Task Manager/flow. |
| `--no-security` | Disable Metaproject Security. |
| `--no-*-hook` | Disable the named hook during initialization. |
| `--mcp` / `--no-mcp` | Enable or disable the optional MCP module. |
| `--treesitter` / `--no-treesitter` | Enable or disable the optional symbol layer. |
| `--testing-tia` / `--no-testing-tia` | Enable or disable coverage-map TIA. |

## 5. Build the initial project context

Run these commands after initialization.

### Build the code graph

```bash
keryx gdgraph build
```

Writes file nodes and edges, a module map, and a human-readable summary.

### Analyze the test stack

```bash
keryx test analyze
```

Detects frameworks, scripts, test files, CI configuration, and testing
conventions without running the suite.

### Run the full test suite

```bash
keryx test run --strict
```

Runs the configured project test command and writes a normalized report.

### Run Code Health

```bash
keryx health run --strict
```

Aggregates configured quality sources and evaluates the strict project gate.

### Collect and validate the wiki

```bash
keryx wiki collect --force
keryx wiki index
keryx wiki check-links
keryx wiki validate
```

`collect --force` refreshes generated drafts that remain CLI-owned. Accepted or
human-owned pages are preserved.

### Build the dashboard

```bash
keryx dashboard build
```

Creates `.metaproject/keryx-dashboard.html` from existing service files and
module artifacts.

### Validate the workspace

```bash
keryx standard validate
keryx standard doctor
keryx security policy validate
keryx flow check
```

Do not treat setup as complete until required validation commands pass or every
failure is explicitly documented.

## 6. Configure agent runtimes

There are four independent integrations:

1. Global bootstrap: tells the agent to discover `.metaproject/index.md`.
2. Orientation: injects a bounded graph + wiki map at turn start.
3. gdctx routing guard: redirects broad raw commands to compact context commands.
4. Security hooks: checks agent input/output at supported runtime seams.

### Install the global bootstrap

Install for every supported runtime:

```bash
keryx agents bootstrap install --runtime all
```

Check status:

```bash
keryx agents bootstrap status --runtime all
```

Preview without writing:

```bash
keryx agents bootstrap install --runtime codex --dry-run
```

Supported bootstrap runtimes: `claude`, `opencode`, `zcode`, `codex`, and
`antigravity`.

### Install turn-start orientation

Codex:

```bash
keryx orient install-hook --runtime codex
```

Claude Code:

```bash
keryx orient install-hook --runtime claude
```

Cursor:

```bash
keryx orient install-hook --runtime cursor
```

Emit the orientation without installing a hook:

```bash
keryx orient codex
```

Compatible orientation hooks currently exist for Claude, Codex, and Cursor.

### Install the gdctx routing guard

```bash
keryx ctx install-hook --runtime all
```

Remove it:

```bash
keryx ctx uninstall-hook --runtime all
```

The guard blocks broad raw `rg`, `grep`, `cat`, and git-diff/log/show reads in
supported harnesses and points the agent to `keryx ctx` alternatives.

### Install security hooks

```bash
keryx security hooks install --runtime all
```

Remove them:

```bash
keryx security hooks uninstall --runtime all
```

Security-hook runtimes: `claude`, `cursor`, `windsurf`, and `generic-mcp`.

## 7. Configure optional MCP integration

MCP is disabled by default and requires `@modelcontextprotocol/sdk` to serve.

### Enable during initialization

```bash
keryx init --yes --mcp
```

### Wire Cursor

```bash
keryx mcp install --runtime cursor
```

### Wire Claude Code

```bash
keryx mcp install --runtime claude
```

### Preview MCP configuration

```bash
keryx mcp install --runtime all --dry-run
```

### Start the server manually

```bash
keryx mcp serve --cwd /absolute/path/to/project
```

The default transport is stdio. HTTP/SSE is isolated, localhost-only, and must
also be enabled by capability configuration:

```bash
keryx mcp serve --http --cwd /absolute/path/to/project
```

## 8. Configure the optional symbol layer

The file graph always works. Tree-sitter symbols and call edges are opt-in.

### Enable symbols

```bash
keryx gdgraph symbols enable
```

### Pull pinned grammar assets

```bash
keryx gdgraph assets pull tree-sitter-typescript
keryx gdgraph assets pull tree-sitter-tsx
keryx gdgraph assets pull tree-sitter-javascript
```

### Rebuild and verify

```bash
keryx gdgraph build
keryx gdgraph symbols status
keryx gdgraph symbol "<exact-symbol-name>"
```

If an optional dependency or grammar is unavailable, keryx keeps the
deterministic file graph and reports how to finish activation.

## 9. Configure optional coverage-map TIA

```bash
keryx test coverage-map build
keryx test coverage-map status
```

Use changed-scope test selection after a coverage map exists:

```bash
keryx test run --changed --strict
```

## 10. One-block recommended project setup

Copy this block for a standard project with Codex integration:

```bash
cd /absolute/path/to/project
keryx init --yes
keryx agents bootstrap install --runtime codex
keryx orient install-hook --runtime codex
keryx ctx install-hook --runtime codex
keryx gdgraph build
keryx test analyze
keryx test run --strict
keryx health run --strict
keryx wiki collect --force
keryx wiki index
keryx wiki check-links
keryx wiki validate
keryx dashboard build
keryx standard validate
keryx security policy validate
keryx flow check
```

Codex does not currently have a dedicated security-hook adapter. Security CLI
gates and Git hooks still apply; use the runtime security-hook installer only for
the supported runtimes listed in section 6.

## 11. Command reference

### Core lifecycle

| Command | Description |
|---|---|
| `keryx init [options]` | Initialize or reconcile `.metaproject`. |
| `keryx status` | Show workspace readiness and enabled modules. |
| `keryx modules` | Interactive module management in a TTY; status otherwise. |
| `keryx modules status` | Show enabled/disabled modules. |
| `keryx modules enable <name>` | Enable and scaffold a module. |
| `keryx modules disable <name>` | Disable a module in the manifest. |
| `keryx update` | Update a managed runtime and refresh service files. |
| `keryx update --skip-runtime` | Refresh local service files without fetching runtime updates. |
| `keryx update --hooks` | Refresh and run executable post-update hooks. |
| `keryx dashboard build` | Rebuild the offline HTML dashboard. |
| `keryx dashboard open` | Rebuild and open the dashboard. |
| `keryx dash` | Alias for dashboard open. |

### Rules and agent startup

| Command | Description |
|---|---|
| `keryx rules sync` | Import root agent entrypoints and refresh managed routing blocks. |
| `keryx rules distill` | Split large entrypoints into high-priority rules and project skills. |
| `keryx agents bootstrap status --runtime <id|all>` | Check global bootstrap state. |
| `keryx agents bootstrap install --runtime <id|all>` | Install or update the global discovery block. |
| `keryx agents bootstrap uninstall --runtime <id|all>` | Remove only the managed global block. |
| `keryx agents bootstrap print` | Print the block for manual installation. |
| `keryx orient [<runtime>]` | Emit bounded graph + wiki startup context. |
| `keryx orient install-hook --runtime <id|all>` | Install compatible orientation hooks. |
| `keryx orient uninstall-hook --runtime <id|all>` | Remove managed orientation hooks. |

### gdgraph

| Command | Description |
|---|---|
| `keryx gdgraph build` | Build file graph and optional symbol/call artifacts. |
| `keryx gdgraph query cycles` | Print import cycles. |
| `keryx gdgraph query orphans` | Print nodes without resolved graph relationships. |
| `keryx gdgraph find "<terms>"` | Find files and available symbols by concept/name. |
| `keryx gdgraph symbol "<name>"` | Show definitions, callers, callees, and wiki links. |
| `keryx gdgraph symbol "<name>" --impact --depth N` | Show transitive caller impact. |
| `keryx gdgraph symbols enable|disable|status` | Control or inspect the optional symbol layer. |
| `keryx gdgraph path "<A>" "<B>"` | Find the shortest file/symbol path. |
| `keryx gdgraph affected <file-or-symbol>` | Show dependencies and dependents. |
| `keryx gdgraph affected <target> --depth N --ranked` | Compute a ranked transitive blast radius. |
| `keryx gdgraph repomap --budget N` | Write a token-budgeted repository map. |
| `keryx gdgraph repomap --changed` | Bias the map toward changed files. |
| `keryx gdgraph context` | Emit the graph orientation fragment. |
| `keryx gdgraph assets list` | Show declared graph assets and availability. |
| `keryx gdgraph assets verify [<id>]` | Verify asset checksums. |
| `keryx gdgraph assets pull <id>` | Explicitly download and verify one asset. |

### gdctx

| Command | Description |
|---|---|
| `keryx ctx status` | Show gdctx configuration and data locations. |
| `keryx ctx diff [--staged|--stat]` | Summarize Git changes and save raw output. |
| `keryx ctx rg "<pattern>"` | Run bounded repository text search. |
| `keryx ctx read <file> --mode outline` | Extract structural outline and markers. |
| `keryx ctx read <file> --mode compact` | Read bounded head/tail context. |
| `keryx ctx read <file> --mode full` | Read the complete file explicitly. |
| `keryx ctx run -- <command...>` | Run a command and compact its output. |
| `keryx ctx show latest` | Show the latest summary artifact. |
| `keryx ctx show latest --raw` | Show the associated saved raw output. |
| `keryx ctx install-hook --runtime <id|all>` | Install routing guards. |
| `keryx ctx uninstall-hook --runtime <id|all>` | Remove routing guards. |

### gdwiki

| Command | Description |
|---|---|
| `keryx wiki status` | Show page counts and last index/link-check state. |
| `keryx wiki new <type> <slug> --title "<title>"` | Create a typed wiki page. |
| `keryx wiki collect` | Create missing generated drafts. |
| `keryx wiki collect --force` | Refresh CLI-owned drafts and rebuild the index. |
| `keryx wiki collect --changed --since <ref>` | Collect only changed graph areas. |
| `keryx wiki index` | Rebuild the hierarchical page index. |
| `keryx wiki check-links` | Check internal wiki links. |
| `keryx wiki validate` | Validate metadata, links, and index freshness. |
| `keryx wiki ask "<question>" --k N` | Retrieve a cited answer from local knowledge. |
| `keryx wiki context` | Emit the wiki orientation fragment. |
| `keryx wiki backlinks <wiki-page-or-code-file>` | Show knowledge and graph backlinks. |

Page types: `architecture`, `domain-model`, `business-rule`, `user-scenario`,
`component`, `service`, `integration`, and `decision`.

### gdskills

| Command | Description |
|---|---|
| `keryx skills status [--json]` | Show installed gdskills state. |
| `keryx skills list` | List registered project skills. |
| `keryx skills inspect <project-skill>` | Inspect one skill package. |
| `keryx skills route <query-or-target>` | Rank skills for a request or path. |
| `keryx skills catalog --profile <profile>` | Print the bundled profile catalog. |
| `keryx skills install --profile <profile>` | Install a skill profile. |
| `keryx skills create <target> --module <module> --name <name>` | Create and register a project skill. |
| `keryx skills generate ...` | Alias for `skills create`. |
| `keryx skills verify <skill-or-target>` | Verify a project skill against evidence. |
| `keryx skills verify --all` | Verify all registered project skills. |
| `keryx skills learn --from-review <path> --skill <module>/<skill>` | Create a review-derived learning proposal. |
| `keryx skills learn apply <proposal.json>` | Apply an approved learning proposal. |
| `keryx skills export <skill> --runtime codex|claude` | Export a runtime artifact. |
| `keryx skills sync --runtime <id> --target <dir>` | Sync exports to an explicit directory. |
| `keryx skills contracts list` | List JSON communication contracts. |
| `keryx skills contracts validate <file> --schema <name>` | Validate an artifact contract. |

### Code Health

| Command | Description |
|---|---|
| `keryx health run [--strict]` | Collect quality sources and evaluate health. |
| `keryx health run --changed --since <ref>` | Scope findings to changed files. |
| `keryx health status` | Show the latest normalized health state. |
| `keryx health gate --strict-warn` | Return a CI-compatible gate exit code. |
| `keryx health sources` | Show configured source availability. |
| `keryx health explain <file-or-module>` | Explain findings for a scope. |
| `keryx health baseline update` | Accept the current health baseline explicitly. |
| `keryx health trend --limit N` | Show recent score history. |

### Testing

| Command | Description |
|---|---|
| `keryx test init` | Initialize testing configuration. |
| `keryx test analyze` | Detect test frameworks, files, scripts, and conventions. |
| `keryx test run [--strict]` | Run and normalize the project test command. |
| `keryx test run --changed --since <ref>` | Run changed-scope tests. |
| `keryx test run --scope <path> --kind <kind>` | Restrict path and test kind. |
| `keryx test status` | Show current testing state and latest result. |
| `keryx test context` | Print normalized testing context. |
| `keryx test explain <file-or-scope>` | Explain related testing evidence. |
| `keryx test related <file>` | Find related tests. |
| `keryx test report latest [--json]` | Print the latest normalized report. |
| `keryx test coverage-map build` | Build coverage-based impact data. |
| `keryx test coverage-map status` | Show coverage-map availability. |

Test kinds: `unit`, `integration`, `e2e`, and `smoke`.

### Memory

| Command | Description |
|---|---|
| `keryx memory new <type> --title "<title>"` | Create a typed draft memory entry. |
| `keryx memory index [--embeddings]` | Rebuild deterministic and optional semantic indexes. |
| `keryx memory search "<query>"` | Search current project memory. |
| `keryx memory search "<query>" --status accepted` | Restrict results to accepted knowledge. |
| `keryx memory search "<query>" --as-of <date>` | Search historical validity state. |
| `keryx memory supersede <old> --by <new>` | Non-destructively replace an entry. |
| `keryx memory assets list|verify|pull [<id>]` | Manage optional memory assets. |
| `keryx memory ingest --from-review <path>` | Derive proposed memory from review evidence. |
| `keryx memory ingest --from-health <path>` | Derive proposed memory from health evidence. |
| `keryx memory check` | Validate memory integrity and relationships. |
| `keryx memory reflect` | Create pattern drafts from repeated accepted evidence. |

Memory types include `lesson`, `decision`, `constraint`, `known-mistake`,
`historical-context`, `pattern`, `task-note`, `review-note`, `incident`,
`migration-note`, and `integration-note`.

### Task Manager / flow

| Command | Description |
|---|---|
| `keryx flow init --issue <url>` | Create a managed flow from an issue. |
| `keryx flow init --title "<title>"` | Create a local managed flow. |
| `keryx flow list` | List flows and status. |
| `keryx flow status <id>` | Show one flow. |
| `keryx flow freeze <id>` | Freeze acceptance criteria and mark ready. |
| `keryx flow start <id>` | Start implementation. |
| `keryx flow task add <id> --title "<title>" --kind <kind>` | Add an atomic flow task. |
| `keryx flow task done <id> <taskId>` | Complete a flow task. |
| `keryx flow ac confirm <id> <ACn> --note "<evidence>"` | Confirm an acceptance criterion. |
| `keryx flow ac update <id> --reason "<reason>"` | Re-freeze changed criteria. |
| `keryx flow implemented <id> --pr <url>` | Record implementation and PR. |
| `keryx flow complete <id> [--comment]` | Run completion gates and finish. |
| `keryx flow block <id> --reason "<reason>"` | Block a flow. |
| `keryx flow unblock <id>` | Restore the previous status. |
| `keryx flow check` | Audit all flow packages. |

Task kinds: `context`, `implement`, `test`, `review`, and `docs`.

### Managed review

| Command | Description |
|---|---|
| `keryx review attach --flow <id> --target <kind> --ref <ref>` | Attach a review package to a flow. |
| `keryx review start --target <kind> --ref <ref>` | Start a standalone managed review. |
| `keryx review ingest --report <path> --ref <ref>` | Convert a report into a managed package. |
| `keryx review status <review-id-or-path>` | Show review lifecycle and coverage. |
| `keryx review complete <review-id-or-path>` | Validate required artifacts and complete. |
| `keryx review lightweight` | Use report-only mode without managed artifacts. |

### Metaproject Standard

| Command | Description |
|---|---|
| `keryx standard validate` | Validate the workspace contract. |
| `keryx standard doctor` | Print actionable repair guidance. |
| `keryx standard capabilities` | Show version, profiles, and active modules. |
| `keryx standard emit llms` | Generate deterministic `llms.txt`. |
| `keryx standard emit llms --stdout` | Print the generated content. |

### Security

| Command | Description |
|---|---|
| `keryx security status` | Show effective mode, policy, and checksum state. |
| `keryx security scan <path> [--json]` | Scan a file or directory. |
| `keryx security scan-mcp <manifest-or-dir> [--strict]` | Scan MCP tool metadata. |
| `keryx security check-input --source <kind> --file <path>` | Check incoming content. |
| `keryx security check-output --target <kind> --file <path>` | Check generated content. |
| `keryx security redact <path> [--out <path>]` | Write or print redacted content. |
| `keryx security report --since <ref>` | Summarize existing security findings. |
| `keryx security policy validate` | Validate schema and config checksum. |
| `keryx security incidents --limit N` | List recent security incidents. |
| `keryx security hooks install --runtime <id|all>` | Install runtime security hooks. |
| `keryx security hooks uninstall --runtime <id|all>` | Remove managed hooks. |
| `keryx security eval --corpus all` | Run deterministic security corpora. |
| `keryx security eval --corpus all --with-model` | Include configured model backends. |

### MCP

| Command | Description |
|---|---|
| `keryx mcp serve [--cwd <root>]` | Serve MCP over stdio. |
| `keryx mcp serve --http [--cwd <root>]` | Serve isolated localhost HTTP/SSE. |
| `keryx mcp install --runtime <id|all>` | Merge keryx into client configuration. |
| `keryx mcp install --runtime <id|all> --dry-run` | Preview client changes. |
| `keryx mcp uninstall --runtime <id|all>` | Remove only the managed keryx server. |

## 12. Daily command workflows

### After pulling repository changes

```bash
keryx update --skip-runtime
keryx gdgraph build
keryx test analyze
keryx wiki collect --changed
keryx wiki index
keryx dashboard build
keryx standard validate
```

### Before committing

```bash
keryx ctx diff --stat
keryx test run --changed --strict
keryx health run --changed --strict
keryx wiki check-links
keryx wiki validate
keryx security report
git diff --check
```

### Before release

```bash
keryx test run --strict
keryx health run --strict
keryx standard validate
keryx standard doctor
keryx wiki check-links
keryx wiki validate
keryx memory check
keryx flow check
keryx security policy validate
keryx security eval --corpus all
bun run typecheck
bun run build
bun pm pack --dry-run
```

Every required command must pass before versioning and tagging.

## 13. Copy-ready prompts for an AI coding agent

These prompts use natural language. The agent is expected to discover and run
the correct keryx commands itself.

### Initialize keryx in a project

```text
Initialize and fully configure keryx in this repository using recommended defaults.
Read .metaproject/index.md immediately after initialization. Build the graph, analyze
the test stack, collect and validate the wiki, run Standard and security validation,
and report every enabled module and any failed gate. Do not commit or push.
```

### Refresh an existing project after a pull

```text
Refresh the existing Metaproject service files without replacing project data.
Then rebuild gdgraph, re-analyze testing context, collect changed wiki drafts,
rebuild the dashboard, and validate the workspace. Summarize only material changes
and blockers. Preserve all user-authored wiki, memory, and flow content.
```

### Orient before investigating code

```text
Read .metaproject/index.md first. Use the project graph and wiki to orient yourself
before reading source files. Show the relevant modules, existing wiki pages, graph
relationships, accepted memory, and test context for <TOPIC>. Use keryx ctx for
searches and large outputs; do not run broad raw grep or cat commands.
```

### Find a feature or symbol

```text
Find everything related to <FEATURE_OR_SYMBOL>. Start with keryx gdgraph find,
then inspect exact symbols and affected paths when the symbol layer is available.
Use wiki backlinks and accepted memory for design context. Verify conclusions in
source code and return the smallest relevant file set with relationship explanations.
```

### Explain architecture

```text
Explain how <AREA_OR_FLOW> works in this repository. Read the wiki index first,
open only relevant pages, use gdgraph paths and affected context to connect concepts
to code, and verify claims against source. Include entry points, data flow, state
ownership, failure handling, tests, and known constraints. Do not modify files.
```

### Enrich wiki drafts with the `gdwiki` skill

Use this prompt for a controlled enrichment batch. The `gdwiki` skill treats
wiki prose generation as bounded synthesis, so it should use a cheaper,
non-flagship model and reserve a stronger model only for sample review.

```text
Use the project-local gdwiki skill to enrich up to <BATCH_SIZE> highest-priority
draft wiki pages. Read .metaproject/index.md and the gdwiki SKILL.md first.

Prepare deterministically: refresh gdgraph only if stale, run keryx wiki collect,
and rebuild the wiki index. Prioritize draft pages by their Depended on by graph
signal. For each page, read only the Key files listed in its generated Reference
section plus the minimum additional code needed to verify claims.

Use a cheap/non-flagship model for page enrichment. If subagents and per-agent
model assignment are available, dispatch one independent subagent per page and
keep the batch bounded. Fill Overview, How it works, Key concepts, and Main flows;
preserve the generated Reference section exactly. Ground every claim in code,
set completed pages to Status: accepted, and bump their versions.

Review a sample for factual accuracy, then run keryx wiki index, keryx wiki
check-links, and keryx wiki validate. Report pages enriched, pages still draft,
the model strategy used, validation results, and the recommended next batch.
Do not commit or push.
```

### Short wiki enrichment prompt

```text
Use the local gdwiki skill to enrich the next <COUNT> highest-priority draft wiki
pages. Use a cheap model, one page per independent subagent when available, read
only each page's Key files, preserve its generated Reference section, ground all
claims in code, mark completed pages accepted, then reindex and validate the wiki.
Do not commit or push.
```

### Enrich wiki pages affected by recent changes

```text
Use the local gdwiki skill to update wiki coverage for changes since <GIT_REF>.
Run keryx wiki collect --changed --since <GIT_REF>, enrich only the newly created
or refreshed draft pages, and use a cheap/non-flagship model for the prose work.
Preserve generated Reference sections, verify claims against the listed Key files,
mark completed pages accepted with bumped versions, then run wiki index,
check-links, and validate. Report changed pages, remaining drafts, and failures.
Do not commit or push.
```

### Implement a feature through Task Manager

```text
Create or resume a keryx flow for <ISSUE_OR_FEATURE>. Freeze explicit acceptance
criteria before implementation, create atomic context/implementation/test/review/docs
tasks, and keep flow state changes inside the keryx flow CLI. Implement on a feature
branch, run changed-scope tests and health checks, update documentation, and stop
before commit, push, or PR creation unless I approve them.
```

### Diagnose a bug without modifying code

```text
Diagnose <BUG_OR_FAILURE> without implementing a fix. Read .metaproject/index.md,
use gdgraph for affected relationships, gdctx for logs/searches, testing context for
related tests, health for normalized findings, and memory for accepted constraints.
Return the root cause, evidence, affected files, risk, and the smallest safe fix plan.
```

### Review current branch changes

```text
Review the current branch against its merge base. Use keryx ctx for the diff and
gdgraph affected for changed exported symbols and shared modules. Check logic,
architecture, security, performance, testing, and repository conventions. Produce
only actionable findings with severity, file, line, evidence, and a concrete fix.
Do not modify code unless I explicitly approve fixes.
```

### Create a managed review package

```text
Run a managed review for <TARGET_KIND> <TARGET_REF>. If a matching flow exists,
attach the review to it; otherwise create a standalone review package. Record every
selected and skipped reviewer, findings, decisions, report, and learning candidates.
Validate the package before completion and report its path and status.
```

### Update documentation from current implementation

```text
Update the English-only documentation for <AREA>. Treat current source and live CLI
help as the source of truth, use the wiki and graph for navigation, and distinguish
implemented behavior from planned requirements. Update documentation indexes, check
all local links, scan changed documentation for Cyrillic, and produce a change report.
Do not commit or push.
```

### Audit repository cleanup before release

```text
Perform a non-destructive release cleanup audit. Check typecheck, full tests, build,
package dry-run, Standard validation, strict Code Health, wiki links, memory integrity,
flow consistency, security policy/eval, generated-file policy, package contents,
duplicate skill variants, completed work artifacts, stale plans, dead links, legacy
branding, and non-English text. Classify cleanup as P0/P1/P2, identify what must not
be deleted blindly, and do not remove anything without separate approval.
```

### Prepare a release after all blockers are fixed

```text
Prepare release <VERSION> without publishing it. Verify every required gate, confirm
the working tree and package contents, update the English changelog and version badge,
bump package metadata consistently, generate release notes, and provide the exact
commit/tag/publish commands for approval. Stop before commit, tag, push, package
publication, or GitHub release creation.
```

### Record a durable decision

```text
Record the accepted decision about <DECISION> in keryx memory. Search for duplicates
and conflicts first, choose the correct memory type and scope, cite the source or
issue, keep the entry in draft unless acceptance is explicit, rebuild the memory
index, run memory check, and report the created path.
```

### Verify a change before handoff

```text
Verify the current changes without editing them. Run the complete applicable gate:
diff hygiene, typecheck, tests, build, related-test discovery, wiki links, Standard,
strict Code Health, security policy, and package dry-run when packaging is affected.
Return a structured PASS/FAIL result with exact commands, failures, affected files,
and release impact.
```

## 14. Troubleshooting

### `bun: command not found`

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

### `keryx: command not found`

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v keryx
```

### `.metaproject` is missing

```bash
cd /absolute/path/to/project
keryx init --yes
```

### Graph output is stale

```bash
keryx gdgraph build
keryx gdgraph context
```

### Symbol commands show no symbols

```bash
keryx gdgraph symbols status
keryx gdgraph symbols enable
keryx gdgraph assets list
keryx gdgraph build
```

### Wiki index or links are stale

```bash
keryx wiki collect --force
keryx wiki index
keryx wiki check-links
keryx wiki validate
```

### Standard validation fails

```bash
keryx standard validate
keryx standard doctor
keryx standard capabilities
```

### MCP SDK is missing

```bash
bun add @modelcontextprotocol/sdk
keryx mcp serve --cwd /absolute/path/to/project
```

### Update cannot write Git hooks

Run the command in a shell with permission to write `.git/hooks`, or refresh
service files without executing hooks:

```bash
keryx update --skip-runtime
```

## 15. Expected project artifacts

After full setup, expect these key paths:

```text
.metaproject/
├── index.md
├── metaproject.json
├── keryx-dashboard.html
├── assets.lock.json
├── rules/
├── skills/
├── project-skills/
├── wiki/
├── memory/
├── flows/
├── reviews/
├── modules/
├── hooks/
└── data/
```

Commit durable, agent-facing context according to the managed `.gitignore`
policy. Do not commit local runtime clones, raw logs, raw security data, temporary
locks, or reproducible storage artifacts.

## 16. Setup completion checklist

- [ ] `keryx --version` works from a new shell.
- [ ] `.metaproject/index.md` exists and is referenced from agent entrypoints.
- [ ] Required modules are enabled.
- [ ] Global bootstrap status is current for the selected runtime.
- [ ] Orientation and routing/security hooks are installed where desired.
- [ ] The graph builds with zero unresolved relative imports.
- [ ] Testing context reflects the current test stack.
- [ ] Full tests pass.
- [ ] Strict Code Health passes or every unavailable source is explicitly fixed.
- [ ] Wiki links and validation pass.
- [ ] Standard validation passes.
- [ ] Security policy validation passes.
- [ ] Flow consistency passes.
- [ ] Optional MCP, symbol, and TIA capabilities are verified if enabled.
- [ ] The dashboard is current.
- [ ] Repository documentation is English-only.
- [ ] No commit, push, tag, or release has occurred without explicit approval.
