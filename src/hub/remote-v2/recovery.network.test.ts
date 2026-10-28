import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, success, D, type Fixture } from "./fixture.test-support";
import { canonicalDigest, validateControl, type Control, type FrameOf } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
async function unknownRun() {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s);
  const turn = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: s.session.version, expectedConfigVersion: 1, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, text: "uncertain native start", interpretation: "literal-message", association: { mode: "ad-hoc", profileConsentVersion: 1 }, busyPolicy: "reject" } }));
  const frame = await s.peer.next("command"); const command = frame.payload as FrameOf<"command">["payload"];
  s.peer.send("run-event", { runId: turn.runId, projectId: f.project.id, checkoutId: "checkout", sessionId: s.session.sessionId, turnId: turn.turnId, localSeq: 1, observedAt: new Date().toISOString(), kind: "state", state: "unknown", reasonCode: "recovery-required" }); await s.peer.next("run-event-ack");
  const run = await success<{ version: number; state: string }>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`, { cookie: f.cookie }));
  const report: Control["ReconciliationReport"] = { runId: turn.runId!, projectId: f.project.id, checkoutId: "checkout", ledgerId: "ledger-1", daemonId: "daemon-1", commandDigest: command.commandDigest, expectedRunVersion: run.version, observation: "confirmed-stopped", observedAt: new Date().toISOString(), sessionId: s.session.sessionId, turnId: turn.turnId! };
  return { s, turn, run, report };
}
test("reconciliation returns the exact closed receipt bound to immutable owned run and idempotent report digest", async () => {
  const { s, report } = await unknownRun(); const path = `/hub/v2/machines/${s.machine.machineId}/reconciliations`;
  const receipt = await success<Control["ReconciliationReceipt"]>(await f.call(path, { method: "POST", token: s.machine.secret, origin: null, key: "reconcile-once", body: report }));
  expect(validateControl("ReconciliationReceipt", receipt).ok).toBe(true); expect(receipt.reportDigest).toBe(canonicalDigest(report)); expect(receipt.machineId).toBe(s.machine.machineId);
  expect(await success<Control["ReconciliationReceipt"]>(await f.call(path, { method: "POST", token: s.machine.secret, origin: null, key: "reconcile-once", body: report }))).toEqual(receipt);
  for (const changed of [{ ...report, commandDigest: D }, { ...report, checkoutId: "foreign" }, { ...report, sessionId: "foreign" }, { ...report, expectedRunVersion: report.expectedRunVersion + 1 }]) expect((await f.call(path, { method: "POST", token: s.machine.secret, origin: null, body: changed })).status).toBe(409);
});
test("human resolve-run needs a matching fresh local receipt and cannot clear unknown from a label or unknown observation", async () => {
  const { s, turn, run, report } = await unknownRun(); const path = `/hub/v2/machines/${s.machine.machineId}/resolve-run`;
  const request: Control["ResolveRunRequest"] = { runId: turn.runId!, expectedRunVersion: run.version, localReconciliationId: "missing", decision: "lost", reason: "Locally confirmed supervisor absence" };
  expect((await f.call(path, { method: "POST", cookie: f.cookie, body: request })).status).toBe(409);
  const receipt = await success<Control["ReconciliationReceipt"]>(await f.call(`/hub/v2/machines/${s.machine.machineId}/reconciliations`, { method: "POST", token: s.machine.secret, origin: null, body: report }));
  await success(await f.call(path, { method: "POST", cookie: f.cookie, body: { ...request, localReconciliationId: receipt.reconciliationId } }));
  expect((await success<{ state: string }>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`, { cookie: f.cookie }))).state).toBe("lost");
  const { Database } = await import("bun:sqlite"); const { join } = await import("node:path"); const db = new Database(join(f.dataDir, "hub.sqlite")); const raw = db.query<{ body: string }, [string]>("SELECT body FROM remote_session WHERE id=?").get(s.session.sessionId)!; const expired = JSON.parse(raw.body); expired.record.controller.expiresAt = new Date(Date.now() - 1).toISOString(); db.query("UPDATE remote_session SET body=? WHERE id=?").run(JSON.stringify(expired), s.session.sessionId); db.close();
  const options = await success<{ reconciliationReceipts: Control["ReconciliationReceipt"][] }>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`, { cookie: f.cookie })); expect(options.reconciliationReceipts.map((r) => r.reconciliationId)).toContain(receipt.reconciliationId);
  const takeover = await success<Control["ControllerReceipt"]>(await f.call(`${s.path}/controller/claim`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: expired.record.version, expectedControllerVersion: expired.record.controller.version, requestedLeaseSeconds: 60, mode: "takeover", previousReleaseReceiptId: receipt.reconciliationId } })); expect(takeover.lease.version).toBe(expired.record.controller.version + 1);

});

test("session-only recovery pages advance independently of run count and retain every session", async()=>{
 const {HEAD}=await import("./fixture.test-support"); f=await fixture(); const s=await admittedSession(f);
 const ids=new Set([s.session.sessionId]);
 for(let i=0;i<101;i++){const receipt=await success<Control["SessionOperationReceipt"]>(await f.call(`/hub/v2/projects/${f.project.id}/sessions`,{method:"POST",cookie:f.cookie,body:{machineId:s.machine.machineId,checkoutId:"checkout",agentProfileId:"native",expectedInventoryVersion:1,expectedHeadSha:HEAD,capabilityDigest:D,policyDigest:D,title:`Recovery ${i}`}}));ids.add(receipt.sessionId);}
 let cursor=0;const found=new Set<string>();
 for(let i=0;i<3;i++){const page=await success<Control["RecoveryPage"]>(await f.call(`/hub/v2/machines/${s.machine.machineId}/recovery?after=${cursor}`,{token:s.machine.secret,origin:null}));expect(page.runs).toEqual([]);for(const record of page.sessions)found.add(record.sessionId);expect(page.cursor).toBeGreaterThan(cursor);cursor=page.cursor;if(!page.hasMore)break;}
 expect(found).toEqual(ids);
});
