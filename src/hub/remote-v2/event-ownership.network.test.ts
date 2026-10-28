import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, D, type Fixture } from "./fixture.test-support";
import type { Control, FrameOf } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
test("session admission and selection events cannot name an unowned run or fabricate configuration/provider provenance", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s);
  const turn = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: s.session.version, expectedConfigVersion: 1, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, text: "exact snapshot", interpretation: "literal-message", association: { mode: "ad-hoc", profileConsentVersion: 1 }, busyPolicy: "reject" } })); const command = (await s.peer.next("command")).payload as Extract<FrameOf<"command">["payload"], { kind: "start-turn" }>;
  const common = { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 4, observedAt: new Date().toISOString() };
  s.peer.send("session-event", { ...common, kind: "turn-admitted", runId: "foreign", turnId: turn.turnId, turnOrdinal: 1, snapshot: command.body.snapshot, association: { mode: "ad-hoc", profileConsentVersion: 1 } }); expect((await s.peer.next("error")).payload).toMatchObject({ code: "stale-reference" });
  s.peer.send("session-event", { ...common, kind: "selection-receipt", receipt: { selectionReceiptId: "invented-provider", sessionId: s.session.sessionId, runId: turn.runId, turnId: turn.turnId, configVersion: 1, candidateId: "unknown-egress", reason: "provider-fallback", policyDigest: D, confirmedOperationDigest: null, observedAt: new Date().toISOString() } }); expect((await s.peer.next("error")).payload).toMatchObject({ code: "stale-reference" });
});
