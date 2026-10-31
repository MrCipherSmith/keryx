import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, D, type Fixture } from "./fixture.test-support";
import type { Control, FrameOf } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
test("authoritative run projection keeps recorded delivered and native-applied approval states distinct across reload", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s); const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  const turn = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: 2, controller, expectedConfigVersion: 1, text: "approval", interpretation: "literal-message", association: { mode: "ad-hoc", profileConsentVersion: 1 }, busyPolicy: "reject" } })); await s.peer.next("command");
  const common = { runId: turn.runId, projectId: f.project.id, checkoutId: "checkout", sessionId: s.session.sessionId, turnId: turn.turnId, observedAt: new Date().toISOString() };
  for (const [index, state] of ["received", "starting", "running"].entries()) { s.peer.send("run-event", { ...common, localSeq: index + 1, kind: "state", state, reasonCode: "none", ...(state === "running" ? { nativeIdentity: { sessionId: s.session.sessionId, turnId: turn.turnId, daemonId: "daemon-1", supervisorHandleId: "supervisor" } } : {}) }); await s.peer.next("run-event-ack"); }
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 4, observedAt: new Date().toISOString(), kind: "session-state", session: { ...s.session, version: 3, state: "busy", activeRunId: turn.runId, activeTurnId: turn.turnId, sessionEventCursor: 4 } }); await s.peer.next("session-event-ack");
  s.peer.send("run-event", { ...common, localSeq: 4, kind: "approval-request", approvalId: "exact-question", actionFingerprint: D, policyDigest: D, expiresAt: new Date(Date.now() + 300000).toISOString(), summary: "Exact owned action", localRequired: false }); await s.peer.next("run-event-ack");
  const runPath = `/hub/v2/projects/${f.project.id}/runs/${turn.runId}`; const current = await success<{ version: number }>(await f.call(runPath, { cookie: f.cookie }));
  const answer = { expectedRunVersion: current.version, expectedSessionVersion: 3, controller, actionFingerprint: D, policyDigest: D, decision: "allow-once" };
  await success(await f.call(`${runPath}/approvals/exact-question/answer`, { method: "POST", cookie: f.cookie, body: answer }));
  const first = await success<{ approvals: { status: string }[] }>(await f.call(runPath, { cookie: f.cookie })); expect(first.approvals[0]!.status).toBe("recorded");
  expect((await f.call(`${runPath}/approvals/exact-question/answer`, { method: "POST", cookie: f.cookie, body: { ...answer, decision: "deny" } })).status).toBe(409);
  const delivery = await s.peer.next("command"); const command = delivery.payload as FrameOf<"command">["payload"];
  s.peer.send("command-receipt", { commandId: command.commandId, hubSequence: command.hubSequence, sessionId: s.session.sessionId, runId: turn.runId, observedRunVersion: current.version, status: "received", errorCode: "none" }); s.peer.send("heartbeat", { daemonId: "daemon-1" }); await s.peer.next("heartbeat-ack");
  expect((await success<{ approvals: { status: string }[] }>(await f.call(runPath, { cookie: f.cookie }))).approvals[0]!.status).toBe("delivered");
  s.peer.send("run-event", { ...common, localSeq: 5, kind: "approval-outcome", approvalId: "exact-question", decision: "allow-once", application: "applied" }); await s.peer.next("run-event-ack");
  expect((await success<{ approvals: { status: string }[] }>(await f.call(runPath, { cookie: f.cookie }))).approvals[0]!.status).toBe("applied");
});
