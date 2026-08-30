#!/usr/bin/env bun

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
import { flowCommand } from "./commands/flow";
import { jobCommand } from "./commands/job";
import { reviewCommand } from "./commands/review";
import { rulesCommand } from "./commands/rules";
import { standardCommand } from "./commands/standard";
import { commandsCommand } from "./commands/commands";
import { securityCommand } from "./commands/security";
import { sandboxCommand } from "./commands/sandbox";
import { mcpCommand } from "./commands/mcp";
import { statusCommand } from "./commands/status";
import { harnessCommand } from "./commands/harness";
import { shellCommand } from "./commands/shell";
import { sessionsCommand } from "./commands/sessions";
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
import packageJson from "../package.json" with { type: "json" };

const VERSION = packageJson.version;

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
  status: statusCommand,
  modules: modulesCommand,
  projects: projectsCommand,
  providers: providersCommand,
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
  mcp: mcpCommand,
  harness: harnessCommand,
  shell: shellCommand,
  sessions: sessionsCommand,
  session: sessionsCommand,
  version: versionCommand,
  workspace: workspaceCommand,
};

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--help" || command === "-h" || command === "help" || !command) {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  // Bare `keryx` is the CLI surface (help above). The interactive TUI agent
  // harness is only `keryx shell […]`. Do not route stray `--flags` into shell.

  const route = CLI_ROUTES[command];
  if (route) {
    await route(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`keryx ${VERSION}

Usage:
  keryx                                        Show CLI usage
  keryx shell [-c|--continue] [-r|--resume [id]] [--provider <p>] [--model <m>] [--base-url <url>] [--agent|--chat] [--tui|--no-tui]
                                               Start TUI agent shell (sessions are per-project)
  keryx sessions list|fork <id>|export <id>|path
                                               List / branch / export sessions for the current project
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
  keryx mcp serve [--http] [--cwd <project-root>]
  keryx workspace create --title <title> [--component <workspace-relative-ref>]
  keryx workspace list|show|add-resource
  keryx mcp install|uninstall --runtime <cursor|claude|opencode|generic|all> [--dry-run]
  keryx --version

Commands:
  shell     Start the interactive TUI agent harness. Use --no-tui or --chat to opt out.
            Sessions: -c continue last in this project, -r [id] resume (per-project).
  sessions  List or export per-project shell sessions
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
  agents    Manage optional global agent bootstrap instructions
  gdgraph   Build and query code dependency graph
  ctx       Run compact context commands and save raw output
  wiki      Manage the local project knowledge base
  skills    Manage bundled Metaproject working skills
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
  mcp       Expose Metaproject services over the Model Context Protocol (opt-in)
`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
