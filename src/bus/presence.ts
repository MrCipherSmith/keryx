// Presence records (specification §4.1, decisions D-06 and D-09).

import { hostname } from "node:os";
import { type LeaseLiveness, processIsAlive } from "../lib/fs";
import { redactSensitiveText } from "../security/service";
import { BusRefusal } from "./errors";
import { ensureBusDir, listDirNames, readJsonRecord, removeFile, writeBusFileAtomic } from "./files";
import { idFromRecordFileName, isBusId, presenceDir, presencePath } from "./paths";
import {
  isAssignableBusName,
  isBusNameShape,
  MAX_ACTIVITY_CHARS,
  parsePresence,
  type PresenceRecord,
  presenceProblems,
  RESERVED_BUS_NAMES,
} from "./schema";

/** D-09: a heartbeat at most this old is live. Written every 5 s by its owner. */
export const BUS_PRESENCE_STALE_MS = 15_000;

export type PresenceLiveness = LeaseLiveness;

export interface PresenceClassifyOptions {
  /** Clock in epoch ms. */
  now: number;
  /** Pid probe; defaults to `processIsAlive`. */
  isAlive?: ((pid: number) => boolean) | undefined;
  /** This host's name; defaults to `os.hostname()`. */
  host?: string | undefined;
  staleMs?: number | undefined;
}

/**
 * D-09: live when `heartbeatAt` is at most `staleMs` old; otherwise stale when
 * the record is from this host and its pid is alive; otherwise gone. The pid
 * only separates hung from dead: a reused pid cannot keep a crashed instance
 * live, because the heartbeat is judged first.
 */
export function classifyPresence(record: PresenceRecord, options: PresenceClassifyOptions): PresenceLiveness {
  const staleMs = options.staleMs ?? BUS_PRESENCE_STALE_MS;
  const heartbeat = Date.parse(record.heartbeatAt);
  if (!Number.isNaN(heartbeat) && options.now - heartbeat <= staleMs) return "live";
  const thisHost = options.host ?? hostname();
  const isAlive = options.isAlive ?? processIsAlive;
  return record.host === thisHost && isAlive(record.pid) ? "stale" : "gone";
}

/**
 * Write (or rewrite) this instance's presence record atomically, 0600 in a 0700
 * directory. The id is checked before any path is built; `activity` is redacted
 * and bounded to 120 characters; anything else invalid is refused.
 */
export async function writePresence(root: string, record: PresenceRecord): Promise<PresenceRecord> {
  if (!isBusId(record.instanceId)) {
    throw new BusRefusal("invalid-id", `instanceId ${JSON.stringify(record.instanceId)} is not a UUID`);
  }
  const file = presencePath(root, record.instanceId);
  const activity =
    typeof record.activity === "string"
      ? redactSensitiveText(record.activity).slice(0, MAX_ACTIVITY_CHARS)
      : record.activity;
  const next: PresenceRecord = { ...record, activity };
  const problems = presenceProblems(next);
  if (problems.length > 0) {
    throw new BusRefusal("invalid-presence", problems.join("; "));
  }
  await ensureBusDir(root);
  await ensureBusDir(presenceDir(root));
  await writeBusFileAtomic(file, `${JSON.stringify(next)}\n`);
  return next;
}

/** The presence record of `instanceId`, or undefined when absent or invalid. Never throws. */
export async function readPresence(root: string, instanceId: string): Promise<PresenceRecord | undefined> {
  if (!isBusId(instanceId)) return undefined;
  try {
    const record = parsePresence(await readJsonRecord(presencePath(root, instanceId)));
    return record !== undefined && record.instanceId === instanceId ? record : undefined;
  } catch {
    return undefined;
  }
}

/** Every valid presence record, sorted by name. Invalid or foreign files are skipped. Never throws. */
export async function listPresence(root: string): Promise<PresenceRecord[]> {
  let names: string[];
  try {
    names = await listDirNames(presenceDir(root));
  } catch {
    return [];
  }
  const records: PresenceRecord[] = [];
  for (const fileName of names) {
    const id = idFromRecordFileName(fileName);
    if (id === undefined) continue;
    const record = await readPresence(root, id);
    if (record !== undefined) records.push(record);
  }
  return records.sort((a, b) => a.name.localeCompare(b.name) || a.instanceId.localeCompare(b.instanceId));
}

export async function removePresence(root: string, instanceId: string): Promise<void> {
  await removeFile(presencePath(root, instanceId));
}

/**
 * D-06 name allocation against the names live instances hold.
 *
 * - No request: `agent-<n>` with the lowest free `n` (from 1).
 * - A request that is free: the request.
 * - A request a live instance holds: `<name>-2`, then `-3`, and so on. The name
 *   is never taken over. The base is shortened when needed so the result still
 *   fits the 32-character name rule.
 *
 * A request that is not a valid name, or is reserved (`all`, `cli`, `system`),
 * is refused.
 */
export function allocateName(requested: string | undefined, liveNames: Iterable<string>): string {
  const taken = new Set(liveNames);
  if (requested === undefined) {
    for (let n = 1; ; n += 1) {
      const candidate = `agent-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  if (RESERVED_BUS_NAMES.includes(requested)) {
    throw new BusRefusal("reserved-name", `"${requested}" is reserved`);
  }
  if (!isBusNameShape(requested)) {
    throw new BusRefusal("invalid-name", `"${requested}" must match ^[a-z0-9][a-z0-9-]{0,31}$`);
  }
  if (!taken.has(requested)) return requested;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${requested.slice(0, 32 - suffix.length)}${suffix}`;
    if (isAssignableBusName(candidate) && !taken.has(candidate)) return candidate;
  }
}
