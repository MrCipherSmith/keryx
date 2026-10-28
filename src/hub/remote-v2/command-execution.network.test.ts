import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, type Fixture } from "./fixture.test-support";
import { catalogueDigest, type Control, type FrameOf } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
const catalogue: Control["CommandCatalogueEntry"][] = [{ commandName: "ci.triage", summary: "Actual admitted analysis operation", handlerId: "native.ci.triage", inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, mutationClass: "workspace", states: ["idle"], busyPolicy: "reject", confirmation: "human", availability: "available", reason: "" }];
test("executing CommandInvoke atomically preallocates a run target and preserves original association without speculatively starting runtime", async () => {
  f = await fixture(); const s = await admittedSession(f, catalogue); const c = await appliedController(f, s);
  const request: Control["CommandInvoke"] = { expectedSessionVersion: s.session.version, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, expectedConfigVersion: 1, catalogueDigest: catalogueDigest(catalogue), commandName: "ci.triage", arguments: {}, busyPolicy: "reject", association: { mode: "ad-hoc", profileConsentVersion: 1 } };
  const response = await success<Control["CommandOutcome"]>(await f.call(`${s.path}/commands/invoke`, { method: "POST", cookie: f.cookie, key: "execution-command", body: request }));
  expect(response.status).toBe("queued"); expect(response.runId).not.toBeNull(); expect(response.turnId).not.toBeNull(); expect(response.confirmation).toBeNull();
  const delivery = await s.peer.next("session-command"); const envelope = delivery.payload as FrameOf<"session-command">["payload"];
  expect(envelope.kind).toBe("invoke-command"); expect(envelope.target.scope).toBe("run");
  if (envelope.target.scope !== "run") throw new Error("expected execution target");
  expect(envelope.target.runId).toBe(response.runId!); expect(envelope.target.turnId).toBe(response.turnId!); expect(envelope.target.expectedSessionVersion).toBe(s.session.version);
  const run = await success<{ state: string; association: Control["FlowAssociation"] }>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${response.runId}`, { cookie: f.cookie })); expect(run.state).toBe("dispatching"); expect(run.association).toEqual(request.association!);
  expect((await success<Control["SessionRecord"]>(await f.call(s.path, { cookie: f.cookie }))).version).toBe(s.session.version);
  expect(await success<Control["CommandOutcome"]>(await f.call(`${s.path}/commands/invoke`, { method: "POST", cookie: f.cookie, key: "execution-command", body: request }))).toEqual(response);
});

test("queue-at-idle workspace command has no execution IDs until fresh FIFO idle admission", async () => {
  const entries: Control["CommandCatalogueEntry"][] = [{ ...catalogue[0]!, states: ["idle"], busyPolicy: "queue-at-idle" }];
  f = await fixture(); const s = await admittedSession(f, entries); const c = await appliedController(f, s); const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  const first = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method:"POST", cookie:f.cookie, body:{expectedSessionVersion:2,controller,expectedConfigVersion:1,text:"first",interpretation:"literal-message",busyPolicy:"reject",association:{mode:"ad-hoc",profileConsentVersion:1}} })); await s.peer.next("command");
  const emit = async (seq: number, event: object) => { s.peer.send("session-event", { sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:"checkout",sessionEventSeq:seq,observedAt:new Date().toISOString(),...event }); await s.peer.next("session-event-ack"); };
  await emit(4,{kind:"session-state",session:{...s.session,version:3,state:"busy",activeRunId:first.runId,activeTurnId:first.turnId,sessionEventCursor:4}});
  const request: Control["CommandInvoke"] = {expectedSessionVersion:3,controller,expectedConfigVersion:1,catalogueDigest:catalogueDigest(entries),commandName:"ci.triage",arguments:{},busyPolicy:"queue-at-idle",association:{mode:"ad-hoc",profileConsentVersion:1}};
  const queued = await success<Control["CommandOutcome"]>(await f.call(`${s.path}/commands/invoke`,{method:"POST",cookie:f.cookie,body:request})); expect(queued.runId).toBeNull(); expect(queued.turnId).toBeNull();
  const initial = (await s.peer.next("session-command")).payload as FrameOf<"session-command">["payload"]; expect(initial.target.scope).toBe("session");
  await emit(5,{kind:"queue-changed",queueVersion:1,item:{queueItemId:"native-command-q",operationId:queued.operationId,version:1,kind:"command",state:"queued",position:0,text:null,commandName:"ci.triage",expectedConfigVersion:1,replacesOperationId:null}});
  await emit(6,{kind:"session-state",session:{...s.session,version:4,state:"busy",activeRunId:first.runId,activeTurnId:first.turnId,queueVersion:1,sessionEventCursor:6}});
  await emit(7,{kind:"session-state",session:{...s.session,version:5,queueVersion:1,sessionEventCursor:7}});
  const admitted = (await s.peer.next("session-command")).payload as FrameOf<"session-command">["payload"]; expect(admitted.target.scope).toBe("run"); expect(admitted.target.expectedSessionVersion).toBe(5); expect(admitted.commandId).not.toBe(initial.commandId);
  const operation = await success<Control["CommandOutcome"]>(await f.call(`${s.path}/operations/${queued.operationId}`,{cookie:f.cookie})); expect(operation.runId).not.toBeNull(); expect(operation.turnId).not.toBeNull();
  await emit(8,{kind:"session-state",session:{...s.session,version:5,queueVersion:1,sessionEventCursor:8}});
  expect((await success<Control["CommandOutcome"]>(await f.call(`${s.path}/operations/${queued.operationId}`,{cookie:f.cookie}))).runId).toBe(operation.runId);
});
