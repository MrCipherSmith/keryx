import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fixture, admittedSession, reviewerToken, success, type Fixture } from "./fixture.test-support";
import type { FrameOf, MachineSummary } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
test("scoped human machine projections never expose another project's checkout labels or profile inventory", async () => {
  f = await fixture(); const s = await admittedSession(f); const other = await success<{ id: string }>(await f.call("/hub/v1/projects", { method: "POST", cookie: f.cookie, body: { name: "Private other project" } }));
  const db = new Database(join(f.dataDir, "hub.sqlite")); const raw = db.query<{ body: string }, [string]>("SELECT body FROM remote_machine WHERE id=?").get(s.machine.machineId)!; const machine = JSON.parse(raw.body); machine.projectIds.push(other.id); db.query("UPDATE remote_machine SET body=? WHERE id=?").run(JSON.stringify(machine), s.machine.machineId); db.close();
  const closed = new Promise<void>((resolve)=>s.peer.socket.addEventListener("close",()=>resolve(),{once:true})); s.peer.send("heartbeat",{daemonId:"daemon-1"}); await closed;
  const peer = await f.connect(s.machine);
  const metadata = await success<MachineSummary>(await f.call(`/hub/v2/machines/${s.machine.machineId}`, { cookie: f.cookie })); const inventory = metadata.inventory as FrameOf<"inventory">["payload"];
  peer.send("inventory", { inventoryVersion: 2, checkouts: [...inventory.checkouts, { ...inventory.checkouts[0], projectId: other.id, checkoutId: "private-checkout", label: "PRIVATE-FOREIGN-LABEL" }] }); peer.send("heartbeat", { daemonId: "daemon-1" }); await peer.next("heartbeat-ack");
  const cookie = await f.login(reviewerToken); const sessionDigest = createHash("sha256").update(cookie.slice(cookie.indexOf("=") + 1)).digest("hex");
  const database = new Database(join(f.dataDir, "hub.sqlite")); const aggregate = JSON.parse(database.query<{ body: string }, []>("SELECT body FROM hub_state WHERE id=1").get()!.body); aggregate.sessions[sessionDigest].principal.projectIds = [f.project.id]; database.query("UPDATE hub_state SET body=? WHERE id=1").run(JSON.stringify(aggregate)); database.close();
  const scoped = await success<MachineSummary>(await f.call(`/hub/v2/machines/${s.machine.machineId}?projectId=${f.project.id}`, { cookie })); expect(scoped.projectIds).toEqual([f.project.id]); expect(scoped.inventory!.checkouts).toHaveLength(1); expect(JSON.stringify(scoped)).not.toContain("PRIVATE-FOREIGN-LABEL");
});
