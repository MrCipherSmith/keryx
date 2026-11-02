import type { QueryClient } from "@tanstack/react-query";
import type { WorkAdapter } from "./adapter";
import type { WorkEvent, WorkRecord, WorkSnapshot } from "./types";
import { isObject, isWorkRecord } from "./validation";

const RECORD_FETCH_BATCH = 8;
const MAX_EVENT_RECORD_READS = 32;

export function workSnapshotKey(scope: number, project: string | null, mode: WorkAdapter["mode"]) {
  return [scope, project, "work", mode, "snapshot"] as const;
}
export function workAttentionKey(scope: number, project: string | null, mode: WorkAdapter["mode"]) {
  return [scope, project, "work", mode, "attention"] as const;
}
export function workObservationsKey(scope: number, project: string | null, mode: WorkAdapter["mode"]) {
  return [scope, project, "work", mode, "observations"] as const;
}

function isNotNewer(existing: WorkRecord, incoming: WorkRecord): boolean {
  if ("version" in existing && "version" in incoming) return existing.version >= incoming.version;
  return "contentDigest" in existing && "contentDigest" in incoming && existing.contentDigest === incoming.contentDigest;
}

/** Keep unchanged identities and never replace a newer aggregate with an old receipt. */
export function mergeWorkRecords(snapshot: WorkSnapshot, changes: WorkRecord[]): WorkSnapshot {
  const records = new Map(snapshot.records.map((record) => [record.id, record]));
  let changed = false;
  for (const record of changes) {
    const existing = records.get(record.id);
    if (existing && isNotNewer(existing, record)) continue;
    records.set(record.id, record);
    changed = true;
  }
  return changed ? { ...snapshot, records: [...records.values()] } : snapshot;
}

function isSnapshot(value: unknown): value is WorkSnapshot {
  return isObject(value) && Array.isArray(value.records) && value.records.every(isWorkRecord) &&
    Array.isArray(value.actions) && typeof value.eventCursor === "string";
}

/** Snapshot reads race events/receipts: their older cut must never rewind mutable versions. */
export function shareWorkSnapshot(previous: unknown, incoming: unknown): unknown {
  if (!isSnapshot(previous) || !isSnapshot(incoming)) return incoming;
  return { ...incoming, records: mergeWorkRecords(previous, incoming.records).records };
}

export function mergeSnapshotCache(client: QueryClient, key: ReturnType<typeof workSnapshotKey>, incoming: WorkSnapshot) {
  client.setQueryData<WorkSnapshot>(key, (previous) => previous
    ? { ...incoming, records: mergeWorkRecords(previous, incoming.records).records }
    : incoming);
}

export function mergeWorkCache(client: QueryClient, key: ReturnType<typeof workSnapshotKey>, changes: WorkRecord[]) {
  client.setQueryData<WorkSnapshot>(key, (snapshot) => snapshot ? mergeWorkRecords(snapshot, changes) : snapshot);
}

export async function fetchEventRecords(adapter: WorkAdapter, snapshot: WorkSnapshot | undefined, events: WorkEvent[], signal: AbortSignal) {
  // Overview owns attention only. Never fetch records which have no cache owner.
  if (!snapshot) return [];
  const existing = new Map(snapshot.records.map((record) => [record.id, record]));
  const ids = [...new Set(events.filter((event) => {
    if (event.entityType === "git-observation") return false;
    const record = existing.get(event.entityId);
    return !record || (event.entityVersion !== null && (!("version" in record) || record.version < event.entityVersion));
  }).map((event) => event.entityId))];
  if (ids.length > MAX_EVENT_RECORD_READS) return (await adapter.snapshot(signal)).records;
  const changes: WorkRecord[] = [];
  for (let offset = 0; offset < ids.length; offset += RECORD_FETCH_BATCH) {
    const batch = await Promise.all(ids.slice(offset, offset + RECORD_FETCH_BATCH).map((id) => adapter.record(id, signal)));
    changes.push(...batch.map((result) => result.record));
  }
  return changes;
}

const refreshListeners = new WeakMap<QueryClient, Map<string, Set<() => void>>>();
export function subscribeWorkRefresh(client: QueryClient, key: ReturnType<typeof workSnapshotKey>, listener: () => void) {
  let namespaces = refreshListeners.get(client);
  if (!namespaces) { namespaces = new Map(); refreshListeners.set(client, namespaces); }
  const namespace = JSON.stringify(key);
  const listeners = namespaces.get(namespace) ?? new Set<() => void>();
  listeners.add(listener);
  namespaces.set(namespace, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) namespaces.delete(namespace);
  };
}

/** Committed receipts may omit side-effect aggregates. Wake their canonical event stream now. */
export function requestWorkRefresh(client: QueryClient, key: ReturnType<typeof workSnapshotKey>) {
  const listeners = refreshListeners.get(client)?.get(JSON.stringify(key));
  if (listeners?.size) listeners.forEach((listener) => listener());
  else void client.invalidateQueries({ queryKey: key, exact: true, refetchType: "active" });
}
