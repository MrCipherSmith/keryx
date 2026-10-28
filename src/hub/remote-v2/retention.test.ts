import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubStore } from "../store";
import { retireRunLogs, runEventPage } from "./retention";
import { canonicalDigest } from "../../remote-control/protocol";
test("seven-day retention removes only log content with explicit paged gaps while preserving critical events and payload tombstones", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-retention-"));
  try {
    const store = openHubStore(dir); const at = Date.now();
    store.writeTransaction((state, repo) => {
      state.projects.push({ id: "p", name: "p", version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0 });
      repo.put("remote_machine", "m", { machineId: "m" }); repo.put("remote_session", "s", { record: { sessionId: "s" } }, { projectId: "p", machineId: "m" });
      repo.put("remote_run", "r", { runId: "r", state: "succeeded", terminalAt: new Date(at).toISOString() }, { projectId: "p", machineId: "m", sessionId: "s" });
      for (const seq of [1, 2]) { const event = seq === 1 ? { runId: "r", localSeq: 1, kind: "log", text: "retained safe log", stream: "diagnostic" } : { runId: "r", localSeq: 2, kind: "state", state: "succeeded" }; repo.put("remote_event", `r:${seq}`, { event, payloadDigest: canonicalDigest(event), retained: true }, { projectId: "p", machineId: "m", sessionId: "s", runId: "r", seq }); }
    });
    store.writeTransaction((_state, repo) => { expect(retireRunLogs(repo, at + 6 * 86400000)).toBe(0); expect(retireRunLogs(repo, at + 8 * 86400000)).toBe(1); });
    const page = runEventPage(store.remote, "r", 0); expect(page.events).toHaveLength(0); expect(page.cursor).toBe(1); expect(page.gap).toEqual({ fromSeq: 1, toSeq: 1 });
    const next = runEventPage(store.remote, "r", 1); expect(next.events[0]).toMatchObject({ kind: "state", state: "succeeded" }); expect(next.cursor).toBe(2);
    const tombstone = store.remote.get<{ payloadDigest: string; retained: boolean }>("remote_event", "r:1")!; expect(tombstone.retained).toBe(false); expect(tombstone.payloadDigest).toHaveLength(64); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
