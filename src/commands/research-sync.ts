// Flow 404: `keryx research sync` keeps three files next to the Part 1 materials current: the counts the
// unchanged `part1-counts.py` produces now, the text-free decisions export from 2 October 2026 on, and
// `sync-status.md`, the one page that says when it ran and where the numbers stand.
//
// Two phases, so a failure leaves the last good data alone: everything is computed in memory first, and only a
// complete result is written. It runs from the repository root, writes only those three files, and never touches
// git history: no commit, no branch, no pull request. The scheduler calls this command; nothing here hooks an event.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadExportWithSummary, loadReport, renderExport } from "../decisions/service";
import { helpOptions, helpTitle, helpUsage, note, style, symbols } from "../lib/ui";
import { formatRunTime, reasonLine, renderFailureStatus, renderStatus } from "./research-sync-status";

const run = promisify(execFile);

export const CATALOG_DIR = path.join("docs", "research", "role-blurring-part1");
export const COUNTS_SCRIPT = "part1-counts.py";
export const SNAPSHOT_COUNTS = "part1-counts.json";
export const LATEST_COUNTS = "part1-counts-latest.json";
export const LATEST_EXPORT = "decisions-export-latest.jsonl";
export const STATUS_FILE = "sync-status.md";
const CONTRIBUTION_LOG = "contribution-log.md";
/** The export starts where the frozen snapshot's journal data starts. */
export const EXPORT_SINCE = new Date(Date.UTC(2026, 9, 2));
const COUNTS_TIMEOUT_MS = 120_000;
/** Nothing the sync writes may name the operator's team repositories (flow 404, AC7). */
const OFF_LIMITS = /frontend|backend|board|process-metrics/i;

export interface SyncDeps {
  /** The repository root: the directory the command was run from. */
  root: string;
  now?: () => Date;
  /** The text of the `part1-counts.json` the unchanged script produces at HEAD. */
  runCounts?: (root: string) => Promise<string>;
  headHash?: (root: string) => Promise<string>;
}

export interface SyncOutcome {
  ok: boolean;
  /** The one-line reason when `ok` is false. */
  reason?: string;
  /** The files whose content changed in this run, relative to the root. */
  changed: string[];
}

class SyncError extends Error {}

const catalogFile = (root: string, name: string): string => path.join(root, CATALOG_DIR, name);

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function tool(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number }, label: string): Promise<string> {
  try {
    const { stdout } = await run(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
    return String(stdout);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new SyncError(`${label} failed${code === undefined ? "" : ` (${String(code)})`}`);
  }
}

async function headHash(root: string): Promise<string> {
  return (await tool("git", ["rev-parse", "HEAD"], { cwd: root }, "git rev-parse HEAD")).trim();
}

/**
 * Run the script, unchanged, over the flows committed at HEAD. It writes into its working directory and reads
 * `.metaproject/flows` there, so it gets a scratch directory holding an archive of HEAD's flows: the repository
 * root stays clean, and the numbers are the ones of the commit, not of whatever is half-edited in the tree.
 */
async function runCounts(root: string): Promise<string> {
  const script = catalogFile(root, COUNTS_SCRIPT);
  if ((await readIfExists(script)) === null) throw new SyncError(`${COUNTS_SCRIPT} not found in ${CATALOG_DIR}`);
  const work = await mkdtemp(path.join(tmpdir(), "keryx-research-"));
  try {
    const gitDir = (await tool("git", ["rev-parse", "--absolute-git-dir"], { cwd: root }, "git rev-parse")).trim();
    const archive = path.join(work, "flows.tar");
    const tree = path.join(work, "tree");
    await mkdir(tree);
    await tool("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD", ".metaproject/flows"], { cwd: root }, "git archive");
    await tool("tar", ["-xf", archive, "-C", tree], { cwd: work }, "tar extract");
    const python = process.platform === "win32" ? "python" : "python3";
    await tool(python, [script], { cwd: tree, env: { ...process.env, GIT_DIR: gitDir }, timeout: COUNTS_TIMEOUT_MS }, COUNTS_SCRIPT);
    const text = await readIfExists(path.join(tree, SNAPSHOT_COUNTS));
    if (text === null) throw new SyncError(`${COUNTS_SCRIPT} wrote no counts`);
    return text;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SyncError(`${what} is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SyncError(`${what} is not a JSON object`);
  return value as Record<string, unknown>;
}

/** The counts without the time they were made: a run that changes nothing else must not rewrite the file. */
function withoutTime(counts: Record<string, unknown>): string {
  const rest = { ...counts };
  delete rest.generated_at;
  return JSON.stringify(rest);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Write when the content differs from what is there. Returns whether the file changed. */
async function writeIfChanged(file: string, content: string): Promise<boolean> {
  if ((await readIfExists(file)) === content) return false;
  await writeAtomic(file, content);
  return true;
}

interface Computed {
  countsText: string;
  /** Whether the file already there holds the same counts, so it is kept as it is. */
  countsKept: boolean;
  exportText: string;
  statusText: string;
}

/** Phase one: everything the three files will hold, computed in memory. Writes nothing. */
async function compute(deps: Required<SyncDeps>): Promise<Computed> {
  const { root } = deps;
  const runAt = deps.now();
  const snapshotText = await readIfExists(catalogFile(root, SNAPSHOT_COUNTS));
  if (snapshotText === null) throw new SyncError(`${SNAPSHOT_COUNTS} not found in ${CATALOG_DIR}`);
  const snapshot = parseObject(snapshotText, SNAPSHOT_COUNTS);

  const head = await deps.headHash(root);
  const fresh = parseObject(await deps.runCounts(root), "counts");
  const previousText = await readIfExists(catalogFile(root, LATEST_COUNTS));
  let previous: Record<string, unknown> | null = null;
  if (previousText !== null) {
    try {
      previous = parseObject(previousText, LATEST_COUNTS);
    } catch {
      previous = null;
    }
  }
  const countsKept = previousText !== null && previous !== null && withoutTime(previous) === withoutTime(fresh);
  const countsText = countsKept && previousText !== null ? previousText : JSON.stringify(fresh, null, 2);
  const latest = countsKept && previous !== null ? previous : fresh;

  const { rows } = await loadExportWithSummary(root, { since: EXPORT_SINCE });
  const exportText = rows.length === 0 ? "" : `${renderExport(rows, "jsonl")}\n`;
  const report = await loadReport(root);
  const log = (await readIfExists(catalogFile(root, CONTRIBUTION_LOG))) ?? "";
  const contributionRows = (log.match(/^\d{4}-\d{2}-\d{2} · /gm) ?? []).length;

  const statusText = renderStatus({ runAt, head, snapshot, latest, report, contributionRows });
  for (const text of [countsText, exportText, statusText]) {
    if (OFF_LIMITS.test(text)) throw new SyncError("output names a repository that must not appear");
  }
  return { countsText, countsKept, exportText, statusText };
}

/** After a failed run: the reason goes into the status page, and nothing else is written. */
async function recordFailure(root: string, runAt: Date, reason: string): Promise<void> {
  const file = catalogFile(root, STATUS_FILE);
  const text = renderFailureStatus({ runAt, reason, previous: await readIfExists(file) });
  await writeIfChanged(file, text);
}

export async function runResearchSync(input: SyncDeps): Promise<SyncOutcome> {
  const deps: Required<SyncDeps> = { now: () => new Date(), runCounts, headHash, ...input };
  const { root } = deps;
  const runAt = deps.now();
  let computed: Computed;
  try {
    if ((await readIfExists(catalogFile(root, SNAPSHOT_COUNTS))) === null && (await readIfExists(catalogFile(root, COUNTS_SCRIPT))) === null) {
      throw new SyncError(`run from the repository root: ${CATALOG_DIR} not found`);
    }
    computed = await compute({ ...deps, now: () => runAt });
  } catch (error) {
    const reason = reasonLine(error, root);
    try {
      await recordFailure(root, runAt, reason);
    } catch {
      // The reason still reaches the caller; the page could not be written.
    }
    return { ok: false, reason, changed: [] };
  }

  const changed: string[] = [];
  try {
    const targets: Array<[string, string]> = [
      [LATEST_COUNTS, computed.countsText],
      [LATEST_EXPORT, computed.exportText],
      [STATUS_FILE, computed.statusText],
    ];
    for (const [name, content] of targets) {
      if (await writeIfChanged(catalogFile(root, name), content)) changed.push(path.join(CATALOG_DIR, name));
    }
  } catch (error) {
    const reason = reasonLine(error, root);
    try {
      await recordFailure(root, runAt, reason);
    } catch {
      // See above.
    }
    return { ok: false, reason, changed };
  }
  return { ok: true, changed };
}

/** The run time of the last sync, as `sync-status.md` states it, or null when there is no page yet. */
export async function readLastSyncRun(root: string): Promise<string | null> {
  const text = await readIfExists(catalogFile(root, STATUS_FILE));
  if (text === null) return null;
  const line = text.split("\n").find((row) => row.startsWith("Запуск (run, UTC): "));
  return line === undefined ? null : line.slice("Запуск (run, UTC): ".length).trim();
}

export function printResearchHelp(): void {
  helpTitle("keryx research", "keep the Part 1 materials current");
  helpUsage(["keryx research sync", "keryx research --help"]);
  helpOptions([
    {
      flag: "sync",
      desc: `Run from the repository root. Refreshes ${CATALOG_DIR}: ${LATEST_COUNTS} (the unchanged ${COUNTS_SCRIPT} at HEAD), ${LATEST_EXPORT} (the text-free decisions export from 2026-10-02) and ${STATUS_FILE} (run time, HEAD, counts now against the snapshot, journal summary). Writes only those files, only when their content changed; no commit, no branch, no pull request. A failed run leaves the previous -latest files as they were and writes the reason into ${STATUS_FILE}.`,
    },
  ]);
}

export async function researchCommand(args: string[] = []): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    printResearchHelp();
    return;
  }
  if (args.slice(1).includes("--help") || args.slice(1).includes("-h")) {
    printResearchHelp();
    return;
  }
  if (sub !== "sync") {
    console.error(`  ${style.red(symbols.cross)} Unknown research command: ${sub}`);
    printResearchHelp();
    process.exitCode = 1;
    return;
  }
  if (args.length > 1) {
    console.error(`  ${style.red(symbols.cross)} keryx research sync takes no arguments.`);
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const outcome = await runResearchSync({ root });
  if (!outcome.ok) {
    console.error(`  ${style.red(symbols.cross)} Research sync failed: ${outcome.reason ?? "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  const when = formatRunTime(new Date());
  console.log(`  ${style.green(symbols.ok)} Research sync done (${when})${outcome.changed.length === 0 ? ": nothing changed" : ""}`);
  for (const file of outcome.changed) console.log(`    ${style.cyan(symbols.arrow)} ${file}`);
  note("Status: " + path.join(CATALOG_DIR, STATUS_FILE));
}
