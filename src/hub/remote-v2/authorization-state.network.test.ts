import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, D, type Fixture } from "./fixture.test-support";
import type { FrameOf } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
test("a fresh short grant never reauthorizes an already applied or stale-version session command", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s); const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  await success(await f.call(`${s.path}/config`, { method: "PUT", cookie: f.cookie, body: { expectedSessionVersion: s.session.version, controller, expectedConfigVersion: 1, baselineCandidateId: "local", reasoningEffort: "none", routing: s.session.config.routing, busyPolicy: "reject" } }));
  const command = (await s.peer.next("session-command")).payload as FrameOf<"session-command">["payload"];
  const path = `/hub/v2/machines/${s.machine.machineId}/commands/${command.commandId}/authorize`; const body = { commandDigest: command.commandDigest, policyDigest: D, target: command.target, controller };
  expect((await f.call(path, { method: "POST", token: s.machine.secret, origin: null, body })).status).toBe(200);
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 4, observedAt: new Date().toISOString(), kind: "session-state", session: { ...s.session, version: 3, sessionEventCursor: 4 } }); await s.peer.next("session-event-ack");
  expect([403, 409]).toContain((await f.call(path, { method: "POST", token: s.machine.secret, origin: null, body })).status);
});

test('an admitted work delivery cannot obtain a replacement application grant while its original TTL remains live',async()=>{
 f=await fixture();const s=await admittedSession(f);const c=await appliedController(f,s);const controller={controllerLeaseId:c.lease.controllerLeaseId,expectedControllerVersion:c.lease.version};await success(await f.call(`${s.path}/messages`,{method:'POST',cookie:f.cookie,body:{expectedSessionVersion:2,controller,expectedConfigVersion:1,text:'One work window',interpretation:'literal-message',busyPolicy:'reject',association:{mode:'ad-hoc',profileConsentVersion:1}}}));const command=(await s.peer.next('command')).payload as FrameOf<'command'>['payload'];const target={scope:'run',sessionId:s.session.sessionId,runId:command.runId,turnId:command.turnId,expectedSessionVersion:2,expectedRunVersion:1};const route=`/hub/v2/machines/${s.machine.machineId}/commands/${command.commandId}/authorize`;const request={commandDigest:command.commandDigest,policyDigest:D,target,controller};expect((await f.call(route,{method:'POST',token:s.machine.secret,origin:null,body:request})).status).toBe(200);
 s.peer.send('command-receipt',{commandId:command.commandId,hubSequence:command.hubSequence,runId:command.runId,sessionId:s.session.sessionId,status:'admitted',observedRunVersion:1,errorCode:'none'});s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');expect((await f.call(route,{method:'POST',token:s.machine.secret,origin:null,body:request})).status).toBe(409);
});
