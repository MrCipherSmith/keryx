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
import { reviewCommand } from "./commands/review";
import { rulesCommand } from "./commands/rules";
import { standardCommand } from "./commands/standard";
import { securityCommand } from "./commands/security";
import { mcpCommand } from "./commands/mcp";
import { statusCommand } from "./commands/status";
import { harnessCommand } from "./commands/harness";
import { shellCommand } from "./commands/shell";
import { modulesCommand } from "./commands/modules";
import { updateCommand } from "./commands/update";
import { dashboardCommand } from "./commands/dashboard";
import { agentsCommand } from "./commands/agents";
import { metricsCommand } from "./commands/metrics";
import packageJson from "../package.json" with { type: "json" };

const VERSION = packageJson.version;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (!command) {
    await shellCommand(args);
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  if (command === "init") {
    await initCommand(args.slice(1));
    return;
  }

  if (command === "status") {
    await statusCommand();
    return;
  }

  if (command === "modules") {
    await modulesCommand(args.slice(1));
    return;
  }

  if (command === "update") {
    await updateCommand(args.slice(1));
    return;
  }

  if (command === "dashboard") {
    await dashboardCommand(args.slice(1));
    return;
  }

  if (command === "dash") {
    await dashboardCommand(args.length > 1 ? args.slice(1) : ["open"]);
    return;
  }

  if (command === "gdgraph") {
    await gdgraphCommand(args.slice(1));
    return;
  }

  if (command === "ctx") {
    await ctxCommand(args.slice(1));
    return;
  }

  if (command === "wiki") {
    await wikiCommand(args.slice(1));
    return;
  }

  if (command === "orient") {
    await orientCommand(args.slice(1));
    return;
  }

  if (command === "sync") {
    await syncCommand(args.slice(1));
    return;
  }

  if (command === "skills") {
    await skillsCommand(args.slice(1));
    return;
  }

  if (command === "skill-verify-skill") {
    await skillVerifySkillCommand(args.slice(1));
    return;
  }

  if (command === "health") {
    await healthCommand(args.slice(1));
    return;
  }

  if (command === "metrics") {
    await metricsCommand(args.slice(1));
    return;
  }

  if (command === "test") {
    await testCommand(args.slice(1));
    return;
  }

  if (command === "memory") {
    await memoryCommand(args.slice(1));
    return;
  }

  if (command === "flow") {
    await flowCommand(args.slice(1));
    return;
  }

  if (command === "review") {
    await reviewCommand(args.slice(1));
    return;
  }

  if (command === "rules") {
    await rulesCommand(args.slice(1));
    return;
  }

  if (command === "agents") {
    await agentsCommand(args.slice(1));
    return;
  }

  if (command === "standard") {
    await standardCommand(args.slice(1));
    return;
  }

  if (command === "security") {
    await securityCommand(args.slice(1));
    return;
  }

  if (command === "mcp") {
    await mcpCommand(args.slice(1));
    return;
  }

  if (command === "harness") {
    await harnessCommand(args.slice(1));
    return;
  }

  if (command === "shell") {
    await shellCommand(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`keryx ${VERSION}

Usage:
  keryx                                        Start the interactive shell (REPL)
  keryx shell [--provider <p>] [--model <m>] [--base-url <url>]
  keryx harness run --provider <fake|anthropic|ollama> --model <m> [--base-url <url>] "<prompt>"
  keryx init [--yes] [--no-gdgraph] [--no-gdctx] [--no-gdwiki] [--no-gdskills] [--gdskills-profile recommended] [--no-health] [--no-testing] [--no-memory] [--no-gdgraph-hook] [--no-gdskills-hook] [--no-health-hook] [--no-testing-post-commit-hook] [--no-testing-pre-push-hook]
  keryx status
  keryx modules [status | enable <name> | disable <name>]
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
  keryx review attach|start|ingest|status|complete
  keryx standard validate
  keryx standard doctor
  keryx standard capabilities
  keryx standard baseline --baseline <status> --pr <status>
  keryx standard emit llms [--stdout]
  keryx security status
  keryx security scan <path> [--json]
  keryx security scan-mcp <manifest|dir> [--json]
  keryx security check-input [--source <kind>] [--file <path>]
  keryx security check-output [--target <kind>] [--file <path>]
  keryx security redact <path> [--out <path>]
  keryx security report [--since <ref>]
  keryx security policy validate
  keryx security incidents [--limit <n>]
  keryx security hooks install --runtime <claude|cursor|windsurf|generic-mcp|all>
  keryx security eval [--corpus <name|all>] [--with-model]
  keryx mcp serve [--http] [--cwd <project-root>]
  keryx mcp install|uninstall --runtime <cursor|claude|generic|all> [--dry-run]
  keryx --version

Commands:
  shell     Start the interactive keryx shell (also runs when keryx is called with no command)
  harness   Run a single provider turn (harness run) and print structured events
  init      Initialize .metaproject in the current project
  status    Show local Metaproject status
  modules   View and toggle Metaproject modules (interactive)
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
  review    Managed review packages and lightweight report-only review mode
  standard  Validate the workspace against the Metaproject Standard
  security  Policy-based scanning, redaction, guardrails and audit reports
  mcp       Expose Metaproject services over the Model Context Protocol (opt-in)
`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
