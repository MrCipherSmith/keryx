// Flow 392: the journal file. Append-only JSONL under
// `.metaproject/data/decisions/journal.jsonl`, one record per line, mode 0o600.
// The reader drops lines it cannot parse and returns [] when the file is absent,
// so a damaged line never takes the report (or a question) down with it.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DecisionRecord } from "./types";

export function decisionsDir(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "decisions");
}

export function journalFile(cwd: string): string {
  return path.join(decisionsDir(cwd), "journal.jsonl");
}

export function configFile(cwd: string): string {
  return path.join(cwd, ".metaproject", "decisions.config.json");
}

export async function appendRecord(cwd: string, record: DecisionRecord): Promise<void> {
  await mkdir(decisionsDir(cwd), { recursive: true });
  await appendFile(journalFile(cwd), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function isRecord(value: unknown): value is DecisionRecord {
  if (value === null || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec["id"] !== "string" || typeof rec["at"] !== "string") return false;
  return rec["kind"] === "open" || rec["kind"] === "answer" || rec["kind"] === "reason";
}

export async function readRecords(cwd: string): Promise<DecisionRecord[]> {
  let raw: string;
  try {
    raw = await readFile(journalFile(cwd), "utf8");
  } catch {
    return [];
  }
  const out: DecisionRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // a damaged line is skipped, never thrown
    }
  }
  return out;
}
