import { expect, test } from "bun:test";
import { makeRig } from "./remote.http.test-helpers";

test("Desktop owner invalidates its binding before acknowledging channel revocation", async () => {
  const rig = makeRig();
  try {
    const serve = await rig.startServe();
    let revoked = false;
    const client = rig.makeClient({ sessionId: "desktop-revoke", project: "/project", owner: { kind: "desktop", incarnation: "owner1", generation: "gen1" }, onLine: () => {}, onChannelRevoked: () => { revoked = true; return true; } });
    const started = await client.start();
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.topicUrl).toMatch(/^https:\/\/t\.me\/c\/[0-9]+\/[1-9][0-9]*$/);
    const hub = serve.service.hub();
    if (hub === undefined) throw new Error("missing hub");
    const acknowledged = await serve.service.surface.revokeChannelBindings(hub, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1_000);
    expect(revoked).toBe(true);
    expect(acknowledged).toBe(true);
  } finally { await rig.cleanup(); }
});
