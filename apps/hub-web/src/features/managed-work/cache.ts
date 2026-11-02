import type { QueryClient } from "@tanstack/react-query";
import type { WorkAdapter } from "./adapter";
import type { WorkEvent, WorkRecord, WorkSnapshot } from "./types";

const RECORD_FETCH_BATCH = 8;
/** Above this many changed records one snapshot read is cheaper than per-record reads. */
export const EVENT_RECORD_LIMIT = 50;

export function workSnapshotKey(scope: number, project: string | null, mode: WorkAdapter["mode"]) {
  return [scope, project, "work", mode, "snapshot"] as const;
}

/** Keep unchanged identities and never replace a newer aggregate with an old receipt. */
export function mergeWorkRecords(snapshot: WorkSnapshot, changes: WorkRecord[]): WorkSnapshot {
  const records = new Map(snapshot.records.map((record) => [record.id, record]));
  let changed = false;
  for (const record of changes) {
    const existing = records.get(record.id);
    if (existing && ("version" in existing && "version" in record ? existing.version >= record.version : "contentDigest" in existing && "contentDigest" in record && existing.contentDigest === record.contentDigest)) continue;
    records.set(record.id, record); changed = true;
  }
  return changed ? { ...snapshot, records: [...records.values()] } : snapshot;
}

export function mergeWorkCache(client: QueryClient, key: ReturnType<typeof workSnapshotKey>, changes: WorkRecord[]) {
  client.setQueryData<WorkSnapshot>(key, (snapshot) => snapshot ? mergeWorkRecords(snapshot, changes) : snapshot);
}

/**
 * A snapshot is a consistent cut at its own eventCursor, which can be older
 * than records the event loop or a receipt merged while it was in flight.
 * The loop never replays those events, so the newer cached versions survive.
 */
export async function loadWorkSnapshot(client: QueryClient, key: ReturnType<typeof workSnapshotKey>, adapter: WorkAdapter, signal?: AbortSignal) {
  const fresh = await adapter.snapshot(signal);
  const current = client.getQueryData<WorkSnapshot>(key);
  return current ? mergeWorkRecords(fresh, current.records) : fresh;
}

export function workSnapshotQuery(client: QueryClient, scope: number, project: string | null, adapter: WorkAdapter) {
  const queryKey = workSnapshotKey(scope, project, adapter.mode);
  return { queryKey, queryFn: ({ signal }: { signal: AbortSignal }) => loadWorkSnapshot(client, queryKey, adapter, signal) };
}

/** Records an event page changed that the cached read model does not hold yet. */
export function changedEventIds(snapshot: WorkSnapshot | undefined, events: WorkEvent[]) {
  // Without a cached read model there is nothing to merge into (the Overview case).
  if (!snapshot) return [];
  const existing = new Map(snapshot.records.map((record) => [record.id, record]));
  return [...new Set(events.filter((event) => {
    if (event.entityType === "git-observation") return false;
    const record = existing.get(event.entityId);
    return !record || (event.entityVersion !== null && (!("version" in record) || record.version < event.entityVersion));
  }).map((event) => event.entityId))];
}

export async function fetchEventRecords(adapter: WorkAdapter, snapshot: WorkSnapshot | undefined, events: WorkEvent[], signal: AbortSignal) {
  const ids = changedEventIds(snapshot, events);
  const changes: WorkRecord[] = [];
  // Small bounded batches avoid a large event page becoming an unbounded request fan-out.
  for (let offset = 0; offset < ids.length; offset += RECORD_FETCH_BATCH) {
    const batch = await Promise.all(ids.slice(offset, offset + RECORD_FETCH_BATCH).map((id) => adapter.record(id, signal)));
    changes.push(...batch.map((result) => result.record));
  }
  return changes;
}

/** Commits wake the event loop of the same read model, so the user's own side effects arrive now. */
const pollWakers = new WeakMap<QueryClient, Map<string, Set<() => void>>>();
export function onWorkPollRequest(client: QueryClient, key: ReturnType<typeof workSnapshotKey>, wake: () => void) {
  const byKey = pollWakers.get(client) ?? new Map<string, Set<() => void>>();
  pollWakers.set(client, byKey);
  const id = JSON.stringify(key);
  const wakers = byKey.get(id) ?? new Set();
  byKey.set(id, wakers.add(wake));
  return () => {
    wakers.delete(wake);
    if (!wakers.size) byKey.delete(id);
  };
}
export function requestWorkPoll(client: QueryClient, key: ReturnType<typeof workSnapshotKey>) {
  for (const wake of pollWakers.get(client)?.get(JSON.stringify(key)) ?? []) wake();
}
