// Flow 392: the journal file. Append-only JSONL under
// `.metaproject/data/decisions/journal.jsonl`, one record per line, mode 0o600.
//
// One journal per repository, not per worktree: the file lives under the MAIN
// checkout (the parent of git's common dir), so a flow worked in a linked
// worktree and the checkout that later merges it read and write the same
// journal. It stays git-ignored. Outside a git repository the journal sits under
// `cwd`, as it always did.
//
// The reader drops lines it cannot parse or whose shape is wrong, and says how
// many it dropped, so a damaged line never takes the report (or a question) down
// with it and is never silently absent either.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import type { DecisionRecord } from "./types";

const rootCache = new Map<string, string>();

/**
 * The directory the journal lives under: the main checkout when `cwd` is in a
 * git repository (main or linked worktree), else `cwd` itself.
 */
export async function journalRoot(cwd: string): Promise<string> {
  const cached = rootCache.get(cwd);
  if (cached !== undefined) return cached;
  let root = cwd;
  const commonDir = await resolveGitCommonDir(cwd);
  // Only the conventional layout (`<root>/.git`) names a checkout; a separate
  // git dir or a bare repo has no checkout to put a journal under.
  if (commonDir !== undefined && path.basename(commonDir) === ".git") root = path.dirname(commonDir);
  rootCache.set(cwd, root);
  return root;
}

export function decisionsDir(root: string): string {
  return path.join(root, ".metaproject", "data", "decisions");
}

/** The journal file under `root` (a directory `journalRoot` returned, or a plain project root). */
export function journalFile(root: string): string {
  return path.join(decisionsDir(root), "journal.jsonl");
}

/** The journal file for the repository `cwd` belongs to. */
export async function resolveJournalFile(cwd: string): Promise<string> {
  return journalFile(await journalRoot(cwd));
}

export function configFile(cwd: string): string {
  return path.join(cwd, ".metaproject", "decisions.config.json");
}

export async function appendRecord(cwd: string, record: DecisionRecord): Promise<void> {
  const root = await journalRoot(cwd);
  await mkdir(decisionsDir(root), { recursive: true });
  await appendFile(journalFile(root), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function endsWithoutNewline(file: string): Promise<boolean> {
  try {
    const text = await readFile(file, "utf8");
    return text.length > 0 && !text.endsWith("\n");
  } catch {
    return false;
  }
}

/** Append several records in one write, so a batch (an import) is never interleaved with another writer's line. */
export async function appendRecords(cwd: string, records: readonly DecisionRecord[]): Promise<void> {
  if (records.length === 0) return;
  const root = await journalRoot(cwd);
  await mkdir(decisionsDir(root), { recursive: true });
  const file = journalFile(root);
  // a last line cut short by an earlier crash has no newline: end it, so the first record of this batch does not fuse with it
  const lead = (await endsWithoutNewline(file)) ? "\n" : "";
  await appendFile(file, lead + records.map((record) => `${JSON.stringify(record)}\n`).join(""), { encoding: "utf8", mode: 0o600 });
}

/** The lock file that serialises a read-then-append over the journal (an import). */
export function journalLockFile(root: string): string {
  return `${journalFile(root)}.lock`;
}

export interface JournalLockOptions {
  /** A lock older than this is taken to be abandoned even when its pid is alive (a hung or reused pid). */
  staleMs?: number;
  /** How long to wait for a lock held by a live run before giving up. */
  timeoutMs?: number;
  pollMs?: number;
}

export const JOURNAL_LOCK_STALE_MS = 60_000;
export const JOURNAL_LOCK_TIMEOUT_MS = 15_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is not ours
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Abandoned: older than `staleMs`, or written by a process that no longer exists. A half-written (empty) lock is young, so it is waited for. */
async function lockIsStale(file: string, staleMs: number): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return false;
  }
  if (Date.now() - mtimeMs > staleMs) return true;
  try {
    const pid = (JSON.parse(await readFile(file, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && !pidAlive(pid);
  } catch {
    return false;
  }
}

async function ownsLock(file: string, token: string): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(file, "utf8")) as { token?: unknown }).token === token;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the journal's lock: an `O_EXCL` file next to the journal that
 * names the holder (pid, time, token). A second run waits for it; a lock whose pid is
 * dead, or that is older than `staleMs`, is broken (renamed away, then removed). The
 * lock is released in `finally`, and only when it is still ours, so a lock that was
 * broken as stale while we hung is not removed from under its new holder. Taking it
 * and breaking a stale one are not atomic with each other; the window is two runs
 * both finding the same abandoned lock, which a lock this young never is.
 *
 * Only a read-then-append needs it (an import deciding which ids are new). A single
 * `appendRecord` is one `O_APPEND` write and does not.
 */
export async function withJournalLock<T>(cwd: string, fn: () => Promise<T>, options: JournalLockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? JOURNAL_LOCK_STALE_MS;
  const timeoutMs = options.timeoutMs ?? JOURNAL_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 25;
  const root = await journalRoot(cwd);
  await mkdir(decisionsDir(root), { recursive: true });
  const file = journalLockFile(root);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await lockIsStale(file, staleMs)) {
      const aside = `${file}.stale-${process.pid}-${Date.now()}`;
      try {
        await rename(file, aside);
        await rm(aside, { force: true });
      } catch {
        // someone else broke it first
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the decisions journal is locked by another run (${file}); try again, or delete that file if no import is running`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return await fn();
  } finally {
    if (await ownsLock(file, token)) await rm(file, { force: true });
  }
}

const isString = (value: unknown): value is string => typeof value === "string";

function isOption(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  return isString(option["id"]) && isString(option["label"]);
}

function isOpen(rec: Record<string, unknown>): boolean {
  if (!(rec["flow"] === null || isString(rec["flow"]))) return false;
  if (!isString(rec["stage"]) || !isString(rec["question"])) return false;
  if (!Array.isArray(rec["options"]) || !rec["options"].every(isOption)) return false;
  if (rec["mode"] !== "ordinary" && rec["mode"] !== "blind") return false;
  if (!Array.isArray(rec["order"]) || !rec["order"].every(isString)) return false;
  const recommendation = rec["recommendation"];
  if (recommendation === null) return true;
  if (typeof recommendation !== "object" || recommendation === undefined) return false;
  return isString((recommendation as Record<string, unknown>)["optionId"]);
}

function isAnswer(rec: Record<string, unknown>): boolean {
  return typeof rec["seq"] === "number" && Number.isFinite(rec["seq"]) && isString(rec["choice"]);
}

function isRecord(value: unknown): value is DecisionRecord {
  if (value === null || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  if (!isString(rec["id"]) || !isString(rec["at"])) return false;
  if (rec["kind"] === "open") return isOpen(rec);
  if (rec["kind"] === "answer") return isAnswer(rec);
  if (rec["kind"] === "reason") return rec["reason"] === undefined || isString(rec["reason"]);
  return false;
}

/** An open record read from disk may predate `reason`; make the shape the code expects. */
function normalise(record: DecisionRecord): DecisionRecord {
  if (record.kind === "open" && record.recommendation !== null && !isString(record.recommendation.reason)) {
    return { ...record, recommendation: { optionId: record.recommendation.optionId, reason: "" } };
  }
  return record;
}

export interface JournalRead {
  records: DecisionRecord[];
  /** Lines that were not JSON or not a well-formed record: dropped, but counted. */
  skipped: number;
}

export async function readJournal(cwd: string): Promise<JournalRead> {
  let raw: string;
  try {
    raw = await readFile(await resolveJournalFile(cwd), "utf8");
  } catch {
    return { records: [], skipped: 0 };
  }
  const records: DecisionRecord[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) records.push(normalise(parsed));
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

export async function readRecords(cwd: string): Promise<DecisionRecord[]> {
  return (await readJournal(cwd)).records;
}
