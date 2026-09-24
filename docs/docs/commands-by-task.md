# Commands by task

Every `keryx` CLI verb and every `keryx shell` command, grouped by task — the same grouping `keryx help` and the OpenTUI shell's `/help` modal use (`src/standard/help-groups.ts`, flow 303).

Generated. Do not hand-edit: regenerate with `bun scripts/generate-commands-by-task.ts`, and `src/standard/commands-by-task.test.ts` fails when this page drifts from the table it is generated from.

## Start here

| CLI command | Summary |
|---|---|
| `keryx init` | Initialize .metaproject in the current project. |
| `keryx status` | Show local Metaproject status. |
| `keryx shell` | Start the interactive TUI agent harness (--no-tui or --chat to opt out). |
| `keryx help` | Grouped command help by task — keryx help [group\|command]. |

| Shell command | Summary |
|---|---|
| `/help` | Show available commands, grouped by task. |

## Connect a model provider

| CLI command | Summary |
|---|---|
| `keryx auth` | Subscription login (SuperGrok, ChatGPT Plus/Pro, GitHub Copilot) and API-key status. |
| `keryx providers` | Providers this operator has configured, and cross-family review eligibility. |

| Shell command | Summary |
|---|---|
| `/connect` | Switch provider; row buttons test/disconnect it. |
| `/search-provider` | Configure and test a web search provider. |
| `/search-connect` | Select a connected web search provider. |
| `/provider` | Switch provider — /provider <name>, or no arg to re-select. |

## Look and feel

| Shell command | Summary |
|---|---|
| `/theme` | Open the theme picker — /theme [name] applies immediately. |
| `/model` | Switch the model. |
| `/models` | Pick a model for the current provider (numbered menu). |
| `/mode` | Show or switch the permission mode — /mode [ask\|trust\|auto]. |
| `/think` | Expand the last reasoning block — /think [auto\|expand\|hide\|collapse]. |
| `/reasoning` | Show or set reasoning effort — /reasoning [off\|minimal\|low\|medium\|high\|xhigh\|max]. |

## Working in keryx shell

| CLI command | Summary |
|---|---|
| `keryx sessions` | List or export per-project shell sessions. |

| Shell command | Summary |
|---|---|
| `/sessions` | Open the session list and switch to one. |
| `/resume` | Resume a prior session in this project. |
| `/new` | Start a new session (old kept on disk). |
| `/clear` | New session (alias of /new). |
| `/compact` | Compact model context — /compact [focus] (archive kept). |
| `/copy` | Copy the newest transcript block to the clipboard. |
| `/expand` | Expand the last tool output block. |
| `/status` | Show session identity, context window, limits, workspaces, and flows. |
| `/queue` | Manage the main queue — /queue <remove\|edit\|force> [N] (N = qN position, default 1). |
| `/interrupt` | Interrupt the running main agent turn. |
| `/exit` | Leave the shell (/quit works too). |
| `/game` | Games against the model — /game [seconds] raises the model-turn deadline. |

## Project knowledge

| CLI command | Summary |
|---|---|
| `keryx gdgraph` | Build and query the code dependency graph. |
| `keryx ctx` | Run compact context commands and save raw output. |
| `keryx wiki` | Manage the local project knowledge base. |
| `keryx memory` | Store and search long-term project memory. |
| `keryx orient` | Emit a bounded graph + wiki startup block, or install it as a turn-start hook. |
| `keryx skills` | Manage bundled Metaproject working skills. |
| `keryx stack` | Deterministic, offline stack detection — keryx stack detect. |

## Managed work

| CLI command | Summary |
|---|---|
| `keryx flow` | Agent-first flow lifecycle (Task Manager). |
| `keryx job` | Agent-first job packages (job-orchestrator state, steps, documents). |
| `keryx review` | Managed review packages and lightweight report-only review mode. |

| Shell command | Summary |
|---|---|
| `/flows` | Browse project flows and inspect one. |
| `/review` | Show project-wide items needing review (proposals, blocked sessions). |
| `/plan` | Toggle read-only mode — /plan [on\|off]. |
| `/goal` | Deterministically start a goal — /goal <text> [--workspace <id>] [--auto [N]]. |

## Automation

| CLI command | Summary |
|---|---|
| `keryx trigger` | Fire one declared project trigger (git hook, cron line, CI job) — one pass, one exit code. |
| `keryx schedule` | Scheduled agent tasks in the background: create (with confirmation), list, pause, resume, remove. |
| `keryx governance` | Read-only report over already-recorded spend, confirmations, signatures and gate outcomes. |

| Shell command | Summary |
|---|---|
| `/triggers` | Declared triggers: last outcome, spend, reservations — run one now. |
| `/schedule` | Schedule a background agent task — shows a confirmation card first (keryx schedule add). |
| `/schedules` | Scheduled tasks: next run, last outcome, report — pause, resume, run now, delete. |
| `/governance` | Show the last governance report, or run one in the background. |

## External agents, ACP and MCP

| CLI command | Summary |
|---|---|
| `keryx acp` | Speak ACP v1 (newline-delimited JSON-RPC) over stdio, for an ACP client (e.g. an editor). |
| `keryx agents` | Manage optional global agent bootstrap instructions. |
| `keryx mcp` | Retired spelling of serve-mcp / integrate; still works, names its replacement. |
| `keryx integrate` | Wire this project into an editor or agent as an MCP server. |
| `keryx integrations` | Install, audit and uninstall Keryx's hooks and instructions in another coding agent. |
| `keryx serve-mcp` | Expose Metaproject services over the Model Context Protocol (opt-in). |
| `keryx bus` | Agent bus: list peers and leases, read the log, send a message, prune. |
| `keryx workspace` | Shared Agent Context: workspaces, FWK reads, propose/review (module sac). |

| Shell command | Summary |
|---|---|
| `/delegate` | Hand a task to an external agent CLI — /delegate <agent> <task>. |
| `/demote` | Move a running foreground task to the background — /demote <task_id>. |
| `/mcp` | MCP servers keryx is connected to — status, connect/disconnect. |
| `/integrations` | Wire this project into an editor over MCP (keryx integrate). |
| `/bus` | Message or view peers on the project agent bus — /bus @<name> <text>. |
| `/workspace` | Show this session's SAC workspace and its slates. |

## Maintenance and diagnostics

| CLI command | Summary |
|---|---|
| `keryx health` | Aggregate code quality signals and run the quality gate. |
| `keryx test` | Analyze testing context and normalize test reports. |
| `keryx standard` | Validate the workspace against the Metaproject Standard. |
| `keryx update` | Refresh managed service files without touching data artifacts. |
| `keryx sync` | Reconcile graph/wiki/memory with the current code, and wire the git hooks. |
| `keryx security` | Policy-based scanning, redaction, guardrails and audit reports. |
| `keryx dashboard` | Build or open the project admin dashboard. |
| `keryx dash` | Rebuild and open .metaproject/keryx-dashboard.html. |
| `keryx metrics` | Provenance-aware execution observability: run records, baselines, benchmarks. |
| `keryx sandbox` | Report OS sandbox launcher availability and the per-capability containment matrix. |
| `keryx modules` | View and toggle Metaproject modules (interactive). |
| `keryx projects` | Inspect the user-global registry of initialized projects. |
| `keryx serve` | Loopback-bound authenticated HTTP entry (off by default; read-only routes). |
| `keryx rules` | Sync root AGENTS.md/CLAUDE.md into high-priority project rules. |
| `keryx harness` | Run a single provider turn (harness run) and print structured events. |
| `keryx version` | Check whether a newer npm release is available. |
| `keryx retention` | Bound stores that grow without bound (gdctx raw/artifacts, owner write-conflict sidecars). |
| `keryx forgetting` | Read the deletion trail — was this removed, or did it never exist? |
| `keryx commands` | Agent-callable command registry (intents, args, output, model usage). |
