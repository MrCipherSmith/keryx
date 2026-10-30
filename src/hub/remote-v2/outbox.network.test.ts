import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, appliedController, publishCapabilities, success, operatorToken, reviewerToken, agentToken, type Fixture } from "./fixture.test-support";
import { startHub } from "../server";
import type { Control } from "../../remote-control/protocol";
let f: Fixture; let restarted: ReturnType<typeof startHub> | undefined;
afterEach(async () => { await restarted?.stop(true); restarted = undefined; if (f) await f.close(); });
test("restart redelivers the same durable pending command only after fresh complete capability projection without renewing identity or expiry", async () => {
  f = await fixture(); const s = await admittedSession(f); const c = await appliedController(f, s);
  const pending = await success<Control["ConfigReceipt"]>(await f.call(`${s.path}/config`, { method: "PUT", cookie: f.cookie, body: { expectedSessionVersion: s.session.version, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, expectedConfigVersion: 1, baselineCandidateId: "local", reasoningEffort: "none", routing: s.session.config.routing, busyPolicy: "reject" } }));
  const first = (await s.peer.next("session-command")).payload;
  await f.server.stop(true); restarted = startHub({ dataDir: f.dataDir, host: "127.0.0.1", port: Number(new URL(f.origin).port), operatorToken, reviewerToken, agentToken });
  const peer = await f.connect(s.machine); peer.send("heartbeat", { daemonId: "daemon-1" }); await peer.next("heartbeat-ack"); expect(peer.pendingFrames().some((frame) => frame.type === "session-command")).toBe(false);
  await publishCapabilities(f, peer); expect((await peer.next("session-command")).payload).toEqual(first);
  expect((await success<Control["ConfigReceipt"]>(await f.call(`${s.path}/operations/${pending.operationId}`, { cookie: f.cookie }))).operationId).toBe(pending.operationId);
});
