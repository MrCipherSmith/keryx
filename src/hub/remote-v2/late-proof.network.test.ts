import {afterEach,expect,test} from 'bun:test';
import {fixture,admittedSession,appliedController,success,type Fixture} from './fixture.test-support';
import type {Control} from '../../remote-control/protocol';
let f:Fixture;afterEach(async()=>{if(f)await f.close();});
test('terminal run proof preserves last native session projection and contradictory late proof leaves durable incident without cursor advancement',async()=>{
 f=await fixture();const s=await admittedSession(f);const c=await appliedController(f,s);const turn=await success<Control['TurnReceipt']>(await f.call(`${s.path}/messages`,{method:'POST',cookie:f.cookie,body:{expectedSessionVersion:2,controller:{controllerLeaseId:c.lease.controllerLeaseId,expectedControllerVersion:c.lease.version},expectedConfigVersion:1,text:'Actual observation boundaries',interpretation:'literal-message',busyPolicy:'reject',association:{mode:'ad-hoc',profileConsentVersion:1}}}));await s.peer.next('command');
 const common={runId:turn.runId,turnId:turn.turnId,sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',observedAt:new Date().toISOString()};const nativeIdentity={sessionId:s.session.sessionId,turnId:turn.turnId,daemonId:'daemon-1',supervisorHandleId:'actual-owner'};
 s.peer.send('session-event',{sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',sessionEventSeq:4,observedAt:new Date().toISOString(),kind:'session-state',session:{...s.session,version:3,state:'busy',activeRunId:turn.runId,activeTurnId:turn.turnId,sessionEventCursor:4}});await s.peer.next('session-event-ack');
 for(const [i,state]of ['received','starting','running','succeeded'].entries()){s.peer.send('run-event',{...common,localSeq:i+1,kind:'state',state,reasonCode:'none',...(i>=2?{nativeIdentity}:{})});await s.peer.next('run-event-ack');}
 const session=await success<Control['SessionRecord']>(await f.call(s.path,{cookie:f.cookie}));expect(session.version).toBe(3);expect(session.state).toBe('busy');
 s.peer.send('run-event',{...common,localSeq:5,kind:'state',state:'failed',reasonCode:'native-failure',nativeIdentity});expect((await s.peer.next('error')).payload).toMatchObject({code:'recovery-required'});
 const run=await success<{state:string;lastLocalSeq:number;incident?:string}>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`,{cookie:f.cookie}));expect(run.state).toBe('succeeded');expect(run.lastLocalSeq).toBe(4);expect(run.incident).toBe('incompatible-late-terminal');
});
