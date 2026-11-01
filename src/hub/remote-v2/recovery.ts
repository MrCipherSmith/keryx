import { canonicalDigest, type Control } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { HubState } from "../store";
import type { RemoteRepository } from "./storage";
import type { HumanAuthority, MachineRecord, OperationRecord, QueueRow, RunRow, SessionRow } from "./model";
import { control, id, iso, saveSession, scoped, version } from "./guards";
export type ReconciliationRow = { report: Control["ReconciliationReport"]; receipt: Control["ReconciliationReceipt"] };
/**
 * A crashed session whose only uncertain run a human resolved lost. Hub then delivers a resume although it holds no verified baseline:
 * the machine re-verifies the owned workspace before it reports the session idle, and only that projection verifies it again.
 * `operationId` is the resume's own pending delivery at its authorization.
 */
export function resumableAfterLost(repo: RemoteRepository, row: SessionRow, operationId?: string): boolean {
  const lost = row.lostRecovery ? repo.get<RunRow>("remote_run", row.lostRecovery.runId) : undefined;
  return lost?.state === "lost" && lost.sessionId === row.record.sessionId && lost.reconciliationId === row.lostRecovery?.reconciliationId && row.record.state === "recovery-required" && row.record.activeRunId === null && (!row.pending || row.pending.operationId === operationId) && repo.unresolvedSessionRuns(row.record.sessionId) === 0;
}
export function reconcile(repo: RemoteRepository, machine: MachineRecord, body: Control["ReconciliationReport"], operationId: string, key: string, activeDaemon?: string | null): Control["ReconciliationReceipt"] {
  if (body.ledgerId !== machine.ledgerId || !machine.projectIds.includes(body.projectId)) fail(403, "scope-denied", "Reconciliation ledger or project denied");
  const run = repo.get<RunRow>("remote_run", body.runId);
  if (!run || run.machineId !== machine.machineId || run.projectId !== body.projectId || run.sessionId !== body.sessionId || run.turnId !== body.turnId || run.checkoutId !== body.checkoutId || run.commandDigest !== body.commandDigest) fail(409, "stale-reference", "Reconciliation does not bind an owned immutable run");
  version(run.version, body.expectedRunVersion);
  if ((activeDaemon && body.daemonId !== activeDaemon) || Date.parse(body.observedAt) > Date.now() + 5000 || Date.parse(body.observedAt) < Date.now() - 30000) fail(409, "stale-reference", "Fresh current local observation required");
  if (body.observation === "owned-running" && !body.nativeIdentity) fail(409, "recovery-required", "Owned runtime identity required");
  if (body.nativeIdentity && (body.nativeIdentity.sessionId !== run.sessionId || body.nativeIdentity.turnId !== run.turnId || body.nativeIdentity.daemonId !== body.daemonId || (run.nativeIdentity && body.nativeIdentity.supervisorHandleId !== run.nativeIdentity.supervisorHandleId))) fail(409, "recovery-required", "Supervisor ownership differs from retained identity");
  const digest = canonicalDigest(body); const previous = repo.get<OperationRecord>("remote_operation", operationId);
  if (previous) { if (previous.payloadDigest !== digest) fail(409, "payload-conflict", "Reconciliation operation changed"); return control("ReconciliationReceipt", previous.response); }
  const receipt: Control["ReconciliationReceipt"] = { reconciliationId: id(), machineId: machine.machineId, reportDigest: digest, receivedAt: iso(), runId: run.runId, projectId: run.projectId, checkoutId: run.checkoutId, ledgerId: machine.ledgerId, daemonId: body.daemonId, expectedRunVersion: run.version, observation: body.observation, sessionId: run.sessionId, turnId: run.turnId };
  repo.put("remote_reconciliation", receipt.reconciliationId, { report: body, receipt } satisfies ReconciliationRow, { projectId: run.projectId, machineId: machine.machineId, sessionId: run.sessionId, runId: run.runId });
  repo.put("remote_operation", operationId, { id: operationId, key, actorId: `machine:${machine.machineId}`, sessionDigest: "", projectId: run.projectId, sessionId: run.sessionId, payloadDigest: digest, request: body, kind: "reconciliation", response: receipt, status: 200 } satisfies OperationRecord, { projectId: run.projectId, machineId: machine.machineId, sessionId: run.sessionId, runId: run.runId });
  return receipt;
}
export function resolveRun(state: HubState, repo: RemoteRepository, authority: HumanAuthority, machine: MachineRecord, body: Control["ResolveRunRequest"]): { runId: string; state: RunRow["state"]; version: number; reconciliationId: string } {
  const run = repo.get<RunRow>("remote_run", body.runId);
  if (!run || run.machineId !== machine.machineId || !machine.projectIds.includes(run.projectId)) fail(404, "not-found", "Run not found"); scoped(authority, run.projectId, state); version(run.version, body.expectedRunVersion);
  const observed = repo.get<ReconciliationRow>("remote_reconciliation", body.localReconciliationId); const receipt = observed?.receipt, report = observed?.report;
  if (!receipt || !report || receipt.machineId !== machine.machineId || receipt.ledgerId !== machine.ledgerId || receipt.runId !== run.runId || receipt.sessionId !== run.sessionId || receipt.turnId !== run.turnId || receipt.checkoutId !== run.checkoutId || receipt.projectId !== run.projectId || receipt.expectedRunVersion !== run.version || receipt.reportDigest !== canonicalDigest(report) || Date.now() - Date.parse(receipt.receivedAt) > 30000 || report.commandDigest !== run.commandDigest || receipt.observation === "unknown") fail(409, "recovery-required", "Matching fresh local reconciliation required");
  if (run.state !== "unknown") fail(409, "stale-reference", "Only uncertain runs may be resolved");
  if (body.decision === "lost" && receipt.observation !== "confirmed-stopped") fail(409, "recovery-required", "Locally confirmed absence required for lost resolution");
  if (receipt.observation === "owned-running") { if (!report.nativeIdentity) fail(409, "recovery-required", "Owned supervisor required"); run.nativeIdentity = report.nativeIdentity; run.state = "running"; }
  else { run.state = "lost"; run.terminalAt ??= new Date().toISOString(); }
  run.version++; run.notificationVersion = (run.notificationVersion ?? 0) + 1; run.reconciliationId = receipt.reconciliationId; run.observedAt = report.observedAt; repo.put("remote_run", run.runId, run, { projectId: run.projectId, machineId: machine.machineId, sessionId: run.sessionId, runId: run.runId });
  const row = repo.get<SessionRow>("remote_session", run.sessionId);
  if(run.state==='lost')repo.releaseRunCapacity(run.runId);
  if (row && run.state === "lost") {
    if (row.pending?.commandId === run.commandId) delete row.pending; row.baselineVerified = false;
    // The crashed daemon's last projection still shows the lost run active, and nothing runs it now. The session is neither busy nor
    // idle nor closed but recovery-required, until a resume the machine re-verifies against its owned baseline. The version is kept:
    // it stays the machine's applied session version that such a resume is pinned to.
    if (row.record.activeRunId === run.runId) {
      row.record = { ...row.record, state: "recovery-required", activeRunId: null, activeTurnId: null }; row.lostRecovery = { runId: run.runId, reconciliationId: receipt.reconciliationId };
      // A restarted native host never takes queued input as authorization: its queued items come back suspended. Hub projects the
      // same, so nothing queued behind the lost run is admitted automatically; a human reauthorizes or removes it.
      for (const queued of repo.all<QueueRow>("remote_queue", { sessionId: run.sessionId })) if (queued.item.state === "queued" && !queued.admissionCommandId) { queued.item = { ...queued.item, state: "suspended" }; repo.put("remote_queue", queued.item.queueItemId, queued, { sessionId: queued.sessionId, projectId: queued.projectId, machineId: queued.machineId, seq: queued.item.position }); }
    }
    saveSession(repo, row);
  }
  state.events.push({ sequence: (state.events.at(-1)?.sequence ?? 0) + 1, projectId: run.projectId, type: "remote-run-resolved", actorId: authority.actor.id, actorRole: authority.actor.role, entityId: run.runId, createdAt: iso() });
  return { runId: run.runId, state: run.state, version: run.version, reconciliationId: receipt.reconciliationId };
}
