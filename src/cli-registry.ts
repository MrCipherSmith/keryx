// A-2 (flow 356, audit remediation 3): `CLI_ROUTES` and `printCommandHelp`,
// split out of `cli.ts` — every command import that dispatch needs, the flat
// `USAGE_BODY` text, and the help-interception machinery that reads it.
//
// WHY THIS FILE EXISTS
//
// `cli.ts` used to hold `CLI_ROUTES` directly, and `commands/help.ts` (an
// adapter, like every other command module) imported `CLI_ROUTES`/
// `printCommandHelp` back from it — `cli.ts` -> `commands/help.ts` (for
// `helpCommand`, one `CLI_ROUTES` entry among ~60) -> `cli.ts` (for
// `CLI_ROUTES`/`printCommandHelp`), a cycle that grew with every command
// `cli.ts` gained (A-2). Moving the two exports here alone would only have
// relocated the SAME cycle onto this file (`commands/help.ts` still needs
// `CLI_ROUTES` to check `arg in CLI_ROUTES`, and `CLI_ROUTES` still needs
// `helpCommand` as its `help` entry) — the fix is that `help` is NOT a
// static import of `commands/help.ts` here. It is a dynamic
// `import("./commands/help")`, resolved only when the route actually runs.
// `keryx gdgraph query cycles`'s load-order adjacency (and
// `import-policy.ts`'s own comment on `dynamic-import`) both deliberately
// exclude a dynamic import from cycle detection: it resolves at CALL time,
// not at module-load time, so it cannot close a load-order cycle the way a
// static edge can. `commands/help.ts` statically imports `CLI_ROUTES`/
// `printCommandHelp` from here as normal; this file never statically imports
// `commands/help.ts` back.
//
// `cli.ts` keeps `main()`, `printHelp()`, `exitCodeForError()` and the
// startup safety guard, and imports everything below from here.
// retired-spellings-ok: file — help text still lists the retired usage lines because those invocations still work; removing them would hide a working command (moved here from cli.ts, flow 356)

import { runModelTurn } from "./harness/provider/single-turn";
import { setModelTurnPort } from "./sac/model-turn-port";
import { initCommand } from "./commands/init";
import { ctxCommand } from "./commands/ctx";
import { gdgraphCommand } from "./commands/gdgraph";
import { wikiCommand } from "./commands/wiki";
import { orientCommand } from "./commands/orient";
import { syncCommand } from "./commands/sync";
import { skillVerifySkillCommand, skillsCommand } from "./commands/skills";
import { healthCommand } from "./commands/health";
import { testCommand } from "./commands/test";
import { memoryCommand } from "./commands/memory";
import { flowCommand, printFlowHelp } from "./commands/flow";
import { jobCommand } from "./commands/job";
import { reviewCommand } from "./commands/review";
import { rulesCommand } from "./commands/rules";
import { standardCommand } from "./commands/standard";
import { commandsCommand } from "./commands/commands";
import { securityCommand } from "./commands/security";
import { sandboxCommand } from "./commands/sandbox";
import { mcpCommand } from "./commands/mcp";
import { printServeMcpHelp, serveMcpCommand } from "./commands/serve-mcp";
import { integrateCommand } from "./commands/integrate";
import { integrationsCommand } from "./commands/integrations";
import { stackCommand } from "./commands/stack";
import { statusCommand } from "./commands/status";
import { harnessCommand } from "./commands/harness";
import { shellCommand } from "./commands/shell";
import { sessionsCommand } from "./commands/sessions";
import { acpCommand } from "./commands/acp";
import { busCommand } from "./commands/bus";
import { modulesCommand } from "./commands/modules";
import { projectsCommand } from "./commands/projects";
import { serveCommand } from "./commands/serve";
import { updateCommand } from "./commands/update";
import { dashboardCommand } from "./commands/dashboard";
import { agentsCommand } from "./commands/agents";
import { metricsCommand } from "./commands/metrics";
import { versionCommand } from "./commands/version";
import { workspaceCommand } from "./commands/workspace";
import { providersCommand } from "./commands/providers";
import { routingCommand } from "./commands/routing";
import { externalCommand } from "./commands/external";
import { authCommand } from "./commands/auth";
import { retentionCommand } from "./commands/retention";
import { forgettingCommand } from "./commands/forgetting";
import { printTriggerHelp, triggerCommand } from "./commands/trigger";
import { scheduleCommand } from "./commands/schedule";
import { governanceCommand, printGovernanceHelp } from "./commands/governance";
import { hooksCommand, printHooksHelp } from "./commands/hooks";
import { bundleCommand, printBundleHelp } from "./commands/bundle";
import { learnCommand, printLearnHelp } from "./commands/learn";
import { sandboxNetForwardCommand } from "./commands/sandbox-net-forward";
import { doctorCommand } from "./commands/doctor";
import { GROUP_SUBCOMMANDS } from "./lib/group-subcommands";
import { MCP_CONSUMER_SUBCOMMANDS } from "./commands/mcp-servers";
import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;

/**
 * Every top-level CLI verb, mapped to its handler. Each handler receives the
 * arguments AFTER the verb.
 *
 * This is exported because it is the only honest source for "what commands does
 * this CLI actually have". The descriptor registry in `src/standard` is
 * hand-curated, and a coverage test that compares it against another
 * hand-written list proves nothing — it just compares two copies of the same
 * belief. Deriving the surface from the dispatch table means a new verb added
 * here fails the coverage test until it is either described or explicitly
 * excluded with a reason.
 *
 * Limit worth stating: this is verb-level. It cannot see that `wiki` grew a new
 * subcommand, because subcommand parsing lives inside each handler. It catches
 * the failure that actually happened twice, not every possible one.
 */
export const CLI_ROUTES: Record<string, (rest: string[]) => Promise<void> | void> = {
  init: initCommand,
  // Flow 303 (AC10): grouped command help by task. `--help`/`-h`/bare `keryx`
  // keep printing the flat USAGE_BODY below (AC5) — this is a SEPARATE verb.
  //
  // A-2 (flow 356): a DYNAMIC import, deliberately — see this file's header
  // comment. `commands/help.ts` needs `CLI_ROUTES` itself (to check
  // `arg in CLI_ROUTES`), so a static import of it here would recreate the
  // exact cycle this file exists to cut.
  help: (rest) => import("./commands/help").then((mod) => mod.helpCommand(rest)),
  // Flow 353 (AC1): one page of ok/warn/fail checks, `--json` machine-readable.
  doctor: doctorCommand,
  status: statusCommand,
  modules: modulesCommand,
  projects: projectsCommand,
  providers: providersCommand,
  routing: routingCommand,
  external: externalCommand,
  auth: authCommand,
  serve: serveCommand,
  update: updateCommand,
  dashboard: dashboardCommand,
  dash: (rest) => dashboardCommand(rest.length > 0 ? rest : ["open"]),
  gdgraph: gdgraphCommand,
  ctx: ctxCommand,
  wiki: wikiCommand,
  orient: orientCommand,
  sync: syncCommand,
  skills: skillsCommand,
  "skill-verify-skill": skillVerifySkillCommand,
  stack: stackCommand,
  health: healthCommand,
  metrics: metricsCommand,
  test: testCommand,
  memory: memoryCommand,
  flow: flowCommand,
  job: jobCommand,
  review: reviewCommand,
  rules: rulesCommand,
  agents: agentsCommand,
  standard: standardCommand,
  commands: commandsCommand,
  security: securityCommand,
  sandbox: sandboxCommand,
  "serve-mcp": serveMcpCommand,
  integrate: integrateCommand,
  integrations: integrationsCommand,
  // Retired spelling of the two verbs above; kept working, kept thin.
  mcp: mcpCommand,
  harness: harnessCommand,
  shell: shellCommand,
  sessions: sessionsCommand,
  session: sessionsCommand,
  acp: acpCommand,
  bus: busCommand,
  version: versionCommand,
  workspace: workspaceCommand,
  retention: retentionCommand,
  forgetting: forgettingCommand,
  trigger: triggerCommand,
  schedule: scheduleCommand,
  governance: governanceCommand,
  hooks: hooksCommand,
  bundle: bundleCommand,
  learn: learnCommand,
  // Flow 301 (AC5): internal helper only — `planUnattendedSandbox.wrap()` invokes this
  // from inside the sandbox; no operator ever types it. Excluded from the CLI
  // reference with a reason (`DOCUMENTED_ELSEWHERE` in `cli-reference-coverage.test.ts`).
  "__sandbox-net-forward": sandboxNetForwardCommand,
};

/**
 * The client supplies the model turn that core refuses to import.
 *
 * `src/sac/**` declares a port and holds no provider: the norm forbids a
 * provider registry, model selection, credentials and live model calls
 * inside core, and a build-graph test fails if any of them reappear there.
 * Without this registration the SAC paths that need a model turn refuse by
 * name rather than pretending to have run one, which is correct but is not
 * what a user with a key configured expects. The CLI is the client, so it
 * registers.
 *
 * Called from `cli.ts`'s `main()`, not at THIS module's own top level: a
 * registration at import time changes the behaviour of every process that
 * merely imports this file — this export exists so `main()` can call it
 * exactly once, at the same point in the same order it always ran.
 */
export function registerModelTurnPort(): void {
  setModelTurnPort(async (request) => runModelTurn(request));
}

/**
 * `mcp`'s consumer subcommands plus its retired publisher spellings
 * (`install`/`uninstall`/`serve`, still handled by `mcpCommand` itself —
 * `./commands/mcp.ts`) — the exact set that command's own dispatch accepts.
 * Assembled here, not inside `group-subcommands.ts` (review round 1, L1):
 * that module is deliberately zone-safe pure data (`src/lib` is the
 * `shared` zone; `MCP_CONSUMER_SUBCOMMANDS` lives in `commands/mcp-servers.ts`,
 * the `adapter` zone, and shared code must not import upward into it) —
 * this file is the composition root that already imports every adapter-zone
 * command module directly, so it is the right place to merge the two.
 */
const MCP_KNOWN_SUBCOMMANDS: readonly string[] = [...MCP_CONSUMER_SUBCOMMANDS, "install", "uninstall", "serve"];

/**
 * The known first-subcommand vocabulary for `command`, or `undefined` when
 * `command` either takes no subcommand at all or is not one this file has
 * verified data for (see `group-subcommands.ts`'s own doc comment for why
 * that set is deliberately not every `CLI_ROUTES` entry). Pure.
 */
export function knownSubcommandsFor(command: string): readonly string[] | undefined {
  if (command === "mcp") return MCP_KNOWN_SUBCOMMANDS;
  return GROUP_SUBCOMMANDS.get(command);
}

/** Every group name this file has verified subcommand data for — the table `cli.test.ts`'s coverage test iterates. */
export function groupsWithKnownSubcommands(): readonly string[] {
  return ["mcp", ...GROUP_SUBCOMMANDS.keys()];
}

/**
 * The usage body `printHelp` (`cli.ts`) prints — and the single source
 * {@link groupUsage} reads a group's own lines from. Hoisted rather than
 * duplicated: a second copy of this text would drift from the one operators
 * actually read.
 */
export const USAGE_BODY = `Usage:
  keryx                                        Show CLI usage
  keryx help [group|command]                   Grouped command help by task (--help/-h keep this flat usage)
  keryx doctor [--json]                        One page: version, Bun floor, ripgrep, sandbox, providers, MCP, integrations, standard, worktrees, graph/wiki freshness
  keryx shell [-c|--continue] [-r|--resume [id]] [--provider <p>] [--model <m>] [--base-url <url>] [--agent|--chat] [--tui|--no-tui]
                                               Start TUI agent shell (sessions are per-project)
  keryx sessions list|fork <id>|export <id>|path
                                               List / branch / export sessions for the current project
  keryx acp [--provider <p>] [--model <m>] [--base-url <url>] [--data-dir <dir>]
                                               Agent Client Protocol agent server over stdio
  keryx bus list [--json] | log [--since <seq>] [--limit N] [--json] | send <@name|@all> [--kind <k>] [--reply-to <id>] <text> | prune
                                               Agent bus: peers, events and messages shared across this clone's worktrees
  keryx version check [--json]                 Check npm latest (advisory; never installs)
  keryx harness run --provider <fake|anthropic|ollama> --model <m> [--base-url <url>] [--record <path>] "<prompt>"
  keryx harness exec [--allow-env KEY]... [--max-runtime-ms N] [--allow-real-subprocess]
                     [--allowed-domains a,b] [--mask-env NAME@host] [--tls-terminate] [--mask-mode auto|manual|off] [--auto-mask] -- <path> [args...]
  keryx harness extension --spec <path>
  keryx harness wave --spec <path>
  keryx harness replay --record <path> [--fixture <path>] [--write-fixture <path>] [--json]
                                               Validate a recorded run's log against a fixture (no re-execution)
  keryx init [--yes] [--no-gdgraph] [--no-gdctx] [--no-gdwiki] [--no-gdskills] [--gdskills-profile recommended] [--no-health] [--no-testing] [--no-memory] [--no-gdgraph-hook] [--no-gdskills-hook] [--no-health-hook] [--no-testing-post-commit-hook] [--no-testing-pre-push-hook]
  keryx status
  keryx modules [status | enable <name> | disable <name>]
  keryx projects [list [--json] | register <path> | forget <id>]
  keryx serve [--bind <addr>] [--port <n>] [--profile <name>] [--acknowledge-non-loopback]
  keryx serve status [--json]
  keryx serve token issue | rotate | revoke
  keryx serve config init|set|show
  keryx update [--skip-runtime] [--hooks]
  keryx dashboard build
  keryx dashboard open
  keryx dash
  keryx rules sync
  keryx sync [--apply]
  keryx sync install-hooks | uninstall-hooks
  keryx providers list [--json]
  keryx providers status [--json] [--refresh]
  keryx providers cross-family [--opt-in] [--json]
  keryx providers test <name> [--json]
  keryx providers remove <name> [--yes] [--json]
  keryx routing list [--json]
  keryx routing set <category> <provider>/<model> [--user|--project]
  keryx routing set <category> <provider> [--user|--project]
  keryx routing unset <category> [--user|--project]
  keryx routing trust
  keryx routing profile list [--json]
  keryx routing profile set <provider>/<model> --tier|--price-in|--price-out|--context|--priority <value>
  keryx external on [--project] | off [--project]
                                               Block/allow sending private work (code, diffs, CI logs, prompts) to Jev/TypeSafe and other listed providers/models
  keryx external status [--json]              Effective on/off, source, Jev credential availability, and what is blocked right now
  keryx external list [--json]                 The effective block list (providers, model patterns) and where it came from
  keryx auth list [--json]
  keryx auth login <provider>
  keryx auth logout <provider>
  keryx auth status <provider> [--json]
  keryx health run [--strict] [--changed [--since <ref>]] [--scope <s>] [--source a,b]
  keryx health status | gate [--strict-warn] | sources | trend
  keryx health explain <file-or-module> [--narrate] [--json]
  keryx health baseline update [--scope <s>]
  keryx orient [<runtime>]
  keryx orient install-hook [--runtime <id|all>] [--dry-run]
  keryx agents bootstrap status --runtime <claude|opencode|zcode|codex|antigravity|all>
  keryx agents bootstrap install --runtime <claude|opencode|zcode|codex|antigravity|all> [--dry-run]
  keryx gdgraph build
  keryx gdgraph query <cycles|orphans>
  keryx gdgraph affected <file>
  keryx ctx status
  keryx wiki status
  keryx wiki new <type> <slug> --title "<title>"
  keryx wiki collect [--force] [--limit <n>]
  keryx wiki index
  keryx wiki check-links
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
  keryx skill-verify-skill <skill-or-target>
  keryx skills contracts validate <file> --schema subagent-result
  keryx stack detect [--cwd <dir>] [--json] [--no-write]
  keryx metrics status|collect|validate|latest|show|plan|benchmark
  keryx test analyze
  keryx test run [--changed]
  keryx test status
  keryx memory new <type> --title "<title>"
  keryx memory search "<query>" [--status accepted]
  keryx memory index
  keryx memory ingest --from-review <path>
  keryx flow init (--issue <url> | --title "<t>")
  keryx flow list
  keryx flow status <id>
  keryx flow complete <id> [--comment]
  keryx job init --name <slug> [--intent implement|analyze|review|custom] [--project <path>]
  keryx job list [--json]
  keryx job status <name> [--json]
  keryx job step <name> <step-id> --status pending|in-progress|completed|skipped|failed [--reason "<text>"]
  keryx job document <name> --type analysis|implementation-report|review|verification-report --file <path>
  keryx job complete <name>
  keryx review attach|start|ingest|status|complete
  keryx standard validate
  keryx standard doctor
  keryx standard capabilities
  keryx standard baseline --baseline <status> --pr <status>
  keryx standard emit llms [--stdout]
  keryx commands [--json] [--module <name>] [--intent "<phrase>"] [--intents]
  keryx security status
  keryx security scan <path> [--json]
  keryx security scan-mcp <manifest|dir> [--json]
  keryx security check-input [--source <kind>] [--file <path>]
  keryx sandbox status [--json]
                                               OS sandbox launcher availability + per-capability containment matrix (report, not a gate)
  keryx security check-output [--target <kind>] [--file <path>]
  keryx security redact <path> [--out <path>]
  keryx security report [--since <ref>]
  keryx security policy validate
  keryx security incidents [--limit <n>]
  keryx security hooks install --runtime <claude|cursor|windsurf|generic-mcp|all>
  keryx security eval [--corpus <name|all>] [--with-model]
  keryx serve-mcp [--http] [--read-only] [--cwd <project-root>]
  keryx integrate [--remove] <cursor|claude|opencode|vscode|generic|all> [--dry-run]
  keryx integrations install --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]
  keryx integrations uninstall --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]
  keryx integrations doctor --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--json]
  keryx integrations matrix [--check] [--write] [--json] [--file <path>]
  keryx mcp serve [--http] ...                  # retired: use keryx serve-mcp
  keryx workspace create --title <title> [--component <workspace-relative-ref>]
  keryx workspace list|show|add-resource
  keryx mcp install|uninstall --runtime ...     # retired: use keryx integrate
  keryx retention status [--json]
  keryx retention sweep [--apply] [--target <id>]... [--max-age-days <n>] [--max-bytes <n>] [--json]
                                               Bound gdctx raw/artifacts logs and owner write-conflict
                                               sidecars; dry run by default, --apply removes
  keryx forgetting trail [--limit <n>] [--json]
  keryx forgetting lookup "<ref-or-path>" [--layer <layer>] [--search] [--json]
                                               Read the deletion trail: what was removed, when, at
                                               whose request, on what basis
  keryx trigger run <name>                      Perform exactly one pass of a declared trigger's
                                               action (.metaproject/triggers.json)
  keryx schedule add|list|show|pause|resume|run|remove
                                               Scheduled agent tasks: confirm a card, keryx installs
                                               a systemd --user timer (launchd/cron elsewhere)
  keryx governance report [--flow <id>] [--owner <name>] [--since <iso>] [--until <iso>] [--all-projects] [--json]
                                               Spend, confirmations, signatures and gate outcomes,
                                               unified across flows; writes latest.md/latest.json
  keryx governance show [--json]                Reprint the most recently written governance report
  keryx hooks list [--json]                     Resolved keryx shell lifecycle hooks (built-in -> user -> project)
  keryx hooks validate [--json] [--ci]          Validate .metaproject/hooks.json and ~/.keryx/hooks.json
  keryx hooks test <id> [--event <name>] [--payload-file <path>] [--json] [--profile <id>]
                                               Run one hook once against a synthetic or captured payload
  keryx hooks enable <id> [--user]              Flip a hook's enabled state (project file, or --user for ~/.keryx/hooks.json)
  keryx hooks trust [--yes]                     Show every command in .metaproject/hooks.json and trust exactly that version
  keryx hooks untrust                           Withdraw trust; project command hooks stop running
  keryx hooks disable <id> [--user] [--acknowledge-gate-risk]
  keryx bundle export --scope <project|team|user> [--include <glob>]... [--kind <k,...>] [--id <id>] [--target-harness <h,...>] <out> [--json]
  keryx bundle import <bundle> [--target-scope <scope>] [--render-for <h,...>] [--force <path>]... [--allow-hooks] [--dry-run] [--json]
  keryx bundle import <catalog-dir> --external [--dry-run] [--json]
  keryx bundle inspect <bundle> [--target-scope <scope>] [--json]
  keryx bundle verify <bundle> [--json]
  keryx bundle verify --external-imports [--json]
  keryx bundle uninstall <bundleId> --target-scope <scope> [--dry-run] [--json]
  keryx learn observe [--hook claude]           Flush pending observations, or adapt one host-hook payload
  keryx learn extract [--domain <d>] [--since <date>] [--json]
                                               Run deterministic signals over the observation window
  keryx learn list [--status <s>] [--domain <d>] [--scope <s>] [--json]
  keryx learn review [<id>] [--scope <s>]       Print a candidate (or all candidates) with its evidence
  keryx learn accept <id> [--scope user] [--refresh]
                                               candidate -> accepted; TTY only, no bypass flag
  keryx learn reject <id> [--scope user]
  keryx learn apply <id> --skill <module/name> [--dry-run]
  keryx learn promote <id>                      project accepted -> user candidate; TTY + typed confirm
  keryx learn graduate [--domain <d>] | graduate apply <proposal-id>
  keryx learn prune [--dry-run] [--json]
  keryx --version

Commands:
  help      Grouped command help by task: every verb, in nine onboarding-ordered groups
  doctor    One-page health check with a fix hint per line; --json for {checks:[...]}
  shell     Start the interactive TUI agent harness. Use --no-tui or --chat to opt out.
            Sessions: -c continue last in this project, -r [id] resume (per-project).
  sessions  List or export per-project shell sessions
  acp       Speak ACP v1 (newline-delimited JSON-RPC) over stdio, for an ACP client (e.g. an editor)
  bus       Agent bus: list peers and leases, read the log, send a message, prune
  version   Check whether a newer npm release is available
  harness   Run a single provider turn (harness run) and print structured events
  init      Initialize .metaproject in the current project
  status    Show local Metaproject status
  modules   View and toggle Metaproject modules (interactive)
  projects  Inspect the user-global registry of initialized projects
  serve     Loopback-bound authenticated HTTP entry (off by default; read-only routes)
  update    Refresh managed service files without touching data artifacts
  dashboard Build or open the project admin dashboard
  dash      Rebuild and open .metaproject/keryx-dashboard.html
  rules     Sync root AGENTS.md/CLAUDE.md into high-priority project rules
  sync      Reconcile graph/wiki/memory with the current code, and wire the git hooks
  providers Providers this operator has configured, and cross-family review eligibility
  routing   Category -> model routing table (list, set, unset, trust) and the model-profile catalogue (profile list, profile set)
  external  Keep private work in-house: block Jev/TypeSafe and other listed providers/models (on, off, status, list)
  auth      Subscription login (SuperGrok, ChatGPT Plus/Pro, GitHub Copilot) and API-key status
  orient    Emit a bounded graph + wiki startup block, or install it as a turn-start hook
  agents    Manage optional global agent bootstrap instructions, and the agent catalog (list/show/export/verify/generate)
  gdgraph   Build and query code dependency graph
  ctx       Run compact context commands and save raw output
  wiki      Manage the local project knowledge base
  skills    Manage bundled Metaproject working skills
  stack     Deterministic, offline stack detection (keryx stack detect)
  health    Aggregate code quality signals and run the quality gate
  test      Analyze testing context and normalize test reports
  memory    Store and search long-term project memory
  flow      Agent-first flow lifecycle (Task Manager)
  job       Agent-first job packages (job-orchestrator state, steps, documents)
  review    Managed review packages and lightweight report-only review mode
  standard  Validate the workspace against the Metaproject Standard
  commands  Agent-callable command registry (intents, args, output, model usage)
  security  Policy-based scanning, redaction, guardrails and audit reports
  sandbox   Report OS sandbox launcher availability and the per-capability containment matrix
  serve-mcp Expose Metaproject services over the Model Context Protocol (opt-in)
  integrate Wire this project into an editor or agent as an MCP server
  integrations Install/uninstall/audit Keryx's hooks and instructions in another coding agent, and the generated capability matrix
  mcp       Retired spelling of serve-mcp / integrate; still works, names its replacement
  metrics   Provenance-aware execution observability: run records, baselines, benchmarks
  workspace Shared Agent Context: workspaces, FWK reads, propose/review (module sac)
  retention Bound stores that grow without bound (gdctx raw/artifacts, owner write-conflict sidecars)
  forgetting Read the deletion trail — was this removed, or did it never exist?
  trigger   Fire one declared project trigger (git hook, cron line, CI job) — one pass, one exit code
  schedule  Scheduled agent tasks in the background: create (with confirmation), list, pause, resume, remove
  governance Read-only report over already-recorded spend, confirmations, signatures and gate outcomes
  hooks     Keryx shell lifecycle hooks: list/validate/test, trust project hooks, enable/disable a registration
  bundle    Portable bundle export/import of skills, rules, agents, memory and hooks across scopes and harnesses
  learn     Self-learning loop: observe, extract, review, accept/reject, apply, promote, graduate, prune
`;

/**
 * Does this argument list ask for help?
 *
 * `--help`/`-h` is recognized only as the FIRST argv token, so
 * `keryx skills install --help` used to RUN the install — which is how a
 * read-only question about a subcommand's usage installed 52 skills. Tokens
 * after a bare `--` belong to a CHILD process (`harness exec -- <cmd>`,
 * `ctx run -- <cmd>`), where `--help` is the child's own flag and must pass
 * through untouched. Pure.
 */
export function helpRequestedFor(rest: readonly string[]): boolean {
  const separator = rest.indexOf("--");
  const head = separator === -1 ? rest : rest.slice(0, separator);
  return head.some((token) => token === "--help" || token === "-h");
}

/**
 * Groups that implement their OWN `--help` (`args.includes("--help")`) instead
 * of treating a leading `--help` as the group's help. For those the guard below
 * must stay out of the way: their handler prints richer usage than this group's
 * block — `keryx shell` prints its full flag list, `keryx agents bootstrap`
 * prints the runtime list — and replacing that with two summary lines would be a
 * regression dressed as a safety fix. Every entry is pinned by a test that
 * drives it (`shell-cli-validation.test.ts`, `cli.test.ts`'s agents case).
 *
 * The list is a list of EXCEPTIONS on purpose: the default is to intercept, so a
 * mutating subcommand cannot inherit `--help` and run. A group that starts
 * answering help itself belongs here, and its own help test will say so.
 */
const DEEP_HELP_GROUPS: ReadonlySet<string> = new Set(["agents", "shell"]);

/**
 * Verbs whose BARE `--help`/`-h` (no subcommand token) is already a pure
 * print, identical to running the verb with no arguments at all —
 * `skillsCommand`/`memoryCommand`/`securityCommand` each special-case a
 * leading `--help`/`-h` as their own `!command` branch. Only the bare case is
 * blanket-safe; a subcommand of these verbs is NOT automatically safe (most
 * of `keryx skills`'s subcommands do not check `--help` at all, and
 * `install` writes files) — see {@link SAFE_SUBCOMMAND_HELP} for the
 * per-subcommand allowlist.
 */
const HELP_SAFE_VERBS: ReadonlySet<string> = new Set(["skills", "memory", "security"]);

/**
 * `<verb> <subcommand> --help` pairs whose subcommand handler checks
 * `--help`/`-h` itself and does nothing else on that path (R700-07) — the
 * same safety bar {@link DEEP_HELP_GROUPS} documents, applied per-subcommand
 * rather than to the whole verb, since most of these verbs' OTHER
 * subcommands (`skills install`, `memory new`, …) do not check `--help` and
 * must keep going through the generic interception below.
 */
const SAFE_SUBCOMMAND_HELP: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["skills", new Set(["doctor", "uninstall", "scout", "eval", "judge-check", "stocktake"])],
  // Not the whole `review` group: ingest/complete/comments reply write.
  // scope and tier only print usage and return.
  ["review", new Set(["scope", "tier"])],
  ["memory", new Set(["handoff"])],
  ["security", new Set(["audit-harness", "impact-evidence"])],
]);

/**
 * Should `<command> <rest…>` be answered by the command's OWN handler
 * instead of the generic interception guard below? True for a bare
 * `<verb> --help` on a {@link HELP_SAFE_VERBS} entry (matches the verb's own
 * no-args output), and for a `<verb> <subcommand> --help` pair listed in
 * {@link SAFE_SUBCOMMAND_HELP} (the subcommand's own handler prints its own
 * help and does nothing else on that path). Pure.
 */
function isKnownSafeHelp(command: string, rest: readonly string[]): boolean {
  const first = rest[0];
  if (first === "--help" || first === "-h") {
    return HELP_SAFE_VERBS.has(command);
  }
  const subcommands = SAFE_SUBCOMMAND_HELP.get(command);
  return subcommands !== undefined && first !== undefined && subcommands.has(first);
}

/**
 * Groups whose `--help` STAYS intercepted (the guard above never lets a
 * mutating subcommand see a stray `--help` and run) but whose printed TEXT
 * is the group's own handler help — not `groupUsage`'s slice of the static
 * `USAGE_BODY` (AC5, flow 294).
 *
 * `DEEP_HELP_GROUPS` above is the other way to solve "the intercepted text is
 * wrong": let the handler see `--help` itself. That is right for `agents` and
 * `shell`, whose EVERY subcommand already guards its own `--help` safely. It
 * is wrong here: `trigger install`/`uninstall`/`list`/`status`/`resolve` (and
 * most of `flow`'s subcommands) do not check for `--help` at all, so
 * `keryx trigger install --help` reaching the handler unintercepted would
 * actually run the install — the exact regression the interception guard
 * exists to prevent. Calling the group's own top-level help FUNCTION directly
 * (its `!command`/`--help`/`-h` branch) gets the same single-source-of-truth
 * text without ever handing a subcommand its own `--help` token.
 */
const RICH_GROUP_HELP: ReadonlyMap<string, () => void> = new Map([
  ["flow", printFlowHelp],
  ["trigger", printTriggerHelp],
  ["serve-mcp", printServeMcpHelp],
  ["governance", printGovernanceHelp],
  ["hooks", printHooksHelp],
  ["bundle", printBundleHelp],
  ["learn", printLearnHelp],
]);

/**
 * Should the group's own usage be printed instead of running anything? Pure, so
 * the property is testable without a terminal: `skills install --help` is a
 * question, `agents bootstrap --help` is answered deeper, and `harness exec --
 * cmd --help` is the CHILD's question.
 */
export function shouldInterceptHelp(command: string, rest: readonly string[]): boolean {
  return !DEEP_HELP_GROUPS.has(command) && !isKnownSafeHelp(command, rest) && helpRequestedFor(rest);
}

/**
 * The `Usage:` lines for one command group, or `undefined` when the group has
 * none. A group's block is its `keryx <group> …` line plus the indented
 * continuation lines that describe it — `sessions` has five of them, `skills`
 * thirteen — and never the next group's line. Pure.
 */
export function groupUsage(command: string, usage: string = USAGE_BODY): string | undefined {
  const lines = usage.split("\n");
  const startsGroup = new RegExp(`^ {2,}keryx ${command}(?:\\s|$)`);
  const isContinuation = /^ {4,}\S/;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!startsGroup.test(line)) {
      continue;
    }
    out.push(line);
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      if (!isContinuation.test(next) || startsGroup.test(next) || /keryx\s/.test(next)) {
        break;
      }
      out.push(next);
    }
  }
  return out.length === 0 ? undefined : out.join("\n");
}

/**
 * A verb's full usage: the richer text `keryx <command> --help` prints today,
 * as a directly callable function — extracted from `main`'s own interception
 * branch (flow 303 AC4, "keryx help <command> prints that command's
 * full usage (the existing rich group help where one exists)") rather than
 * duplicated. The FOUR rich group helps (flow, trigger, serve-mcp,
 * governance — AC5) win first; `agents`/`shell` (`DEEP_HELP_GROUPS`) answer
 * their own `--help` safely (proven by `shell-cli-validation.test.ts` and
 * `cli.test.ts`'s agents case — see the doc comment on `DEEP_HELP_GROUPS`),
 * so their route is invoked directly with exactly the token that reaches it
 * when an operator types `keryx <command> --help`; every other verb falls
 * back to its `groupUsage` slice of `USAGE_BODY`, same as before this
 * extraction.
 */
export async function printCommandHelp(command: string): Promise<void> {
  const richHelp = RICH_GROUP_HELP.get(command);
  if (richHelp) {
    richHelp();
    return;
  }
  if (DEEP_HELP_GROUPS.has(command)) {
    const route = CLI_ROUTES[command];
    if (route) {
      await route(["--help"]);
      return;
    }
  }
  const usage = groupUsage(command);
  console.log(usage === undefined ? `keryx ${VERSION}\n\n${USAGE_BODY}` : `keryx ${command} — usage:\n\n${usage}\n`);
}
