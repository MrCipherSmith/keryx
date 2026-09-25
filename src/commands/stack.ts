// `keryx stack detect` (flow 309, W1, Lane A) — CLI surface over
// `src/stack/service.ts`. Deterministic, offline; never mutates skills,
// rules, or install state — only `.metaproject/data/stack/stack.json`.

import path from "node:path";
import { stat } from "node:fs/promises";
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

  // `--cwd` present but with no value (a trailing flag, the next token is
  // itself another `--flag`, or the `--cwd=` form with nothing after the
  // `=`) must be refused, not silently fall back to the process cwd:
  // `optionValue` returns `undefined` for "absent" and "present but
  // valueless" alike, and it returns `""` for `--cwd=` — `path.resolve`
  // treats an empty string as a no-op, so an unchecked empty value would
  // quietly resolve to the process cwd. The flag's presence has to be
  // checked separately, and the value has to be checked for emptiness too.
  const cwdFlagGiven = args.includes("--cwd") || args.some((arg) => arg.startsWith("--cwd="));
  const cwdOption = optionValue(args, "--cwd");
  if (cwdFlagGiven && (cwdOption === undefined || cwdOption === "")) {
    console.error("--cwd requires a directory argument");
    process.exitCode = 1;
    return;
  }

  const root = cwdOption !== undefined ? path.resolve(cwd, cwdOption) : cwd;
  const json = args.includes("--json");
  const write = !args.includes("--no-write");

  let rootStat: Awaited<ReturnType<typeof stat>>;
  try {
    rootStat = await stat(root);
  } catch {
    console.error(`--cwd directory does not exist: ${root}`);
    process.exitCode = 1;
    return;
  }
  if (!rootStat.isDirectory()) {
    console.error(`--cwd is not a directory: ${root}`);
    process.exitCode = 1;
    return;
  }

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
