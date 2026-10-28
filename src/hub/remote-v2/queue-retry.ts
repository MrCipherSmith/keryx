import {canonicalDigest,type FrameOf} from '../../remote-control/protocol';
import type {RemoteRepository} from './storage';
import type {StoredCommand,QueueRow,SessionRow,RunRow,OperationRecord} from './model';
import {saveSession} from './guards';
const knownRefusals=new Set(['command-expired','machine-offline','stale-reference','unauthorized','forbidden','scope-denied','stale-version','controller-conflict','controller-expired','setup-required','checkout-dirty','machine-busy','workspace-conflict','stale-catalogue','invalid-arguments','unknown-command','ad-hoc-forbidden']);
/** A delivery refusal does not reject the already queued logical operation. */
export function releaseQueuedAttempt(repo:RemoteRepository,command:StoredCommand,frame:FrameOf<'command-receipt'>|FrameOf<'session-command-receipt'>,currentAuthority:boolean):boolean{
 const receipt=frame.payload;
 if(!['not-applied','rejected'].includes(receipt.status)||receipt.errorCode===null||!knownRefusals.has(receipt.errorCode))return false;
 const envelope=command.envelope;
 const runId='target' in envelope?(envelope.target.scope==='run'?envelope.target.runId:undefined):envelope.kind==='start-turn'?envelope.runId:undefined;
 const sessionId='target' in envelope?envelope.target.sessionId:envelope.sessionId;
 if(!runId)return false;
 const row=repo.get<SessionRow>('remote_session',sessionId),run=repo.get<RunRow>('remote_run',runId);
 const queued=repo.all<QueueRow>('remote_queue',{sessionId}).find(q=>q.admissionCommandId===envelope.commandId);
 if(!row||!run||!queued||!['queued','suspended'].includes(queued.item.state)||queued.item.operationId!==command.operationId||queued.machineId!==command.machineId||queued.projectId!==command.projectId||run.commandId!==envelope.commandId||run.nativeIdentity||row.record.activeRunId===runId||repo.hasAdmittedTurn(runId)||!['dispatching','received','starting','rejected','failed'].includes(run.state)||queued.admissionReceipt===undefined)return false;
 const operation=repo.get<OperationRecord>('remote_operation',command.operationId);
 if(!operation||operation.payloadDigest!==queued.payloadDigest)return false;
 // Starting included real preparation/classifier activity. Preserve that fact
 // and its usage; never widen the run graph to starting -> rejected.
 const terminal=run.state==='starting'||run.state==='failed'?'failed':'rejected';
 if(run.state!==terminal){run.state=terminal;run.version++;run.notificationVersion=(run.notificationVersion??0)+1;}
 run.terminalAt??=new Date().toISOString();repo.put('remote_run',runId,run);repo.releaseRunCapacity(runId);
 const status=(operation.response as {status?:string}|undefined)?.status;
 const logicalStillQueued=status==='queued'||status==='admitted';
 if(logicalStillQueued){operation.response=queued.admissionReceipt;operation.status=200;delete operation.deliveryFailure;repo.put('remote_operation',operation.id,operation);}
 const lease=row.record.controller;
 const expectedController='target' in envelope&&envelope.kind==='invoke-command'?envelope.body.controller:'controller' in envelope?envelope.controller:null;
 const retryable=logicalStillQueued&&currentAuthority&&queued.item.state==='queued'&&['command-expired','machine-offline','stale-reference'].includes(receipt.errorCode)
  &&lease?.state==='held'&&lease.actorId===command.authority.actor.id&&lease.controllerLeaseId===queued.controller.controllerLeaseId&&lease.version===queued.controller.expectedControllerVersion&&Date.parse(lease.expiresAt)>Date.now()
  &&row.record.config.configVersion===queued.item.expectedConfigVersion&&row.record.config.policyDigest===command.policyDigest&&canonicalDigest(expectedController)===canonicalDigest(queued.controller);
 if(retryable){delete queued.admissionCommandId;queued.retryAfter=Date.now()+5000;queued.retryAfterSessionCursor=row.record.sessionEventCursor;repo.put('remote_queue',queued.item.queueItemId,queued);}
 // A nonretryable holder/policy/role refusal retains the queue fence until an
 // actual suspended event and an explicit new human reauthorization.
 if(row.pending?.commandId===envelope.commandId){delete row.pending;delete row.pendingController;}
 saveSession(repo,row);return true;
}
