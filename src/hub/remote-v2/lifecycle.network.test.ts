import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, type Fixture } from "./fixture.test-support";
import { catalogueDigest, type Control } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
const entry: Control["CommandCatalogueEntry"] = { commandName: "new", summary: "Open a new native conversation", handlerId: "native.conversation.new", inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "string", maxLength: 32768 }, mutationClass: "session", states: ["idle"], busyPolicy: "reject", confirmation: "none", availability: "available", reason: "actual child identity" };
test("original human new CommandInvoke preallocates child identity and exposes derived receipt without machine human-route mutation", async () => {
  f = await fixture(); const s = await admittedSession(f, [entry]); const c = await appliedController(f, s);
  const receipt = await success<Control["SessionOperationReceipt"]>(await f.call(`${s.path}/commands/invoke`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: s.session.version, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, expectedConfigVersion: 1, catalogueDigest: catalogueDigest([entry]), commandName: "new", arguments: {}, busyPolicy: "reject" } }));
  expect(receipt.kind).toBe("create-session"); expect(receipt.status).toBe("pending"); expect(receipt.sessionId).not.toBe(s.session.sessionId); expect(receipt.operationId).toBeTruthy();
  const delivery = await s.peer.next("session-command"); const command = delivery.payload as { kind: string; commandId: string; target: { sessionId: string } };
  expect(command.kind).toBe("invoke-command"); expect(command.target.sessionId).toBe(s.session.sessionId);
  expect(await success<Control["SessionOperationReceipt"]>(await f.call(`${s.path}/operations/${command.commandId}`, { token: s.machine.secret, origin: null }))).toEqual(receipt);
  const childPath = `/hub/v2/projects/${f.project.id}/sessions/${receipt.sessionId}`; const child = await success<Control["SessionRecord"]>(await f.call(childPath, { token: s.machine.secret, origin: null })); expect(child.sessionId).toBe(receipt.sessionId); expect(child.state).toBe("opening"); expect(child.controller).toBeNull();
  expect((await success<Control["SessionRecord"]>(await f.call(s.path, { cookie: f.cookie }))).sessionId).toBe(s.session.sessionId);
  expect((await f.call(`/hub/v2/projects/${f.project.id}/sessions`, { method: "POST", token: s.machine.secret, origin: null, body: {} })).status).toBe(403);
});
test("direct fork and resume validate history clean target and baseline before allocating or mutating projections", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s); const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  const fork: Control["SessionFork"] = { expectedSessionVersion: s.session.version, controller, throughHistoryCursor: 0, expectedHistoryVersion: s.session.historyVersion, targetCheckoutId: "missing", expectedInventoryVersion: 1, expectedHeadSha: "b".repeat(40), title: "No forged checkout" };
  expect((await f.call(`${s.path}/fork`, { method: "POST", cookie: f.cookie, body: fork })).status).toBe(409);
  expect((await f.call(`${s.path}/fork`, { method: "POST", cookie: f.cookie, body: {...fork,targetCheckoutId:"checkout"} })).status).toBe(409);
  expect((await f.call(`${s.path}/resume`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: s.session.version, controller, expectedHistoryVersion: s.session.historyVersion, expectedWorkspaceBaseline: "c".repeat(64) } })).status).toBe(409);
  expect((await success<Control["SessionPage"]>(await f.call(`/hub/v2/projects/${f.project.id}/sessions`, { cookie: f.cookie }))).sessions).toHaveLength(1);
});

test("sessions.open reader attachment refuses another machine and stale target without allocating work",async()=>{
 const open:Control["CommandCatalogueEntry"]={...entry,commandName:"sessions.open",mutationClass:"read",inputSchema:{type:"object",additionalProperties:false,properties:{sessionId:{type:"string",maxLength:200},expectedSessionVersion:{type:"integer",minimum:1,maximum:Number.MAX_SAFE_INTEGER}},required:["sessionId","expectedSessionVersion"]}};
 f=await fixture();const s=await admittedSession(f,[open]);const c=await appliedController(f,s);const other=await admittedSession(f);
 const request={expectedSessionVersion:2,controller:{controllerLeaseId:c.lease.controllerLeaseId,expectedControllerVersion:c.lease.version},expectedConfigVersion:1,catalogueDigest:catalogueDigest([open]),commandName:"sessions.open",arguments:{sessionId:other.session.sessionId,expectedSessionVersion:1},busyPolicy:"reject"};
 expect((await f.call(`${s.path}/commands/invoke`,{method:"POST",cookie:f.cookie,body:request})).status).toBe(409);
 expect((await f.call(`${s.path}/commands/invoke`,{method:"POST",cookie:f.cookie,body:{...request,arguments:{sessionId:s.session.sessionId,expectedSessionVersion:1}}})).status).toBe(409);
 const accepted=await success<Control["CommandOutcome"]>(await f.call(`${s.path}/commands/invoke`,{method:"POST",cookie:f.cookie,body:{...request,arguments:{sessionId:s.session.sessionId,expectedSessionVersion:2}}}));expect(accepted.runId).toBeNull();expect(accepted.turnId).toBeNull();expect(accepted.status).toBe("queued");
 expect((await success<Control["SessionPage"]>(await f.call(`/hub/v2/projects/${f.project.id}/sessions`,{cookie:f.cookie}))).sessions).toHaveLength(2);
});
