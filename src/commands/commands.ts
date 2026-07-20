// `keryx commands` — agent-facing command descriptor surface (flow 087, item 1).
//
// Thin handler over `src/standard/command-registry.ts`. Default output is the
// Markdown rendering; `--json` emits the stable machine-readable payload the
// harness consumes; `--module <m>` filters; `--intent "<phrase>"` resolves a
// natural-language phrase to the best-matching command(s).

import {
  emitCommandsJson,
  matchIntent,
  renderCommandsMarkdown,
  renderIntentTable,
} from "../standard/command-registry";
import { optionValue } from "../lib/args";

export async function commandsCommand(args: string[] = []): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  const module = optionValue(args, "--module");
  const intent = optionValue(args, "--intent");
  const asJson = args.includes("--json");

  if (intent !== undefined) {
    const matches = matchIntent(intent);
    if (asJson) {
      console.log(JSON.stringify({ schemaVersion: 1, query: intent, matches }, null, 2));
      return;
    }
    if (matches.length === 0) {
      console.log(`No command matched intent: ${intent}`);
      process.exitCode = 1;
      return;
    }
    for (const match of matches) {
      console.log(`keryx ${match.command} — ${match.summary}`);
    }
    return;
  }

  if (args.includes("--intents")) {
    console.log(renderIntentTable());
    return;
  }

  if (asJson) {
    console.log(emitCommandsJson(module));
    return;
  }

  console.log(renderCommandsMarkdown(module));
}

function printHelp(): void {
  console.log(`keryx commands

Usage:
  keryx commands                     Markdown registry of agent-callable commands
  keryx commands --json              Machine-readable descriptor payload (harness/MCP)
  keryx commands --module <name>     Filter to one module
  keryx commands --intent "<phrase>" Resolve a natural-language phrase to command(s)
  keryx commands --intents           Emit the intent -> command table (index.md)
`);
}
