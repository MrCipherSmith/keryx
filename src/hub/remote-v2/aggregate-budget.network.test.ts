import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {fixture,admittedSession,type Fixture} from './fixture.test-support';
import type {Projection} from './model';
let f:Fixture;afterEach(async()=>{if(f)await f.close();});
test('aggregate staging quota spans authenticated machines and completed projections release staging transactionally',async()=>{
 f=await fixture({remoteBudgets:{stagingBytes:2000}});const sessions:Awaited<ReturnType<typeof admittedSession>>[]=[];for(let i=0;i<3;i++)sessions.push(await admittedSession(f));
 const db=new Database(join(f.dataDir,'hub.sqlite'));const pages=sessions.map(s=>{const p=JSON.parse(db.query<{body:string},[string]>('SELECT body FROM remote_projection WHERE machineId=?').get(s.machine.machineId)!.body) as Projection;return {projectId:p.projectId,checkoutId:p.checkoutId,agentProfileId:p.agentProfileId,projectionVersion:2,inventoryVersion:p.inventoryVersion,policyDigest:p.policyDigest,capabilityDigest:p.capabilityDigest,catalogueVersion:p.catalogueVersion,catalogueDigest:p.catalogueDigest,cursor:0,nextCursor:2,kind:'routing',totalEntries:3,entries:p.candidates,profileIds:p.profileIds};});
 for(let i=0;i<2;i++){sessions[i]!.peer.send('capability-page',pages[i]);sessions[i]!.peer.send('heartbeat',{daemonId:'daemon-1'});await sessions[i]!.peer.next('heartbeat-ack');}
 const before=db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM remote_capability_page').get()!.n;
 sessions[2]!.peer.send('capability-page',pages[2]);expect((await sessions[2]!.peer.next('error')).payload).toMatchObject({code:'quota-exceeded'});expect(db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM remote_capability_page').get()!.n).toBe(before);
 const page={...pages[0]!,projectionVersion:3,totalEntries:2,nextCursor:null};sessions[0]!.peer.send('capability-page',{...page,kind:'catalogue',totalEntries:0,entries:[],nextCursor:null,profileIds:undefined});sessions[0]!.peer.send('capability-page',page);sessions[0]!.peer.send('heartbeat',{daemonId:'daemon-1'});await sessions[0]!.peer.next('heartbeat-ack');
 sessions[2]!.peer.send('capability-page',pages[2]);sessions[2]!.peer.send('heartbeat',{daemonId:'daemon-1'});await sessions[2]!.peer.next('heartbeat-ack');
 const rows=db.query<{machineId:string},[]>('SELECT machineId FROM remote_capability_page').all();expect(rows.some(r=>r.machineId===sessions[0]!.machine.machineId)).toBe(false);expect(rows.some(r=>r.machineId===sessions[2]!.machine.machineId)).toBe(true);db.close();
});

test('ordinary byte admission is aggregate across machines and exact applied receipts release capacity without deleting identity',async()=>{
 const {appliedController,success}=await import('./fixture.test-support');f=await fixture({remoteBudgets:{pendingBytes:3000}});const sessions:Awaited<ReturnType<typeof admittedSession>>[]=[];const controllers:import('../../remote-control/protocol').Control['ControllerReceipt'][]=[];
 for(let i=0;i<3;i++){const s=await admittedSession(f);sessions.push(s);controllers.push(await appliedController(f,s));}
 const body=(i:number)=>({expectedSessionVersion:2,controller:{controllerLeaseId:controllers[i]!.lease.controllerLeaseId,expectedControllerVersion:controllers[i]!.lease.version},expectedConfigVersion:1,baselineCandidateId:'local',reasoningEffort:'none',routing:sessions[i]!.session.config.routing,busyPolicy:'reject'});
 const receipts=[];for(let i=0;i<2;i++){receipts.push(await success<import('../../remote-control/protocol').Control['ConfigReceipt']>(await f.call(`${sessions[i]!.path}/config`,{method:'PUT',cookie:f.cookie,body:body(i)})));await sessions[i]!.peer.next('session-command');}
 const refused=await f.call(`${sessions[2]!.path}/config`,{method:'PUT',cookie:f.cookie,key:'after-capacity',body:body(2)});expect(refused.status).toBe(413);
 const s=sessions[0]!;s.peer.send('session-event',{sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',sessionEventSeq:4,observedAt:new Date().toISOString(),kind:'config-receipt',receipt:{...receipts[0],status:'applied',sessionVersion:3,configVersion:2,effectiveFromTurnOrdinal:1}});await s.peer.next('session-event-ack');s.peer.send('session-event',{sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',sessionEventSeq:5,observedAt:new Date().toISOString(),kind:'session-state',session:{...s.session,version:3,config:{...s.session.config,configVersion:2},sessionEventCursor:5}});await s.peer.next('session-event-ack');
 expect((await f.call(`${sessions[2]!.path}/config`,{method:'PUT',cookie:f.cookie,key:'after-capacity',body:body(2)})).status).toBe(200);
 const db=new Database(join(f.dataDir,'hub.sqlite'));expect(db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM remote_command').get()!.n).toBeGreaterThanOrEqual(9);db.close();
});
