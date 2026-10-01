// AC8 (flow 377): Disconnect deletes every topic, stops polling and erases the token and the
// config. With serve down the files are erased anyway and the answer says the topics remain.
//
// Real loopback serve, fake Bot API, real shell client. No live network.

import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { botTokenPath, remoteConfigPath } from "./paths";
import { BOT_TOKEN, connectFully, makeChannelsRig, type ChannelsRig } from "./channels.test-helpers";
import { ChannelsClient } from "./channels-client";
import { makeRig } from "./remote.http.test-helpers";
import { readTree, settle, until } from "./remote.test-helpers";
import { BotApiError } from "./types";

let r: ChannelsRig | undefined;
afterEach(async () => {
  await r?.rig.cleanup();
  r = undefined;
});

async function openSessions(rig: ChannelsRig, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const shell = rig.rig.makeClient({
      sessionId: `sess-disc-000${i}`,
      project: `/work/app${i}`,
      name: `release-${i}`,
      onLine: () => undefined,
    });
    const started = await shell.start();
    expect(started.ok).toBe(true);
  }
  await until(() => rig.rig.api.topics().length === count, `${count} topics`);
}

describe("Disconnect with serve running", () => {
  test("deletes every topic, stops polling and erases the token and the config", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    await openSessions(r, 3);
    await until(() => r?.rig.api.activePollers() === 1, "the hub to poll");

    const result = await r.client.disconnect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deleted).toBe(3);
      expect(result.value.remaining).toBe(0);
      expect(result.value.topicsDeleted).toBe(true);
      expect(result.value.erased).toBe(true);
      expect(result.value.message).toContain("3 topics deleted");
    }

    expect(r.rig.api.topics()).toEqual([]);
    expect(r.rig.api.deletedTopics).toHaveLength(3);
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
    expect(r.serve.service.hub()).toBeUndefined();

    // Polling has stopped and stays stopped.
    await until(() => r?.rig.api.activePollers() === 0, "polling to stop");
    const polls = r.rig.api.callCount("getUpdates");
    await settle();
    await settle();
    expect(r.rig.api.callCount("getUpdates")).toBe(polls);

    const status = await r.client.status();
    expect(status.ok && status.value.telegram.state).toBe("not-connected");
  });

  test("with nothing running in the group it still erases the files and reports zero topics", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    const result = await r.client.disconnect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deleted).toBe(0);
      expect(result.value.erased).toBe(true);
      expect(result.value.message).toContain("0 topics deleted");
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
  });

  test("a topic Telegram will not delete is counted and named, and the files are still erased", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    await openSessions(r, 2);
    r.rig.api.failNext("deleteForumTopic", new BotApiError("network", "deleteForumTopic: request failed"));

    const result = await r.client.disconnect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deleted).toBe(1);
      expect(result.value.remaining).toBe(1);
      expect(result.value.topicsDeleted).toBe(false);
      expect(result.value.message).toContain("could not be deleted");
      expect(result.value.message).toContain("remain in the group");
    }
    expect(r.rig.api.topics()).toHaveLength(1);
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
  });

  test("Disconnect, then Connect again, works without restarting serve", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    await r.client.disconnect();
    expect(r.serve.service.hub()).toBeUndefined();

    await connectFully(r);
    expect(r.serve.service.hub()).toBeDefined();
    const test = await r.client.test();
    expect(test.ok).toBe(true);
  });

  test("with Telegram never connected there is nothing to delete and nothing to erase, and it says so honestly", async () => {
    r = await makeChannelsRig();
    const result = await r.client.disconnect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deleted).toBe(0);
      expect(result.value.topicsDeleted).toBe(false);
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
  });
});

describe("Disconnect with serve down", () => {
  test("the files are erased anyway and the answer says that the topics remain in the group", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    await openSessions(r, 2);
    const topicsBefore = r.rig.api.topics().length;
    await r.serve.stop();

    const result = await r.client.disconnect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.topicsDeleted).toBe(false);
      expect(result.value.deleted).toBe(0);
      expect(result.value.erased).toBe(true);
      expect(result.value.message).toContain("keryx serve is not running");
      expect(result.value.message).toContain("remain in the group");
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
    expect(r.rig.api.topics()).toHaveLength(topicsBefore);
  });

  test("the secret is gone from disk even then", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    await r.serve.stop();
    await r.client.disconnect();
    expect(readTree(r.rig.dir).filter((entry) => entry.text.includes(BOT_TOKEN))).toEqual([]);
    expect(existsSync(botTokenPath(r.rig.dir))).toBe(false);
    expect(existsSync(remoteConfigPath(r.rig.dir))).toBe(false);
  });
});

describe("Disconnect when serve is up but Telegram is not running in it", () => {
  test("a hub that lost the poller to another machine cannot delete topics: the files go and the answer says the topics remain", async () => {
    // A configured machine, and another poller already holds the token: the hub never comes up.
    const rig = makeRig({ configured: true });
    const intruder = rig.api.connect("another-machine");
    const abort = new AbortController();
    const parked = intruder.getUpdates({ timeoutSec: 5, signal: abort.signal }).catch(() => undefined);
    await until(() => rig.api.activePollers() === 1, "the other poller to park");
    const serve = await rig.startServe({ service: { pairing: { code: "ABCD2345" } } });
    const client = new ChannelsClient({ dir: rig.dir });
    r = { rig, serve, client };
    await until(async () => {
      const status = await client.status();
      return status.ok && status.value.telegram.state === "off";
    }, "the hub to give up", 8_000);
    abort.abort();
    await parked;

    const result = await r.client.disconnect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.topicsDeleted).toBe(false);
      expect(result.value.erased).toBe(true);
      expect(result.value.message).toContain("remain in the group");
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
  });
});
