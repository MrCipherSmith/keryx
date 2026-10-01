// AC5: a second `keryx serve` on the same bot token does not crash and does not
// poll. It says why, answers every other route as usual, and the remote routes
// answer 503 with the reason.
//
// Two ways it happens, both covered:
//   - the poller lock on this machine is held (a second serve in the same user-global dir);
//   - the lock is not enough (another machine, a stale lock) and Telegram itself says 409.

import { afterEach, describe, expect, test } from "bun:test";
import { call, makeRig, type Rig } from "./remote.http.test-helpers";
import { until } from "./remote.test-helpers";
import { openRemoteService } from "./service";

let rig: Rig;
afterEach(async () => {
  await rig.cleanup();
});

describe("a second serve on the same bot token", () => {
  test("the poller lock is held: it starts, says why, serves other routes and answers 503 on remote ones", async () => {
    rig = makeRig();
    const first = await rig.startServe();
    expect(rig.notices).toEqual([]);

    const second = await rig.startServe();
    expect(rig.notices).toHaveLength(1);
    expect(rig.notices[0]).toContain("remote control is off");
    expect(second.service.hub()).toBeUndefined();

    // The listener of the second serve is fine for everything but remote control.
    expect((await call(second.origin, second.serveToken, "GET", "/v1/status")).status).toBe(200);
    const refused = await call(second.origin, second.shellToken, "POST", "/v1/remote/register", { sessionId: "sess-ss-0001", project: "/work/app", name: "release" });
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: { code: "remote-unavailable", message: expect.any(String) } });
    // The 503 carries the same reason the operator was told.
    const reason = (rig.notices[0] ?? "").replace("remote control is off: ", "");
    expect(reason).not.toBe("");
    expect((refused.body as { error: { message: string } }).error.message).toContain(reason);

    // The first serve is untouched: still polling, still the one the shells find.
    expect(first.service.hub()).toBeDefined();
    const client = rig.makeClient({ sessionId: "sess-ss-0002", project: "/work/app", name: "release", onLine: () => undefined });
    const started = await client.start();
    expect(started.ok).toBe(true);
    expect(first.service.hub()?.list().map((session) => session.name)).toEqual(["release"]);

    // Stopping the second serve takes nothing of the first one's with it (endpoint file, lock).
    await second.stop();
    expect(client.connected).toBe(true);
    const again = await call(first.origin, first.shellToken, "POST", "/v1/remote/heartbeat", { sessionId: "sess-ss-0002" });
    expect(again.status).toBe(200);
  });

  test("a lock left by a dead process is taken over, and the serve polls", async () => {
    rig = makeRig();
    const stale = await rig.startServe({ service: { lock: { pid: 4_000_001, isAlive: () => true } } });
    expect(stale.service.hub()).toBeDefined();
    await stale.stop();

    // Its owner is gone: the file stays, the next serve finds no live holder.
    const next = await rig.startServe({ service: { lock: { pid: 4_000_002, isAlive: () => false } } });
    expect(next.service.hub()).toBeDefined();
    expect(rig.notices).toEqual([]);
  });

  test("Telegram says another poller owns the token: serve stops polling, says so, and keeps serving", async () => {
    rig = makeRig();
    // The lock cannot see another machine, so it is off for both: the 409 is what tells them.
    const a = await rig.startServe({ service: { lock: { disabled: true } } });
    const b = await rig.startServe({ service: { lock: { disabled: true } }, api: rig.api.connect("other-machine") });

    // Exactly one of them loses the race for the long poll, and it is told so.
    await until(() => rig.notices.length === 1, "one serve to give up polling", 10_000);
    expect(rig.notices[0]).toContain("remote control is off");

    const answers = await Promise.all(
      [a, b].map((serve) => call(serve.origin, serve.shellToken, "POST", "/v1/remote/register", { sessionId: "sess-ss-0003", project: "/work/app", name: "release" })),
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 503].sort());
    // Both still answer the rest of the API.
    for (const serve of [a, b]) {
      expect((await call(serve.origin, serve.serveToken, "GET", "/v1/status")).status).toBe(200);
    }
  });

  test("serve bound beyond loopback refuses remote control with a reason and still serves", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    // The refusal for a non-loopback bind is unit-level (the listener here is loopback): the service
    // says so for an address that is not.
    const opened = openRemoteService({ dir: rig.dir, api: rig.api, lock: { disabled: true }, onNotice: (message) => rig.notices.push(message) });
    if (opened.status !== "ready") {
      throw new Error("expected a ready service");
    }
    const result = await opened.service.start({ address: "0.0.0.0", port: 1 });
    expect(result.ok).toBe(false);
    expect(rig.notices.at(-1)).toContain("not a loopback address");
    expect((await call(serve.origin, serve.serveToken, "GET", "/v1/status")).status).toBe(200);
  });
});
