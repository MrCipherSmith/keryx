import { afterEach, expect, test } from "bun:test";
import { fixture, success, type Fixture } from "./fixture.test-support";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
const NativeWebSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket };
async function unreachable(origin: string) {
  let rejected = false;
  try { await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(500) }); } catch { rejected = true; }
  expect(rejected).toBe(true);
  const socket = new NativeWebSocket(`${origin.replace("http", "ws")}/hub/v2/events/socket?projectId=closed`, {});
  const upgraded = await new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), 500); socket.addEventListener("open", () => { clearTimeout(timer); resolve(true); }, { once: true }); socket.addEventListener("error", () => { clearTimeout(timer); resolve(false); }, { once: true }); });
  expect(upgraded).toBe(false); socket.close();
}
test("normal shutdown closes actual authenticated clients and refuses subsequent HTTP and upgrade connections", async () => {
  f = await fixture(); const machine = await f.enroll(); const peer = await f.connect(machine);
  const closed = new Promise<number>((resolve) => peer.socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
  await f.server.stop(true); expect(await closed).toBe(1012); expect(peer.socket.readyState).toBe(WebSocket.CLOSED); await unreachable(f.origin);
});
test("shutdown after a server-revoked WebSocket completes despite pinned Bun1.3.14 phantom counter", async () => {
  f = await fixture(); const machine = await f.enroll(); const peer = await f.connect(machine);
  const closed = new Promise<number>((resolve) => peer.socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
  const metadata = await success<{ version: number }>(await f.call(`/hub/v2/machines/${machine.machineId}`, { cookie: f.cookie }));
  await success(await f.call(`/hub/v2/machines/${machine.machineId}/revoke`, { method: "POST", cookie: f.cookie, body: { expectedVersion: metadata.version } }));
  expect(await closed).toBe(1008); expect(peer.socket.readyState).toBe(WebSocket.CLOSED);
  await f.server.stop(true); await unreachable(f.origin);
});
