import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, type Fixture } from "./fixture.test-support";
import type { Control } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
test("same-controller native queue admission automatically gets a new idle-boundary command without inventing queued run IDs", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s);
  const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  const request: Control["MessageSubmit"] = { expectedSessionVersion: 2, expectedConfigVersion: 1, controller, text: "first", interpretation: "literal-message", busyPolicy: "reject", association: { mode: "ad-hoc", profileConsentVersion: 1 } };
  const first = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: request })); await s.peer.next("command");
  const emit = async (seq: number, event: object) => { s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: seq, observedAt: new Date().toISOString(), ...event }); await s.peer.next("session-event-ack"); };
  await emit(4, { kind: "session-state", session: { ...s.session, version: 3, state: "busy", activeRunId: first.runId, activeTurnId: first.turnId, nextTurnOrdinal: 2, sessionEventCursor: 4 } });
  const queued = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { ...request, expectedSessionVersion: 3, text: "later literal message", busyPolicy: "enqueue" } }));
  expect(queued.status).toBe("queued"); expect(queued.runId).toBeNull(); expect(queued.turnId).toBeNull(); expect(queued.queueItemId).toBeNull();
  const queueCommand = await s.peer.next("session-command"); expect((queueCommand.payload as { kind: string }).kind).toBe("submit-message");
  const item: Control["QueueItem"] = { queueItemId: "actual-native-q", version: 1, kind: "message", operationId: queued.operationId, state: "queued", position: 0, text: "later literal message", commandName: null, expectedConfigVersion: 1, replacesOperationId: null };
  await emit(5, { kind: "queue-changed", queueVersion: 1, item });
  await emit(6, { kind: "session-state", session: { ...s.session, version: 4, state: "busy", activeRunId: first.runId, activeTurnId: first.turnId, nextTurnOrdinal: 2, queueVersion: 1, sessionEventCursor: 6 } });
  await emit(7, { kind: "session-state", session: { ...s.session, version: 5, state: "idle", activeRunId: null, activeTurnId: null, nextTurnOrdinal: 2, queueVersion: 1, sessionEventCursor: 7 } });
  const delivery = await s.peer.next("command"); const command = delivery.payload as { commandId:string; runId: string; turnId: string; hubSequence: number; expectedSessionVersion: number; body: { request: Control["StartTurnRequest"] } };
  expect(command.runId).not.toBe(first.runId); expect(command.turnId).not.toBe(first.turnId); expect(command.expectedSessionVersion).toBe(5); expect(command.body.request.messageId).toBe(queued.operationId); expect(command.body.request.text).toBe("later literal message");
  expect((await success<Control["SessionRecord"]>(await f.call(s.path, { cookie: f.cookie }))).version).toBe(5);
  await emit(8, { kind: "session-state", session: { ...s.session, version: 5, state: "idle", activeRunId: null, activeTurnId: null, nextTurnOrdinal: 2, queueVersion: 1, sessionEventCursor: 8 } });
  expect((await success<Control["RecoveryPage"]>(await f.call(`/hub/v2/machines/${s.machine.machineId}/recovery`, { token: s.machine.secret, origin: null }))).hubSequence).toBe(command.hubSequence);
  for(const [i,state] of ['received','starting'].entries()){s.peer.send('run-event',{runId:command.runId,turnId:command.turnId,sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',localSeq:i+1,observedAt:new Date().toISOString(),kind:'state',state,reasonCode:'none'});await s.peer.next('run-event-ack');}
  s.peer.send('command-receipt',{commandId:command.commandId,hubSequence:command.hubSequence,runId:command.runId,sessionId:s.session.sessionId,observedRunVersion:3,status:'not-applied',errorCode:'command-expired'});
  s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');
  const restored=await success<Control['TurnReceipt']>(await f.call(`${s.path}/operations/${queued.operationId}`,{cookie:f.cookie}));expect(restored.status).toBe('queued');expect(restored.runId).toBeNull();const attempt=await success<{state:string;lastLocalSeq:number}>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${command.runId}`,{cookie:f.cookie}));expect(attempt.state).toBe('failed');expect(attempt.lastLocalSeq).toBe(2);
  const {Database}=await import('bun:sqlite');const {join}=await import('node:path');const db=new Database(join(f.dataDir,'hub.sqlite'));const stored=JSON.parse(db.query<{body:string},[string]>('SELECT body FROM remote_queue WHERE id=?').get(item.queueItemId)!.body);expect(stored.admissionCommandId).toBeUndefined();expect(stored.retryAfter).toBeGreaterThan(Date.now());
  await emit(9,{kind:'session-state',session:{...s.session,version:5,queueVersion:1,sessionEventCursor:9}});
  expect((await success<Control['RecoveryPage']>(await f.call(`/hub/v2/machines/${s.machine.machineId}/recovery`,{token:s.machine.secret,origin:null}))).hubSequence).toBe(command.hubSequence);
  const retry=JSON.parse(db.query<{body:string},[string]>('SELECT body FROM remote_queue WHERE id=?').get(item.queueItemId)!.body);retry.retryAfter=Date.now()-1;db.query('UPDATE remote_queue SET body=? WHERE id=?').run(JSON.stringify(retry),item.queueItemId);db.close();
  await emit(10,{kind:'session-state',session:{...s.session,version:5,queueVersion:1,sessionEventCursor:10}});
  const fresh=(await s.peer.next('command')).payload as {commandId:string;runId:string;hubSequence:number;body:{request:{messageId:string}}};expect(fresh.commandId).not.toBe(command.commandId);expect(fresh.runId).not.toBe(command.runId);expect(fresh.body.request.messageId).toBe(queued.operationId);
  s.peer.send('command-receipt',{commandId:fresh.commandId,hubSequence:fresh.hubSequence,runId:fresh.runId,sessionId:s.session.sessionId,observedRunVersion:1,status:'not-applied',errorCode:'recovery-required'});s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');
  const retained=new Database(join(f.dataDir,'hub.sqlite'));const pending=JSON.parse(retained.query<{body:string},[string]>('SELECT body FROM remote_session WHERE id=?').get(s.session.sessionId)!.body);expect(pending.pending.commandId).toBe(fresh.commandId);retained.close();


});

test("idle admission refusal preserves the observed native queue until an actual suspension event", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s);
  const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  const request: Control["MessageSubmit"] = { expectedSessionVersion: 2, expectedConfigVersion: 1, controller, text: "first", interpretation: "literal-message", busyPolicy: "reject", association: { mode: "ad-hoc", profileConsentVersion: 1 } };
  const first = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: request })); await s.peer.next("command");
  const emit = async (seq: number, event: object) => { s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: seq, observedAt: new Date().toISOString(), ...event }); await s.peer.next("session-event-ack"); };
  await emit(4, { kind: "session-state", session: { ...s.session, version: 3, state: "busy", activeRunId: first.runId, activeTurnId: first.turnId, nextTurnOrdinal: 2, sessionEventCursor: 4 } });
  const queued = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { ...request, expectedSessionVersion: 3, text: "later literal message", busyPolicy: "enqueue" } }));
  expect(queued.status).toBe("queued"); expect(queued.runId).toBeNull(); expect(queued.turnId).toBeNull(); expect(queued.queueItemId).toBeNull();
  const queueCommand = await s.peer.next("session-command"); expect((queueCommand.payload as { kind: string }).kind).toBe("submit-message");
  const item: Control["QueueItem"] = { queueItemId: "actual-native-q", version: 1, kind: "message", operationId: queued.operationId, state: "queued", position: 0, text: "later literal message", commandName: null, expectedConfigVersion: 1, replacesOperationId: null };
  await emit(5, { kind: "queue-changed", queueVersion: 1, item });
  await emit(6, { kind: "session-state", session: { ...s.session, version: 4, state: "busy", activeRunId: first.runId, activeTurnId: first.turnId, nextTurnOrdinal: 2, queueVersion: 1, sessionEventCursor: 6 } });
  await emit(7, { kind: "session-state", session: { ...s.session, version: 5, state: "idle", activeRunId: null, activeTurnId: null, nextTurnOrdinal: 2, queueVersion: 1, config:{...s.session.config,configVersion:2}, sessionEventCursor: 7 } });
  const observed=await success<Control['QueuePage']>(await f.call(`${s.path}/queue`,{cookie:f.cookie}));expect(observed.queueVersion).toBe(1);expect(observed.items[0]).toMatchObject({queueItemId:item.queueItemId,state:'queued',version:1});
  const receipt=await success<Control['TurnReceipt']>(await f.call(`${s.path}/operations/${queued.operationId}`,{cookie:f.cookie}));expect(receipt.status).toBe('queued');expect(receipt.runId).toBeNull();
});
