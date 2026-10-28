import { runEventPage } from "./retention";
import { releasedControllerAlias } from "./controller-recovery";
import type { ReconciliationRow } from "./recovery";
import { type Control, type FrameOf } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { HubStore } from "../store";
import type { ApprovalRow, HumanAuthority, MachineRecord, OperationRecord, QueueRow, RunRow, SessionRow } from "./model";
import { control, scoped, session } from "./guards";
import { completeProjection, type SessionDependencies } from "./sessions";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
function boundedRecords<T>(records:T[]): {records:T[];hasMore:boolean} {
  const selected:T[]=[]; let bytes=2048;
  for(const record of records) { const size=Buffer.byteLength(JSON.stringify(record))+1; if(selected.length>=100 || bytes+size>512*1024)break; selected.push(record); bytes+=size; }
  return {records:selected,hasMore:selected.length<records.length};
}
export function createRemoteReader(store: HubStore, deps: SessionDependencies) {
  function humanRead(p: string[], url: URL, auth: HumanAuthority): Response {
    if (p[0] === "machines") {
      const metadata = (m: MachineRecord) => ({ machineId: m.machineId, version: m.version, displayName: m.displayName, projectIds: m.projectIds.filter((projectId) => !auth.actor.projectIds || auth.actor.projectIds.includes(projectId)), revoked: m.revoked, createdAt: m.createdAt, lastSeenAt: m.lastSeenAt, connected: deps.online(m.machineId), recoveryRequired: m.recoveryRequired, inventory: (() => { const inventory = store.remote.get<FrameOf<"inventory">["payload"]>("remote_inventory", m.machineId); return inventory ? { ...inventory, checkouts: inventory.checkouts.filter((checkout) => (!auth.actor.projectIds || auth.actor.projectIds.includes(checkout.projectId)) && (!url.searchParams.get("projectId") || checkout.projectId === url.searchParams.get("projectId"))) } : null; })() });
      const projectFilter = url.searchParams.get("projectId"); if (projectFilter) scoped(auth, projectFilter, store.load());
      const permitted = store.remote.all<MachineRecord>("remote_machine").filter((m) => (!projectFilter || m.projectIds.includes(projectFilter)) && m.projectIds.some((projectId) => !auth.actor.projectIds || auth.actor.projectIds.includes(projectId)));
      if (p.length === 1) return json({ machines: permitted.map(metadata) });
      const target = permitted.find((m) => m.machineId === p[1]); if (!target) fail(404, "not-found", "Machine not found"); return json(metadata(target));
    }
    if (p[0] !== "projects" || !p[1]) fail(404, "not-found", "Route not found");
    scoped(auth, p[1], store.load()); const projectId = p[1]; const after = Number(url.searchParams.get("after") ?? "0"); if (!Number.isSafeInteger(after) || after < 0) fail(400, "invalid-cursor", "Invalid cursor");
    if (p[2] === "runs") {
      const all = store.remote.all<RunRow>("remote_run", { projectId });
      const exposed = (run: RunRow) => {
        const { commandDigest, commandId, nativeIdentity, ...safe } = run;
        const approvals = store.remote.all<ApprovalRow>("remote_approval_projection", { runId: run.runId }).map((question) => ({ approvalId: question.approvalId, runId: question.runId, sessionId: question.sessionId, turnId: question.turnId, actionFingerprint: question.actionFingerprint, policyDigest: question.policyDigest, expiresAt: question.expiresAt, summary: question.summary, localRequired: question.localRequired, status: question.status, ...(question.decision ? { decision: question.decision } : {}) }));
        const reconciliationReceipts = store.remote.all<ReconciliationRow>("remote_reconciliation", { runId: run.runId }).map((record) => record.receipt).filter((receipt) => (receipt.expectedRunVersion === run.version || (run.state === "lost" && run.reconciliationId === receipt.reconciliationId && receipt.expectedRunVersion + 1 === run.version)) && Date.now() - Date.parse(receipt.receivedAt) <= 30000 && receipt.observation !== "unknown");
        return { ...safe, approvals, reconciliationReceipts, connected: deps.online(run.machineId) };
      };
      if (!p[3]) return json({ runs: all.slice(after, after + 100).map(exposed), cursor: Math.min(all.length, after + 100), nextCursor: all.length > after + 100 ? after + 100 : null });
      const run = all.find((r) => r.runId === p[3]); if (!run) fail(404, "not-found", "Run not found");
      if (!p[4]) return json(exposed(run));
      if (p[4] === "events") return json(runEventPage(store.remote, run.runId, after));
    }
    if (p[2] !== "sessions") fail(404, "not-found", "Route not found");
    if (!p[3]) { const sessions = store.remote.all<SessionRow>("remote_session", { projectId }).map((row) => row.record).slice(after, after + 100); return json(control("SessionPage", { sessions, cursor: after + sessions.length, hasMore: sessions.length === 100 })); }
    const row = session(store.remote, projectId, p[3]); const suffix = p[4];
    if (!suffix) return json(row.record);
    if (suffix === "operations" && p[5]) { const release = releasedControllerAlias(store.remote, row, p[5]); if (release) return json(release); const operation = store.remote.get<OperationRecord>("remote_operation", p[5]); if (!operation || operation.projectId !== projectId || (operation.sessionId && operation.sessionId !== row.record.sessionId)) fail(404, "not-found", "Operation not found"); return json(operation.deliveryFailure ?? operation.response,operation.status); }
    if (suffix === "config") return json(row.record.config);
    if (suffix === "commands") { const projection = completeProjection(store.remote, row); return json(control("CommandCatalogue", { catalogueVersion: projection.catalogueVersion, catalogueDigest: projection.catalogueDigest, capabilityDigest: projection.capabilityDigest, entries: projection.catalogue })); }
    if (suffix === "routing") { const projection = completeProjection(store.remote, row); return json(control("RoutingAvailability", { version: projection.projectionVersion, policyDigest: projection.policyDigest, capabilityDigest: projection.capabilityDigest, candidates: projection.candidates, profileIds: projection.profileIds })); }
    if (suffix === "queue") return json(control("QueuePage", { cursor: 0, hasMore: false, queueVersion: row.record.queueVersion, items: store.remote.all<QueueRow>("remote_queue", { sessionId: row.record.sessionId }).map((q) => q.item) }));
    if (suffix === "history") { const page = boundedRecords(store.remote.all<Control["SessionMessage"]>("remote_history", { sessionId: row.record.sessionId }).filter((m) => m.historyCursor > after)); return json(control("HistoryPage", { historyVersion: row.record.historyVersion, messages: page.records, cursor: page.records.at(-1)?.historyCursor ?? after, hasMore: page.hasMore, retainedFromCursor: 0, gap: false })); }
    if (suffix === "events") { const page = boundedRecords(store.remote.all<Control["SessionEvent"]>("remote_session_event", { sessionId: row.record.sessionId }).filter((e) => e.sessionEventSeq > after)); return json(control("SessionEventPage", { events:page.records, cursor: page.records.at(-1)?.sessionEventSeq ?? after, hasMore: page.hasMore, retainedFromCursor: 0, gap: false })); }
    fail(404, "not-found", "Route not found");
  }
  return humanRead;
}
