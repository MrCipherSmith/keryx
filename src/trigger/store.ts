// Flow 295 (C1, AC5, AC9): the per-machine schedule store — the one place keryx
// WRITES a trigger entry.
//
// `triggers.json` stays hand-edited and committed; keryx never writes it. A
// schedule the operator creates from the shell (`/schedule`, the
// `schedule_create` tool) or the CLI (`keryx schedule add`) lands here instead:
//
//   - `.metaproject/data/trigger/schedules.json`, same `{schemaVersion, triggers}`
//     shape `loadTriggersConfig` already reads, merged after `triggers.json`;
//   - never committed: `ensureTriggerDataIgnored` writes a `.gitignore` beside it
//     listing the store and the reports directory, before the first write;
//   - protected from an unattended agent: the floor refuses any write under
//     `.metaproject/data/trigger/` (`./unattended.ts`);
//   - every entry carries `confirmedHash` — the hash of the content the operator
//     confirmed. `keryx trigger run` refuses an entry whose content no longer
//     matches it (`grants-changed`), so an edit behind an installed timer never runs.
//
// Writes are atomic (temp file + rename) under a lock in the self-ignoring
// locks directory, so two shells creating schedules at once cannot interleave.

import { constants as fsConstants, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import { ensureLocksDir, keryxLocksDir } from "../lib/maintenance-lock";
import { scheduleContentCanonical, scheduleStorePath, TRIGGERS_SCHEMA_VERSION, triggerEntryProblems } from "./config";
import { ensureScheduleKey, scheduleMac } from "./schedule-key";
import { expectedReportRelPath, triggerDataDir } from "./record";

/** What `.metaproject/data/trigger/.gitignore` lists: the store and the reports. `runs.jsonl` stays trackable. */
const TRIGGER_DATA_GITIGNORE =
  "# keryx: per-machine schedules and their reports — never commit (flow 295)\n" +
  "schedules.json\n" +
  ".schedules.json.*\n" +
  "reports/\n";

/** Reports live here: `<dir>/<name>/<runId>.md`. */
export function triggerReportsDir(projectRoot: string): string {
  return path.join(triggerDataDir(projectRoot), "reports");
}

/** M2: the most of a report any reader loads. A report keryx writes is a few KiB. */
export const REPORT_READ_CAP_BYTES = 256 * 1024;

export type ReportRead = { readonly ok: true; readonly text: string; readonly truncated: boolean } | { readonly ok: false; readonly reason: string };

/**
 * Flow 295 (M2): read one schedule's report, and only a real report.
 *
 *   - the path must normalise to `triggerReportsDir(root)/<name>/<runId>.md`, and the
 *     directory it is in must really be that directory (no symlinked parent);
 *   - `lstat` must show a regular file (not a symlink, FIFO or device) under the cap;
 *   - it is opened `O_NOFOLLOW | O_NONBLOCK`, so a file swapped for a FIFO after the
 *     `lstat` can neither hang the reader nor redirect it, and at most the cap is read.
 */
export async function readScheduleReport(projectRoot: string, name: string, reportPath: string): Promise<ReportRead> {
  const abs = path.resolve(projectRoot, reportPath);
  const runId = path.basename(abs).replace(/\.md$/, "");
  const expected = expectedReportRelPath(name, runId);
  if (expected === undefined || !abs.endsWith(".md") || abs !== path.resolve(projectRoot, expected)) {
    return { ok: false, reason: `${reportPath} is not where keryx writes ${name}'s reports — not read` };
  }
  try {
    const realDir = realpathSync(path.dirname(abs));
    if (realDir !== path.join(realpathSync(projectRoot), path.dirname(expected))) {
      return { ok: false, reason: `the reports directory of ${name} is a link to somewhere else — not read` };
    }
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: `${reportPath} is not a regular file — not read` };
    if (st.size > REPORT_READ_CAP_BYTES) return { ok: false, reason: `${reportPath} is ${st.size} bytes, over the ${REPORT_READ_CAP_BYTES}-byte report cap — not read` };
    const nofollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const nonblock = (fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
    const handle = await open(abs, fsConstants.O_RDONLY | nofollow | nonblock);
    try {
      const fst = await handle.stat();
      if (!fst.isFile()) return { ok: false, reason: `${reportPath} is not a regular file — not read` };
      const buffer = Buffer.alloc(Math.min(fst.size, REPORT_READ_CAP_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { ok: true, text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: fst.size > REPORT_READ_CAP_BYTES };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { ok: false, reason: `could not read ${reportPath} (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** Make `.metaproject/data/trigger/` ignore the store and the reports. Idempotent; appends missing lines only. */
export async function ensureTriggerDataIgnored(projectRoot: string): Promise<void> {
  const dir = triggerDataDir(projectRoot);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, ".gitignore");
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const have = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = TRIGGER_DATA_GITIGNORE.split("\n").filter((line) => line.length > 0 && !line.startsWith("#") && !have.has(line));
  if (current.length === 0) {
    await writeFile(file, TRIGGER_DATA_GITIGNORE, "utf8");
  } else if (missing.length > 0) {
    await writeFile(file, `${current.replace(/\n?$/, "\n")}${missing.join("\n")}\n`, "utf8");
  }
}

/** One raw store entry, as written. */
export type StoredScheduleEntry = Record<string, unknown> & { readonly name: string; readonly confirmedHash: string };

async function readRawStore(projectRoot: string): Promise<Record<string, unknown>[]> {
  const file = scheduleStorePath(projectRoot);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const parsed = JSON.parse(text) as { schemaVersion?: unknown; triggers?: unknown };
  if (parsed.schemaVersion !== TRIGGERS_SCHEMA_VERSION || !Array.isArray(parsed.triggers)) {
    throw new Error(`${file} is not a schedule store (schemaVersion ${TRIGGERS_SCHEMA_VERSION}, triggers[])`);
  }
  return parsed.triggers as Record<string, unknown>[];
}

/** Read the store's raw entries (for listing and for rewriting). Absent → []. */
export async function readScheduleStore(projectRoot: string): Promise<Record<string, unknown>[]> {
  return readRawStore(projectRoot);
}

async function withStoreLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  await ensureLocksDir(projectRoot);
  return withFileLock(path.join(keryxLocksDir(projectRoot), "schedules.lock"), fn, { timeoutMs: 10_000 });
}

async function writeRawStore(projectRoot: string, entries: readonly Record<string, unknown>[]): Promise<void> {
  await ensureTriggerDataIgnored(projectRoot);
  await writeFileAtomic(
    scheduleStorePath(projectRoot),
    `${JSON.stringify({ schemaVersion: TRIGGERS_SCHEMA_VERSION, triggers: entries }, null, 2)}\n`,
  );
}

/**
 * Add a confirmed schedule. Refuses a malformed entry, and refuses a name already in the store.
 * `confirmedHash` is computed HERE from the exact entry being stored, so a caller
 * cannot hand in a hash that does not match what is written. Since flow 295 F1 it is an
 * HMAC keyed by this machine's schedule key (`./schedule-key.ts`), which is created on first use.
 */
export async function addConfirmedSchedule(projectRoot: string, entry: Record<string, unknown>): Promise<StoredScheduleEntry> {
  const { confirmedHash: _ignored, ...content } = entry;
  const problems = triggerEntryProblems(content);
  if (problems.length > 0) throw new Error(`schedule refused: ${problems.join("; ")}`);
  const key = ensureScheduleKey();
  if (!key.ok) throw new Error(`schedule refused: ${key.reason}`);
  const stored = { ...content, confirmedHash: scheduleMac(key.key, scheduleContentCanonical(content)) } as StoredScheduleEntry;
  await withStoreLock(projectRoot, async () => {
    const entries = await readRawStore(projectRoot);
    if (entries.some((e) => e["name"] === stored.name)) {
      throw new Error(`a schedule named "${stored.name}" already exists — remove it first or pick another name`);
    }
    await writeRawStore(projectRoot, [...entries, stored]);
  });
  return stored;
}

/** Set `enabled` on one stored schedule. Content (and so the hash) is unchanged. Returns false when absent. */
export async function setScheduleEnabled(projectRoot: string, name: string, enabled: boolean): Promise<boolean> {
  return withStoreLock(projectRoot, async () => {
    const entries = await readRawStore(projectRoot);
    const index = entries.findIndex((e) => e["name"] === name);
    if (index < 0) return false;
    const next = [...entries];
    next[index] = { ...entries[index], enabled };
    await writeRawStore(projectRoot, next);
    return true;
  });
}

/** Remove one stored schedule. Returns false when absent. */
export async function removeStoredSchedule(projectRoot: string, name: string): Promise<boolean> {
  return withStoreLock(projectRoot, async () => {
    const entries = await readRawStore(projectRoot);
    const next = entries.filter((e) => e["name"] !== name);
    if (next.length === entries.length) return false;
    await writeRawStore(projectRoot, next);
    return true;
  });
}
