// `keryx product` (flow 362) — the intent of the product as a derived index.
// `index` reads every flow and requirements package and writes a disposable
// index; `open` lists the intents closed in code that nobody has looked back at.
// Read-only over the project, no model, no network, and it never refuses or
// blocks any other command.

import {
  buildIntentIndex,
  loadOpenReport,
  renderIndexSummary,
  renderOpen,
  serializeIndex,
  writeIntentIndex,
} from "../product/service";

const FLAGS = ["--json"] as const;

function rejectUnknownFlags(command: string, args: readonly string[]): void {
  const unknown = args.filter((argument) => argument.startsWith("-") && !FLAGS.includes(argument as (typeof FLAGS)[number]));
  if (unknown.length > 0) {
    throw new Error(`Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx product ${command}\`: ${unknown.join(", ")}. Accepted: ${FLAGS.join(", ")}.`);
  }
  const extra = args.filter((argument) => !argument.startsWith("-"));
  if (extra.length > 0) throw new Error(`\`keryx product ${command}\` takes no arguments (got ${extra.join(" ")}).`);
}

async function runIndex(args: string[]): Promise<void> {
  rejectUnknownFlags("index", args);
  const cwd = process.cwd();
  const index = await buildIntentIndex(cwd);
  const file = await writeIntentIndex(cwd, index);
  console.log(args.includes("--json") ? serializeIndex(index).trimEnd() : renderIndexSummary(index, file));
}

async function runOpen(args: string[]): Promise<void> {
  rejectUnknownFlags("open", args);
  const loaded = await loadOpenReport(process.cwd());
  if (!loaded.ok) {
    console.error(loaded.message);
    process.exitCode = 1;
    return;
  }
  console.log(args.includes("--json") ? JSON.stringify(loaded.report, null, 2) : renderOpen(loaded.report));
}

export async function productCommand(args: string[] = []): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "index") {
    await runIndex(args.slice(1));
    return;
  }
  if (command === "open") {
    await runOpen(args.slice(1));
    return;
  }
  console.error(`Unknown product subcommand: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`keryx product — what the product set out to do, and whether anyone checked

Usage:
  keryx product index [--json]
  keryx product open [--json]

\`index\` reads every flow (.metaproject/flows/) and requirements package
(docs/requirements/) and writes .metaproject/data/product/index.json.
That directory is disposable: delete it and \`index\` rebuilds an equivalent
one, byte for byte. It reports how many entries state no intent, which is
the limit of everything built on it.

\`open\` lists the intents closed in code (flow status done) with no recorded
look back, each with the flow and its outcome criterion, or
"not measured — no instrument stated". The header splits them into no
criterion stated, criterion stated but never observed, and observed. It
refuses to answer from a missing or stale index and names \`keryx product index\`.

An observation is a line in the flow's journal.md that begins
\`outcome-observed:\`. \`index\` reads it, and that flow leaves the list.

Nothing here gates a flow, calls a model or runs by itself.
`);
}
