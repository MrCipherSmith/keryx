import {resumeProved} from './closure';
import type { Control, FrameOf } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { HubStore } from "../store";
import type { HumanAuthority, SessionRow } from "./model";
import { control, held, id, machine, saveSession, session, version } from "./guards";
import { createSession,completeProjection, type SessionDependencies } from "./sessions";
import { sessionCommand } from "./commands";
export function createLifecycleOperations(store: HubStore, deps: SessionDependencies) {
  function prepareFork(row: SessionRow, auth: HumanAuthority, request: Control["SessionFork"], operationId: string): Control["SessionOperationReceipt"] {
    if (row.record.state !== "idle" || row.record.activeRunId) fail(409, "session-busy", "Fork requires idle source");
    if(request.targetCheckoutId===row.record.checkoutId)fail(409,"workspace-conflict","Fork requires a separate explicitly mapped clean target checkout");
    version(row.record.historyVersion, request.expectedHistoryVersion);
    if (request.throughHistoryCursor > row.record.historyCursor) fail(409, "stale-reference", "Fork history cursor is unavailable");
    const inventory = store.remote.get<FrameOf<"inventory">["payload"]>("remote_inventory", row.record.machineId);
    const checkout = inventory?.checkouts.find((c) => c.projectId === row.record.projectId && c.checkoutId === request.targetCheckoutId);
    const profile = checkout?.agentProfiles.find((p) => p.profileId === row.record.agentProfileId);
    if (!inventory || !checkout || !profile) fail(409, "setup-required", "Explicit locally mapped fork checkout/profile required");
    const created = createSession(store.load(), store.remote, deps, auth, row.record.projectId, { machineId: row.record.machineId, checkoutId: checkout.checkoutId, agentProfileId: profile.profileId, expectedInventoryVersion: request.expectedInventoryVersion, expectedHeadSha: request.expectedHeadSha, capabilityDigest: profile.capabilityDigest, policyDigest: profile.policyDigest, title: request.title }, operationId, false);
    const child = session(store.remote, row.record.projectId, created.sessionId); child.record.forkedFromSessionId = row.record.sessionId; saveSession(store.remote, child);
    return { ...created, kind: "fork-session", session: child.record };
  }
  function direct(row: SessionRow, auth: HumanAuthority, action: string, input: unknown, operationId: string): Control["SessionOperationReceipt"] {
    if(row.pendingClosure)fail(409,'session-busy','An exact close intent remains pending');
    if(row.closing&&action!=='resume')fail(409,'session-closed','Session queue is sealed for close');
    const b = action === "resume" ? control("SessionResume", input) : action === "fork" ? control("SessionFork", input) : control("SessionClose", input);
    version(row.record.version, b.expectedSessionVersion); held(row, auth, b.controller);
    if (!deps.online(row.record.machineId)) fail(409, "machine-offline", "Machine offline");
    if (action === "fork") { const request = control("SessionFork", input); const created = prepareFork(row, auth, request, operationId); sessionCommand(store.remote, machine(store.remote, row.record.machineId), row, auth, operationId, "fork-session", { newSessionId: created.sessionId, request }); return created; }
    if (action === "resume") {
      resumeProved(store.remote,row);
      const request = control("SessionResume", input); version(row.record.historyVersion, request.expectedHistoryVersion);
      if (request.expectedWorkspaceBaseline !== row.record.workspaceBaseline || !row.baselineVerified) fail(409, "workspace-conflict", "Measured workspace baseline differs");
      if (row.record.state === "recovery-required" || row.record.activeRunId) fail(409, "recovery-required", "Runtime ownership must be reconciled before resume");
    }
    const kind = action === "resume" ? "resume-session" : "close-session";
    sessionCommand(store.remote, machine(store.remote, row.record.machineId), row, auth, operationId, kind, input);
    if(kind==='close-session'){const pending=row.pending;if(!pending)throw new Error('Close delivery reservation missing');row.pendingClosure=pending;delete row.pending;row.closing=true;saveSession(store.remote,row);}else{row.resumingOperationId=operationId;saveSession(store.remote,row);}
    return { receiptId: id(), operationId, sessionId: row.record.sessionId, kind, status: "pending", observedSessionVersion: row.record.version, session: row.record, reason: "none" };
  }
  function fromCommand(row: SessionRow, auth: HumanAuthority, command: Control["CommandInvoke"], operationId: string): Control["SessionOperationReceipt"] | undefined {
    if (command.commandName === "sessions.open") {
      const args = command.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.sessionId !== "string") fail(400, "invalid-arguments", "Typed reader attachment target required");
      const target = session(store.remote, row.record.projectId, args.sessionId);
      if (target.record.machineId !== row.record.machineId) fail(409, "stale-reference", "Machine reader cannot attach another machine's private history");
      const {sessionId:_sessionId,...open} = args;
      version(target.record.version, control("SessionOpen",open).expectedSessionVersion);
      // The selected machine validates/attaches its actual local history and
      // returns the catalogue's non-null reader link, without creating a lease.
      return undefined;
    }
    if (!["new", "clear", "sessions.fork", "sessions.resume"].includes(command.commandName)) return undefined;
    if (row.record.state !== "idle" || row.record.activeRunId) fail(409, "session-busy", "Conversation identity operations require idle source");
    const args = command.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) fail(400, "invalid-arguments", "Typed lifecycle arguments required");
    let receipt: Control["SessionOperationReceipt"];
    if (command.commandName === "new" || command.commandName === "clear") {
      const inventory = store.remote.get<FrameOf<"inventory">["payload"]>("remote_inventory", row.record.machineId);
      const checkout = inventory?.checkouts.find((c) => c.projectId === row.record.projectId && c.checkoutId === row.record.checkoutId);
      if (!inventory || !checkout) fail(409, "setup-required", "Current explicit checkout inventory required");
      receipt = createSession(store.load(), store.remote, deps, auth, row.record.projectId, { machineId: row.record.machineId, checkoutId: row.record.checkoutId, agentProfileId: row.record.agentProfileId, expectedInventoryVersion: inventory.inventoryVersion, expectedHeadSha: checkout.headSha, capabilityDigest: row.record.config.capabilityDigest, policyDigest: row.record.config.policyDigest, title: "New session" }, operationId, false);
    } else if (command.commandName === "sessions.fork") receipt = prepareFork(row, auth, control("SessionFork", { ...args, expectedSessionVersion: row.record.version, controller: command.controller }), operationId);
    else {
      if (typeof args.sessionId !== "string") fail(400, "invalid-arguments", "Existing target session required");
      const target = session(store.remote, row.record.projectId, args.sessionId);
      if (target.record.machineId !== row.record.machineId) fail(409, "stale-reference", "Session resume requires the same selected machine");
      resumeProved(store.remote,target);
      const { sessionId: _sessionId, ...resume } = args;
      const request = control("SessionResume", resume); version(target.record.version, request.expectedSessionVersion); held(target, auth, request.controller); version(target.record.historyVersion, request.expectedHistoryVersion);
      if (target.record.workspaceBaseline !== request.expectedWorkspaceBaseline || !target.baselineVerified || target.record.activeRunId || target.record.state === "recovery-required" || target.pending) fail(409, "recovery-required", "Target native session requires reconciliation");
      target.resumingOperationId=operationId;saveSession(store.remote,target);
      receipt = { receiptId: id(), operationId, sessionId: target.record.sessionId, kind: "resume-session", status: "pending", observedSessionVersion: target.record.version, session: target.record, reason: "none" };
    }
    sessionCommand(store.remote, machine(store.remote, row.record.machineId), row, auth, operationId, "invoke-command", command);
    return receipt;
  }
  return { direct, fromCommand };
}

/** Recheck all secondary lifecycle targets at the fresh effect grant boundary. */
export function authorizeLifecycle(repo:import('./storage').RemoteRepository,row:SessionRow,command:import('./model').StoredCommand):void {
 const envelope=command.envelope;
 const inventory=(target:SessionRow,clean:boolean)=>{
  const current=machine(repo,target.record.machineId);
  const snapshot=repo.get<FrameOf<'inventory'>['payload']>('remote_inventory',current.machineId);
  const checkout=snapshot?.checkouts.find(c=>c.projectId===target.record.projectId&&c.checkoutId===target.record.checkoutId);
  const profile=checkout?.agentProfiles.find(p=>p.profileId===target.record.agentProfileId);
  if(!snapshot||current.inventoryEpoch!==current.epoch||snapshot.inventoryVersion!==current.inventoryVersion||(clean&&snapshot.inventoryVersion!==target.inventoryVersion)||!checkout||checkout.headSha!==target.headSha||!profile||profile.readiness!=='ready'||profile.policyDigest!==target.record.config.policyDigest||profile.capabilityDigest!==target.record.config.capabilityDigest)fail(409,'stale-reference','Lifecycle target inventory or permitted profile changed');
  completeProjection(repo,target);
  if(clean&&(!checkout.clean||!checkout.available||checkout.busy))fail(409,'workspace-conflict','Lifecycle target must remain clean and available');
 };
 const resume=(target:SessionRow,request:Control['SessionResume'])=>{
  resumeProved(repo,target);
  version(target.record.version,request.expectedSessionVersion);held(target,command.authority,request.controller);version(target.record.historyVersion,request.expectedHistoryVersion);
  if(!target.baselineVerified||target.record.workspaceBaseline!==request.expectedWorkspaceBaseline||target.record.activeRunId||target.record.state==='recovery-required'||(target.pending&&target.pending.operationId!==command.operationId))fail(409,'recovery-required','Lifecycle target ownership or workspace changed');
  inventory(target,false);
 };
 const fork=(request:Control['SessionFork'])=>{held(row,command.authority,request.controller);version(row.record.historyVersion,request.expectedHistoryVersion);if(row.record.activeRunId||request.throughHistoryCursor>row.record.historyCursor||request.targetCheckoutId===row.record.checkoutId)fail(409,'stale-reference','Fork source history or target changed');};
 let derived=false;
 if(envelope.kind==='resume-session'){resume(row,envelope.body);return;}
 if(envelope.kind==='fork-session'){fork(envelope.body.request);derived=true;}
 if(envelope.kind==='create-session'){inventory(row,true);return;}
 if(envelope.kind==='invoke-command'){
  const request=envelope.body,args=request.arguments;
  if(!['new','clear','sessions.fork','sessions.resume','sessions.open'].includes(request.commandName))return;
  if(!args||typeof args!=='object'||Array.isArray(args))fail(400,'invalid-arguments','Typed lifecycle target required');
  if(request.commandName==='sessions.open'||request.commandName==='sessions.resume'){
   if(typeof args.sessionId!=='string')fail(400,'invalid-arguments','Typed selected session required');
   const target=session(repo,row.record.projectId,args.sessionId);if(target.record.machineId!==row.record.machineId)fail(403,'scope-denied','Lifecycle target belongs to another machine');
   const {sessionId:_selected,...input}=args;
   if(request.commandName==='sessions.open')version(target.record.version,control('SessionOpen',input).expectedSessionVersion);else resume(target,control('SessionResume',input));
   return;
  }
  if(request.commandName==='sessions.fork')fork(control('SessionFork',{...args,expectedSessionVersion:row.record.version,controller:request.controller}));
  derived=true;
 }
 if(!derived)return;
 const operation=repo.get<import('./model').OperationRecord>('remote_operation',command.operationId);
 const receipt=control('SessionOperationReceipt',operation?.response);
 const child=session(repo,row.record.projectId,receipt.sessionId);
 if(!receipt.session||child.record.machineId!==row.record.machineId||child.record.state!=='opening'||child.record.version!==receipt.session.version||child.record.activeRunId||receipt.status!=='pending'||(envelope.kind==='fork-session'&&envelope.body.newSessionId!==child.record.sessionId))fail(409,'stale-reference','Server selected child changed or was already materialized');
 inventory(child,true);
}
