import {validateControl,type Control} from '../../remote-control/protocol';
import {fail} from '../domain';
import type {RemoteRepository} from './storage';
import type {SessionRow,StoredCommand,OperationRecord} from './model';
/** A close intent stays distinct from an ordinary CAS delivery or its projection. */
export function observeClosureReceipt(repo:RemoteRepository,row:SessionRow,operation:OperationRecord,receipt:Control['SessionOperationReceipt']):boolean{
 if(row.pendingClosure?.operationId!==operation.id)return false;
 const command=repo.get<StoredCommand>('remote_command',row.pendingClosure.commandId);
 if(!command||command.envelope.kind!=='close-session'||command.operationId!==operation.id||command.projectId!==row.record.projectId||command.machineId!==row.record.machineId||command.envelope.target.sessionId!==row.record.sessionId||receipt.kind!=='close-session'||receipt.sessionId!==row.record.sessionId)fail(409,'stale-reference','Close receipt differs from exact pending closure');
 if(receipt.session&&(receipt.session.machineId!==row.record.machineId||receipt.session.projectId!==row.record.projectId||receipt.session.checkoutId!==row.record.checkoutId||receipt.session.sessionId!==row.record.sessionId||receipt.session.agentProfileId!==row.record.agentProfileId))fail(403,'scope-denied','Close snapshot ownership differs');
 const normalized={...receipt,operationId:operation.id};row.pendingClosure.receipt=normalized;
 if(receipt.status==='pending'||receipt.status==='recovery-required'||receipt.status==='rejected'){
  operation.response=normalized;operation.status=200;delete operation.deliveryFailure;repo.put('remote_operation',operation.id,operation);
  if(receipt.status==='rejected'){delete row.pendingClosure;row.closing=false;}
 }
 command.domainAccepted=receipt.status!=='rejected';command.status=receipt.status==='recovery-required'?'unknown':receipt.status==='rejected'?'rejected':'admitted';if(receipt.status==='rejected')command.capacityReleased=true;repo.put('remote_command',command.envelope.commandId,command);
 return true;
}
export function settleClosure(repo:RemoteRepository,row:SessionRow):void{
 const pending=row.pendingClosure;
 if(pending&&row.record.state==='closed'){
  const parsed=validateControl('SessionOperationReceipt',pending.receipt);
  if(parsed.ok&&parsed.value.kind==='close-session'&&parsed.value.status==='applied'&&parsed.value.sessionId===row.record.sessionId&&parsed.value.observedSessionVersion<=row.record.version&&repo.unresolvedSessionRuns(row.record.sessionId)===0){
   const command=repo.get<StoredCommand>('remote_command',pending.commandId),operation=repo.get<OperationRecord>('remote_operation',pending.operationId);
   if(!command||command.envelope.kind!=='close-session'||!operation||command.operationId!==operation.id)fail(409,'recovery-required','Pending close identity missing');
   operation.response={...parsed.value,operationId:operation.id};operation.status=200;delete operation.deliveryFailure;repo.put('remote_operation',operation.id,operation);command.status='applied';command.capacityReleased=true;repo.put('remote_command',pending.commandId,command);row.lastCloseOperationId=operation.id;delete row.pendingClosure;
  }
 }
 if(row.resumingOperationId&&row.record.state==='idle'){
  const operation=repo.get<OperationRecord>('remote_operation',row.resumingOperationId);const receipt=validateControl('SessionOperationReceipt',operation?.response);
  if(receipt.ok&&receipt.value.kind==='resume-session'&&receipt.value.status==='applied'&&receipt.value.sessionId===row.record.sessionId&&receipt.value.observedSessionVersion<=row.record.version){row.closing=false;delete row.resumingOperationId;}
 }
}
export function resumeProved(repo:RemoteRepository,row:SessionRow):void{
 if(row.record.state==='closed'&&(!row.closedProof||row.pendingClosure||repo.unresolvedSessionRuns(row.record.sessionId)>0))fail(409,'recovery-required','Closed conversation needs actual prior cessation and current native reconciliation');
}
