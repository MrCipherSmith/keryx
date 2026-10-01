// What the remote routes refuse, over a real socket: oversize and mistyped
// bodies, malformed ids, bad keyboards and approvals. Every refusal is a
// structured error and leaves the hub exactly as it was.

import { afterEach, describe, expect, test } from "bun:test";
import { MAX_REMOTE_BODY_BYTES, remoteRoutePath } from "./protocol";
import { call, makeRig, openRawStream, type Rig, type ServeInstance } from "./remote.http.test-helpers";

let rig: Rig;
let serve: ServeInstance;
afterEach(async () => {
  await rig.cleanup();
});

async function boot(): Promise<void> {
  rig = makeRig();
  serve = await rig.startServe();
}

function post(route: Parameters<typeof remoteRoutePath>[0], body: unknown, headers: Record<string, string> = {}): ReturnType<typeof call> {
  return call(serve.origin, serve.shellToken, "POST", remoteRoutePath(route), body, headers);
}

function errorCode(answer: { body: unknown }): string | undefined {
  return (answer.body as { error?: { code?: string } }).error?.code;
}

const REGISTER = { sessionId: "sess-sl-0001", project: "/work/app", name: "release" };

describe("bodies", () => {
  test("a body over the limit is refused before it is read: declared length and streamed", async () => {
    await boot();
    const big = JSON.stringify({ ...REGISTER, project: "x".repeat(MAX_REMOTE_BODY_BYTES) });
    const declared = await post("register", big);
    expect(declared.status).toBe(413);
    expect(errorCode(declared)).toBe("payload-too-large");

    // No content-length: a chunked body that grows past the limit.
    const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
    let sent = 0;
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { authorization: `Bearer ${serve.shellToken}`, "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > MAX_REMOTE_BODY_BYTES * 2) {
            controller.close();
            return;
          }
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
      duplex: "half",
    };
    const response = await fetch(`${serve.origin}${remoteRoutePath("register")}`, init).catch(() => undefined);
    // Either the server answered 413, or it cut the connection once it had seen enough: never a 200.
    expect(response === undefined || response.status === 413).toBe(true);
    expect(serve.service.hub()?.list()).toEqual([]);
  });

  test("anything but application/json is 415", async () => {
    await boot();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonp", "multipart/form-data"]) {
      const response = await fetch(`${serve.origin}${remoteRoutePath("register")}`, {
        method: "POST",
        headers: { authorization: `Bearer ${serve.shellToken}`, "content-type": type },
        body: JSON.stringify(REGISTER),
      });
      expect({ type, status: response.status }).toEqual({ type, status: 415 });
    }
    const none = await fetch(`${serve.origin}${remoteRoutePath("register")}`, { method: "POST", headers: { authorization: `Bearer ${serve.shellToken}` }, body: "{}" });
    // Bun fills in text/plain for a string body; either way it is not JSON.
    expect(none.status).toBe(415);
  });

  test("malformed JSON, and JSON that is not an object, are 400", async () => {
    await boot();
    for (const body of ["{", "", "null", "[]", "7", '"text"']) {
      const answer = await post("register", body);
      expect({ body, status: answer.status, code: errorCode(answer) }).toEqual({ body, status: 400, code: "invalid-request" });
    }
  });

  test("the hub saw none of it", async () => {
    await boot();
    await post("register", "{");
    expect(serve.service.hub()?.list()).toEqual([]);
  });
});

describe("ids are validated by shape, never by prefix", () => {
  test("a bad session id is 400 on every route that takes one", async () => {
    await boot();
    const bad = ["", "..", "../etc", "a b", "a/b", "x".repeat(65), "sess-1\n", "-sess", 5, null, ["sess"], { id: "x" }];
    for (const route of ["register", "deregister", "heartbeat", "reply", "approval", "ack"] as const) {
      for (const sessionId of bad) {
        const answer = await post(route, { ...REGISTER, sessionId, text: "t", prompt: "p", updateId: 1 });
        expect({ route, sessionId, status: answer.status }).toEqual({ route, sessionId, status: 400 });
      }
    }
    for (const sessionId of ["", "..", "a b", "x".repeat(65), "a%2Fb", "sess-1&x=1"]) {
      const stream = await openRawStream(serve.origin, serve.shellToken, sessionId);
      expect({ sessionId, status: stream.status }).toEqual({ sessionId, status: 400 });
    }
    const missing = await call(serve.origin, serve.shellToken, "GET", remoteRoutePath("stream"));
    expect(missing.status).toBe(400);
    expect(serve.service.hub()?.list()).toEqual([]);
  });

  test("a well-formed id that was never registered is 404, not a crash", async () => {
    await boot();
    const ghost = "sess-sl-ghost";
    expect((await post("heartbeat", { sessionId: ghost })).status).toBe(404);
    expect((await post("reply", { sessionId: ghost, text: "hi" })).status).toBe(404);
    expect((await post("approval", { sessionId: ghost, prompt: "p" })).status).toBe(404);
    expect((await post("ack", { sessionId: ghost, updateId: 1 })).status).toBe(404);
    const stream = await openRawStream(serve.origin, serve.shellToken, ghost);
    expect(stream.status).toBe(404);
    // Deregistering what does not exist is not an error: it is already gone.
    const gone = await post("deregister", { sessionId: ghost });
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ existed: false });
  });

  test("register fields: project and name are bounded and clean", async () => {
    await boot();
    for (const body of [
      { sessionId: "sess-sl-0002" },
      { sessionId: "sess-sl-0002", project: "" },
      { sessionId: "sess-sl-0002", project: "x".repeat(257) },
      { sessionId: "sess-sl-0002", project: "/a\u0000b" },
      { sessionId: "sess-sl-0002", project: "/a", name: "n".repeat(129) },
      { sessionId: "sess-sl-0002", project: "/a", name: "bad\nname" },
      { sessionId: "sess-sl-0002", project: "/a", name: 7 },
    ]) {
      const answer = await post("register", body);
      expect({ body, status: answer.status }).toEqual({ body, status: 400 });
    }
    expect(serve.service.hub()?.list()).toEqual([]);
  });

  test("a name another live session holds is 409, and a blank name means no name was asked for", async () => {
    await boot();
    expect((await post("register", REGISTER)).status).toBe(200);
    const taken = await post("register", { ...REGISTER, sessionId: "sess-sl-0003" });
    expect(taken.status).toBe(409);
    expect(errorCode(taken)).toBe("name-taken");
    const blank = await post("register", { ...REGISTER, sessionId: "sess-sl-0004", name: "   " });
    expect(blank.status).toBe(200);
    expect((blank.body as { name: string }).name).not.toBe("");
  });
});

describe("replies", () => {
  async function registered(): Promise<void> {
    await boot();
    expect((await post("register", REGISTER)).status).toBe(200);
  }

  test("text is required and bounded", async () => {
    await registered();
    for (const text of ["", 5, null, "x".repeat(20_001)]) {
      const answer = await post("reply", { sessionId: REGISTER.sessionId, text });
      expect({ status: answer.status }).toEqual({ status: 400 });
    }
    expect((await post("reply", { sessionId: REGISTER.sessionId, text: "x".repeat(20_000) })).status).toBe(200);
  });

  test("a keyboard that is empty, too big, or malformed is 400; a good one is queued", async () => {
    await registered();
    const button = (text: unknown, data: unknown): unknown => ({ text, data });
    const tooManyRows = Array.from({ length: 9 }, () => [button("a", "a")]);
    const tooManyButtons = [Array.from({ length: 9 }, () => button("a", "a"))];
    const cases: unknown[] = [
      [],
      [[]],
      "not an array",
      [["not a button"]],
      tooManyRows,
      tooManyButtons,
      [[button("", "a")]],
      [[button("x".repeat(65), "a")]],
      [[button("ok", "")]],
      [[button("ok", "d".repeat(65))]],
      [[button("ok", "é".repeat(33))]],
      [[button("ok", 5)]],
      [[button("ok", "ap:ap0123456789ab:allow")]],
      [[button("ok", "ap:anything")]],
    ];
    for (const keyboard of cases) {
      const answer = await post("reply", { sessionId: REGISTER.sessionId, text: "pick", keyboard });
      expect({ keyboard, status: answer.status }).toEqual({ keyboard, status: 400 });
    }
    const fine = await post("reply", { sessionId: REGISTER.sessionId, text: "pick", keyboard: [[button("Yes", "choice:yes"), button("No", "choice:no")]] });
    expect(fine.status).toBe(200);
  });
});

describe("approvals", () => {
  test("timeoutMs is an integer inside the allowed window", async () => {
    await boot();
    await post("register", REGISTER);
    const stream = await openRawStream(serve.origin, serve.shellToken, REGISTER.sessionId);
    expect(stream.status).toBe(200);
    for (const timeoutMs of [0, 99, 3_600_001, 1.5, "1000"]) {
      const answer = await post("approval", { sessionId: REGISTER.sessionId, prompt: "p", timeoutMs });
      expect({ timeoutMs, status: answer.status }).toEqual({ timeoutMs, status: 400 });
    }
    for (const prompt of ["", 5, "x".repeat(3_001)]) {
      expect((await post("approval", { sessionId: REGISTER.sessionId, prompt })).status).toBe(400);
    }
    expect((await post("approval", { sessionId: REGISTER.sessionId, prompt: "ok", timeoutMs: 100 })).status).toBe(200);
    stream.close();
  });

  test("at most eight wait at once per session", async () => {
    await boot();
    await post("register", REGISTER);
    const stream = await openRawStream(serve.origin, serve.shellToken, REGISTER.sessionId);
    const statuses: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      statuses.push((await post("approval", { sessionId: REGISTER.sessionId, prompt: `p${i}`, timeoutMs: 60_000 })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 429]);
    stream.close();
  });

  test("ack takes a non-negative integer", async () => {
    await boot();
    await post("register", REGISTER);
    for (const updateId of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 2]) {
      const answer = await post("ack", { sessionId: REGISTER.sessionId, updateId });
      expect({ updateId, status: answer.status }).toEqual({ updateId, status: 400 });
    }
    expect((await post("ack", { sessionId: REGISTER.sessionId, updateId: 5 })).status).toBe(200);
  });
});
