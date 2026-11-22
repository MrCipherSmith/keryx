import { expect, test } from "bun:test";
import { makeRig } from "./remote.http.test-helpers";

test("Desktop owner invalidates its binding before acknowledging channel revocation", async () => {
  const rig = makeRig();
  try {
    const serve = await rig.startServe();
    const events: string[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input).includes("channel-revoke-ack")) events.push("acknowledged");
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const client = rig.makeClient({
      sessionId: "desktop-revoke", project: "/project",
      owner: { kind: "desktop", incarnation: "owner1", generation: "gen1" },
      onLine: () => {},
      onChannelRevoked: () => { events.push("invalidated"); return true; },
      fetchImpl,
    });
    const started = await client.start();
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.topicUrl).toMatch(/^https:\/\/t\.me\/c\/[0-9]+\/[1-9][0-9]*$/);
    const hub = serve.service.hub();
    if (hub === undefined) throw new Error("missing hub");
    const acknowledged = await serve.service.surface.revokeChannelBindings(hub, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1_000);
    expect(events).toEqual(["invalidated", "acknowledged"]);
    expect(acknowledged).toBe(true);
  } finally { await rig.cleanup(); }
});
