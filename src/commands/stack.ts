// `keryx stack detect` (flow 309, W1, Lane A) — CLI surface over
// `src/stack/service.ts`. Deterministic, offline; never mutates skills,
// rules, or install state — only `.metaproject/data/stack/stack.json`.

import path from "node:path";
import { helpOptions, helpTitle, helpUsage, heading, style } from "../lib/ui";
import { optionValue } from "../lib/args";
import { readStackDetection, runStackDetect, serializeStackDetection, stackJsonPath, type StackDetection } from "../stack/service";

export async function stackCommand(args: string[], cwd: string = process.cwd()): Promise<void> {
  const sub = args[0];

  if (sub === undefined || sub === "--help" || sub === "-h") {
    printStackHelp();
    return;
  }
  if (sub === "detect") {
    await handleDetect(args.slice(1), cwd);
    return;
  }

  console.error(`Unknown stack command: ${sub}`);
  printStackHelp();
  process.exitCode = 1;
}

async function handleDetect(args: string[], cwd: string): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printDetectHelp();
    return;
  }

  const cwdOption = optionValue(args, "--cwd");
  const root = cwdOption !== undefined ? path.resolve(cwd, cwdOption) : cwd;
  const json = args.includes("--json");
  const write = !args.includes("--no-write");

  const doc = await runStackDetect(root, { write });

  if (json) {
    process.stdout.write(serializeStackDetection(doc));
    return;
  }

  printSummary(doc, root, write);
}

function printSummary(doc: StackDetection, root: string, wrote: boolean): void {
  const present = Object.entries(doc.tags)
    .filter(([, value]) => value)
    .map(([tag]) => tag)
    .sort();

  console.log(`${style.bold("Stack detection")} for ${root}`);
  console.log(`  ${doc.uncertain ? style.yellow("uncertain") : style.green("certain")} — ${doc.reason}`);
  console.log(`  tags present: ${present.length > 0 ? present.join(", ") : "none"}`);
  if (doc.matched.length > 0) {
    console.log(`  matched: ${doc.matched.join(", ")}`);
  }
  console.log(`  signals: ${doc.perSignal.length}`);
  if (wrote) {
    console.log(`  wrote ${stackJsonPath(root)}`);
  } else {
    console.log(`  --no-write: nothing written`);
  }
}

function printStackHelp(): void {
  helpTitle("stack", "Deterministic, offline stack detection");
  helpUsage(["keryx stack detect [--cwd <dir>] [--json] [--no-write]"]);
  heading("Subcommands");
  console.log(`  ${style.cyan("detect")}  Detect the repository's stack tags and write .metaproject/data/stack/stack.json`);
}

function printDetectHelp(): void {
  helpTitle("stack detect", "Deterministic, offline stack detection");
  helpUsage(["keryx stack detect [--cwd <dir>] [--json] [--no-write]"]);
  helpOptions([
    { flag: "--cwd <dir>", desc: "Detect against this directory instead of the current one" },
    { flag: "--json", desc: "Print exactly the persisted document" },
    { flag: "--no-write", desc: "Detect and print without writing stack.json" },
  ]);
}

/** Re-exported for tests and other commands that only need to read the last detection. */
export { readStackDetection };
