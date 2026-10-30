import { canonicalDigest, parseMachineFrame, runCommandDigest, sessionCommandDigest, validateControl, type Control } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { RemoteRepository } from "./storage";
import type { MachineRecord, OperationRecord, RunRow, SessionRow, StoredCommand } from "./model";
export type ReleasedControllerRow = { receipt: Control["ControllerReceipt"]; commandId: string; operationId: string; source?: "human-command" } | { source:"local-cessation"; receipt:Control["ControllerReceipt"]; eventSeq:number; closedEventSeq:number; epoch:number; ledgerId:string; receivedAt:string };
/** D15: terminal history is retained; physical cessation never relabels a run lost. */
function knownTerminalCessation(repo:RemoteRepository,row:SessionRow):boolean {
  const launches=new Set<string>();
  for(const run of repo.sessionValues<RunRow>("remote_run",row.record.sessionId)){
    if(!["succeeded","failed","cancelled","rejected","lost"].includes(run.state)||run.incident||!run.terminalAt||run.machineId!==row.record.machineId||run.projectId!==row.record.projectId||run.checkoutId!==row.record.checkoutId||run.sessionId!==row.record.sessionId)return false;
    const command=repo.get<StoredCommand>("remote_command",run.commandId);if(!command||command.projectId!==run.projectId||command.machineId!==run.machineId)return false;
    const envelope=command.envelope,target="target" in envelope?envelope.target:undefined;
    const exactTarget="runId" in envelope?envelope.sessionId===run.sessionId&&envelope.runId===run.runId&&envelope.turnId===run.turnId:target?.scope==="run"&&target.sessionId===run.sessionId&&target.runId===run.runId&&target.turnId===run.turnId;
    const digest="runId" in envelope?runCommandDigest(envelope):sessionCommandDigest(envelope);
    if(!exactTarget||envelope.checkoutId!==run.checkoutId||envelope.projectId!==run.projectId||!["start-turn","invoke-command"].includes(envelope.kind)||digest!==run.commandDigest||digest!==envelope.commandDigest)return false;
    if(run.state==="lost"){
      const local=run.reconciliationId&&repo.get<import("./recovery").ReconciliationRow>("remote_reconciliation",run.reconciliationId);
      if(!local||local.receipt.observation!=="confirmed-stopped"||local.receipt.runId!==run.runId||local.receipt.machineId!==run.machineId||local.receipt.sessionId!==run.sessionId||local.receipt.projectId!==run.projectId||local.receipt.expectedRunVersion+1!==run.version||local.receipt.reportDigest!==canonicalDigest(local.report)||local.report.commandDigest!==run.commandDigest)return false;
    }else{
      const stored=repo.terminalEvent<import("./events").StoredRunEvent>(run.runId,run.state),event=stored?.event;
      const explicitNonadmission=(command.status==="not-applied"||command.status==="rejected")&&!run.nativeIdentity&&!repo.hasAdmittedTurn(run.runId);
      if(!event){if(run.state!=="rejected"||!explicitNonadmission)return false;}
      else if(event.kind!=="state"||event.state!==run.state||event.runId!==run.runId||event.sessionId!==run.sessionId||event.projectId!==run.projectId||event.checkoutId!==run.checkoutId||event.turnId!==run.turnId||event.localSeq>run.lastLocalSeq||(!run.nativeIdentity&&!explicitNonadmission)||run.nativeIdentity&&(!event.nativeIdentity||canonicalDigest(event.nativeIdentity)!==canonicalDigest(run.nativeIdentity)))return false;
    }
    launches.add(run.commandId);
  }
  for(const command of repo.sessionValues<StoredCommand>("remote_command",row.record.sessionId)){
    if(["applied","not-applied","rejected"].includes(command.status))continue;
    if(command.status!=="admitted"||!launches.has(command.envelope.commandId))return false;
  }
  return true;
}
/** Accept only deescalation after the owning local process measured actual cessation. */
export function observeLocalCessation(repo:RemoteRepository,row:SessionRow,m:MachineRecord,event:Extract<Control["SessionEvent"],{kind:"controller-changed"}>):void {
  const previous=row.record.controller, receipt=event.receipt, lease=receipt.lease, proof=row.closedProof;
  if (!previous || !["held","expired"].includes(previous.state) || Date.parse(previous.expiresAt)>Date.now() || !proof || proof.eventSeq!==row.record.sessionEventCursor || proof.epoch!==m.epoch || proof.ledgerId!==m.ledgerId || row.record.state!=="closed" || row.record.activeRunId || row.record.activeTurnId || row.pending || row.pendingClosure || row.pendingController || !knownTerminalCessation(repo,row)) fail(409,"recovery-required","Local cessation requires an exact expired closed host with exact known terminal history without uncertain work");
  if(receipt.sessionVersion!==row.record.version+1 || lease.version!==previous.version+1 || canonicalDigest({...lease,version:previous.version,state:previous.state})!==canonicalDigest(previous) || lease.state!=="released") fail(409,"stale-reference","Local cessation cannot change controller ownership or extend authority");
  if(repo.get("remote_controller_release",lease.controllerLeaseId)||repo.get("remote_operation",lease.controllerLeaseId)||repo.get("remote_command",lease.controllerLeaseId))fail(409,"payload-conflict","Controller release provenance alias already occupied");
  repo.put("remote_controller_release",lease.controllerLeaseId,{source:"local-cessation",receipt,eventSeq:event.sessionEventSeq,closedEventSeq:proof.eventSeq,epoch:m.epoch,ledgerId:m.ledgerId,receivedAt:new Date().toISOString()} satisfies ReleasedControllerRow,{projectId:row.record.projectId,machineId:m.machineId,sessionId:row.record.sessionId});
}
/** D8 read-only alias. It never turns a proposal or a historical lease into a takeover grant. */
export function releasedControllerAlias(repo: RemoteRepository, row: SessionRow, alias: string): Control["ControllerReceipt"] | undefined {
  const stored = repo.get<ReleasedControllerRow>("remote_controller_release", alias);
  const lease = row.record.controller;
  if (!stored?.receipt) { if (lease?.controllerLeaseId === alias) fail(404, "not-found", "Applied release not available"); return undefined; }
  if (repo.get("remote_operation", alias) || repo.get("remote_command", alias)) fail(409, "payload-conflict", "Ambiguous controller receipt alias");
  if (!lease || lease.state !== "released" || lease.controllerLeaseId !== alias || canonicalDigest(lease) !== canonicalDigest(stored.receipt.lease) || stored.receipt.sessionVersion > row.record.version) fail(404, "not-found", "Current applied release not found");
  if(stored.source==="local-cessation"){
    const closed=repo.get<Control["SessionEvent"]>("remote_session_event",`${row.record.sessionId}:${stored.closedEventSeq}`), released=repo.get<Control["SessionEvent"]>("remote_session_event",`${row.record.sessionId}:${stored.eventSeq}`);
    if(!closed||closed.kind!=="session-state"||closed.session.state!=="closed"||!released||released.kind!=="controller-changed"||stored.eventSeq!==stored.closedEventSeq+1||canonicalDigest(released.receipt)!==canonicalDigest(stored.receipt)||!knownTerminalCessation(repo,row))fail(404,"not-found","Measured local cessation provenance unavailable");
    const parsed=validateControl("ControllerReceipt",stored.receipt);if(!parsed.ok)fail(409,"recovery-required","Stored local release invalid");return parsed.value;
  }
  const command = repo.get<StoredCommand>("remote_command", stored.commandId), operation = repo.get<OperationRecord>("remote_operation", stored.operationId);
  if (!command || command.frameType !== "session-command" || command.envelope.kind !== "release-controller" || command.machineId !== row.record.machineId || command.projectId !== row.record.projectId || command.envelope.target.sessionId !== row.record.sessionId || command.envelope.commandDigest !== sessionCommandDigest(command.envelope) || command.status !== "applied" || !operation || operation.sessionId !== row.record.sessionId || operation.projectId !== row.record.projectId || canonicalDigest(operation.response) !== canonicalDigest(stored.receipt)) fail(404, "not-found", "Exact applied release provenance unavailable");
  const delivery = parseMachineFrame(JSON.stringify({ v: 2, type: "session-command-receipt", messageId: "release-read", epoch: 1, payload: command.receipt }), "machine-to-hub");
  if (!delivery.ok || delivery.value.type !== "session-command-receipt" || delivery.value.payload.status !== "applied" || delivery.value.payload.receiptId !== stored.receipt.receiptId || delivery.value.payload.commandId !== stored.commandId || delivery.value.payload.sessionId !== row.record.sessionId) fail(404, "not-found", "Machine applied release receipt required");
  const receipt = validateControl("ControllerReceipt", stored.receipt); if (!receipt.ok) fail(409, "recovery-required", "Stored release receipt invalid"); return receipt.value;
}

/** A controller takeover may use fresh local absence proof; it never clears a native lease or grants execution. */
export function verifiedControllerRecovery(repo: RemoteRepository, row: SessionRow, reconciliationId: string): boolean {
  const local = repo.get<import("./recovery").ReconciliationRow>("remote_reconciliation", reconciliationId);
  const lease = row.record.controller;
  if (!local || !lease || (lease.state === "held" && Date.parse(lease.expiresAt) > Date.now()) || local.receipt.machineId !== row.record.machineId || local.receipt.sessionId !== row.record.sessionId || local.receipt.projectId !== row.record.projectId || local.receipt.observation !== "confirmed-stopped" || Date.now() - Date.parse(local.receipt.receivedAt) > 30000 || local.receipt.reportDigest !== canonicalDigest(local.report)) return false;
  const run = repo.get<import("./model").RunRow>("remote_run", local.receipt.runId);
  if (!run || run.state !== "lost" || run.reconciliationId !== reconciliationId || local.receipt.expectedRunVersion + 1 !== run.version || run.commandDigest !== local.report.commandDigest || run.sessionId !== row.record.sessionId || run.machineId !== row.record.machineId) return false;
  return !repo.all<import("./model").RunRow>("remote_run", { sessionId: row.record.sessionId }).some((candidate) => candidate.runId !== run.runId && !["succeeded", "failed", "cancelled", "rejected", "lost"].includes(candidate.state));
}
