import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, type Fixture } from "./fixture.test-support";
import type { Control } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
test("a new human observer can read only the exact current applied release through its lease alias", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s); const path = `${s.path}/operations/${c.lease.controllerLeaseId}`;
  expect((await f.call(path, { cookie: f.cookie })).status).toBe(404);
  const release = await success<Control["ControllerReceipt"]>(await f.call(`${s.path}/controller/release`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: c.sessionVersion, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version } } }));
  expect((await f.call(path, { cookie: f.cookie })).status).toBe(404);
  const delivery = await s.peer.next("session-command"); const command = delivery.payload as { commandId: string; hubSequence: number };
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 4, observedAt: new Date().toISOString(), kind: "controller-changed", receipt: release }); await s.peer.next("session-event-ack");
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 5, observedAt: new Date().toISOString(), kind: "session-state", session: { ...s.session, version: release.sessionVersion, controller: release.lease, sessionEventCursor: 5 } }); await s.peer.next("session-event-ack");
  s.peer.send("session-command-receipt", { commandId: command.commandId, hubSequence: command.hubSequence, sessionId: s.session.sessionId, observedSessionVersion: release.sessionVersion, status: "applied", receiptId: release.receiptId, errorCode: null }); s.peer.send("heartbeat", { daemonId: "daemon-1" }); await s.peer.next("heartbeat-ack");
  const newTab = await f.login(); expect(await success<Control["ControllerReceipt"]>(await f.call(path, { cookie: newTab }))).toEqual(release);
  expect((await f.call(path.replace(s.session.sessionId, "foreign"), { cookie: newTab })).status).toBe(404);
  const { Database } = await import("bun:sqlite"); const { join } = await import("node:path"); const db = new Database(join(f.dataDir, "hub.sqlite")); db.query("INSERT INTO remote_operation(id,projectId,sessionId,body) VALUES(?,?,?,?)").run(c.lease.controllerLeaseId, f.project.id, s.session.sessionId, JSON.stringify({ id: c.lease.controllerLeaseId, projectId: f.project.id, sessionId: s.session.sessionId, response: {} })); db.close();
  expect((await f.call(path, { cookie: newTab })).status).toBe(409);
});
