// Per-page version history for `.metaproject/wiki/` (flow 367, AC1-AC4).
//
// Every keryx command that overwrites or deletes a wiki page goes through
// `writeWikiPage` / `deleteWikiPage`. Each version of a page is kept as a plain
// markdown file in the page's own history folder, and that folder's `index.md`
// lists every version: when it became live, which command and run produced it,
// its sha256, and a link to the stored copy. The newest row is the current one.
//
//   .metaproject/data/gdwiki/history/
//     runs.jsonl                         one line per page a run touched
//     components/src-auth/               history of wiki/components/src-auth.md
//       index.md                         current version + table of versions
//       v0001-2026-10-01T10-26-50-000Z.md
//
// A version's file is written when the version is recorded, not when it is
// replaced: a page edited by hand after a keryx write would otherwise lose the
// keryx version, since its bytes would exist nowhere else. A page keryx has not
// written before gets its live content recorded as a `baseline` version first.
//
// The tree sits outside the wiki root on purpose: everything under
// `.metaproject/wiki/` is read as current truth by `wiki validate`, `wiki ask`
// and the wiki index. Nothing here archives: every version is an `.md` file.

import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, toPosix, withFileLock, writeFileAtomic } from "../lib/fs";
import { loadWikiConfig } from "./config";

export const DEFAULT_HISTORY_KEEP = 20;

const INDEX_FILE = "index.md";
const RUNS_FILE = "runs.jsonl";
const PRUNED_FILE = "(pruned)";
const INVALID_FILE = "(invalid)";
/** Index rows kept per page; rows past it are dropped once their copy is pruned. */
const MAX_INDEX_ROWS = 200;
/** `runs.jsonl` is trimmed to its newest half once it passes this size. */
const MAX_RUNS_BYTES = 2 * 1024 * 1024;
const NO_FILE = "-";
const DELETED_SHA = "(deleted)";
const NO_RUN = "-";

/** Who is writing: one per command invocation, shared by every page it touches. */
export interface WikiWriteContext {
  cwd: string;
  /** The command as a user would type it, e.g. `wiki enrich`, `sync --apply`. */
  command: string;
  runId: string;
  /** Stored versions kept per page; older version files are pruned. */
  keep?: number;
  /** Index rows kept per page (default MAX_INDEX_ROWS). */
  maxIndexRows?: number;
  now?: () => Date;
}

export interface WikiVersionRow {
  version: number;
  /** ISO time the content became live (first seen, for baseline/manual rows). */
  at: string;
  by: string;
  run: string;
  /** sha256 of the content, or `(deleted)` for a deletion. */
  sha: string;
  /** Stored copy's file name, `(pruned)`, or `-` for a deletion. */
  file: string;
}

export interface WikiPageHistory {
  /** Page path relative to the wiki root, posix. */
  page: string;
  /** Newest (current) first. */
  rows: WikiVersionRow[];
}

export interface WikiRunEntry {
  runId: string;
  command: string;
  page: string;
  at: string;
  action: "created" | "updated" | "deleted";
}

export interface WikiWriteResult {
  /** False when the content was byte-identical and nothing was written. */
  changed: boolean;
  action?: WikiRunEntry["action"];
}

export function wikiRootPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki");
}

export function wikiHistoryRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "gdwiki", "history");
}

export function newWikiRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

export function createWikiWriteContext(
  cwd: string,
  command: string,
  options: { keep?: number; now?: () => Date } = {},
): WikiWriteContext {
  const now = options.now ?? (() => new Date());
  // The label lands in a markdown table cell: no pipes, no line breaks, no
  // backticks to open a code span across cells (review r1 S-006), bounded.
  const label = command.replace(/[|\r\n]+/g, " ").replace(/`/g, "'").replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    cwd,
    command: label,
    runId: newWikiRunId(now()),
    now,
    ...(options.keep !== undefined ? { keep: options.keep } : {}),
  };
}

/** A write context whose retention comes from `.metaproject/wiki.config.json`. */
export async function openWikiWriteContext(cwd: string, command: string): Promise<WikiWriteContext> {
  return createWikiWriteContext(cwd, command, { keep: (await loadWikiConfig(cwd)).history.keep });
}

/** Page path relative to the wiki root (posix); throws when outside it. */
export function wikiPageKey(cwd: string, absolutePath: string): string {
  const relative = path.relative(wikiRootPath(cwd), path.resolve(absolutePath));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`not a wiki page: ${absolutePath}`);
  }
  return toPosix(relative);
}

/**
 * A page key is a wiki-relative posix path. One arriving from argv or from
 * `runs.jsonl` is checked here, because every path below is joined from it: a
 * `..` segment would point a read, a restore or a delete outside the wiki and
 * history roots (review r1 S-002).
 */
function assertPageKey(page: string): string {
  const segments = page.split("/");
  if (
    page.length === 0 ||
    page.includes("\\") ||
    path.isAbsolute(page) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`not a wiki page path: ${page}`);
  }
  return page;
}

export function pageHistoryDir(cwd: string, page: string): string {
  return path.join(wikiHistoryRoot(cwd), ...assertPageKey(page).replace(/\.md$/i, "").split("/"));
}

function pagePath(cwd: string, page: string): string {
  return path.join(wikiRootPath(cwd), ...assertPageKey(page).split("/"));
}

/** A version file name as keryx writes it: `vNNNN-<timestamp>.md`, nothing else. */
const VERSION_FILE = /^v\d+-[0-9A-Za-z-]+\.md$/;

/**
 * The path of one stored version. `file` is read back from an `index.md` that
 * anyone can edit, so it is held to the shape keryx writes and must resolve
 * inside the page's history folder — otherwise a crafted row could make a
 * prune delete, or a restore read, any `.md` file reachable by `..` (review r1
 * S-001).
 */
function versionFilePath(cwd: string, page: string, file: string): string {
  const dir = pageHistoryDir(cwd, page);
  const target = path.join(dir, file);
  if (!VERSION_FILE.test(file) || path.dirname(target) !== dir) {
    throw new Error(`history index names an invalid version file for ${page}: ${file}`);
  }
  return target;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function versionLabel(version: number): string {
  return `v${String(version).padStart(4, "0")}`;
}

export function parseVersionLabel(value: string): number {
  const match = /^v?(\d+)$/i.exec(value.trim());
  if (!match) throw new Error(`not a version: ${value} (expected vNNNN)`);
  return Number(match[1]);
}

async function readBufferOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// index.md: rendered from rows and parsed back from the same fixed table.
// ---------------------------------------------------------------------------

export function renderPageHistoryIndex(history: WikiPageHistory): string {
  const current = history.rows[0];
  const lines = [
    "---",
    `page: ${history.page}`,
    `current: ${current ? versionLabel(current.version) : "none"}`,
    "---",
    "",
    `# History: ${history.page}`,
    "",
    "Written by keryx before each change to the page; the first row is the current version.",
    `Restore with \`keryx wiki restore ${history.page} --version vNNNN\`.`,
    "",
    "| version | when (UTC) | by | run | sha256 | file |",
    "|---|---|---|---|---|---|",
  ];
  history.rows.forEach((row, index) => {
    const label = index === 0 ? `${versionLabel(row.version)} (current)` : versionLabel(row.version);
    const file = row.file.endsWith(".md") ? `[${versionLabel(row.version)}](${row.file})` : row.file;
    // `by` is argv-derived: rendered as a code span so a link or emphasis in a
    // command line stays inert text in the table (review r1 S-006).
    lines.push(`| ${label} | ${row.at} | \`${row.by}\` | ${row.run} | ${row.sha} | ${file} |`);
  });
  return `${lines.join("\n")}\n`;
}

const ROW = /^\|\s*v(\d+)[^|]*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/;

export function parsePageHistoryIndex(markdown: string, page: string): WikiPageHistory {
  const rows: WikiVersionRow[] = [];
  for (const line of markdown.split("\n")) {
    const match = ROW.exec(line);
    if (!match) continue;
    const link = /^\[v\d+\]\((.+)\)$/.exec(match[6]!);
    const file = link ? link[1]! : match[6]!;
    rows.push({
      version: Number(match[1]),
      at: match[2]!,
      by: match[3]!.replace(/^`(.*)`$/, "$1"),
      run: match[4]!,
      sha: match[5]!,
      // Only a name keryx could have written is kept as a file reference; any
      // other value (a path, a traversal) is treated as no stored copy.
      file: file.endsWith(".md") && !VERSION_FILE.test(file) ? INVALID_FILE : file,
    });
  }
  rows.sort((a, b) => b.version - a.version);
  return { page, rows };
}

export async function readPageHistory(cwd: string, page: string): Promise<WikiPageHistory | null> {
  const indexPath = path.join(pageHistoryDir(cwd, page), INDEX_FILE);
  const raw = await readBufferOrNull(indexPath);
  if (raw === null) return null;
  const history = parsePageHistoryIndex(raw.toString("utf8"), page);
  if (history.rows.length === 0) {
    throw new Error(`history index has no version rows (edited by hand?): ${indexPath}`);
  }
  return history;
}

// ---------------------------------------------------------------------------
// The write path.
// ---------------------------------------------------------------------------

/** Store `content` as `version`'s file and prove the stored bytes match. */
async function storeVersion(cwd: string, page: string, version: number, at: string, content: Buffer): Promise<string> {
  const fileName = `${versionLabel(version)}-${at.replace(/[:.]/g, "-")}.md`;
  const target = path.join(pageHistoryDir(cwd, page), fileName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  if (sha256(await readFile(target)) !== sha256(content)) {
    throw new Error(`history: stored version does not match the page bytes: ${target}`);
  }
  return fileName;
}

/**
 * Bring the history in line with what is on disk before a write:
 *
 * - no history yet: the live page is recorded as a `baseline` version (nothing
 *   is recorded when the page does not exist either);
 * - the page differs from its last recorded version (changed outside keryx, or
 *   an earlier write was interrupted): the live content is recorded as a
 *   `manual (detected)` version.
 */
async function reconcile(cwd: string, page: string, live: Buffer | null, liveSeenAt: string): Promise<WikiPageHistory> {
  const existing = await readPageHistory(cwd, page);
  const liveSha = live === null ? DELETED_SHA : sha256(live);
  const record = async (version: number, by: string): Promise<WikiVersionRow> => ({
    version,
    at: liveSeenAt,
    by,
    run: NO_RUN,
    sha: liveSha,
    file: live === null ? NO_FILE : await storeVersion(cwd, page, version, liveSeenAt, live),
  });

  if (existing === null) {
    return { page, rows: live === null ? [] : [await record(1, "baseline (before history)")] };
  }
  const current = existing.rows[0]!;
  if (current.sha === liveSha) return existing;
  // Also reached after an interrupted write (page written, index not yet
  // advanced): indistinguishable from a hand edit, so it is recorded the same
  // way and nothing is dropped — at worst an extra row, never a lost one.
  const manual = await record(current.version + 1, live === null ? "manual delete (detected)" : "manual (detected)");
  return { page, rows: [manual, ...existing.rows] };
}

/**
 * Mark versions beyond `keep` as pruned and return the files to delete. Nothing
 * is deleted here: the caller removes them only after the new index is on disk,
 * so a write that fails midway never leaves an index pointing at deleted files.
 */
function planPrune(
  history: WikiPageHistory,
  keep: number,
  maxRows = MAX_INDEX_ROWS,
): { history: WikiPageHistory; files: string[] } {
  const stored = history.rows.filter((row) => VERSION_FILE.test(row.file));
  const drop = new Set(stored.slice(Math.max(1, keep)).map((row) => row.version));
  const rows = history.rows.map((row) => (drop.has(row.version) ? { ...row, file: PRUNED_FILE } : row));
  // The index itself is bounded too (review r1 S-004): past MAX_INDEX_ROWS the
  // oldest rows go, and by then their copies are long pruned.
  return {
    history: { page: history.page, rows: rows.slice(0, Math.max(keep + 1, maxRows)) },
    files: history.rows.filter((row) => drop.has(row.version)).map((row) => row.file),
  };
}

/**
 * The history tree must never be committed (a commit of it would carry every
 * enrich run's page copies into the branch), and the project's gitignore block
 * is only as current as its last `keryx update` (review r1 S-003). So the tree
 * ignores itself: a `.gitignore` of `*` at its root, written once.
 */
async function ensureHistoryRoot(cwd: string): Promise<void> {
  const root = wikiHistoryRoot(cwd);
  const ignore = path.join(root, ".gitignore");
  if (await readBufferOrNull(ignore)) return;
  await mkdir(root, { recursive: true });
  await writeFile(ignore, "# keryx wiki page history (flow 367): local undo state, never committed.\n*\n", "utf8");
}

/** True when `file` exists, is non-empty and its last byte is not `\n`. */
async function endsWithoutNewline(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * Append one line to `runs.jsonl`. A single short append to a file opened for
 * appending needs no lock between pages; only trimming does: once the log
 * passes MAX_RUNS_BYTES it is cut to its newest half under a lock, so it cannot
 * grow without bound (review r1 S-004). An append racing that rare trim can be
 * lost; the page's own history index still has its row.
 */
async function appendRun(cwd: string, entry: WikiRunEntry): Promise<void> {
  const root = wikiHistoryRoot(cwd);
  const file = path.join(root, RUNS_FILE);
  // After a torn last line (an append cut short) the file does not end in a
  // newline, and this entry would be glued onto the fragment and lost with it.
  const lead = (await endsWithoutNewline(file)) ? "\n" : "";
  await appendFile(file, `${lead}${JSON.stringify(entry)}\n`, "utf8");
  if ((await stat(file)).size <= MAX_RUNS_BYTES) return;
  await withFileLock(path.join(root, ".runs.lock"), async () => {
    if ((await stat(file)).size <= MAX_RUNS_BYTES) return;
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    await writeFileAtomic(file, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`);
  });
}

async function mutatePage(ctx: WikiWriteContext, absolutePath: string, next: Buffer | null): Promise<WikiWriteResult> {
  const page = wikiPageKey(ctx.cwd, absolutePath);
  const dir = pageHistoryDir(ctx.cwd, page);
  await ensureHistoryRoot(ctx.cwd);
  return withFileLock(path.join(path.dirname(dir), `.${path.basename(dir)}.lock`), async () => {
    const live = await readBufferOrNull(absolutePath);
    if (next === null ? live === null : live !== null && live.equals(next)) {
      return { changed: false };
    }
    const now = (ctx.now ?? (() => new Date()))().toISOString();
    const liveSeenAt = live === null ? now : (await stat(absolutePath)).mtime.toISOString();

    const before = await reconcile(ctx.cwd, page, live, liveSeenAt);
    const version = (before.rows[0]?.version ?? 0) + 1;
    const row: WikiVersionRow = {
      version,
      at: now,
      by: ctx.command,
      run: ctx.runId,
      sha: next === null ? DELETED_SHA : sha256(next),
      file: next === null ? NO_FILE : await storeVersion(ctx.cwd, page, version, now, next),
    };
    const { history, files: pruned } = planPrune(
      { page, rows: [row, ...before.rows] },
      ctx.keep ?? DEFAULT_HISTORY_KEEP,
      ctx.maxIndexRows,
    );
    const action: WikiRunEntry["action"] = next === null ? "deleted" : live === null ? "created" : "updated";

    // The run log first (review r1 L-009): a page this run is about to change
    // must be findable by `restore --run` even if what follows fails. A logged
    // page that then was not written shows up there as a conflict, not a loss.
    await appendRun(ctx.cwd, { runId: ctx.runId, command: ctx.command, page, at: now, action });

    // Then the page, then the index. A page write that fails (a read-only
    // page, a full disk) leaves the index as it was, and the new version's
    // file is removed again. Written in place, not by rename, so a page's own
    // permissions still apply: a read-only page is refused, not replaced.
    try {
      if (next === null) {
        await rm(absolutePath, { force: true });
      } else {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, next);
      }
    } catch (error) {
      if (VERSION_FILE.test(row.file)) await rm(versionFilePath(ctx.cwd, page, row.file), { force: true });
      throw error;
    }
    // A crash here leaves a page that differs from the index's current row;
    // `reconcile` records it next time, and its bytes are already stored above.
    await writeFileAtomic(path.join(dir, INDEX_FILE), renderPageHistoryIndex(history));
    for (const file of pruned) await rm(versionFilePath(ctx.cwd, page, file), { force: true });
    return { changed: true, action };
  });
}

/**
 * Write a wiki page through its history: the previous content is recorded
 * first, and a failure to record it throws with the page left untouched.
 * Byte-identical content is a no-op and records nothing.
 *
 * `content` is a string, so every write is UTF-8; a stored version holds the
 * page's exact prior bytes whatever their encoding.
 */
export async function writeWikiPage(ctx: WikiWriteContext, absolutePath: string, content: string): Promise<WikiWriteResult> {
  return mutatePage(ctx, absolutePath, Buffer.from(content, "utf8"));
}

/** Delete a wiki page, keeping its last content in the page's history first. */
export async function deleteWikiPage(ctx: WikiWriteContext, absolutePath: string): Promise<WikiWriteResult> {
  return mutatePage(ctx, absolutePath, null);
}

// ---------------------------------------------------------------------------
// Runs, and restoring.
// ---------------------------------------------------------------------------

export async function readWikiRuns(cwd: string): Promise<WikiRunEntry[]> {
  const raw = await readBufferOrNull(path.join(wikiHistoryRoot(cwd), RUNS_FILE));
  if (raw === null) return [];
  const entries: WikiRunEntry[] = [];
  for (const line of raw.toString("utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as WikiRunEntry);
    } catch {
      // A torn last line from an interrupted append; the page indexes stay authoritative.
    }
  }
  return entries;
}

export interface WikiRunSummary {
  runId: string;
  command: string;
  at: string;
  pages: number;
}

/** Runs newest first, one row per run id. */
export async function listWikiRuns(cwd: string): Promise<WikiRunSummary[]> {
  const byRun = new Map<string, { summary: WikiRunSummary; pages: Set<string> }>();
  for (const entry of await readWikiRuns(cwd)) {
    const run = byRun.get(entry.runId) ?? {
      summary: { runId: entry.runId, command: entry.command, at: entry.at, pages: 0 },
      pages: new Set<string>(),
    };
    run.pages.add(entry.page);
    run.summary.pages = run.pages.size;
    if (entry.at < run.summary.at) run.summary.at = entry.at;
    byRun.set(entry.runId, run);
  }
  return [...byRun.values()].map((run) => run.summary).sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Pages `runId` changed, from the runs log. */
export async function pagesChangedByRun(cwd: string, runId: string): Promise<string[]> {
  const entries = (await readWikiRuns(cwd)).filter((entry) => entry.runId === runId);
  return [...new Set(entries.map((entry) => entry.page))].sort();
}

/** After a mutating command: say how to undo it, when it changed any page. */
export async function printWikiUndoHint(ctx: WikiWriteContext, log: (line: string) => void = console.log): Promise<void> {
  const pages = await pagesChangedByRun(ctx.cwd, ctx.runId);
  if (pages.length === 0) return;
  log(`wiki history: ${pages.length} page(s) changed in ${ctx.runId} — undo with \`keryx wiki restore --run ${ctx.runId}\``);
}

async function readVersionContent(cwd: string, page: string, row: WikiVersionRow): Promise<Buffer | null> {
  if (row.sha === DELETED_SHA) return null;
  if (!VERSION_FILE.test(row.file)) {
    throw new Error(`${versionLabel(row.version)} of ${page} has no stored copy (${row.file})`);
  }
  const content = await readFile(versionFilePath(cwd, page, row.file));
  if (sha256(content) !== row.sha) {
    throw new Error(`${versionLabel(row.version)} of ${page} does not match its recorded sha256`);
  }
  return content;
}

/**
 * What the page said before its live content, for judging what the last change
 * did: the newest recorded version with different content, counted from the
 * OLDEST recorded occurrence of the live content. So after a restore (the live
 * page equals an earlier version again) the page is judged against what came
 * before that earlier version, not against the damage the restore undid.
 *
 * Null when the live content is not in the history at all: the page was
 * changed outside keryx since, which is as likely a deliberate edit as damage,
 * and nothing records it until keryx next writes the page — judging it would
 * report an error nobody can clear (review r1 L-001). Null also when there is
 * no history, or that version was a deletion or is pruned.
 */
export async function readPreviousVersion(cwd: string, page: string, live: string): Promise<string | null> {
  const history = await readPageHistory(cwd, page);
  if (history === null) return null;
  const liveSha = sha256(Buffer.from(live, "utf8"));
  let oldestMatch = -1;
  history.rows.forEach((row, index) => {
    if (row.sha === liveSha) oldestMatch = index;
  });
  if (oldestMatch < 0) return null;
  const previous = history.rows.slice(oldestMatch + 1).find((row) => row.sha !== liveSha);
  if (!previous || previous.sha === DELETED_SHA || !VERSION_FILE.test(previous.file)) return null;
  return (await readVersionContent(cwd, page, previous))?.toString("utf8") ?? null;
}

export interface WikiRestoreOutcome {
  page: string;
  /** The version the page now holds, or `(absent)` when it did not exist before. */
  restoredTo: string;
  action: "restored" | "deleted" | "unchanged";
}

const ABSENT: WikiVersionRow = { version: 0, at: "", by: "", run: NO_RUN, sha: DELETED_SHA, file: NO_FILE };

async function restoreTo(ctx: WikiWriteContext, page: string, target: WikiVersionRow): Promise<WikiRestoreOutcome> {
  const content = await readVersionContent(ctx.cwd, page, target);
  const absolutePath = pagePath(ctx.cwd, page);
  const result = content === null
    ? await deleteWikiPage(ctx, absolutePath)
    : await writeWikiPage(ctx, absolutePath, content.toString("utf8"));
  return {
    page,
    restoredTo: target.version === 0 ? "(absent)" : versionLabel(target.version),
    action: !result.changed ? "unchanged" : content === null ? "deleted" : "restored",
  };
}

/**
 * Restore one page to `version`. Without one: undo the last change — back to
 * the last recorded version when the page was changed outside keryx since
 * (a hand edit, a script), otherwise to the version before the current one.
 */
export async function restoreWikiPage(ctx: WikiWriteContext, page: string, version?: number): Promise<WikiRestoreOutcome> {
  const history = await readPageHistory(ctx.cwd, page);
  if (history === null) throw new Error(`no history for ${page}`);
  const live = await readBufferOrNull(pagePath(ctx.cwd, page));
  const changedSince = history.rows[0]!.sha !== (live === null ? DELETED_SHA : sha256(live));
  const target = version !== undefined
    ? history.rows.find((row) => row.version === version)
    : changedSince ? history.rows[0] : history.rows[1];
  if (!target) {
    throw new Error(version === undefined ? `${page} has only one version` : `${page} has no ${versionLabel(version)}`);
  }
  return restoreTo(ctx, page, target);
}

export interface WikiRunRestoreResult {
  runId: string;
  restored: WikiRestoreOutcome[];
  /** Pages changed again after the run; left alone unless `force`. */
  conflicts: { page: string; reason: string }[];
}

/**
 * Put every page `runId` touched back to the version it had before that run:
 * pages the run created are deleted, pages it deleted come back. A page changed
 * again after the run (by a later run or by hand) is reported as a conflict and
 * left alone, unless `force`.
 */
export async function restoreWikiRun(
  ctx: WikiWriteContext,
  runId: string,
  options: { force?: boolean } = {},
): Promise<WikiRunRestoreResult> {
  const pages = await pagesChangedByRun(ctx.cwd, runId);
  if (pages.length === 0) throw new Error(`no pages recorded for ${runId} (list runs with \`keryx wiki history --runs\`)`);
  const result: WikiRunRestoreResult = { runId, restored: [], conflicts: [] };
  for (const page of pages) {
    // One page that cannot be restored (its target version pruned, its history
    // unreadable, a bad key in the log) is reported and the rest still go back
    // — never an abort half way with nothing said (review r1 L-002).
    try {
      const outcome = await restorePageFromRun(ctx, page, runId, options.force === true);
      if ("reason" in outcome) result.conflicts.push(outcome);
      else result.restored.push(outcome);
    } catch (error) {
      result.conflicts.push({ page, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

async function restorePageFromRun(
  ctx: WikiWriteContext,
  page: string,
  runId: string,
  force: boolean,
): Promise<WikiRestoreOutcome | { page: string; reason: string }> {
  const history = await readPageHistory(ctx.cwd, page);
  const fromRun = history?.rows.filter((row) => row.run === runId) ?? [];
  if (history === null || fromRun.length === 0) {
    return { page, reason: "no version from this run in the page history" };
  }
  const newest = fromRun[0]!;
  const oldest = fromRun[fromRun.length - 1]!;
  const live = await readBufferOrNull(pagePath(ctx.cwd, page));
  const liveSha = live === null ? DELETED_SHA : sha256(live);
  if (!force && (history.rows[0]!.version !== newest.version || liveSha !== newest.sha)) {
    return { page, reason: "changed after this run (use --force to restore anyway)" };
  }
  const before = history.rows.find((row) => row.version < oldest.version) ?? ABSENT;
  return restoreTo(ctx, page, before);
}
