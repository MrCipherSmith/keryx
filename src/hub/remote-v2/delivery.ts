import {commandRunId,saveSession} from './guards';
import type {RemoteRepository} from "./storage";
import type {OperationRecord,RunRow,SessionRow,StoredCommand} from "./model";
/** Start expiry never asserts that an unobserved local process stopped. */
export function expirePendingCommands(repo:RemoteRepository,now=Date.now()):{projectId:string;sessionId:string;runId?:string}[] {
 const changes:{projectId:string;sessionId:string;runId?:string}[]=[];
 for(const command of repo.expiringCommands<StoredCommand>(now)) {
  if(!['pending','received','admitted'].includes(command.status)||command.capacityReleased)continue;
  // A when-idle close the machine admitted waits for the current turn's boundary: its outcome is the machine's boundary receipt, never the delivery TTL.
  if(command.envelope.kind==='close-session'&&command.status==='admitted'&&command.domainAccepted===true)continue;
  const control=command.capacity==='cancel'||command.capacity==='denial'||command.envelope.kind==='cancel-run';
  if((command.status!=='pending'&&!control)||Date.parse(command.envelope.expiresAt)>now)continue;
  const uncertain=command.deliveredAt!==undefined;
  command.status=control?'expired-unconfirmed':uncertain?"unknown":"not-applied";if(control)command.capacityReleased=true;
  repo.put("remote_command",command.envelope.commandId,command);
  const operation=repo.get<OperationRecord>("remote_operation",command.operationId);
  if(operation){operation.status=409;operation.deliveryFailure={error:{code:control?"command-expired":uncertain?"recovery-required":"command-expired",message:control?"Control delivery expired; application and cessation remain unconfirmed":uncertain?"Delivered operation has no native admission proof; reconcile local ownership":"Operation expired before delivery"}};repo.put("remote_operation",operation.id,operation);}
  const envelope=command.envelope,sessionId="target" in envelope?envelope.target.sessionId:envelope.sessionId;
  const row=repo.get<SessionRow>("remote_session",sessionId);
  if(row&&control&&!uncertain&&row.pendingClosure?.commandId===envelope.commandId){delete row.pendingClosure;row.closing=false;}
  if(row){if(row.pending?.commandId===envelope.commandId){if(uncertain&&!control)row.baselineVerified=false;else{delete row.pending;delete row.pendingController;}}saveSession(repo,row);}
  const runId=commandRunId(envelope);
  changes.push({projectId:command.projectId,sessionId,...(runId?{runId}:{})});
  const run=runId&&repo.get<RunRow>("remote_run",runId);
  if(run&&run.commandId===envelope.commandId&&run.state==="dispatching"){run.state=uncertain?"unknown":"rejected";run.version++;run.notificationVersion=(run.notificationVersion??0)+1;run.observedAt=new Date(now).toISOString();if(!uncertain)run.terminalAt=run.observedAt;repo.put("remote_run",run.runId,run);}
 }
 return changes;
}
