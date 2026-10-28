import {canonicalDigest,type Control} from '../../remote-control/protocol';
import type {RemoteRepository} from './storage';
import type {SessionRow,StoredCommand,OperationRecord} from './model';
/** A native state snapshot is not a receipt for whichever delivery is pending. */
export function applicationObserved(repo:RemoteRepository,row:SessionRow,command:StoredCommand|undefined,next:Control['SessionRecord']):boolean{
 if(!command)return false;const envelope=command.envelope;
 if(envelope.kind==='create-session')return next.state!=='opening'&&next.workspaceBaseline!=='0'.repeat(64);
 if(envelope.kind==='claim-controller'||envelope.kind==='release-controller')return !!row.pendingController&&next.version>=row.pendingController.sessionVersion&&canonicalDigest(next.controller)===canonicalDigest(row.pendingController.lease);
 const runId='target' in envelope?envelope.target.scope==='run'?envelope.target.runId:undefined:envelope.kind==='start-turn'?envelope.runId:undefined;
 if(runId){const response=repo.get<OperationRecord>('remote_operation',command.operationId)?.response as {status?:string}|undefined;return next.activeRunId===runId||response?.status==='confirmation-required';}
 const receipt=command.receipt as {status?:string}|undefined;
 return command.domainAccepted===true||command.status==='admitted'||receipt?.status==='applied'||receipt?.status==='admitted';
}
