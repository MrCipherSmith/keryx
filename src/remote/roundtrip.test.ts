// AC3: a message written in a session's topic reaches the running shell, and
// the shell's answer comes back to the SAME topic, over the whole real path:
//
//   fake Bot API -> poller -> hub -> serve (real listener, loopback socket)
//     -> SSE -> RemoteClient.onLine -> RemoteClient.reply -> serve -> hub -> fake Bot API
//
// Only Telegram is a fake. Everything between is the code `keryx serve` runs.

import { afterEach, describe, expect, test } from "bun:test";
import { OWNER_ID, STRANGER_ID, until } from "./remote.test-helpers";
import { call, makeRig, openRawStream, type Rig, untilFrame } from "./remote.http.test-helpers";

let rig: Rig;
afterEach(async () => {
  await rig.cleanup();
});

describe("round trip: topic -> shell -> same topic", () => {
  test("a line written in the topic reaches onLine, and reply lands in that topic", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const lines: { text: string; threadId: number; fromId: number; updateId: number }[] = [];
    const client = rig.makeClient({
      sessionId: "sess-rt-0001",
      project: "/work/app",
      name: "release",
      onLine: (text, meta) => {
        lines.push({ text, threadId: meta.threadId, fromId: meta.fromId, updateId: meta.updateId });
      },
    });
    const started = await client.start();
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.name).toBe("release");
    expect(client.connected).toBe(true);
    expect(rig.api.topics().map((topic) => topic.messageThreadId)).toEqual([started.threadId]);

    const pushed = rig.api.pushMessage({ fromId: OWNER_ID, text: "run the tests", threadId: started.threadId });
    await until(() => lines.length === 1, "the line to reach the shell");
    expect(lines[0]).toEqual({ text: "run the tests", threadId: started.threadId, fromId: OWNER_ID, updateId: pushed.update_id });

    expect(await client.reply("12 passed")).toBe(true);
    await until(() => rig.api.sentTo(started.threadId).some((message) => message.text === "12 passed"), "the reply in the topic");
    // Not in any other topic, and not in the general chat.
    expect(rig.api.sent.filter((message) => message.text === "12 passed").map((message) => message.messageThreadId)).toEqual([started.threadId]);
    expect(serve.shellToken).not.toBe("");
  });

  test("two sessions get two topics and their lines do not cross", async () => {
    rig = makeRig();
    await rig.startServe();
    const seen: Record<string, string[]> = { a: [], b: [] };
    const a = rig.makeClient({ sessionId: "sess-rt-a", project: "/work/a", name: "alpha", onLine: (text) => void seen.a?.push(text) });
    const b = rig.makeClient({ sessionId: "sess-rt-b", project: "/work/b", name: "beta", onLine: (text) => void seen.b?.push(text) });
    const [ra, rb] = await Promise.all([a.start(), b.start()]);
    if (!ra.ok || !rb.ok) {
      throw new Error("both sessions should register");
    }
    expect(ra.threadId).not.toBe(rb.threadId);

    rig.api.pushMessage({ fromId: OWNER_ID, text: "for alpha", threadId: ra.threadId });
    rig.api.pushMessage({ fromId: OWNER_ID, text: "for beta", threadId: rb.threadId });
    await until(() => seen.a?.length === 1 && seen.b?.length === 1, "both lines");
    expect(seen).toEqual({ a: ["for alpha"], b: ["for beta"] });

    await b.reply("beta says hi");
    await until(() => rig.api.sentTo(rb.threadId).some((message) => message.text === "beta says hi"), "beta reply");
    expect(rig.api.sentTo(ra.threadId).some((message) => message.text === "beta says hi")).toBe(false);
  });

  test("a message from a sender who is not on the allow list never reaches the shell", async () => {
    rig = makeRig();
    await rig.startServe();
    const lines: string[] = [];
    const client = rig.makeClient({ sessionId: "sess-rt-0002", project: "/work/app", name: "release", onLine: (text) => void lines.push(text) });
    const started = await client.start();
    if (!started.ok) {
      throw new Error("register failed");
    }
    rig.api.pushMessage({ fromId: STRANGER_ID, text: "rm -rf /", threadId: started.threadId });
    rig.api.pushMessage({ fromId: OWNER_ID, text: "hello", threadId: started.threadId });
    await until(() => lines.length >= 1, "the owner's line");
    expect(lines).toEqual(["hello"]);
  });

  test("the stream frame is SSE with the update id as the event id", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const registered = await call(serve.origin, serve.shellToken, "POST", "/v1/remote/register", { sessionId: "sess-rt-0003", project: "/work/app", name: "release" });
    expect(registered.status).toBe(200);
    const threadId = (registered.body as { threadId: number }).threadId;
    const stream = await openRawStream(serve.origin, serve.shellToken, "sess-rt-0003");
    expect(stream.status).toBe(200);
    const ready = await untilFrame(stream, "status");
    expect(JSON.parse(ready.data)).toEqual({ kind: "ready" });

    const pushed = rig.api.pushMessage({ fromId: OWNER_ID, text: "frame me", threadId });
    const inbound = await untilFrame(stream, "inbound");
    expect(inbound.id).toBe(String(pushed.update_id));
    expect(JSON.parse(inbound.data)).toMatchObject({ updateId: pushed.update_id, text: "frame me", threadId, fromId: OWNER_ID });
    stream.close();
  });
});
