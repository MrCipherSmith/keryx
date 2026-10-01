// Restart over the real channel: serve dies between handing a line to the shell
// and recording that the shell took it. The line is not lost and not run twice.
//
//   serve 1: delivers, the shell runs it and acks over HTTP, then the journal ack
//            "crashes" (the hub's `beforeAck` seam throws), and serve 1 stops;
//   serve 2: same config dir, new port. The shell's stream reconnects (it re-reads
//            the endpoint file), re-registers under the same name (same topic), the
//            journalled line is redelivered, the shell recognises the update id,
//            acks it again without running it again, and serve 2 settles the journal.

import { afterEach, describe, expect, test } from "bun:test";
import { InboundQueues } from "./inbound";
import { nameKey } from "./naming";
import { makeRig, type Rig } from "./remote.http.test-helpers";
import { OWNER_ID, settle, until } from "./remote.test-helpers";

let rig: Rig;
afterEach(async () => {
  await rig.cleanup();
});

describe("serve restart between receive and ack, over real HTTP", () => {
  test("the line is delivered exactly once to the shell", async () => {
    rig = makeRig();
    let crash = true;
    const first = await rig.startServe({
      service: {
        beforeAck: () => {
          if (crash) {
            throw new Error("serve died before it recorded the ack");
          }
        },
      },
    });
    const lines: { text: string; updateId: number }[] = [];
    const client = rig.makeClient({
      sessionId: "sess-rs-0001",
      project: "/work/app",
      name: "release",
      onLine: (text, meta) => {
        lines.push({ text, updateId: meta.updateId });
      },
    });
    const started = await client.start();
    if (!started.ok) {
      throw new Error("register failed");
    }
    const pushed = rig.api.pushMessage({ fromId: OWNER_ID, text: "deploy now", threadId: started.threadId });
    await until(() => lines.length === 1, "the line to reach the shell");
    // Serve keeps the entry: the shell took it, but the journal was never told.
    await until(() => rig.events.some((event) => event.type === "delivery-failed"), "the failed ack");
    expect(new InboundQueues({ dir: rig.dir }).pending(nameKey("release"))).toHaveLength(1);

    crash = false;
    await first.stop();
    await until(() => !client.connected, "the shell to notice serve is gone");

    const second = await rig.startServe();
    expect(second.port).not.toBe(first.port);
    // The shell finds the new serve by itself.
    await until(() => client.connected, "the shell to reconnect to the new serve", 10_000);
    expect(client.threadId).toBe(started.threadId);
    await until(() => new InboundQueues({ dir: rig.dir }).pending(nameKey("release")).length === 0, "the journal to settle", 10_000);
    await settle();
    await settle();

    expect(lines).toEqual([{ text: "deploy now", updateId: pushed.update_id }]);
    // Still working afterwards, in the same topic.
    rig.api.pushMessage({ fromId: OWNER_ID, text: "and then this", threadId: started.threadId });
    await until(() => lines.length === 2, "the next line");
    expect(lines.map((line) => line.text)).toEqual(["deploy now", "and then this"]);
    expect(await client.reply("done")).toBe(true);
    await until(() => rig.api.sentTo(started.threadId).some((message) => message.text === "done"), "the reply after the restart");
  });

  test("a line that arrives while serve is down waits in Telegram and is delivered after the restart", async () => {
    rig = makeRig();
    const first = await rig.startServe();
    const lines: string[] = [];
    const client = rig.makeClient({ sessionId: "sess-rs-0002", project: "/work/app", name: "release", onLine: (text) => void lines.push(text) });
    const started = await client.start();
    if (!started.ok) {
      throw new Error("register failed");
    }
    await first.stop();
    rig.api.pushMessage({ fromId: OWNER_ID, text: "while serve was down", threadId: started.threadId });
    await settle();
    expect(lines).toEqual([]);

    await rig.startServe();
    await until(() => lines.length === 1, "the waiting line", 10_000);
    await settle();
    expect(lines).toEqual(["while serve was down"]);
  });

  test("a shell started before serve waits for it and registers when serve comes up", async () => {
    rig = makeRig();
    const lines: string[] = [];
    const client = rig.makeClient({ sessionId: "sess-rs-0003", project: "/work/app", name: "release", onLine: (text) => void lines.push(text) });
    const early = await client.start();
    expect(early.ok).toBe(false);
    expect(early.ok === false && early.retrying).toBe(true);

    await rig.startServe();
    await until(() => client.connected, "the shell to find serve", 10_000);
    expect(client.name).toBe("release");
    const threadId = client.threadId;
    if (threadId === undefined) {
      throw new Error("no topic after registering");
    }
    rig.api.pushMessage({ fromId: OWNER_ID, text: "hello late", threadId });
    await until(() => lines.length === 1, "the line");
  });
});
