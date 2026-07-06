#!/usr/bin/env bun

import { initCommand } from "./commands/init";
import { ctxCommand } from "./commands/ctx";
import { gdgraphCommand } from "./commands/gdgraph";
import { wikiCommand } from "./commands/wiki";
import { skillVerifySkillCommand, skillsCommand } from "./commands/skills";
import { healthCommand } from "./commands/health";
import { statusCommand } from "./commands/status";
import { updateCommand } from "./commands/update";

const VERSION = "0.1.0";

async function main(): Promise<void> {
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

  if (command === "update") {
    await updateCommand();
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

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`gd-metapro ${VERSION}

Usage:
  gd-metapro init [--yes] [--no-gdgraph] [--no-gdctx] [--no-gdwiki] [--no-gdskills] [--gdskills-profile recommended] [--no-health] [--no-gdgraph-hook] [--no-gdskills-hook]
  gd-metapro status
  gd-metapro update
  gd-metapro gdgraph build
  gd-metapro gdgraph query <cycles|orphans>
  gd-metapro gdgraph affected <file>
  gd-metapro ctx status
  gd-metapro wiki status
  gd-metapro wiki new <type> <slug> --title "<title>"
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
  gd-metapro skills export <project-skill> --runtime codex|claude
  gd-metapro skills sync --runtime codex|claude --target <dir>
  gd-metapro skill-verify-skill <skill-or-target>
  gd-metapro skills contracts validate <file> --schema subagent-result
  gd-metapro --version

Commands:
  init      Initialize .metaproject in the current project
  status    Show local Metaproject status
  update    Update installed runtime and run project hooks
  gdgraph   Build and query code dependency graph
  ctx       Run compact context commands and save raw output
  wiki      Manage the local project knowledge base
  skills    Manage bundled Metaproject working skills
  health    Aggregate code quality signals and run the quality gate
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
