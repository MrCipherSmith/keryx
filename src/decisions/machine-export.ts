// The per-machine export of the recommendation journal, and the merge of several machines' exports.
//
// The journal and the arm-assignment seed live on one machine and never in git, so an operator who works on
// several machines has several journals, each with its own seed and its own `seq` numbering. Each machine
// writes its whole journal to `raw/decisions-<host>.jsonl`; the merge of every such file is the one dataset
// that shows all machines. A row carries no question, option or reason text, and never the seed: `host` and
// `seedHash` identify the machine without revealing it.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { saltFile, type SaltOptions } from "./arms";
import { buildExportWithSummary, exportRef } from "./export";
import { readQuality } from "./quality";
import { readJournal } from "./store";
import type { OpenRecord } from "./types";

export type MachineRow = Record<string, unknown>;

export interface MachineExport {
  /** The first 8 hex characters of the seed file's SHA-256: no hostname, no user, no path. */
  host: string;
  /** The full SHA-256 of the seed file. */
  seedHash: string;
  rows: MachineRow[];
}

export interface MergedMachines {
  /** Every row, ordered by (openedAt, host, seq), each with `globalSeq` as its last key. */
  rows: MachineRow[];
  perHost: Array<{ host: string; count: number }>;
}

/** The file name of a machine's raw export. */
export const machineFileName = (host: string): string => `decisions-${host}.jsonl`;

const HOST_FILE = /^decisions-([0-9a-f]{8})\.jsonl$/;
const SEED_HASH = /^[0-9a-f]{64}$/;
/** Keys that would carry words: none may appear in a row, at any depth. */
const TEXT_KEYS = new Set(["question", "options", "option", "reason", "text", "prompt", "title"]);

/**
 * The whole local journal as rows tagged with this machine. Returns null when the machine has no seed file
 * (it never recorded a decision): it never creates, migrates or prints a seed. Throws when the journal or the
 * export reports a record it could not use, so a partial file is never written.
 */
export async function machineExport(cwd: string, deps: SaltOptions = {}): Promise<MachineExport | null> {
  let seedBytes: Buffer;
  try {
    seedBytes = await readFile(await saltFile(cwd, deps));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  const seedHash = createHash("sha256").update(seedBytes).digest("hex");
  const host = seedHash.slice(0, 8);

  const journal = await readJournal(cwd);
  const { rows, summary } = buildExportWithSummary(journal.records, await readQuality(cwd));
  if (journal.skipped > 0 || summary.skipped > 0) throw new Error("the journal has records that could not be exported");

  const opens = journal.records.filter((record): record is OpenRecord => record.kind === "open");
  const ordinal = new Map(opens.map((open, at) => [exportRef(open.id), at + 1]));
  const byRef = new Map(opens.map((open) => [exportRef(open.id), open]));

  const out: MachineRow[] = rows.map(({ seed: _seed, ...row }) => {
    const open = byRef.get(row.ref);
    const explicit = open !== undefined && Number.isSafeInteger(open.seq);
    const seq = explicit ? (open?.seq as number) : ordinal.get(row.ref);
    return { ...row, seq, ...(explicit ? {} : { seqDerived: true }), host, seedHash };
  });
  if (out.some((row) => !Number.isSafeInteger(row.seq))) throw new Error("a journal record has no usable seq");
  if (new Set(out.map((row) => row.seq)).size !== out.length) throw new Error("the journal has a duplicate seq");
  if (out.some((row) => typeof row.openedAt !== "string")) throw new Error("a journal record has no readable openedAt");
  return { host, seedHash, rows: out };
}

/** JSONL: one row per line, a trailing newline, and nothing at all for no rows. */
export function renderMachineRows(rows: readonly MachineRow[]): string {
  return rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function hasTextKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTextKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, inner]) => TEXT_KEYS.has(key) || hasTextKey(inner));
}

/** Parse and check one raw file. `label` is its name (no directory path needed); errors name it and the line. */
export function parseMachineRows(text: string, label: string): MachineRow[] {
  const fileHost = HOST_FILE.exec(label.split("/").pop() ?? "")?.[1];
  const rows: MachineRow[] = [];
  const seen = new Set<number>();
  let host: string | undefined;
  const lines = text.split("\n");
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (line.trim().length === 0) continue;
    const fail = (why: string): never => {
      throw new Error(`${label}: line ${at + 1}: ${why}`);
    };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return fail("not valid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("not a JSON object");
    const row = value as MachineRow;
    if (typeof row.host !== "string" || typeof row.seedHash !== "string" || !SEED_HASH.test(row.seedHash)) return fail("host or seedHash is missing or malformed");
    if (row.host !== row.seedHash.slice(0, 8)) return fail("host does not match seedHash");
    if (!Number.isSafeInteger(row.seq)) return fail("seq is not an integer");
    if (typeof row.openedAt !== "string") return fail("openedAt is not a string");
    if ("seed" in row) return fail("a row carries a seed");
    if ("globalSeq" in row) return fail("a raw row carries globalSeq");
    if (hasTextKey(row)) return fail("a row carries a text field");
    if (host !== undefined && host !== row.host) return fail("more than one host in a file");
    if (fileHost !== undefined && fileHost !== row.host) return fail("host differs from the file name");
    host = row.host;
    const seq = row.seq as number;
    if (seen.has(seq)) return fail(`duplicate (host, seq): (${row.host}, ${seq})`);
    seen.add(seq);
    rows.push(row);
  }
  return rows;
}

const compare = (a: unknown, b: unknown): number => (a === b ? 0 : (a as string | number) < (b as string | number) ? -1 : 1);

/**
 * Merge the machines' rows into one ordered set. `(host, seq)` is the key: one pair seen twice is an error,
 * not a row to drop. Order is by `openedAt`, then host, then seq; `globalSeq` is the 1-based place in that
 * order. `seq` and `arm` are left as they were written: the arm was drawn from (the machine's seed, seq).
 */
export function mergeMachineRows(files: ReadonlyArray<{ label: string; rows: readonly MachineRow[] }>): MergedMachines {
  const seen = new Map<string, string>();
  const all: MachineRow[] = [];
  for (const file of files) {
    for (const row of file.rows) {
      const key = `${String(row.host)}\u0000${String(row.seq)}`;
      const first = seen.get(key);
      if (first !== undefined) throw new Error(`duplicate (host, seq): (${String(row.host)}, ${String(row.seq)}) in ${first} and ${file.label}`);
      seen.set(key, file.label);
      all.push(row);
    }
  }
  all.sort((a, b) => compare(a.openedAt, b.openedAt) || compare(a.host, b.host) || compare(a.seq, b.seq));
  const counts = new Map<string, number>();
  for (const row of all) counts.set(String(row.host), (counts.get(String(row.host)) ?? 0) + 1);
  const perHost = [...counts].map(([host, count]) => ({ host, count })).sort((a, b) => compare(a.host, b.host));
  return { rows: all.map((row, at) => ({ ...row, globalSeq: at + 1 })), perHost };
}
