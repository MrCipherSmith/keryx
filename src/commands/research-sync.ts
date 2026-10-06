// Flow 404: `keryx research sync` keeps the Part 1 materials next to it current: the counts the unchanged
// `part1-counts.py` produces now, this machine's own text-free decisions export (`raw/decisions-<host>.jsonl`), the
// merge of every machine's raw export (`decisions-export-latest.jsonl`), and `sync-status.md`, the one page that says
// when it ran and where the numbers stand. The journal lives on one machine only, so each machine writes only its
// own raw file and the merged file is rebuilt from all of `raw/`: machines no longer overwrite each other.
//
// Two phases, so a failure leaves the last good data alone: everything is computed in memory first, and only a
// complete result is written. It runs from the repository root, writes only those files, and never touches
// git history: no commit, no branch, no pull request. The scheduler calls this command; nothing here hooks an event.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadReport, machineExport, machineFileName, mergeMachineRows, parseMachineRows, renderMachineRows, type MachineRow } from "../decisions/service";
import { pathExists } from "../lib/fs";
import { helpOptions, helpTitle, helpUsage, note, style, symbols } from "../lib/ui";
import { scheduleResearchSync, unscheduleResearchSync } from "../scheduler/research-sync-job";
import { formatRunTime, reasonLine, renderFailureStatus, renderStatus } from "./research-sync-status";

const run = promisify(execFile);

export const CATALOG_DIR = path.join("docs", "research", "role-blurring-part1");
export const COUNTS_SCRIPT = "part1-counts.py";
export const SNAPSHOT_COUNTS = "part1-counts.json";
export const LATEST_COUNTS = "part1-counts-latest.json";
export const LATEST_EXPORT = "decisions-export-latest.jsonl";
export const STATUS_FILE = "sync-status.md";
const CONTRIBUTION_LOG = "contribution-log.md";
/** One text-free export per machine, written by that machine's sync; the merged file is built from all of them. */
export const RAW_DIR = "raw";
const RAW_FILE = /^decisions-.+\.jsonl$/;
const COUNTS_TIMEOUT_MS = 120_000;
/** git and tar are quick; a child that has not answered in this long is hung. */
const TOOL_TIMEOUT_MS = 60_000;
/** Nothing the sync writes may name the operator's team repositories (flow 404, AC7). */
const OFF_LIMITS = /(?<![a-z0-9])(?:frontend|backend|board|process-metrics)(?![a-z0-9])/i;

/** Whole words only: "dashboard" or "keyboard" is not the word "board". */
export const namesOffLimits = (text: string): boolean => OFF_LIMITS.test(text);

export interface SyncDeps {
  /** The repository root: the directory the command was run from. */
  root: string;
  now?: () => Date;
  /** The text of the `part1-counts.json` the unchanged script produces at HEAD. */
  runCounts?: (root: string) => Promise<string>;
  headHash?: (root: string) => Promise<string>;
  /** Test seam: how a staged file is written before the renames. Default `writeFile`. */
  writeStaged?: (file: string, content: string) => Promise<void>;
  /** Test seam: how a staged file replaces its target. Default `rename`. */
  renameStaged?: (from: string, to: string) => Promise<void>;
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
    const { stdout } = await run(command, args, { timeout: TOOL_TIMEOUT_MS, ...options, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
    return String(stdout);
  } catch (error) {
    const failed = error as { code?: unknown; killed?: unknown };
    if (failed.killed === true) throw new SyncError(`${label} timed out`);
    const code = failed.code;
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
  /** This machine's raw export, relative to the catalog, and its text; null when there is nothing to write. */
  ownRaw: { name: string; text: string } | null;
}

/**
 * Every raw export in the working tree, parsed and checked, with this machine's file replaced by the text just
 * computed so the merge is of one generation. A file that fails its checks, or a pair seen twice, fails the run (every error in phase one is a failed run).
 */
async function rawFiles(root: string, ownRaw: { name: string; text: string } | null): Promise<Array<{ label: string; rows: MachineRow[] }>> {
  let names: string[];
  try {
    names = (await readdir(catalogFile(root, RAW_DIR))).filter((name) => RAW_FILE.test(name));
  } catch {
    names = [];
  }
  const own = ownRaw === null ? null : path.posix.basename(ownRaw.name);
  if (own !== null && !names.includes(own)) names.push(own);
  const files: Array<{ label: string; rows: MachineRow[] }> = [];
  for (const name of names.sort()) {
    const body = name === own ? (ownRaw as { text: string }).text : await readFile(catalogFile(root, path.join(RAW_DIR, name)), "utf8");
    const label = `${RAW_DIR}/${name}`;
    files.push({ label, rows: parseMachineRows(body, label) });
  }
  return files;
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

  const own = await machineExport(root);
  const ownRaw = own === null || own.rows.length === 0 ? null : { name: `${RAW_DIR}/${machineFileName(own.host)}`, text: renderMachineRows(own.rows) };
  const merged = mergeMachineRows(await rawFiles(root, ownRaw));
  const exportText = renderMachineRows(merged.rows);
  const machines = {
    perHost: merged.perHost,
    total: merged.rows.length,
    withRecommendation: merged.rows.filter((row) => row.hasRecommendation === true).length,
    live: merged.rows.filter((row) => row.backfilled !== true).length,
  };
  const report = await loadReport(root);
  const log = (await readIfExists(catalogFile(root, CONTRIBUTION_LOG))) ?? "";
  const contributionRows = (log.match(/^\d{4}-\d{2}-\d{2} · /gm) ?? []).length;

  const statusText = renderStatus({ runAt, head, snapshot, latest, report, contributionRows, machines });
  for (const text of [countsText, exportText, statusText, ownRaw?.text ?? ""]) {
    if (namesOffLimits(text)) throw new SyncError("output names a repository that must not appear");
  }
  return { countsText, countsKept, exportText, statusText, ownRaw };
}

/** After a failed run: the reason goes into the status page, and nothing else is written. */
async function recordFailure(root: string, runAt: Date, reason: string): Promise<void> {
  const file = catalogFile(root, STATUS_FILE);
  const text = renderFailureStatus({ runAt, reason, previous: await readIfExists(file) });
  await writeIfChanged(file, text);
}

export async function runResearchSync(input: SyncDeps): Promise<SyncOutcome> {
  const deps: Required<SyncDeps> = { now: () => new Date(), runCounts, headHash, writeStaged: (file, content) => writeFile(file, content, "utf8"), renameStaged: rename, ...input };
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

  // Phase two, in two steps so the three files stay of one generation as far as a filesystem allows: every file
  // that changed is written to a temp file first (a failure here has touched nothing that matters), and only then
  // are the temp files renamed in a row.
  const changed: string[] = [];
  const staged: Array<{ name: string; file: string; temp: string; previous: string | null }> = [];
  const renamed: typeof staged = [];
  try {
    const targets: Array<[string, string]> = [
      ...(computed.ownRaw === null ? [] : [[computed.ownRaw.name, computed.ownRaw.text] as [string, string]]),
      [LATEST_COUNTS, computed.countsText],
      [LATEST_EXPORT, computed.exportText],
      [STATUS_FILE, computed.statusText],
    ];
    for (const [name, content] of targets) {
      const file = catalogFile(root, name);
      const previous = await readIfExists(file);
      if (previous === content) continue;
      if (name.startsWith(`${RAW_DIR}/`)) await mkdir(path.dirname(file), { recursive: true });
      const item = { name, file, temp: `${file}.tmp-${process.pid}`, previous };
      staged.push(item);
      await deps.writeStaged(item.temp, content);
    }
    for (const item of staged) {
      await deps.renameStaged(item.temp, item.file);
      renamed.push(item);
      changed.push(path.join(CATALOG_DIR, item.name));
    }
  } catch (error) {
    for (const item of staged) await rm(item.temp, { force: true });
    // A rename that failed part-way would leave the files of different generations: put the old content back.
    for (const item of renamed) {
      try {
        if (item.previous === null) await rm(item.file, { force: true });
        else await writeFile(item.file, item.previous, "utf8");
      } catch {
        // Best effort; the reason below still reaches the caller.
      }
    }
    changed.length = 0;
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
  helpUsage(["keryx research sync", "keryx research sync --schedule daily", "keryx research sync --unschedule", "keryx research --help"]);
  helpOptions([
    {
      flag: "sync",
      desc: `Run from the repository root. Refreshes ${CATALOG_DIR}: ${RAW_DIR}/decisions-<host>.jsonl (this machine's whole text-free decisions journal; skipped when the machine has no seed), ${LATEST_COUNTS} (the unchanged ${COUNTS_SCRIPT} at HEAD), ${LATEST_EXPORT} (the merge of every ${RAW_DIR}/decisions-*.jsonl, ordered by time, with globalSeq) and ${STATUS_FILE} (run time, HEAD, counts now against the snapshot, journal summary, machines and records per machine). Writes only those files, only when their content changed; no commit, no branch, no pull request. A failed run, including a duplicate (host, seq) or an invalid raw file, leaves the previous -latest files as they were and writes the reason into ${STATUS_FILE}.`,
    },
    {
      flag: "sync --schedule daily",
      desc: "Run from the repository root. Creates the daily entry: a running `keryx serve` then runs the sync once per UTC day from this directory (a restart the same day does not run it again; a failed run is shown as a notice in serve and is not retried until the next day). It does not run the sync now. Needs the catalog directory. Serve ignores an entry that git tracks, so one committed into a clone is never acted on.",
    },
    {
      flag: "sync --unschedule",
      desc: "Removes the daily entry and the record of its last run. A sync already written stays as it is.",
    },
  ]);
}

const SYNC_USAGE = "keryx research sync [--schedule daily | --unschedule]";

/** `keryx research sync --schedule daily` and `--unschedule`: the daily entry a running `keryx serve` acts on. */
async function researchScheduleCommand(rest: string[]): Promise<void> {
  const fail = (message: string): void => {
    console.error(`  ${style.red(symbols.cross)} ${message}`);
    process.exitCode = 1;
  };
  let schedule: string | undefined;
  let unschedule = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === "--unschedule") {
      unschedule = true;
    } else if (arg === "--schedule") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) return fail(`--schedule needs a value: daily. Usage: ${SYNC_USAGE}`);
      schedule = value;
      i += 1;
    } else if (arg.startsWith("--schedule=")) {
      schedule = arg.slice("--schedule=".length);
    } else {
      return fail(`keryx research sync: unknown argument ${JSON.stringify(arg.slice(0, 40))}. Usage: ${SYNC_USAGE}`);
    }
  }
  if (schedule !== undefined && unschedule) return fail("--schedule and --unschedule cannot be used together.");
  if (schedule !== undefined && schedule !== "daily") return fail(`--schedule takes "daily" only (got ${JSON.stringify(schedule.slice(0, 40))}).`);

  const root = process.cwd();
  if (unschedule) {
    const { removed } = await unscheduleResearchSync(root);
    console.log(`  ${style.green(symbols.ok)} ${removed ? "Daily research sync removed" : "No daily research sync was scheduled"}`);
    return;
  }
  if (!(await pathExists(path.join(root, CATALOG_DIR)))) return fail(`run from the repository root: ${CATALOG_DIR} not found`);
  const { created } = await scheduleResearchSync(root);
  console.log(`  ${style.green(symbols.ok)} ${created ? "Daily research sync scheduled" : "Daily research sync is already scheduled"}`);
  note("keryx serve runs it once per UTC day, from this directory; stop it with: keryx research sync --unschedule");
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
  const rest = args.slice(1);
  if (rest.length > 0) {
    await researchScheduleCommand(rest);
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
