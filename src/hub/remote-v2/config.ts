import { canonicalDigest,validateArguments, type Control } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { RemoteRepository } from "./storage";
import type { HumanAuthority, Projection, SessionRow } from "./model";
import { held, id, machine, version } from "./guards";
import { completeProjection } from "./sessions";
import { sessionCommand } from "./commands";
export type ConfirmationRow = { card: Control["CommandConfirmationRequest"]; original: Control["ConfigChange"]; authority: HumanAuthority; consumed: boolean; receipt: Control["ConfigReceipt"] };
export type CommandConfirmationRow = { card: Control["CommandConfirmationRequest"]; originalOperationId: string; original: Control["CommandInvoke"]; authority: HumanAuthority; consumed: boolean; outcome: Control["CommandOutcome"] };
export function configChange(repo: RemoteRepository, auth: HumanAuthority, row: SessionRow, body: Control["ConfigChange"], operationId: string): Control["ConfigReceipt"] {
  if(row.closing)fail(409,'session-closed','Session queue is sealed for close');
  version(row.record.version, body.expectedSessionVersion); held(row, auth, body.controller); version(row.record.config.configVersion, body.expectedConfigVersion);
  candidates(completeProjection(repo, row), body);
  if (row.record.activeRunId && body.busyPolicy === "reject") fail(409, "session-busy", "Configuration changes require an idle boundary");
  sessionCommand(repo, machine(repo, row.record.machineId), row, auth, operationId, "change-config", body);
  // HTTP acceptance reserves delivery only. The actual SessionHost owns confirmations and idle-boundary application.
  return { receiptId: id(), operationId, sessionId: row.record.sessionId, sessionVersion: row.record.version, status: "queued", configVersion: null, effectiveFromTurnOrdinal: null, reason: "none", confirmation: null };
}
function candidates(p: Projection, body: Control["ConfigChange"]) {
  if (!p.profileIds.includes(body.routing.profileId)) fail(409, "candidate-unavailable", "Routing profile unavailable");
  const ids = new Set([body.baselineCandidateId, ...body.routing.candidateIds, body.routing.fallbackCandidateId]);
  return [...ids].map((id) => { const candidate = p.candidates.find((c) => c.candidateId === id); if (!candidate || !candidate.available || candidate.reason !== "none" || !candidate.reasoningEfforts.includes(body.reasoningEffort)) fail(409, "candidate-unavailable", "Connected locally permitted candidate required"); return candidate; });
}
export function configConfirm(repo: RemoteRepository, auth: HumanAuthority, row: SessionRow, body: Control["CommandConfirmation"], confirmationOperationId: string,authorityValid:(authority:HumanAuthority,projectId:string)=>boolean): Control["ConfigReceipt"] {
  version(row.record.version, body.expectedSessionVersion); held(row, auth, body.controller);
  if(row.closing&&body.decision==='allow-once')fail(409,'session-closed','Closing session cannot admit a configuration change');
  const pending = repo.get<ConfirmationRow>("remote_confirmation", body.confirmationId);
  if (!pending || pending.card.sessionId !== row.record.sessionId || pending.card.actorId !== auth.actor.id || pending.card.operationDigest !== body.operationDigest || pending.card.policyDigest !== body.policyDigest || canonicalDigest(pending.card.controller) !== canonicalDigest(body.controller)) fail(409, "stale-reference", "Exact confirmation binding required");
  if (pending.consumed) fail(409, "payload-conflict", "Confirmation already submitted");
  if (Date.parse(pending.card.expiresAt) <= Date.now()) fail(409, "approval-expired", "Native confirmation deadline expired");
  version(row.record.config.configVersion, pending.card.expectedConfigVersion);
  if(body.decision==='allow-once'){if(!authorityValid(pending.authority,row.record.projectId))fail(403,'forbidden','Original configuration actor authority was revoked');candidates(completeProjection(repo, row), pending.original);}
  sessionCommand(repo, machine(repo, row.record.machineId), row, auth, confirmationOperationId, "confirm-command", body);
  pending.consumed = true;
  pending.receipt = { ...pending.receipt, status: "queued", reason: "none", confirmation: null };
  repo.put("remote_confirmation", body.confirmationId, pending, { sessionId: row.record.sessionId, projectId: row.record.projectId, machineId: row.record.machineId });
  return pending.receipt;
}
export function authorizeConfirmation(repo:RemoteRepository,row:SessionRow,command:import('./model').StoredCommand,authorityValid:(authority:HumanAuthority,projectId:string)=>boolean):void {
 if(command.envelope.kind!=='confirm-command')return;
 const body=command.envelope.body;
 const pending=repo.get<ConfirmationRow|CommandConfirmationRow>('remote_confirmation',body.confirmationId);
 if(!pending||!pending.consumed||pending.card.sessionId!==row.record.sessionId||pending.card.actorId!==command.authority.actor.id||pending.card.operationDigest!==body.operationDigest||pending.card.policyDigest!==body.policyDigest||canonicalDigest(pending.card.controller)!==canonicalDigest(body.controller))fail(409,'stale-reference','Fresh confirmation no longer binds its exact native card');
 if(Date.parse(pending.card.expiresAt)<=Date.now())fail(409,'approval-expired','Native confirmation deadline expired before delivery');
 version(row.record.config.configVersion,pending.card.expectedConfigVersion);
 if(body.decision==='deny')return;
 if(!authorityValid(pending.authority,row.record.projectId))fail(403,'forbidden','Original command actor authority was revoked');
 const projection=completeProjection(repo,row);
 if('receipt' in pending)candidates(projection,pending.original);
 else {const original=pending.original;const entry=projection.catalogue.find(e=>e.commandName===original.commandName);if(projection.catalogueDigest!==original.catalogueDigest||!entry||entry.availability!=='available'||!validateArguments(entry.inputSchema,original.arguments).ok)fail(409,'stale-catalogue','Confirmed command catalogue or arguments changed');}
}
