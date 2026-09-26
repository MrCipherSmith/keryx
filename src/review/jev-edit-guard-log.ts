// Jev EDIT GUARD — flow 343: "It logs every call (latency, cost, flags,
// file) to `.metaproject/data/jev/edit-guard.jsonl`."
//
// One JSON object per line, append-only — never a single JSON document that
// would need a full read-modify-write per hook invocation (a hook that
// crashes mid-write must not corrupt every prior record). Mirrors
// `src/review/jev-rules-cache.ts`'s own "missing/unparsable reads as empty,
// never throws" discipline; a caller (the CLI's `status`, the TUI's
// `/editguard` modal) must never fail to open because ONE line of history
// is malformed.

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { EDIT_GUARD_LOG_PATH } from "./jev-edit-guard";

export { EDIT_GUARD_LOG_PATH };

export const EDIT_GUARD_LOG_STATUSES = ["flagged", "clean", "skipped", "error", "timeout"] as const;
export type EditGuardLogStatus = (typeof EDIT_GUARD_LOG_STATUSES)[number];

export interface EditGuardLogFlag {
  readonly ruleId: string;
  readonly clauseId: string;
  readonly file: string;
  readonly line: number;
  readonly probability: number;
}

export interface EditGuardLogRecord {
  /** ISO-8601 timestamp of the hook invocation. */
  readonly at: string;
  readonly file: string;
  readonly tool: string;
  readonly status: EditGuardLogStatus;
  /** Why `status` is `skipped`/`error`/`timeout` — a redacted message, never a raw error stack. */
  readonly reason?: string;
  readonly latencyMs: number;
  /** How many Jev calls this invocation actually made (0 for `skipped`). */
  readonly jevCalls: number;
  readonly costUsd?: number;
  readonly threshold: number;
  readonly flags: readonly EditGuardLogFlag[];
}

function isEditGuardLogStatus(value: unknown): value is EditGuardLogStatus {
  return typeof value === "string" && (EDIT_GUARD_LOG_STATUSES as readonly string[]).includes(value);
}

/** A parsed line that does not shape up as an `EditGuardLogRecord` is dropped, never thrown over — one bad line must not blind every reader to every good one. */
function parseRecord(line: string): EditGuardLogRecord | undefined {
  if (line.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.at !== "string" ||
    typeof record.file !== "string" ||
    typeof record.tool !== "string" ||
    !isEditGuardLogStatus(record.status) ||
    typeof record.latencyMs !== "number" ||
    typeof record.jevCalls !== "number" ||
    typeof record.threshold !== "number"
  ) {
    return undefined;
  }
  const flags: EditGuardLogFlag[] = Array.isArray(record.flags)
    ? record.flags.filter(
        (f): f is EditGuardLogFlag =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as Record<string, unknown>).ruleId === "string" &&
          typeof (f as Record<string, unknown>).clauseId === "string" &&
          typeof (f as Record<string, unknown>).file === "string" &&
          typeof (f as Record<string, unknown>).line === "number" &&
          typeof (f as Record<string, unknown>).probability === "number",
      )
    : [];
  return {
    at: record.at,
    file: record.file,
    tool: record.tool,
    status: record.status,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    latencyMs: record.latencyMs,
    jevCalls: record.jevCalls,
    ...(typeof record.costUsd === "number" ? { costUsd: record.costUsd } : {}),
    threshold: record.threshold,
    flags,
  };
}

/** Every record, oldest first (file order) — malformed lines silently dropped. `[]` when the file is absent. */
export async function readEditGuardLogRecords(cwd: string): Promise<EditGuardLogRecord[]> {
  const file = path.join(cwd, EDIT_GUARD_LOG_PATH);
  if (!(await pathExists(file))) return [];
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: EditGuardLogRecord[] = [];
  for (const line of text.split("\n")) {
    const record = parseRecord(line);
    if (record !== undefined) out.push(record);
  }
  return out;
}

/**
 * Append one record. Best-effort by construction (a caller in the hook's own
 * fail-open path wraps this in a `try/catch` too — see
 * `src/commands/review-jev-edit-guard.ts` — a log write must never be the
 * reason a hook that should stay silent instead throws).
 */
export async function appendEditGuardLog(cwd: string, record: EditGuardLogRecord): Promise<void> {
  const file = path.join(cwd, EDIT_GUARD_LOG_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export interface EditGuardTodayStats {
  readonly calls: number;
  readonly flagged: number;
  readonly costUsd: number;
}

/** `at`'s UTC calendar date equals `now`'s — "today" reads the same regardless of the reader's local timezone. */
function isSameUtcDate(iso: string, now: Date): boolean {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return false;
  return (
    at.getUTCFullYear() === now.getUTCFullYear() &&
    at.getUTCMonth() === now.getUTCMonth() &&
    at.getUTCDate() === now.getUTCDate()
  );
}

/** `calls`: total Jev calls made today (sum of `jevCalls`, so a batched multi-region invocation still counts every call it made). `flagged`: total flags today. `costUsd`: summed `costUsd` where present. */
export function editGuardTodayStats(records: readonly EditGuardLogRecord[], now: Date = new Date()): EditGuardTodayStats {
  const today = records.filter((r) => isSameUtcDate(r.at, now));
  return {
    calls: today.reduce((sum, r) => sum + r.jevCalls, 0),
    flagged: today.reduce((sum, r) => sum + r.flags.length, 0),
    costUsd: today.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
  };
}

/** Every flag across `records`, newest record first, then in-record order — flattened once so both the CLI `status` and the TUI modal read the same "recent flags" list. */
export function recentEditGuardFlags(records: readonly EditGuardLogRecord[], limit = 10): readonly (EditGuardLogFlag & { readonly at: string })[] {
  const flat = [...records]
    .reverse()
    .flatMap((r) => r.flags.map((f) => ({ ...f, at: r.at })));
  return flat.slice(0, limit);
}
