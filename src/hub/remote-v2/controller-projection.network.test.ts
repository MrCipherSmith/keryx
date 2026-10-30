import {afterEach,expect,test} from 'bun:test';
import {fixture,admittedSession,appliedController,type Fixture} from './fixture.test-support';
let f:Fixture;afterEach(async()=>{if(f)await f.close();});
test('a machine session snapshot cannot extend or invent human controller authority',async()=>{
 f=await fixture();const s=await admittedSession(f);const c=await appliedController(f,s);
 const session={...s.session,version:c.sessionVersion+1,sessionEventCursor:4,controller:{...c.lease,expiresAt:new Date(Date.parse(c.lease.expiresAt)+60000).toISOString()}};
 s.peer.send('session-event',{sessionId:session.sessionId,projectId:f.project.id,checkoutId:'checkout',sessionEventSeq:4,observedAt:new Date().toISOString(),kind:'session-state',session});
 s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');expect(s.peer.pendingFrames().some(frame=>frame.type==='error')).toBe(true);expect(s.peer.pendingFrames().some(frame=>frame.type==='session-event-ack')).toBe(false);
});
test('only a causally closed never-run expired lease can publish local cessation release',async()=>{
 f=await fixture();const s=await admittedSession(f);const c=await appliedController(f,s);const lease={...c.lease,expiresAt:new Date(Date.now()-1000).toISOString()};
 const {Database}=await import('bun:sqlite');const {join}=await import('node:path');const db=new Database(join(f.dataDir,'hub.sqlite'));db.query("UPDATE remote_session SET body=json_set(body,'$.record.controller.expiresAt',?) WHERE id=?").run(lease.expiresAt,s.session.sessionId);db.close();
 const released={receiptId:'local-cessation-release',sessionVersion:c.sessionVersion+1,lease:{...lease,version:lease.version+1,state:'released'}};
 const emit=async(seq:number,event:object)=>{s.peer.send('session-event',{sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',sessionEventSeq:seq,observedAt:new Date().toISOString(),...event});s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');};
 await emit(4,{kind:'controller-changed',receipt:released});expect(s.peer.pendingFrames().filter(frame=>frame.type==='error')).toHaveLength(1);
 await emit(4,{kind:'session-state',session:{...s.session,version:c.sessionVersion,controller:lease,state:'closed',sessionEventCursor:4}});await s.peer.next('session-event-ack');
 await emit(5,{kind:'controller-changed',receipt:released});expect(s.peer.pendingFrames().filter(frame=>frame.type==='error')).toHaveLength(1);await s.peer.next('session-event-ack');
 const response=await f.call(`${s.path}/operations/${lease.controllerLeaseId}`,{cookie:f.cookie});expect(response.status).toBe(200);expect(await response.json()).toEqual(released);
});
for(const refusal of ['live-lease','wrong-generation','changed-actor','prior-run','uncertain-command','busy-snapshot'] as const)test(`local cessation refuses ${refusal}`,async()=>{
 f=await fixture();const s=await admittedSession(f);const c=await appliedController(f,s);const lease={...c.lease,expiresAt:new Date(Date.now()+(refusal==='live-lease'?60000:-1000)).toISOString()};
 const {Database}=await import('bun:sqlite');const {join}=await import('node:path');const db=new Database(join(f.dataDir,'hub.sqlite'));db.query("UPDATE remote_session SET body=json_set(body,'$.record.controller.expiresAt',?) WHERE id=?").run(lease.expiresAt,s.session.sessionId);
 if(refusal==='prior-run')db.query('INSERT INTO remote_run(id,projectId,machineId,sessionId,body) VALUES(?,?,?,?,?)').run('prior-run',f.project.id,s.session.machineId,s.session.sessionId,JSON.stringify({state:'unknown'}));
 if(refusal==='uncertain-command')db.query('INSERT INTO remote_command(id,projectId,machineId,sessionId,body) VALUES(?,?,?,?,?)').run('uncertain-work',f.project.id,s.session.machineId,s.session.sessionId,JSON.stringify({status:'unknown'}));db.close();
 const emit=async(seq:number,event:object)=>{s.peer.send('session-event',{sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',sessionEventSeq:seq,observedAt:new Date().toISOString(),...event});s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');};
 await emit(4,{kind:'session-state',session:{...s.session,version:c.sessionVersion,controller:lease,state:refusal==='busy-snapshot'?'busy':'closed',sessionEventCursor:4}});
 const before=s.peer.pendingFrames().filter(frame=>frame.type==='error').length;
 const seq=refusal==='prior-run'?4:5;const released={receiptId:'refused-local-release',sessionVersion:c.sessionVersion+1,lease:{...lease,version:lease.version+(refusal==='wrong-generation'?2:1),actorId:refusal==='changed-actor'?'forged-actor':lease.actorId,state:'released'}};
 await emit(seq,{kind:'controller-changed',receipt:released});expect(s.peer.pendingFrames().filter(frame=>frame.type==='error')).toHaveLength(before+1);expect((await f.call(`${s.path}/operations/${lease.controllerLeaseId}`,{cookie:f.cookie})).status).toBe(404);
});
