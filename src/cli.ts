#!/usr/bin/env bun

import { initCommand } from "./commands/init";
import { statusCommand } from "./commands/status";

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

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`gd-metapro ${VERSION}

Usage:
  gd-metapro init [--yes] [--no-gdgraph]
  gd-metapro status
  gd-metapro --version

Commands:
  init      Initialize .metaproject in the current project
  status    Show local Metaproject status
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
