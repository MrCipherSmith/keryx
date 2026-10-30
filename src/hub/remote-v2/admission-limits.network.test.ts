import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture, admittedSession, appliedController, success, type Fixture } from "./fixture.test-support";
import type { Control } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
test("1000 unresolved machine commands refuse new admission atomically without losing critical identities", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s); const db = new Database(join(f.dataDir, "hub.sqlite"));
  const insert = db.query("INSERT INTO remote_command(id,projectId,machineId,sessionId,seq,body) VALUES(?,?,?,?,?,?)");
  db.transaction(() => { for (let n = 0; n < 1000; n++) insert.run(`retained-${n}`, f.project.id, s.machine.machineId, s.session.sessionId, 10000 + n, JSON.stringify({ machineId: s.machine.machineId, status: "unknown" })); })(); db.close();
  const response = await f.call(`${s.path}/config`, { method: "PUT", cookie: f.cookie, body: { expectedSessionVersion: s.session.version, expectedConfigVersion: 1, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, baselineCandidateId: "local", reasoningEffort: "none", routing: s.session.config.routing, busyPolicy: "reject" } }); expect(response.status).toBe(413);
  expect((await success<Control["SessionRecord"]>(await f.call(s.path, { cookie: f.cookie }))).version).toBe(s.session.version);
});

test('full ordinary pending capacity preserves an active cancel and its native terminal receipt',async()=>{
 f=await fixture();const s=await admittedSession(f);const c=await appliedController(f,s);const controller={controllerLeaseId:c.lease.controllerLeaseId,expectedControllerVersion:c.lease.version};
 const turn=await success<Control['TurnReceipt']>(await f.call(`${s.path}/messages`,{method:'POST',cookie:f.cookie,body:{expectedSessionVersion:2,controller,expectedConfigVersion:1,text:'active',interpretation:'literal-message',busyPolicy:'reject',association:{mode:'ad-hoc',profileConsentVersion:1}}}));await s.peer.next('command');
 const nativeIdentity={sessionId:s.session.sessionId,turnId:turn.turnId,daemonId:'daemon-1',supervisorHandleId:'owned-handle'};
 for(const [i,state] of ['received','starting','running'].entries()){s.peer.send('run-event',{runId:turn.runId,turnId:turn.turnId,sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',localSeq:i+1,observedAt:new Date().toISOString(),kind:'state',state,reasonCode:'none',...(state==='running'?{nativeIdentity}:{})});await s.peer.next('run-event-ack');}
 const db=new Database(join(f.dataDir,'hub.sqlite'));const insert=db.query('INSERT INTO remote_command(id,machineId,seq,body) VALUES(?,?,?,?)');db.transaction(()=>{for(let i=0;i<1000;i++)insert.run(`full-${i}`,s.machine.machineId,10000+i,JSON.stringify({status:'unknown',machineId:s.machine.machineId}));})();db.close();
 expect((await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}/cancel`,{method:'POST',cookie:f.cookie,body:{expectedRunVersion:4,expectedSessionVersion:2,controller,reason:'Stop current owned run'}})).status).toBe(200);
 const cancel=await s.peer.next('command');expect(cancel.payload).toMatchObject({kind:'cancel-run'});
 for(const [i,state] of ['cancelling','cancelled'].entries()){s.peer.send('run-event',{runId:turn.runId,turnId:turn.turnId,sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',localSeq:i+4,observedAt:new Date().toISOString(),kind:'state',state,reasonCode:'none',nativeIdentity});await s.peer.next('run-event-ack');}
 expect((await success<{state:string}>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`,{cookie:f.cookie}))).state).toBe('cancelled');
 const {openHubStore}=await import('../store');const store=openHubStore(f.dataDir);expect(store.remote.commandUsage('cancel').count).toBe(0);store.close();
});
