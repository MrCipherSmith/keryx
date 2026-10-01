// AC9 (flow 377): the machine name comes from the hostname and appears in the Test message and
// in topic names. Nothing is configured per machine.
//
// Real loopback serve, fake Bot API, real shell client. No live network.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { remoteConfigPath } from "./paths";
import { connectFully, makeChannelsRig, type ChannelsRig } from "./channels.test-helpers";
import { defaultName, localMachineName, machineSlug } from "./naming";
import { until } from "./remote.test-helpers";

let r: ChannelsRig | undefined;
afterEach(async () => {
  await r?.rig.cleanup();
  r = undefined;
});

describe("the machine name is the hostname", () => {
  test("it is read from the hostname, trimmed", () => {
    expect(localMachineName(() => "  ws-berlin-07\n")).toBe("ws-berlin-07");
  });

  test("an empty or unreadable hostname falls back to a name that is still usable", () => {
    expect(localMachineName(() => "   ")).toBe("this-machine");
    expect(
      localMachineName(() => {
        throw new Error("no hostname");
      }),
    ).toBe("this-machine");
  });

  test("a hostname becomes a short, safe slug for topic names", () => {
    const slug = machineSlug("WS Berlin.07");
    expect(slug).not.toMatch(/\s/);
    expect(slug.length).toBeGreaterThan(0);
    expect(machineSlug("???")).toBe("machine");
  });

  test("two machines get different topic names for the same project and session", () => {
    const a = defaultName("/work/app", "sess-aaaa-1111", undefined, "ws-berlin-07");
    const b = defaultName("/work/app", "sess-aaaa-1111", undefined, "ws-tokyo-02");
    expect(a).not.toBe(b);
    expect(a.startsWith(`${machineSlug("ws-berlin-07")}-`)).toBe(true);
    expect(b.startsWith(`${machineSlug("ws-tokyo-02")}-`)).toBe(true);
  });
});

describe("nothing is configured per machine", () => {
  test("the config Connect writes holds no machine key", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    const config = JSON.parse(readFileSync(remoteConfigPath(r.rig.dir), "utf8")) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(["allowedUserIds", "chatId", "orphanMs", "runTimeoutMs", "schemaVersion"]);
    expect(JSON.stringify(config)).not.toContain(localMachineName());
  });

  test("by default serve reports the local hostname as the machine", async () => {
    r = await makeChannelsRig();
    const status = await r.client.status();
    expect(status.ok && status.value.machine).toBe(localMachineName());
  });
});

describe("the machine name shows where the operator looks", () => {
  test("the Test message names the machine, and so does the result", async () => {
    r = await makeChannelsRig({ service: { machine: "ws-berlin-07" } });
    await connectFully(r);
    const status = await r.client.status();
    expect(status.ok && status.value.machine).toBe("ws-berlin-07");

    const result = await r.client.test();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.machine).toBe("ws-berlin-07");
    }
    const general = r.rig.api.sent.filter((entry) => entry.chatId === r?.rig.api.chatId && entry.messageThreadId === undefined);
    expect(general).toHaveLength(1);
    expect(general[0]?.text).toContain("ws-berlin-07");
  });

  test("with topics named by machine, a session's topic starts with the machine's slug", async () => {
    r = await makeChannelsRig({ service: { machine: "ws-berlin-07", nameTopicsByMachine: true } });
    await connectFully(r);
    const shell = r.rig.makeClient({ sessionId: "sess-mach-0001", project: "/work/app", name: "", onLine: () => undefined });
    const started = await shell.start();
    expect(started.ok).toBe(true);
    await until(() => r?.rig.api.topics().length === 1, "the session's topic");
    expect(r.rig.api.topics()[0]?.name.startsWith(`${machineSlug("ws-berlin-07")}-`)).toBe(true);
  });

  test("without that option the topic names are unchanged", async () => {
    r = await makeChannelsRig({ service: { machine: "ws-berlin-07" } });
    await connectFully(r);
    const shell = r.rig.makeClient({ sessionId: "sess-mach-0002", project: "/work/app", name: "", onLine: () => undefined });
    const started = await shell.start();
    expect(started.ok).toBe(true);
    await until(() => r?.rig.api.topics().length === 1, "the session's topic");
    expect(r.rig.api.topics()[0]?.name.startsWith(`${machineSlug("ws-berlin-07")}-`)).toBe(false);
  });
});
