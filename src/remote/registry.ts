// The serve-side registry of remote sessions (flow 376, block 1).
//
// One record per topic NAME. The name -> `message_thread_id` binding is the
// thing that must survive a serve restart, an orphaned shell and a returning
// shell, so it lives on disk: `<user-global dir>/remote/sessions.json`, rewritten
// atomically, owner-only. It is separate from the shell's session-lease
// directory on purpose: serve never writes into a session's own state.
//
// Heartbeats are kept in memory only and reach disk with the next structural
// change. After a restart every record that was live gets one fresh lease
// period to reconnect (see `load`), instead of being declared dead off a
// timestamp that stopped moving while serve was down.

import path from "node:path";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { SESSION_LEASE_STALE_MS } from "../session/lease";
import { nameKey } from "./naming";
import { ensureRemoteDir, REGISTRY_FILE } from "./paths";

export type RemoteSessionStatus = "live" | "unavailable";

export interface RemoteSessionRecord {
  name: string;
  sessionId: string;
  project: string;
  chatId: number;
  threadId: number;
  registeredAt: number;
  lastHeartbeat: number;
  status: RemoteSessionStatus;
  /** When the heartbeat went stale; the orphan timeout runs from here. */
  unavailableSince?: number;
}

const REGISTRY_VERSION = 1;

function parseRecord(value: unknown): RemoteSessionRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const numbers = ["chatId", "threadId", "registeredAt", "lastHeartbeat"] as const;
  if (typeof raw.name !== "string" || typeof raw.sessionId !== "string" || typeof raw.project !== "string") {
    return undefined;
  }
  if (!numbers.every((key) => typeof raw[key] === "number" && Number.isFinite(raw[key]))) {
    return undefined;
  }
  if (raw.status !== "live" && raw.status !== "unavailable") {
    return undefined;
  }
  if (raw.unavailableSince !== undefined && typeof raw.unavailableSince !== "number") {
    return undefined;
  }
  return raw as unknown as RemoteSessionRecord;
}

/** A heartbeat still counts if it is younger than the lease staleness bound. Future stamps count (clock skew). */
export function isFresh(record: Pick<RemoteSessionRecord, "lastHeartbeat">, now: number): boolean {
  return now - record.lastHeartbeat < SESSION_LEASE_STALE_MS;
}

/** A record whose owner may be displaced: unavailable, or live with a stale heartbeat. */
export function isLive(record: RemoteSessionRecord, now: number): boolean {
  return record.status === "live" && isFresh(record, now);
}

export class SessionRegistry {
  private readonly dir: string | undefined;
  private readonly now: () => number;
  private readonly file: string;
  private readonly byName = new Map<string, RemoteSessionRecord>();

  constructor(options: { dir?: string; now: () => number }) {
    this.dir = options.dir;
    this.now = options.now;
    this.file = path.join(ensureRemoteDir(this.dir), REGISTRY_FILE);
  }

  /**
   * Read the registry. Live records get a fresh lease period: serve was down, so
   * their stored heartbeat says nothing about whether the shell is alive.
   * Returns false when a file existed but could not be used (it is left alone).
   */
  load(): boolean {
    this.byName.clear();
    const read = readConfigFile(this.file);
    if (!read.ok) {
      return read.reason === "absent";
    }
    let doc: unknown;
    try {
      doc = JSON.parse(read.text);
    } catch {
      return false;
    }
    const records = (doc as { records?: unknown } | null)?.records;
    if (!Array.isArray(records)) {
      return false;
    }
    const now = this.now();
    for (const candidate of records) {
      const record = parseRecord(candidate);
      if (record === undefined) {
        continue;
      }
      if (record.status === "live") {
        record.lastHeartbeat = now;
      }
      this.byName.set(nameKey(record.name), record);
    }
    return true;
  }

  save(): void {
    writeOwnerOnlyFileAtomic(
      this.file,
      `${JSON.stringify({ version: REGISTRY_VERSION, records: [...this.byName.values()] }, null, 2)}\n`,
    );
  }

  records(): RemoteSessionRecord[] {
    return [...this.byName.values()];
  }

  byNameKey(name: string): RemoteSessionRecord | undefined {
    return this.byName.get(nameKey(name));
  }

  bySession(sessionId: string): RemoteSessionRecord | undefined {
    for (const record of this.byName.values()) {
      if (record.sessionId === sessionId) {
        return record;
      }
    }
    return undefined;
  }

  byThread(chatId: number, threadId: number): RemoteSessionRecord | undefined {
    for (const record of this.byName.values()) {
      if (record.chatId === chatId && record.threadId === threadId) {
        return record;
      }
    }
    return undefined;
  }

  /** Insert or replace by name. Does not save. */
  put(record: RemoteSessionRecord): void {
    this.byName.set(nameKey(record.name), record);
  }

  /** Re-key a record under a new name. Does not save. */
  rename(record: RemoteSessionRecord, name: string): void {
    this.byName.delete(nameKey(record.name));
    record.name = name;
    this.byName.set(nameKey(name), record);
  }

  remove(name: string): void {
    this.byName.delete(nameKey(name));
  }
}
