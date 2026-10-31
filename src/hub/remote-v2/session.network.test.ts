import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, D, type Fixture } from "./fixture.test-support";
import { canonicalDigest } from "../../remote-control/protocol";
import type { Control } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });

test("controller CAS lease does not grant observers or stale generations mutation authority", async () => {
  f = await fixture(); const s = await admittedSession(f);
  const claim = { expectedSessionVersion: 1, expectedControllerVersion: 0, requestedLeaseSeconds: 60, mode: "claim" };
  const key = "claim-one";
  const receipt = await appliedController(f, s, key);
  expect(await success<Control["ControllerReceipt"]>(await f.call(`${s.path}/controller/claim`, { method: "POST", cookie: f.cookie, key, body: claim }))).toEqual(receipt);
  expect(receipt.lease.actorKind).toBe("human-operator");
  expect(Date.parse(receipt.lease.expiresAt) - Date.now()).toBeLessThanOrEqual(60000);
  expect((await f.call(`${s.path}/controller/claim`, { method: "POST", cookie: f.cookie, body: claim })).status).toBe(409);
  expect((await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: receipt.sessionVersion, expectedConfigVersion: 1, controller: { controllerLeaseId: receipt.lease.controllerLeaseId, expectedControllerVersion: receipt.lease.version + 1 }, text: "must not run", interpretation: "literal-message", busyPolicy: "enqueue", association: { mode: "ad-hoc", profileConsentVersion: 1 } } })).status).toBe(409);
});

test("cost privacy config confirmation binds original operation and cannot apply a changed digest", async () => {
  f = await fixture(); const s = await admittedSession(f);
  const c = await appliedController(f, s);
  const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  const request = { expectedSessionVersion: c.sessionVersion, controller, expectedConfigVersion: 1, baselineCandidateId: "metered", reasoningEffort: "high", routing: { enabled: false, profileId: "default", candidateIds: ["metered"], fallbackCandidateId: "metered" }, busyPolicy: "reject" };
  let receipt = await success<Control["ConfigReceipt"]>(await f.call(`${s.path}/config`, { method: "PUT", cookie: f.cookie, body: request }));
  expect(receipt.status).toBe("queued"); expect(receipt.confirmation).toBeNull();
  await s.peer.next("session-command");
  const card: Control["CommandConfirmationRequest"] = { confirmationId: "native-negative-card", sessionId: s.session.sessionId, operationId: receipt.operationId, operationDigest: canonicalDigest(request), policyDigest: D, expectedConfigVersion: 1, proposedConfigDigest: D, controller, actorId: c.lease.actorId, expiresAt: new Date(Date.now() + 300000).toISOString(), summary: "Actual model change", costEffect: "Metered", privacyEffect: "Egress" };
  receipt = { ...receipt, status: "confirmation-required", reason: "confirmation-required", confirmation: card };
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 4, observedAt: new Date().toISOString(), kind: "config-receipt", receipt }); await s.peer.next("session-event-ack");
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 5, observedAt: new Date().toISOString(), kind: "session-state", session: { ...s.session, sessionEventCursor: 5 } }); await s.peer.next("session-event-ack");
  expect((await success<Control["SessionConfig"]>(await f.call(`${s.path}/config`, { cookie: f.cookie }))).configVersion).toBe(1);
  const confirm = { expectedSessionVersion: receipt.sessionVersion, controller, confirmationId: receipt.confirmation!.confirmationId, operationDigest: "b".repeat(64), policyDigest: D, decision: "allow-once" };
  expect((await f.call(`${s.path}/config/confirm`, { method: "POST", cookie: f.cookie, body: confirm })).status).toBe(409);
  const denied = await success<Control["ConfigReceipt"]>(await f.call(`${s.path}/config/confirm`, { method: "POST", cookie: f.cookie, body: { ...confirm, operationDigest: receipt.confirmation!.operationDigest, decision: "deny" } }));
  expect(denied.operationId).toBe(receipt.operationId); expect(denied.status).toBe("queued");
});

test("queue literal messages allocate no run until admission and edit uses item queue and controller versions", async () => {
  f = await fixture(); const s = await admittedSession(f);
  const c = await appliedController(f, s);
  const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  const body = { expectedSessionVersion: c.sessionVersion, expectedConfigVersion: 1, controller, text: "/literal\nsecond line", interpretation: "literal-message", busyPolicy: "enqueue", association: { mode: "ad-hoc", profileConsentVersion: 1 } };
  const first = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, key: "message-1", body }));
  expect(await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, key: "message-1", body }))).toEqual(first);
  const queue = await success<Control["QueuePage"]>(await f.call(`${s.path}/queue`, { cookie: f.cookie }));
  if (first.status === "queued") { expect(first.runId).toBeNull(); expect(first.turnId).toBeNull(); }
  expect((await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, key: "message-1", body: { ...body, text: "changed" } })).status).toBe(409);
  expect(queue.items.length).toBeLessThanOrEqual(100);
  expect((await f.call(`${s.path}/queue/nonexistent`, { method: "PATCH", cookie: f.cookie, body: { expectedSessionVersion: first.sessionVersion, controller, expectedQueueVersion: queue.queueVersion, expectedItemVersion: 1, queueItemId: "different", text: "must not edit" } })).status).toBe(400);
});
