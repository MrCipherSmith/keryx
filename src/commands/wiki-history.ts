// `keryx wiki history` and `keryx wiki restore` (flow 367): read and undo the
// per-page version history every wiki writer records (`../wiki/history.ts`).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import {
  listWikiRuns,
  openWikiWriteContext,
  pageHistoryDir,
  parseVersionLabel,
  printWikiUndoHint,
  readPageHistory,
  restoreWikiPage,
  restoreWikiRun,
} from "../wiki/service";

const HISTORY_USAGE = "Usage: keryx wiki history <page> | keryx wiki history --runs [--json]";
const RESTORE_USAGE =
  "Usage: keryx wiki restore <page> [--version vNNNN] | keryx wiki restore --run <run-id> [--force]";

/** Accepts `components/a.md`, `components/a`, or `.metaproject/wiki/components/a.md`. */
function normalizePage(value: string): string {
  const posix = value.replace(/\\/g, "/").replace(/^\.?\/?\.metaproject\/wiki\//, "");
  return posix.endsWith(".md") ? posix : `${posix}.md`;
}

export async function runHistoryCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  if (args.includes("--runs")) {
    const runs = await listWikiRuns(cwd);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
      return;
    }
    if (runs.length === 0) {
      process.stdout.write("no wiki history runs recorded yet\n");
      return;
    }
    for (const run of runs) {
      process.stdout.write(`${run.runId}  ${run.at}  ${run.pages} page(s)  ${run.command}\n`);
    }
    process.stdout.write(`\nundo a run: keryx wiki restore --run <run-id>\n`);
    return;
  }

  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) {
    console.error(HISTORY_USAGE);
    process.exitCode = 1;
    return;
  }
  const page = normalizePage(target);
  try {
    if (args.includes("--json")) {
      const history = await readPageHistory(cwd, page);
      if (history === null) throw new Error("no history");
      process.stdout.write(`${JSON.stringify(history, null, 2)}\n`);
      return;
    }
    process.stdout.write(await readFile(path.join(pageHistoryDir(cwd, page), "index.md"), "utf8"));
  } catch {
    console.error(`no history recorded for ${page} — keryx records one the first time it writes the page`);
    process.exitCode = 1;
  }
}

export async function runRestoreCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const runId = optionValue(args, "--run");
  const versionRaw = optionValue(args, "--version");
  const target = args.find(
    (arg, index) => !arg.startsWith("--") && !(index > 0 && ["--run", "--version"].includes(args[index - 1]!)),
  );
  if ((runId === undefined) === (target === undefined)) {
    console.error(RESTORE_USAGE);
    process.exitCode = 1;
    return;
  }

  const history = await openWikiWriteContext(cwd, ["wiki restore", ...args].join(" "));
  const json = args.includes("--json");
  try {
    if (runId !== undefined) {
      const result = await restoreWikiRun(history, runId, { force: args.includes("--force") });
      if (result.conflicts.length > 0) process.exitCode = 1;
      if (json) {
        process.stdout.write(`${JSON.stringify({ ...result, undoRunId: history.runId }, null, 2)}\n`);
        return;
      }
      for (const entry of result.restored) {
        process.stdout.write(`  ${entry.action.padEnd(9)} ${entry.page} -> ${entry.restoredTo}\n`);
      }
      for (const conflict of result.conflicts) {
        process.stdout.write(`  CONFLICT  ${conflict.page}: ${conflict.reason}\n`);
      }
      process.stdout.write(
        `restored ${result.restored.length} page(s) from ${runId}; ${result.conflicts.length} conflict(s)\n`,
      );
    } else {
      const page = normalizePage(target!);
      const version = versionRaw === undefined ? undefined : parseVersionLabel(versionRaw);
      const outcome = await restoreWikiPage(history, page, version);
      if (json) {
        process.stdout.write(`${JSON.stringify({ ...outcome, undoRunId: history.runId }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${outcome.action}: ${outcome.page} -> ${outcome.restoredTo}\n`);
    }
  } catch (error) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
      return;
    }
    console.error(`wiki restore: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  // A restore is itself recorded, so it can be undone the same way.
  await printWikiUndoHint(history);
}
