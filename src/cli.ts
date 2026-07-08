#!/usr/bin/env bun

import { initCommand } from "./commands/init";
import { ctxCommand } from "./commands/ctx";
import { gdgraphCommand } from "./commands/gdgraph";
import { wikiCommand } from "./commands/wiki";
import { skillVerifySkillCommand, skillsCommand } from "./commands/skills";
import { healthCommand } from "./commands/health";
import { testCommand } from "./commands/test";
import { memoryCommand } from "./commands/memory";
import { flowCommand } from "./commands/flow";
import { rulesCommand } from "./commands/rules";
import { standardCommand } from "./commands/standard";
import { securityCommand } from "./commands/security";
import { mcpCommand } from "./commands/mcp";
import { statusCommand } from "./commands/status";
import { modulesCommand } from "./commands/modules";
import { updateCommand } from "./commands/update";
import { dashboardCommand } from "./commands/dashboard";
import packageJson from "../package.json" with { type: "json" };

const VERSION = packageJson.version;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
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

  if (command === "rules") {
    await rulesCommand(args.slice(1));
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

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`gd-metapro ${VERSION}

Usage:
  gd-metapro init [--yes] [--no-gdgraph] [--no-gdctx] [--no-gdwiki] [--no-gdskills] [--gdskills-profile recommended] [--no-health] [--no-testing] [--no-memory] [--no-gdgraph-hook] [--no-gdskills-hook] [--no-health-hook] [--no-testing-post-commit-hook] [--no-testing-pre-push-hook]
  gd-metapro status
  gd-metapro modules [status | enable <name> | disable <name>]
  gd-metapro update [--skip-runtime] [--hooks]
  gd-metapro dashboard build
  gd-metapro dashboard open
  gd-metapro dash
  gd-metapro rules sync
  gd-metapro gdgraph build
  gd-metapro gdgraph query <cycles|orphans>
  gd-metapro gdgraph affected <file>
  gd-metapro ctx status
  gd-metapro wiki status
  gd-metapro wiki new <type> <slug> --title "<title>"
  gd-metapro wiki collect [--force] [--limit <n>]
  gd-metapro wiki index
  gd-metapro wiki check-links
  gd-metapro skills status
  gd-metapro skills list
  gd-metapro skills inspect <project-skill>
  gd-metapro skills route <query-or-target>
  gd-metapro skills catalog [--profile recommended]
  gd-metapro skills install [--profile recommended]
  gd-metapro skills create <target> --module <module> --name <skill-name>
  gd-metapro skills verify <skill-or-target>
  gd-metapro skills learn --from-review <path> --skill <module>/<skill>
  gd-metapro skills learn apply <proposal.json>
  gd-metapro skills export <project-skill> --runtime codex|claude|plugin
  gd-metapro skills sync --runtime codex|claude --target <dir>
  gd-metapro skill-verify-skill <skill-or-target>
  gd-metapro skills contracts validate <file> --schema subagent-result
  gd-metapro test analyze
  gd-metapro test run [--changed]
  gd-metapro test status
  gd-metapro memory new <type> --title "<title>"
  gd-metapro memory search "<query>" [--status accepted]
  gd-metapro memory index
  gd-metapro memory ingest --from-review <path>
  gd-metapro flow init (--issue <url> | --title "<t>")
  gd-metapro flow list
  gd-metapro flow status <id>
  gd-metapro flow complete <id> [--comment]
  gd-metapro standard validate
  gd-metapro standard doctor
  gd-metapro standard capabilities
  gd-metapro standard emit llms [--stdout]
  gd-metapro security status
  gd-metapro security scan <path> [--json]
  gd-metapro security scan-mcp <manifest|dir> [--json]
  gd-metapro security check-input [--source <kind>] [--file <path>]
  gd-metapro security check-output [--target <kind>] [--file <path>]
  gd-metapro security redact <path> [--out <path>]
  gd-metapro security report [--since <ref>]
  gd-metapro security policy validate
  gd-metapro security incidents [--limit <n>]
  gd-metapro security hooks install --runtime <claude|cursor|windsurf|generic-mcp|all>
  gd-metapro security eval [--corpus <name|all>] [--with-model]
  gd-metapro mcp serve [--http]
  gd-metapro --version

Commands:
  init      Initialize .metaproject in the current project
  status    Show local Metaproject status
  modules   View and toggle Metaproject modules (interactive)
  update    Refresh managed service files without touching data artifacts
  dashboard Build or open the project admin dashboard
  dash      Rebuild and open .metaproject/gd-metapro-dashboard.html
  rules     Sync root AGENTS.md/CLAUDE.md into high-priority project rules
  gdgraph   Build and query code dependency graph
  ctx       Run compact context commands and save raw output
  wiki      Manage the local project knowledge base
  skills    Manage bundled Metaproject working skills
  health    Aggregate code quality signals and run the quality gate
  test      Analyze testing context and normalize test reports
  memory    Store and search long-term project memory
  flow      Agent-first flow lifecycle (Task Manager)
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
