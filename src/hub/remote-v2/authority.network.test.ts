import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, success, operatorToken, reviewerToken, agentToken, type Fixture } from "./fixture.test-support";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });

test("one-use scoped enrollment is atomic and persists only digests", async () => {
  f = await fixture();
  const pair = await success<{ code: string }>(await f.call("/hub/v2/machines/pairings", { method: "POST", cookie: f.cookie, body: { displayName: "one use", projectIds: [f.project.id] } }));
  const body = { code: pair.code, agentVersion: "test", ledgerId: "ledger-1" };
  const responses = await Promise.all([f.call("/hub/v2/machines/enroll", { method: "POST", body }), f.call("/hub/v2/machines/enroll", { method: "POST", body })]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const machine = await success<{ machineId: string; secret: string }>(responses.find((r) => r.status === 200)!);
  expect(machine.secret.length).toBeGreaterThanOrEqual(43);
  const db = new Database(join(f.dataDir, "hub.sqlite"), { readonly: true });
  const rows = db.query("SELECT * FROM remote_machine").all();
  expect(JSON.stringify(rows)).not.toContain(machine.secret);
  expect(JSON.stringify(db.query("SELECT * FROM remote_pairing").all())).not.toContain(pair.code);
  db.close();
  expect(Buffer.from(readFileSync(join(f.dataDir, "hub.sqlite"))).includes(Buffer.from(machine.secret))).toBe(false);
});

test("v2 controls reject agents reviewers cross-origin and human bearer without browser session", async () => {
  f = await fixture(); const body = { displayName: "denied", projectIds: [f.project.id] };
  for (const token of [operatorToken, reviewerToken, agentToken]) expect((await f.call("/hub/v2/machines/pairings", { method: "POST", token, body })).status).toBe(403);
  const reviewer = await f.login(reviewerToken);
  expect((await f.call("/hub/v2/machines/pairings", { method: "POST", cookie: reviewer, body })).status).toBe(403);
  expect((await f.call("/hub/v2/machines/pairings", { method: "POST", cookie: f.cookie, origin: "https://evil.test", body })).status).toBe(403);
  expect((await f.call("/hub/v2/machines/pairings", { method: "POST", cookie: f.cookie, body: { ...body, projectIds: [] } })).status).toBe(400);
});

test("machine socket has real upgrade epoch heartbeat revocation and disjoint credentials", async () => {
  f = await fixture(); const machine = await f.enroll(); const peer = await f.connect(machine);
  expect(peer.epoch).toBeGreaterThan(0);
  peer.send("heartbeat", { daemonId: "daemon-1" });
  expect((await peer.next("heartbeat-ack")).epoch).toBe(peer.epoch);
  const closed = new Promise<number>((resolve) => peer.socket.addEventListener("close", (e) => resolve(e.code), { once: true }));
  const metadata = await success<{ version: number }>(await f.call(`/hub/v2/machines/${machine.machineId}`, { cookie: f.cookie }));
  await success(await f.call(`/hub/v2/machines/${machine.machineId}/revoke`, { method: "POST", cookie: f.cookie, body: { expectedVersion: metadata.version } }));
  expect(await closed).toBe(1008);
  expect((await f.call(`/hub/v2/machines/${machine.machineId}/recovery`, { token: machine.secret })).status).toBe(401);
});

test("machine context reads are scope-gated and cannot invoke human controls", async () => {
  f = await fixture(); const machine = await f.enroll();
  const other = await success<{ id: string }>(await f.call("/hub/v1/projects", { method: "POST", cookie: f.cookie, body: { name: "Other" } }));
  expect((await f.call(`/hub/v1/projects/${f.project.id}/context`, { token: machine.secret })).status).toBe(200);
  expect([403, 404]).toContain((await f.call(`/hub/v1/projects/${other.id}/context`, { token: machine.secret })).status);
  expect((await f.call("/hub/v2/machines/pairings", { method: "POST", token: machine.secret, body: { displayName: "escalate", projectIds: [other.id] } })).status).toBe(403);
  expect((await f.call("/hub/v1/session", { method: "POST", body: { token: machine.secret } })).status).toBe(401);
});

test("an already upgraded machine socket cannot survive credential rotation or a project scope change", async () => {
  for (const change of ["credential", "scope"] as const) {
    f = await fixture(); const enrolled = await f.enroll(); const peer = await f.connect(enrolled);
    const db = new Database(join(f.dataDir, "hub.sqlite"));
    const record = db.query<{body:string}, [string]>("SELECT body FROM remote_machine WHERE id=?").get(enrolled.machineId)!;
    const current = JSON.parse(record.body); if (change === "credential") current.credentialDigest = "f".repeat(64); else current.projectIds = [];
    db.query("UPDATE remote_machine SET body=? WHERE id=?").run(JSON.stringify(current), enrolled.machineId); db.close();
    const closed = new Promise<number>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Stale authenticated socket remained open")), 500); peer.socket.addEventListener("close", (event) => { clearTimeout(timer); resolve(event.code); }, {once:true}); });
    peer.send("heartbeat", {daemonId:"daemon-1"});
    expect(await closed).toBe(1008); await f.close();
  }
});
