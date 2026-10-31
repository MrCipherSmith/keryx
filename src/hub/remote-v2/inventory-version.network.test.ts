import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, success, type Fixture } from "./fixture.test-support";
import type { FrameOf, MachineSummary } from "../../remote-control/protocol";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
test("a machine inventory changes only through a higher version: a changed payload at the same or a lower version stays a refused replay conflict", async () => {
  f = await fixture(); const s = await admittedSession(f);
  const read = async () => (await success<MachineSummary>(await f.call(`/hub/v2/machines/${s.machine.machineId}`, { cookie: f.cookie }))).inventory as FrameOf<"inventory">["payload"];
  const settled = async () => { s.peer.send("heartbeat", { daemonId: "daemon-1" }); await s.peer.next("heartbeat-ack"); };
  const current = await read(); expect(current.inventoryVersion).toBe(1);
  const moved = (headSha: string) => current.checkouts.map((checkout) => ({ ...checkout, headSha }));
  // The identical replay at the stored version is accepted without an error.
  s.peer.send("inventory", current); await settled(); expect(s.peer.pendingFrames().filter((frame) => frame.type === "error")).toEqual([]); expect(await read()).toEqual(current);
  // A changed payload at the same version is a conflicting replay: refused, and Hub keeps what it had.
  s.peer.send("inventory", { inventoryVersion: 1, checkouts: moved("c".repeat(40)) });
  expect((await s.peer.next("error")).payload).toMatchObject({ code: "payload-conflict" }); expect(await read()).toEqual(current);
  // The next version carries the change.
  s.peer.send("inventory", { inventoryVersion: 2, checkouts: moved("c".repeat(40)) }); await settled();
  expect(await read()).toEqual({ inventoryVersion: 2, checkouts: moved("c".repeat(40)) });
  // A lower version never rolls Hub back, whatever it carries.
  s.peer.send("inventory", { inventoryVersion: 1, checkouts: current.checkouts });
  expect((await s.peer.next("error")).payload).toMatchObject({ code: "payload-conflict" }); expect((await read()).inventoryVersion).toBe(2);
});
