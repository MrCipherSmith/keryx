// The SSE stream itself, read raw: keepalive, Last-Event-ID resume, one stream
// per session, and what a closing serve says. The client library is not used
// here, so each property is shown at the wire.

import { afterEach, describe, expect, test } from "bun:test";
import { remoteRoutePath } from "./protocol";
import { call, makeRig, openRawStream, type Rig, type ServeInstance, untilFrame } from "./remote.http.test-helpers";
import { OWNER_ID, settle, until } from "./remote.test-helpers";

let rig: Rig;
let serve: ServeInstance;
afterEach(async () => {
  await rig.cleanup();
});

const SESSION = "sess-st-0001";

async function boot(keepaliveMs?: number): Promise<number> {
  rig = makeRig();
  serve = await rig.startServe(keepaliveMs === undefined ? {} : { service: { surface: { keepaliveMs } } });
  const registered = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("register"), { sessionId: SESSION, project: "/work/app", name: "release" });
  if (registered.status !== 200) {
    throw new Error("register failed");
  }
  return (registered.body as { threadId: number }).threadId;
}

function ack(updateId: number): Promise<{ status: number }> {
  return call(serve.origin, serve.shellToken, "POST", remoteRoutePath("ack"), { sessionId: SESSION, updateId });
}

describe("the stream", () => {
  test("starts with a ready status and has the event-stream headers", async () => {
    await boot();
    const response = await fetch(`${serve.origin}${remoteRoutePath("stream")}?sessionId=${SESSION}`, { headers: { authorization: `Bearer ${serve.shellToken}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    await response.body?.cancel();
  });

  test("an idle stream carries keepalive comments, and the parser ignores them", async () => {
    await boot(25);
    const stream = await openRawStream(serve.origin, serve.shellToken, SESSION);
    await until(() => (stream.text().match(/: keepalive/g) ?? []).length >= 2, "two keepalives");
    expect(stream.frames.map((frame) => frame.event)).toEqual(["status"]);
    stream.close();
  });

  test("the keepalive keeps flowing past several intervals and the stream stays open", async () => {
    await boot(100);
    const stream = await openRawStream(serve.origin, serve.shellToken, SESSION);
    await untilFrame(stream, "status");
    await until(() => (stream.text().match(/: keepalive/g) ?? []).length >= 4, "four keepalives");
    expect(stream.ended()).toBe(false);
    stream.close();
  });
});

describe("Last-Event-ID", () => {
  test("a line is sent once, and the next waits for the ack of the first", async () => {
    const threadId = await boot();
    const stream = await openRawStream(serve.origin, serve.shellToken, SESSION);
    const one = rig.api.pushMessage({ fromId: OWNER_ID, text: "one", threadId });
    const two = rig.api.pushMessage({ fromId: OWNER_ID, text: "two", threadId });
    await until(() => stream.frames.some((frame) => frame.event === "inbound"), "the first line");
    await settle();
    await settle();
    expect(stream.frames.filter((frame) => frame.event === "inbound").map((frame) => frame.id)).toEqual([String(one.update_id)]);
    expect((await ack(one.update_id)).status).toBe(200);
    await until(() => stream.frames.filter((frame) => frame.event === "inbound").length === 2, "the second line after the first ack");
    expect(stream.frames.filter((frame) => frame.event === "inbound").map((frame) => frame.id)).toEqual([String(one.update_id), String(two.update_id)]);
    stream.close();
  });

  test("a reconnect that names the last completed id gets only what came after", async () => {
    const threadId = await boot();
    const first = await openRawStream(serve.origin, serve.shellToken, SESSION);
    const one = rig.api.pushMessage({ fromId: OWNER_ID, text: "one", threadId });
    await untilFrame(first, "inbound");
    // The shell finished "one" but the ack never made it; then the connection dropped.
    first.close();
    const two = rig.api.pushMessage({ fromId: OWNER_ID, text: "two", threadId });
    await settle();

    const second = await openRawStream(serve.origin, serve.shellToken, SESSION, { "last-event-id": String(one.update_id) });
    expect(second.status).toBe(200);
    await untilFrame(second, "inbound");
    await settle();
    const ids = second.frames.filter((frame) => frame.event === "inbound").map((frame) => frame.id);
    expect(ids).toEqual([String(two.update_id)]);
    second.close();
  });

  test("a reconnect that names nothing is sent the line again: at-least-once on the wire", async () => {
    const threadId = await boot();
    const first = await openRawStream(serve.origin, serve.shellToken, SESSION);
    const one = rig.api.pushMessage({ fromId: OWNER_ID, text: "one", threadId });
    await untilFrame(first, "inbound");
    first.close();
    await settle();

    const second = await openRawStream(serve.origin, serve.shellToken, SESSION);
    const again = await untilFrame(second, "inbound");
    expect(again.id).toBe(String(one.update_id));
    second.close();
  });

  test("a malformed Last-Event-ID is ignored, not trusted", async () => {
    const threadId = await boot();
    const first = await openRawStream(serve.origin, serve.shellToken, SESSION);
    const one = rig.api.pushMessage({ fromId: OWNER_ID, text: "one", threadId });
    await untilFrame(first, "inbound");
    first.close();
    await settle();
    for (const bogus of ["-1", "1e9", "abc", "99999999999999999999", ""]) {
      const stream = await openRawStream(serve.origin, serve.shellToken, SESSION, { "last-event-id": bogus });
      const frame = await untilFrame(stream, "inbound");
      expect({ bogus, id: frame.id }).toEqual({ bogus, id: String(one.update_id) });
      stream.close();
      await settle();
    }
  });
});

describe("one stream per session", () => {
  test("a newer stream supersedes the older one, which is told and closed", async () => {
    const threadId = await boot();
    const older = await openRawStream(serve.origin, serve.shellToken, SESSION);
    await untilFrame(older, "status");
    const newer = await openRawStream(serve.origin, serve.shellToken, SESSION);
    await until(() => older.ended(), "the older stream to close");
    expect(older.frames.map((frame) => (frame.event === "status" ? (JSON.parse(frame.data) as { kind: string }).kind : frame.event))).toEqual(["ready", "superseded"]);

    rig.api.pushMessage({ fromId: OWNER_ID, text: "to the new one", threadId });
    const delivered = await untilFrame(newer, "inbound");
    expect(JSON.parse(delivered.data)).toMatchObject({ text: "to the new one" });
    expect(older.frames.some((frame) => frame.event === "inbound")).toBe(false);
    newer.close();
  });

  test("two sessions have independent streams", async () => {
    const threadId = await boot();
    const other = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("register"), { sessionId: "sess-st-0002", project: "/work/b", name: "other" });
    expect(other.status).toBe(200);
    const a = await openRawStream(serve.origin, serve.shellToken, SESSION);
    const b = await openRawStream(serve.origin, serve.shellToken, "sess-st-0002");
    rig.api.pushMessage({ fromId: OWNER_ID, text: "for a only", threadId });
    await untilFrame(a, "inbound");
    await settle();
    expect(b.frames.some((frame) => frame.event === "inbound")).toBe(false);
    expect(a.ended() || b.ended()).toBe(false);
    a.close();
    b.close();
  });
});

describe("a serve that is stopping", () => {
  test("tells the stream it is closing, then ends it", async () => {
    await boot();
    const stream = await openRawStream(serve.origin, serve.shellToken, SESSION);
    await untilFrame(stream, "status");
    await serve.stop();
    await until(() => stream.ended(), "the stream to end");
    const kinds = stream.frames.filter((frame) => frame.event === "status").map((frame) => (JSON.parse(frame.data) as { kind: string }).kind);
    expect(kinds).toEqual(["ready", "closing"]);
  });

  test("deregistering ends that session's stream", async () => {
    await boot();
    const stream = await openRawStream(serve.origin, serve.shellToken, SESSION);
    await untilFrame(stream, "status");
    const left = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("deregister"), { sessionId: SESSION });
    expect(left.status).toBe(200);
    await until(() => stream.ended(), "the stream to end");
  });
});
