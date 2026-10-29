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

test("a human lost resolution frees its crashed session from the lost run: recovery-required, never busy, idle or closed, queued work suspended, until a machine-verified resume makes it idle for new work", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s);
  const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
  const emit = async (seq: number, event: object) => { s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: seq, observedAt: new Date().toISOString(), ...event }); await s.peer.next("session-event-ack"); };
  const runEvent = async (runId: string, turnId: string, localSeq: number, fields: object) => { s.peer.send("run-event", { runId, turnId, sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", localSeq, observedAt: new Date().toISOString(), ...fields }); await s.peer.next("run-event-ack"); };
  const read = async () => success<Control["SessionRecord"]>(await f.call(s.path, { cookie: f.cookie }));
  const message = (text: string, version: number, busyPolicy: "reject" | "enqueue") => f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: version, expectedConfigVersion: 1, controller, text, interpretation: "literal-message", busyPolicy, association: { mode: "ad-hoc", profileConsentVersion: 1 } } });
  // A running turn with a message queued behind it, as the machine published them before its daemon crashed.
  const turn = await success<Control["TurnReceipt"]>(await message("crashing turn", s.session.version, "reject")); const start = (await s.peer.next("command")).payload as FrameOf<"command">["payload"];
  await emit(4, { kind: "session-state", session: { ...s.session, version: 3, state: "busy", activeRunId: turn.runId, activeTurnId: turn.turnId, nextTurnOrdinal: 2, sessionEventCursor: 4 } });
  const queued = await success<Control["TurnReceipt"]>(await message("queued behind the crash", 3, "enqueue")); await s.peer.next("session-command");
  const item: Control["QueueItem"] = { queueItemId: "crash-queued", version: 1, kind: "message", operationId: queued.operationId, state: "queued", position: 0, text: "queued behind the crash", commandName: null, expectedConfigVersion: 1, replacesOperationId: null };
  await emit(5, { kind: "queue-changed", queueVersion: 1, item });
  const busy: Control["SessionRecord"] = { ...s.session, version: 4, state: "busy", activeRunId: turn.runId, activeTurnId: turn.turnId, nextTurnOrdinal: 2, queueVersion: 1, sessionEventCursor: 6 };
  await emit(6, { kind: "session-state", session: busy });
  const nativeIdentity = { sessionId: s.session.sessionId, turnId: turn.turnId!, daemonId: "daemon-1", supervisorHandleId: "supervisor-1" };
  for (const [i, state] of (["received", "starting"] as const).entries()) await runEvent(turn.runId!, turn.turnId!, i + 1, { kind: "state", state, reasonCode: "none" });
  await runEvent(turn.runId!, turn.turnId!, 3, { kind: "state", state: "running", reasonCode: "none", nativeIdentity });
  // The daemon crashed: the reconnected machine shows the run unknown, proves the absence locally, and a human resolves it lost.
  await runEvent(turn.runId!, turn.turnId!, 4, { kind: "state", state: "unknown", reasonCode: "recovery-required", nativeIdentity });
  const run = await success<{ version: number }>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`, { cookie: f.cookie }));
  const report: Control["ReconciliationReport"] = { runId: turn.runId!, projectId: f.project.id, checkoutId: "checkout", ledgerId: "ledger-1", daemonId: "daemon-1", commandDigest: start.commandDigest, expectedRunVersion: run.version, observation: "confirmed-stopped", observedAt: new Date().toISOString(), sessionId: s.session.sessionId, turnId: turn.turnId! };
  const receipt = await success<Control["ReconciliationReceipt"]>(await f.call(`/hub/v2/machines/${s.machine.machineId}/reconciliations`, { method: "POST", token: s.machine.secret, origin: null, body: report }));
  await success(await f.call(`/hub/v2/machines/${s.machine.machineId}/resolve-run`, { method: "POST", cookie: f.cookie, body: { runId: turn.runId, expectedRunVersion: run.version, localReconciliationId: receipt.reconciliationId, decision: "lost", reason: "Locally confirmed absence" } }));
  // Released is not resumed: nothing runs the lost turn, so the session is neither busy with it nor idle nor closed, and its controller stays.
  const released = await read();
  expect({ state: released.state, activeRunId: released.activeRunId, activeTurnId: released.activeTurnId, version: released.version }).toEqual({ state: "recovery-required", activeRunId: null, activeTurnId: null, version: busy.version });
  expect(released.controller).toEqual(c.lease);
  // Queued input never becomes authorization after a crash: it is suspended, as the restarted native host keeps it.
  expect((await success<Control["QueuePage"]>(await f.call(`${s.path}/queue`, { cookie: f.cookie }))).items.map((i) => ({ operationId: i.operationId, state: i.state }))).toEqual([{ operationId: queued.operationId, state: "suspended" }]);
  // New work on the unverified baseline is still refused.
  expect(await (await message("too early", released.version, "reject")).json()).toMatchObject({ error: { code: "recovery-required" } });
  // A human resume is delivered: only the machine's own re-verified owned baseline makes the session idle again.
  const resume = await success<Control["SessionOperationReceipt"]>(await f.call(`${s.path}/resume`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: released.version, controller, expectedHistoryVersion: released.historyVersion, expectedWorkspaceBaseline: released.workspaceBaseline } }));
  expect({ kind: resume.kind, status: resume.status }).toEqual({ kind: "resume-session", status: "pending" });
  const delivered = (await s.peer.next("session-command")).payload as FrameOf<"session-command">["payload"]; expect(delivered.kind).toBe("resume-session");
  const authorized = await f.call(`/hub/v2/machines/${s.machine.machineId}/commands/${delivered.commandId}/authorize`, { method: "POST", token: s.machine.secret, origin: null, body: { commandDigest: delivered.commandDigest, policyDigest: D, target: delivered.target, controller } });
  expect(authorized.status).toBe(200);
  const resumed: Control["SessionRecord"] = { ...busy, state: "idle", activeRunId: null, activeTurnId: null, sessionEventCursor: 8 };
  s.peer.send("session-command-receipt", { commandId: delivered.commandId, hubSequence: delivered.hubSequence, sessionId: s.session.sessionId, observedSessionVersion: resumed.version, status: "applied", receiptId: resume.receiptId, errorCode: null });
  await emit(7, { kind: "operation-receipt", receipt: { ...resume, status: "applied", observedSessionVersion: resumed.version, session: resumed } });
  await emit(8, { kind: "session-state", session: resumed });
  expect((await read()).state).toBe("idle");
  // The machine's own projection ends Hub's lost-resolution overlay: a later machine-reported fence is never resumable through it.
  await emit(9, { kind: "session-state", session: { ...resumed, state: "recovery-required", sessionEventCursor: 9 } });
  expect(await (await f.call(`${s.path}/resume`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: resumed.version, controller, expectedHistoryVersion: resumed.historyVersion, expectedWorkspaceBaseline: resumed.workspaceBaseline } })).json()).toMatchObject({ error: { code: "recovery-required" } });
  await emit(10, { kind: "session-state", session: { ...resumed, sessionEventCursor: 10 } });
  // New work is admitted; the suspended item behind the lost run is never admitted on its own.
  const next = await success<Control["TurnReceipt"]>(await message("new work after recovery", resumed.version, "reject")); expect(next.status).toBe("admitted");
  const admitted = (await s.peer.next("command")).payload as FrameOf<"command">["payload"];
  expect(admitted.kind === "start-turn" ? admitted.body.request.text : admitted.kind).toBe("new work after recovery");
  s.peer.send("heartbeat", { daemonId: "daemon-1" }); await s.peer.next("heartbeat-ack");
  expect(s.peer.pendingFrames().filter((frame) => frame.type === "command")).toEqual([]);
  expect((await success<Control["QueuePage"]>(await f.call(`${s.path}/queue`, { cookie: f.cookie }))).items.map((i) => i.state)).toEqual(["suspended"]);
});

test("session-only recovery pages advance independently of run count and retain every session", async()=>{
 const {HEAD}=await import("./fixture.test-support"); f=await fixture(); const s=await admittedSession(f);
 const ids=new Set([s.session.sessionId]);
 for(let i=0;i<101;i++){const receipt=await success<Control["SessionOperationReceipt"]>(await f.call(`/hub/v2/projects/${f.project.id}/sessions`,{method:"POST",cookie:f.cookie,body:{machineId:s.machine.machineId,checkoutId:"checkout",agentProfileId:"native",expectedInventoryVersion:1,expectedHeadSha:HEAD,capabilityDigest:D,policyDigest:D,title:`Recovery ${i}`}}));ids.add(receipt.sessionId);}
 let cursor=0;const found=new Set<string>();
 for(let i=0;i<3;i++){const page=await success<Control["RecoveryPage"]>(await f.call(`/hub/v2/machines/${s.machine.machineId}/recovery?after=${cursor}`,{token:s.machine.secret,origin:null}));expect(page.runs).toEqual([]);for(const record of page.sessions)found.add(record.sessionId);expect(page.cursor).toBeGreaterThan(cursor);cursor=page.cursor;if(!page.hasMore)break;}
 expect(found).toEqual(ids);
});
