import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, type Fixture } from "./fixture.test-support";
import { catalogueDigest, type Control } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
const catalogue: Control["CommandCatalogueEntry"][] = [{ commandName: "interrupt", summary: "Stop only the current owned turn", handlerId: "native.interrupt", inputSchema: { type: "object", additionalProperties: false, properties: { runId: { type: "string", maxLength: 200 }, turnId: { type: "string", maxLength: 200 } }, required: ["runId", "turnId"] }, resultSchema: { type: "string", maxLength: 32768 }, mutationClass: "session", states: ["idle", "busy", "paused"], busyPolicy: "reject", confirmation: "none", availability: "available", reason: "actual owned supervisor required" }];
test("D7 existing-turn control binds exact active run and never allocates new work", async () => {
  f = await fixture(); const s = await admittedSession(f, catalogue); const c = await appliedController(f, s); const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  const run = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: s.session.version, controller, expectedConfigVersion: 1, text: "owned active turn", interpretation: "literal-message", association: { mode: "ad-hoc", profileConsentVersion: 1 }, busyPolicy: "reject" } })); await s.peer.next("command");
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 4, observedAt: new Date().toISOString(), kind: "session-state", session: { ...s.session, version: 3, state: "busy", activeRunId: run.runId, activeTurnId: run.turnId, sessionEventCursor: 4 } }); await s.peer.next("session-event-ack");
  const request: Control["CommandInvoke"] = { expectedSessionVersion: 3, controller, expectedConfigVersion: 1, catalogueDigest: catalogueDigest(catalogue), commandName: "interrupt", arguments: { runId: "foreign", turnId: run.turnId! }, busyPolicy: "reject" };
  expect((await f.call(`${s.path}/commands/invoke`, { method: "POST", cookie: f.cookie, body: request })).status).toBe(409);
  const receipt = await success<Control["CommandOutcome"]>(await f.call(`${s.path}/commands/invoke`, { method: "POST", cookie: f.cookie, body: { ...request, arguments: { runId: run.runId, turnId: run.turnId } } })); expect(receipt.runId).toBeNull(); expect(receipt.turnId).toBeNull();
  const after = await success<{ runs: unknown[] }>(await f.call(`/hub/v2/projects/${f.project.id}/runs`, { cookie: f.cookie })); expect(after.runs).toHaveLength(1);
});
