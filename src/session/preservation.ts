// Flow 415: immutable local evidence; queued is NOT delivered or accepted.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_TRANSCRIPT_FILE_BYTES, readConfigFile, readTranscriptFile } from "../lib/config-dir";

export type PreservationFiles = Record<string, string>;
export interface PreservationSnapshot { version: 1; files: PreservationFiles }
export interface PreservationReceipt {
  version: 1; snapshot: string; state: "pending-review"; inventory: string[];
}
const hash = (body: string): string => createHash("sha256").update(body).digest("hex");
const allowed = new Set(["context.jsonl", "archive.jsonl", "transcript.jsonl", "summary.json", "slate.json"]);
function syncDir(dir: string): void {
  // Windows directory fsync is unsupported: atomic rename, not power-loss durability.
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function writePreservationFile(file: string, body: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, body, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, file); syncDir(dir); }
  catch (error) {
    try { unlinkSync(tmp); }
    catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], "preservation write and cleanup failed", { cause: cleanupError });
      }
    }
    throw error;
  }
}
export function commitPreservation(dir: string, files: PreservationFiles, beforeSelect?: () => void): string {
  const sorted: PreservationFiles = {};
  for (const name of Object.keys(files).sort()) {
    if (!allowed.has(name)) throw new Error("unsupported preservation file");
    sorted[name] = files[name]!;
  }
  const body = JSON.stringify({ version: 1, files: sorted });
  if (Buffer.byteLength(body, "utf8") > MAX_TRANSCRIPT_FILE_BYTES) {
    throw new Error("preservation snapshot exceeds readable size limit");
  }
  const id = hash(body);
  const base = path.join(dir, "preservation");
  mkdirSync(path.join(base, "generations"), { recursive: true, mode: 0o700 });
  syncDir(dir); syncDir(base);
  writePreservationFile(path.join(base, "generations", `${id}.json`), body);
  beforeSelect?.(); // fault seam: pointer still names the prior complete generation
  writePreservationFile(path.join(base, "CURRENT"), id);
  return id;
}
export function readPreservation(dir: string, snapshotId?: string): PreservationSnapshot | undefined {
  const base = path.join(dir, "preservation");
  let id = snapshotId;
  if (id === undefined) {
    try { id = readFileSync(path.join(base, "CURRENT"), "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  }
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid preservation identity");
  const read = readTranscriptFile(path.join(base, "generations", `${id}.json`));
  if (!read.ok) throw new Error(`snapshot unreadable: ${read.reason}`);
  if (hash(read.text) !== id) throw new Error("snapshot hash mismatch");
  const value: unknown = JSON.parse(read.text);
  if (value === null || typeof value !== "object") throw new Error("invalid snapshot");
  const parsed = value as Partial<PreservationSnapshot>;
  if (parsed.version !== 1 || parsed.files === null || typeof parsed.files !== "object" || Array.isArray(parsed.files)) throw new Error("invalid snapshot");
  for (const [name, body] of Object.entries(parsed.files)) {
    if (!allowed.has(name) || typeof body !== "string") throw new Error("invalid snapshot file");
  }
  return parsed as PreservationSnapshot;
}
/** Caller must own the session; never restore a Slate over a successor. */
export function restorePreservedHistory(dir: string): boolean {
  const snapshot = readPreservation(dir);
  if (snapshot === undefined) return false;
  for (const [name, body] of Object.entries(snapshot.files)) {
    if (name !== "slate.json") writePreservationFile(path.join(dir, name), body);
  }
  return true;
}
export function collectPreservationFiles(dir: string, rawSlate?: string): PreservationFiles {
  const files: PreservationFiles = {};
  for (const name of allowed) {
    if (name === "slate.json") continue;
    const read = readTranscriptFile(path.join(dir, name));
    if (read.ok) files[name] = read.text;
    else if (read.reason !== "absent") throw new Error(`cannot preserve ${name}: ${read.reason}`);
  }
  if (rawSlate !== undefined) files["slate.json"] = rawSlate;
  return files;
}
/** Called under Slate lock before removal. Notes remain review evidence, not Seeds. */
export function queuePreservedWrapUp(dir: string, rawSlate: string): PreservationReceipt {
  const files = collectPreservationFiles(dir, rawSlate);
  const snapshot = commitPreservation(dir, files);
  const slate = JSON.parse(rawSlate) as { seeds?: unknown[]; notes?: Record<string, unknown>; trail?: unknown[] };
  const receipt: PreservationReceipt = {
    version: 1, snapshot, state: "pending-review",
    inventory: [
      ...(slate.seeds?.length ? [`Seeds: ${slate.seeds.length}`] : []),
      ...(Object.keys(slate.notes ?? {}).length ? [`Notes require review: ${Object.keys(slate.notes ?? {}).length}`] : []),
      ...(slate.trail?.length ? [`Tool outcomes require review: ${slate.trail.length}`] : []),
      ...(files["archive.jsonl"]?.trim() ? ["Transcript retained for evidence review"] : []),
    ],
  };
  const outbox = path.join(dir, "preservation", "outbox");
  const target = path.join(outbox, `${snapshot}.json`);
  mkdirSync(outbox, { recursive: true, mode: 0o700 }); syncDir(path.dirname(outbox));
  // Atomic complete receipt first; concurrent identical captures converge on
  // identical pending content. Delivery will need a separate fenced receipt.
  writePreservationFile(target, JSON.stringify(receipt));
  return receipt;
}

/** HISTORY remains authoritative after compatibility mirroring; CURRENT can
 * independently select Slate evidence. Readers never overwrite live Slate. */
export function readPendingHistory(dir: string): PreservationSnapshot | undefined {
  let read = readConfigFile(path.join(dir, "preservation", "HISTORY"));
  if (!read.ok && read.reason === "absent") {
    read = readConfigFile(path.join(dir, "preservation", "MIRRORING"));
  }
  if (!read.ok) {
    if (read.reason === "absent") return undefined;
    throw new Error(`history checkpoint marker unreadable: ${read.reason}`);
  }
  const snapshot = readPreservation(dir, read.text);
  if (snapshot === undefined) throw new Error("history checkpoint missing");
  for (const name of ["context.jsonl", "archive.jsonl", "transcript.jsonl", "summary.json"]) {
    if (snapshot.files[name] === undefined) throw new Error(`history checkpoint missing ${name}`);
  }
  return snapshot;
}
export function commitHistoryCheckpoint(dir: string, files: PreservationFiles, beforeMirror?: () => void): string {
  for (const name of ["context.jsonl", "archive.jsonl", "transcript.jsonl", "summary.json"]) {
    if (files[name] === undefined) throw new Error(`history checkpoint missing ${name}`);
  }
  // HISTORY is the single history commit boundary. An interruption between
  // CURRENT and HISTORY retains the previous committed history.
  const id = commitPreservation(dir, files);
  const marker = path.join(dir, "preservation", "HISTORY");
  writePreservationFile(marker, id);
  beforeMirror?.();
  for (const [name, body] of Object.entries(files)) {
    if (name !== "slate.json") writePreservationFile(path.join(dir, name), body);
  }
  return id;
}
