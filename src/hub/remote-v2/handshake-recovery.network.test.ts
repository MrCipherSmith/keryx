import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fixture, success, type Fixture } from "./fixture.test-support";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
const NativeWebSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket };
test("a credential with a different local ledger durably blocks dispatch instead of rolling back the recovery flag", async () => {
  f = await fixture(); const machine = await f.enroll(); const socket = new NativeWebSocket(`${f.origin.replace("http", "ws")}/hub/v2/machines/socket`, { protocols: ["keryx.hub.machine.v2"], headers: { Authorization: `Bearer ${machine.secret}` } });
  try {
    const error = new Promise<Record<string, unknown>>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("No ledger recovery refusal")), 1500); socket.addEventListener("message", (event) => { const value = JSON.parse(String(event.data)) as Record<string, unknown>; if (value.type === "error") { clearTimeout(timer); resolve(value); } }); });
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("Upgrade failed")), { once: true }); });
    socket.send(JSON.stringify({ v: 2, type: "hello", messageId: randomUUID(), epoch: 0, payload: { machineId: machine.machineId, ledgerId: "different-ledger", daemonId: "new-daemon", agentVersion: "test", capabilities: [], lastHubSequence: 0, runCursors: [], sessionCursors: [] } })); expect((await error).payload).toMatchObject({ code: "recovery-required" });
    const metadata = await success<{ recoveryRequired: boolean }>(await f.call(`/hub/v2/machines/${machine.machineId}`, { cookie: f.cookie })); expect(metadata.recoveryRequired).toBe(true);
  } finally { socket.close(); }
});
