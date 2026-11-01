import { afterEach, expect, test } from "bun:test";
import { openHubStore } from "../store";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture, admittedSession, appliedController, success, D, HEAD, type Fixture } from "./fixture.test-support";
import type { Control } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });

test.each(["ad-hoc", "flow"] as const)("%s machine result atomically creates immutable correctly attributed revision/checks", async (mode) => {
  f = await fixture(); const s = await admittedSession(f);
  const c = await appliedController(f, s);
  let association: Control["FlowAssociation"] = { mode: "ad-hoc", profileConsentVersion: 1 };
  let frozenReplay: {path:string;body:{expectedVersion:number};response:unknown}|undefined;
  if (mode === "flow") {
    const imported = await success<{ documents: { id: string; contentDigest: string }[] }>(await f.call(`/hub/v1/projects/${f.project.id}/import`, { method: "POST", token: "remote-test-agent-" + "a".repeat(64), body: { expectedVersion: f.project.version, sourceRevision: "source", documents: [{ path: "spec.md", kind: "spec", content: "# Frozen execution\nActual check." }] } }));
    let flow = await success<{ id: string; version: number; specContentDigest: string; criteria: string[] }>(await f.call(`/hub/v1/projects/${f.project.id}/flows`, { method: "POST", cookie: f.cookie, body: { title: "Managed result", specDocumentId: imported.documents[0]!.id, criteria: ["Actual check"] } }));
    const freezePath=`/hub/v1/projects/${f.project.id}/flows/${flow.id}/freeze`,freezeBody={expectedVersion:flow.version};
    flow = await success<typeof flow>(await f.call(freezePath, { method: "POST", cookie: f.cookie, key:"freeze-before-conversion", body:freezeBody }));
    frozenReplay={path:freezePath,body:freezeBody,response:flow};
    flow = await success<typeof flow>(await f.call(`/hub/v1/projects/${f.project.id}/flows/${flow.id}/start`, { method: "POST", cookie: f.cookie, body: { expectedVersion: flow.version } }));
    const { criteriaDigest } = await import("../../remote-control/protocol");
    association = { mode: "flow", flowId: flow.id, expectedFlowVersion: flow.version, specDigest: flow.specContentDigest, criteriaDigest: criteriaDigest(flow.criteria) };
  }
  const receipt = await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: c.sessionVersion, expectedConfigVersion: 1, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, text: "actual test operation", interpretation: "literal-message", busyPolicy: "reject", association } }));
  expect(receipt.status).toBe("admitted");
  const command = await s.peer.next("command"); const payload = command.payload as Record<string, unknown>;
  const auth = await success<Control["AuthorizationGrant"]>(await f.call(`/hub/v2/machines/${s.machine.machineId}/commands/${payload.commandId}/authorize`, { method: "POST", token: s.machine.secret, origin: null, body: { commandDigest: payload.commandDigest, policyDigest: D, target: { scope: "run", sessionId: receipt.sessionId, runId: receipt.runId, turnId: receipt.turnId, expectedRunVersion: 1, expectedSessionVersion: receipt.sessionVersion }, controller: payload.controller } }));
  expect(Date.parse(auth.expiresAt) - Date.now()).toBeLessThanOrEqual(5000);
  const event = { runId: receipt.runId, sessionId: receipt.sessionId, turnId: receipt.turnId, projectId: f.project.id, checkoutId: "checkout", localSeq: 1, observedAt: new Date().toISOString(), kind: "state", state: "succeeded", reasonCode: "none" };
  for (const [index, state] of ["received", "starting", "running", "succeeded"].entries()) { s.peer.send("run-event", { ...event, localSeq: index + 1, state, ...(index >= 2 ? { nativeIdentity: { sessionId: receipt.sessionId, turnId: receipt.turnId, daemonId: "daemon-1", supervisorHandleId: "supervisor-1" } } : {}) }); await s.peer.next("run-event-ack"); }
  const run = await success<{ version: number }>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${receipt.runId}`, { cookie: f.cookie }));
  const body = { expectedRunVersion: run.version, gitBaseSha: HEAD, outcome: "succeeded", partial: false, changes: [{ path: "new.ts", contentBase64: Buffer.from("export const actual = true;\n").toString("base64"), mode: "100644" }], checks: [{ checkId: "actual", command: "deterministic-check", exitCode: 0, output: "actual result" }], sessionId: receipt.sessionId, turnId: receipt.turnId, association, workspaceBaseline: D };
  const path = `/hub/v2/projects/${f.project.id}/runs/${receipt.runId}/result`;
  const triggerDb = new Database(join(f.dataDir, "hub.sqlite"));
  triggerDb.exec("CREATE TRIGGER reject_result BEFORE INSERT ON remote_result_receipt BEGIN SELECT RAISE(ABORT,'injected receipt persistence failure'); END");
  expect((await f.call(path, { method: "POST", token: s.machine.secret, origin: null, key: "fault", body })).status).toBe(500);
  const failedState = JSON.parse(triggerDb.query<{ body: string }, []>("SELECT body FROM hub_state WHERE id=1").get()!.body) as { revisions: unknown[]; evidence: unknown[] };
  expect(failedState.revisions).toHaveLength(0); expect(failedState.evidence).toHaveLength(0);
  triggerDb.exec("DROP TRIGGER reject_result"); triggerDb.close();
  const result = await success<Control["ResultReceipt"]>(await f.call(path, { method: "POST", token: s.machine.secret, origin: null, key: "result-1", body }));
  if (mode === "ad-hoc") expect(result).toMatchObject({ checksKind: "RunChecks", flowId: null, evidenceId: null });
  else { expect(result.checksKind).toBe("FlowEvidence"); expect(result.evidenceId).not.toBeNull(); }
  if(mode==='flow'){
    const store=openHubStore(f.dataDir);store.workTransaction(()=>store.work.markConverted(f.project.id,association.mode==='flow'?association.flowId:'','managed-replacement'));store.close();
    expect<unknown>(await success(await f.call(frozenReplay!.path,{method:'POST',cookie:f.cookie,key:'freeze-before-conversion',body:frozenReplay!.body}))).toEqual(frozenReplay!.response);
    expect((await f.call(frozenReplay!.path,{method:'POST',cookie:f.cookie,key:'new-freeze-operation',body:frozenReplay!.body})).status).toBe(409);
  }
  expect(await success<Control["ResultReceipt"]>(await f.call(path, { method: "POST", token: s.machine.secret, origin: null, key: "result-1", body }))).toEqual(result);
  expect((await f.call(path, { method: "POST", token: s.machine.secret, origin: null, key: "result-1", body: { ...body, partial: true } })).status).toBe(409);
  const db = new Database(join(f.dataDir, "hub.sqlite"), { readonly: true });
  const raw = db.query<{ body: string }, []>("SELECT body FROM hub_state WHERE id=1").get()!;
  const aggregate = JSON.parse(raw.body) as { revisions: { id: string; createdBy: string; purpose: string }[]; evidence: unknown[]; projects: { lineRevisionId: string | null }[] };
  expect(aggregate.revisions.filter((r) => r.id === result.revisionId)).toHaveLength(1);
  expect(aggregate.revisions.find((r) => r.id === result.revisionId)).toMatchObject({ createdBy: `machine:${s.machine.machineId}`, purpose: "review-bundle" });
  expect(aggregate.evidence).toHaveLength(mode === "flow" ? 1 : 0); expect(aggregate.projects[0]?.lineRevisionId).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM remote_result_receipt").get()).toEqual({ n: 1 });
  db.close();
});
