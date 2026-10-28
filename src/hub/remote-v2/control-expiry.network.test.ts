import {afterEach,expect,test} from 'bun:test';
import {fixture,admittedSession,appliedController,success,type Fixture} from './fixture.test-support';
import type {Control,FrameOf} from '../../remote-control/protocol';
import {openHubStore} from '../store';
import {expirePendingCommands} from './delivery';
let f:Fixture;afterEach(async()=>{if(f)await f.close();});
test('expired received cancellation remains unconfirmed and allows a fresh explicit cancellation without deleting its identity',async()=>{
 f=await fixture();const s=await admittedSession(f);const c=await appliedController(f,s);const controller={controllerLeaseId:c.lease.controllerLeaseId,expectedControllerVersion:c.lease.version};const turn=await success<Control['TurnReceipt']>(await f.call(`${s.path}/messages`,{method:'POST',cookie:f.cookie,body:{expectedSessionVersion:2,controller,expectedConfigVersion:1,text:'Owned uncertain start',interpretation:'literal-message',busyPolicy:'reject',association:{mode:'ad-hoc',profileConsentVersion:1}}}));await s.peer.next('command');
 const path=`/hub/v2/projects/${f.project.id}/runs/${turn.runId}/cancel`;await success(await f.call(path,{method:'POST',cookie:f.cookie,body:{expectedRunVersion:1,expectedSessionVersion:2,controller,reason:'Explicit stop'}}));const cancel=(await s.peer.next('command')).payload as FrameOf<'command'>['payload'];s.peer.send('command-receipt',{commandId:cancel.commandId,hubSequence:cancel.hubSequence,runId:cancel.runId,sessionId:s.session.sessionId,status:'received',observedRunVersion:1,errorCode:'none'});s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');
 const store=openHubStore(f.dataDir);store.writeTransaction((_state,repo)=>expirePendingCommands(repo,Date.parse(cancel.expiresAt)+1));const old=store.remote.get<{status:string}>('remote_command',cancel.commandId);expect(old?.status).toBe('expired-unconfirmed');store.close();
 const current=await success<{version:number;state:string;cancelRequested:boolean}>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`,{cookie:f.cookie}));expect(current.state).not.toBe('cancelled');expect(current.cancelRequested).toBe(true);
 expect((await f.call(path,{method:'POST',cookie:f.cookie,body:{expectedRunVersion:current.version,expectedSessionVersion:2,controller,reason:'Fresh explicit stop'}})).status).toBe(200);const fresh=(await s.peer.next('command')).payload as FrameOf<'command'>['payload'];expect(fresh.commandId).not.toBe(cancel.commandId);
});
