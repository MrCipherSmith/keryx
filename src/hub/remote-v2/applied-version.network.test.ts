import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, success, type Fixture } from "./fixture.test-support";
import type { Control } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });

test("accepted controller and turn operations leave applied session projection unchanged until machine state commits", async () => {
  f = await fixture(); const s = await admittedSession(f);
  const claim = await success<Control["ControllerReceipt"]>(await f.call(`${s.path}/controller/claim`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: 1, expectedControllerVersion: 0, requestedLeaseSeconds: 60, mode: "claim" } }));
  const before = await success<Control["SessionRecord"]>(await f.call(s.path, { cookie: f.cookie }));
  expect(before.version).toBe(1); expect(before.controller).toBeNull();
  const controllerFrame = await s.peer.next("session-command");
  const controller = { controllerLeaseId: claim.lease.controllerLeaseId, expectedControllerVersion: claim.lease.version };
  const message = { expectedSessionVersion: 2, expectedConfigVersion: 1, controller, text: "owned later turn", interpretation: "literal-message", busyPolicy: "reject", association: { mode: "ad-hoc", profileConsentVersion: 1 } };
  expect((await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: message })).status).toBe(409);
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 2, observedAt: new Date().toISOString(), kind: "controller-changed", receipt: claim }); await s.peer.next("session-event-ack");
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 3, observedAt: new Date().toISOString(), kind: "session-state", session: { ...s.session, version: 2, controller: claim.lease, sessionEventCursor: 3 } }); await s.peer.next("session-event-ack");
  const receipt = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, key: "stable-turn", body: message }));
  const command = await s.peer.next("command");
  const envelope = command.payload as { expectedSessionVersion: number; body: { request: Control["StartTurnRequest"] } };
  expect(envelope.expectedSessionVersion).toBe(2); expect(envelope.body.request.expectedSessionVersion).toBe(2);
  expect((await success<Control["SessionRecord"]>(await f.call(s.path, { cookie: f.cookie }))).version).toBe(2);
  expect(await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, key: "stable-turn", body: message }))).toEqual(receipt);
  expect((await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, key: "another-start", body: message })).status).toBe(409);
  expect((controllerFrame.payload as { target: { expectedSessionVersion: number } }).target.expectedSessionVersion).toBe(1);
});

test("owning machine command alias returns only its exact immutable controller receipt and refuses foreign missing ambiguous aliases", async () => {
  f = await fixture(); const s = await admittedSession(f);
  const receipt = await success<Control["ControllerReceipt"]>(await f.call(`${s.path}/controller/claim`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: 1, expectedControllerVersion: 0, requestedLeaseSeconds: 60, mode: "claim" } }));
  const frame = await s.peer.next("session-command"); const command = frame.payload as { commandId: string };
  const alias = `${s.path}/operations/${command.commandId}`;
  expect(await success<Control["ControllerReceipt"]>(await f.call(alias, { token: s.machine.secret, origin: null }))).toEqual(receipt);
  const other = await f.enroll();
  expect((await f.call(alias, { token: other.secret, origin: null })).status).toBe(404);
  expect((await f.call(`${s.path}/operations/missing`, { token: s.machine.secret, origin: null })).status).toBe(404);
  expect((await f.call(alias.replace(s.session.sessionId, "other-session"), { token: s.machine.secret, origin: null })).status).toBe(404);
  const { Database } = await import("bun:sqlite"); const { join } = await import("node:path");
  const db = new Database(join(f.dataDir, "hub.sqlite"));
  db.query("INSERT INTO remote_operation(id,projectId,sessionId,body) VALUES(?,?,?,?)").run(command.commandId, f.project.id, s.session.sessionId, JSON.stringify({ id: command.commandId, projectId: f.project.id, sessionId: s.session.sessionId, kind: "other", response: {}, actorId: "foreign", sessionDigest: "foreign", payloadDigest: "foreign", request: {}, status: 200 })); db.close();
  expect((await f.call(alias, { token: s.machine.secret, origin: null })).status).toBe(409);
});

test('an exact explicit controller rejection clears only its own pending fence and preserves the applied lease',async()=>{
 f=await fixture();const s=await admittedSession(f);const claim={expectedSessionVersion:1,expectedControllerVersion:0,requestedLeaseSeconds:60,mode:'claim'};
 await success(await f.call(`${s.path}/controller/claim`,{method:'POST',cookie:f.cookie,key:'refused-controller',body:claim}));const command=(await s.peer.next('session-command')).payload as {commandId:string;hubSequence:number};
 s.peer.send('session-command-receipt',{commandId:command.commandId,hubSequence:command.hubSequence,sessionId:s.session.sessionId,observedSessionVersion:1,status:'not-applied',receiptId:'explicit-refusal',errorCode:'controller-conflict'});s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');
 const actual=await success<Control['SessionRecord']>(await f.call(s.path,{cookie:f.cookie}));expect(actual.version).toBe(1);expect(actual.controller).toBeNull();
 expect((await f.call(`${s.path}/controller/claim`,{method:'POST',cookie:f.cookie,key:'fresh-controller-after-refusal',body:claim})).status).toBe(200);
});
