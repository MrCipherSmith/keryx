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

import { appendFile, mkdir, readFile } from "node:fs/promises";
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
