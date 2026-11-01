import type { QueryClient } from "@tanstack/react-query";
import type { WorkAdapter } from "./adapter";
import type { WorkEvent, WorkRecord, WorkSnapshot } from "./types";

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

export async function fetchEventRecords(adapter: WorkAdapter, snapshot: WorkSnapshot | undefined, events: WorkEvent[], signal: AbortSignal) {
  const existing = new Map(snapshot?.records.map((record) => [record.id, record]));
  const ids = [...new Set(events.filter((event) => {
    const record = existing.get(event.entityId);
    return !record || (event.entityVersion !== null && (!("version" in record) || record.version < event.entityVersion));
  }).map((event) => event.entityId))];
  const changes: WorkRecord[] = [];
  // Small bounded batches avoid a large event page becoming an unbounded request fan-out.
  for (let offset = 0; offset < ids.length; offset += 8) {
    const batch = await Promise.all(ids.slice(offset, offset + 8).map((id) => adapter.record(id, signal)));
    changes.push(...batch.map((result) => result.record));
  }
  return changes;
}
