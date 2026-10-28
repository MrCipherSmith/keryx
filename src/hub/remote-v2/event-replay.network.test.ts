import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, type Fixture } from "./fixture.test-support";
import type { Control } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
test("durable raw payload receipts allow redacted duplicate replay and only exact contiguous log-only gap bounds advance cursors", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s);
  const turn = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: s.session.version, expectedConfigVersion: 1, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, text: "logs", interpretation: "literal-message", association: { mode: "ad-hoc", profileConsentVersion: 1 }, busyPolicy: "reject" } })); await s.peer.next("command");
  const base = { runId: turn.runId, sessionId: s.session.sessionId, turnId: turn.turnId, projectId: f.project.id, checkoutId: "checkout", observedAt: new Date().toISOString() };
  const log = { ...base, kind: "log", localSeq: 1, stream: "diagnostic", text: "Bearer synthetic-token-never-persist" };
  s.peer.send("run-event", log); await s.peer.next("run-event-ack"); s.peer.send("run-event", log); expect((await s.peer.next("run-event-ack")).payload).toMatchObject({ localSeq: 1 });
  s.peer.send("run-event", { ...base, kind: "log-gap", localSeq: 5, fromSeq: 2, toSeq: 4 }); expect((await s.peer.next("run-event-ack")).payload).toMatchObject({ localSeq: 5 });
  s.peer.send("run-event", { ...base, kind: "log-gap", localSeq: 8, fromSeq: 3, toSeq: 7 }); expect((await s.peer.next("error")).payload).toMatchObject({ code: "replay-gap" });
  const events = await success<{ events: { kind: string; text?: string }[]; cursor: number }>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}/events`, { cookie: f.cookie })); expect(events.cursor).toBe(5); expect(events.events[0]!.text).toBe("Bearer [REDACTED]"); expect(events.events[1]!.kind).toBe("log-gap");
});
