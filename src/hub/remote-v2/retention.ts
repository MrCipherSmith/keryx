import type { FrameOf } from "../../remote-control/protocol";
import type { RemoteRepository } from "./storage";
import type { RunRow } from "./model";
import { storedRunEvent, type StoredRunEvent } from "./events";
/** Critical events and immutable launch identities are never retired with logs. */
export function retireRunLogs(repo: RemoteRepository, now = Date.now()): number {
  const terminal = new Set(repo.all<RunRow>("remote_run").filter((run) => ["succeeded", "failed", "cancelled", "rejected", "lost"].includes(run.state) && run.terminalAt && Date.parse(run.terminalAt) + 7 * 86400000 <= now).map((run) => run.runId));
  if (!terminal.size) return 0;
  let count = 0;
  for (const record of repo.all<StoredRunEvent>("remote_event")) {
    if (count >= 1000) break;
    if (!record.event || record.event.kind !== "log" || !record.retained || !terminal.has(record.event.runId)) continue;
    record.event.text = ""; record.retained = false;
    repo.put("remote_event", `${record.event.runId}:${record.event.localSeq}`, record); count++;
  }
  return count;
}
export function runEventPage(repo: RemoteRepository, runId: string, after: number): { events: FrameOf<"run-event">["payload"][]; cursor: number; gap: { fromSeq: number; toSeq: number } | null } {
  const records = repo.runEventsAfter<StoredRunEvent | FrameOf<"run-event">["payload"]>(runId, after);
  const events: FrameOf<"run-event">["payload"][] = []; let cursor = after, bytes = 0; let gap: { fromSeq: number; toSeq: number } | null = null;
  for (const record of records) {
    const event = storedRunEvent(record), archived = "event" in record && !record.retained;
    if (archived) { if (!gap) gap = { fromSeq: event.localSeq, toSeq: event.localSeq }; else gap.toSeq = event.localSeq; cursor = event.localSeq; continue; }
    if (gap) break;
    const size = Buffer.byteLength(JSON.stringify(event)); if (events.length >= 500 || bytes + size > 512 * 1024) break;
    bytes += size; events.push(event); cursor = event.localSeq;
  }
  return { events, cursor, gap };
}
