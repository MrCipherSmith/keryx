#!/usr/bin/env bun

import { initCommand } from "./commands/init";
import { gdgraphCommand } from "./commands/gdgraph";
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

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`gd-metapro ${VERSION}

Usage:
  gd-metapro init [--yes] [--no-gdgraph] [--no-gdgraph-hook]
  gd-metapro status
  gd-metapro update
  gd-metapro gdgraph build
  gd-metapro gdgraph query <cycles|orphans>
  gd-metapro gdgraph affected <file>
  gd-metapro --version

Commands:
  init      Initialize .metaproject in the current project
  status    Show local Metaproject status
  update    Update installed runtime and run project hooks
  gdgraph   Build and query code dependency graph
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
