// Flow 399 review T-1: every place the remote channel passes text through `redactSensitiveText`
// has a test that fails when that one call is replaced with the identity function.
//
// Why a shared fixture: the redactor and the history guard (`looksLikeSecret`) are two different
// nets. The history guard hides a turn that looks like a long token, so a fixture like
// `sk-ant-api03-...` never reaches the redactor at all and proves nothing about it. The fixture
// below is a secret the redactor masks and the guard does not flag.
//
// Where a site is behind a second redaction further down the same path (the reason of a
// fallback is redacted in `describe` and again in `record`), the test uses a text longer than
// the cap that sits between the two, so a secret cut in half by the cap is something only the
// FIRST redaction can have masked: the second one no longer recognises the half.

import { afterEach, describe, expect, test } from "bun:test";
import { createHttpBotApi } from "./bot-api-http";
import { BOT_TOKEN, connectFully, makeChannelsRig, type ChannelsRig } from "./channels.test-helpers";
import { FakeBotApi } from "./fake-bot-api";
import { looksLikeSecret } from "./history";
import { OutboundQueue } from "./outbound-queue";
import { Pairing } from "./pairing";
import { UpdatePoller, type PollerStatus } from "./poller";
import { call, makeRig, type Rig, type ServeInstance } from "./remote.http.test-helpers";
import { type Harness, makeHarness, makeRemoteDir, until } from "./remote.test-helpers";
import { remoteRoutePath } from "./protocol";
import { MAX_REASON_LENGTH, RenderingState, sendRendered } from "./rendering";
import { BotApiError } from "./types";
import { redactSensitiveText } from "../security/service";
import { rmSync } from "node:fs";

/** An AWS access key id: masked by the redactor, not flagged by `looksLikeSecret` (no mixed case run). */
const AWS = "AKIAIOSFODNN7EXAMPLE";
/** Enough of the key that a cut through it still shows. */
const AWS_HEAD = "AKIAIO";
const MASK = "[REDACTED:secret]";

test("the fixture is a secret the redactor masks and the history guard does not flag", () => {
  expect(looksLikeSecret(AWS)).toBe(false);
  expect(redactSensitiveText(`key ${AWS} end`)).toBe(`key ${MASK} end`);
});

describe("rendering.ts: what is kept of a refusal", () => {
  test("record redacts the reason it keeps (rendering.ts:94)", () => {
    const state = new RenderingState();
    const recorded = state.record("rich-to-html", `Bad Request: rejected ${AWS} for the chat`);
    expect(recorded.reason).not.toContain(AWS_HEAD);
    expect(recorded.reason).toContain(MASK);
    expect(state.lastFallback()?.reason).toBe(recorded.reason);
  });

  test("pauseRich redacts the reason that is shown while rich is paused (rendering.ts:101)", () => {
    const state = new RenderingState();
    state.pauseRich(`method not supported ${AWS}`);
    const reason = state.richPausedReason();
    expect(reason).toBeDefined();
    expect(reason).not.toContain(AWS_HEAD);
    expect(reason).toContain(MASK);
  });

  test("a description is redacted BEFORE the reason is capped, so the cap cannot cut a secret into a shape nothing recognises (rendering.ts:163)", async () => {
    const api = new FakeBotApi();
    const state = new RenderingState({ mode: () => "html" });
    // The secret starts just before the cap: capped first, the reason would end in "AKIAIOSF…".
    const description = `can't parse entities: ${"x".repeat(MAX_REASON_LENGTH - 50)} ${AWS} and more words after it`;
    api.failNext("sendMessage", new BotApiError("rejected", `sendMessage: 400 Bad Request: ${description}`, { status: 400 }));
    await sendRendered(api, { chatId: api.chatId, text: "hello" }, { state });
    const reason = state.lastFallback()?.reason ?? "";
    expect(reason.length).toBeGreaterThan(MAX_REASON_LENGTH - 60);
    expect(reason).not.toContain(AWS_HEAD);
    expect(api.sent.map((m) => m.text)).toEqual(["hello"]);
  });
});

describe("hub.ts", () => {
  let h: Harness;
  afterEach(async () => {
    await h.cleanup();
  });

  test("the reason a topic could not be created is redacted (hub.ts:160)", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    h.api.failNext("createForumTopic", new BotApiError("rejected", `createForumTopic: 400 Bad Request: ${AWS}`, { status: 400 }));
    const result = await hub.register({ sessionId: "sess-red-0001", project: "/work/app" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("api-error");
      expect(result.message).not.toContain(AWS_HEAD);
      expect(result.message).toContain(MASK);
    }
  });

  test("an event's detail is redacted: a session named like a secret never reaches the event feed (hub.ts:743)", async () => {
    h = makeHarness();
    const events: { type: string; detail?: string }[] = [];
    const hub = h.makeHub({ onEvent: (event) => events.push(event) });
    const result = await hub.register({ sessionId: "sess-red-0002", project: "/work/app", name: AWS });
    expect(result.ok).toBe(true);
    const created = events.find((event) => event.type === "topic-created");
    expect(created?.detail).toBeDefined();
    expect(JSON.stringify(events)).not.toContain(AWS_HEAD);
    expect(created?.detail).toContain(MASK);
  });
});

describe("http-surface.ts: a button label is redacted (http-surface.ts:595)", () => {
  let rig: Rig;
  let serve: ServeInstance;
  afterEach(async () => {
    await rig.cleanup();
  });

  test("a reply's button text reaches Telegram masked", async () => {
    rig = makeRig();
    serve = await rig.startServe();
    const post = (route: Parameters<typeof remoteRoutePath>[0], body: unknown) => call(serve.origin, serve.shellToken, "POST", remoteRoutePath(route), body);
    expect((await post("register", { sessionId: "sess-red-0003", project: "/work/app", name: "release" })).status).toBe(200);
    const answer = await post("reply", { sessionId: "sess-red-0003", text: "pick one", keyboard: [[{ text: `use ${AWS}`, data: "choice:one" }]] });
    expect(answer.status).toBe(200);
    await until(() => rig.api.sent.some((message) => message.inlineKeyboard !== undefined), "the keyboard reaches Telegram");
    const keyboard = rig.api.sent.find((message) => message.inlineKeyboard !== undefined)?.inlineKeyboard;
    expect(JSON.stringify(keyboard)).not.toContain(AWS_HEAD);
    expect(JSON.stringify(keyboard)).toContain(MASK);
    expect(keyboard?.[0]?.[0]?.callback_data).toBe("choice:one");
  });
});

describe("channels.ts: Test reports why Telegram refused (channels.ts:45)", () => {
  let r: ChannelsRig | undefined;
  afterEach(async () => {
    await r?.rig.cleanup();
    r = undefined;
  });

  test("the reason carries the description with the secret masked", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    r.rig.api.failNext("sendMessage", new BotApiError("rejected", `sendMessage: 400 Bad Request: refused for ${AWS}`, { status: 400 }));
    const result = await r.client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("refused for");
      expect(result.reason).not.toContain(AWS_HEAD);
      expect(result.reason).toContain(MASK);
      expect(result.reason).not.toContain(BOT_TOKEN);
    }
  });
});

describe("pairing.ts: could not reach Telegram (pairing.ts:76)", () => {
  test("the reason masks a secret in the transport's error", async () => {
    const api = new FakeBotApi();
    api.failNext("getMe", new BotApiError("network", `getMe: request failed (${AWS})`));
    const result = await Pairing.open({ api, code: "K7M2QX9P" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("unreachable");
      expect(result.reason).toContain("could not reach Telegram");
      expect(result.reason).not.toContain(AWS_HEAD);
      expect(result.reason).toContain(MASK);
    }
  });
});

describe("poller.ts: why the last cycle failed (poller.ts:183)", () => {
  test("a failing getUpdates leaves a masked reason", async () => {
    const statuses: PollerStatus[] = [];
    let calls = 0;
    const api = new FakeBotApi();
    const failing = {
      ...api.connect("poller"),
      getUpdates: async () => {
        calls += 1;
        throw new Error(`socket closed near ${AWS}`);
      },
    };
    const poller = new UpdatePoller({
      api: failing,
      sink: { accept: async () => undefined },
      // A real macrotask: a sleep that resolves at once would spin the loop in microtasks and starve the test's own timers.
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
      backoffMs: [1],
      onStatus: (status) => statuses.push(status),
    });
    poller.start();
    await until(() => calls >= 2, "two failed cycles");
    await poller.stop();
    const reasons = statuses.map((status) => status.reason).filter((reason): reason is string => reason !== undefined);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join("\n")).not.toContain(AWS_HEAD);
    expect(reasons.join("\n")).toContain(MASK);
  });
});

describe("outbound-queue.ts: what stopped a flush (outbound-queue.ts:266)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function queue(api: FakeBotApi, onDrop?: (entry: unknown, reason: string) => void): OutboundQueue {
    const dir = makeRemoteDir();
    dirs.push(dir);
    return new OutboundQueue({ api, dir, now: () => 1_000, ...(onDrop === undefined ? {} : { onDrop }) });
  }

  test("a retryable failure's description is masked in stoppedBy", async () => {
    const api = new FakeBotApi();
    const q = queue(api);
    q.enqueue({ chatId: api.chatId, text: "hello" });
    api.failNext("sendMessage", new BotApiError("network", `sendMessage: request failed (${AWS})`));
    const result = await q.flush();
    expect(result.sent).toBe(0);
    expect(result.remaining).toBe(1);
    expect(result.stoppedBy).toBeDefined();
    expect(result.stoppedBy).not.toContain(AWS_HEAD);
    expect(result.stoppedBy).toContain(MASK);
  });

  test("a permanent refusal's description is masked in the drop report", async () => {
    const api = new FakeBotApi();
    const dropped: string[] = [];
    const q = queue(api, (_entry, reason) => dropped.push(reason));
    q.enqueue({ chatId: api.chatId, text: "hello" });
    api.failNext("sendMessage", new BotApiError("rejected", `sendMessage: 403 Forbidden: ${AWS}`, { status: 403 }));
    const result = await q.flush();
    expect(result.dropped).toBe(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).not.toContain(AWS_HEAD);
    expect(dropped[0]).toContain(MASK);
  });
});

describe("bot-api-http.ts: the transport scrubs what Telegram echoes (bot-api-http.ts:52)", () => {
  test("a description carrying a secret other than the bot token is masked, and the token is still replaced", async () => {
    const token = "7123456789:AAFakeTokenForRedactionTests_abcdefghij";
    const stub = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: ${AWS} and bot${token}` }), { status: 400 });
    const api = createHttpBotApi({ token, baseUrl: "http://bot-api.invalid", fetchImpl: stub as unknown as typeof fetch });
    const error = await api.getMe().then(
      () => undefined,
      (caught: unknown) => caught as BotApiError,
    );
    expect(error).toBeInstanceOf(BotApiError);
    const message = error?.message ?? "";
    expect(message).not.toContain(AWS_HEAD);
    expect(message).toContain(MASK);
    expect(message).not.toContain("AAFakeTokenForRedactionTests");
    expect(message).toContain("[bot-token]");
  });
});
