// Telegram HTML on the way out: every text keryx sends goes through the rendered
// path, a refused rendering falls back to plain text once, and the HTTP client
// carries `parse_mode`. All against the fake Bot API; no socket is opened.

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createHttpBotApi } from "./bot-api-http";
import { FakeBotApi } from "./fake-bot-api";
import { formatReply } from "./format";
import { checkTelegramHtml } from "./format-html";
import { OutboundQueue, type OutboundEntry } from "./outbound-queue";
import { RenderingState } from "./rendering";
import { type Harness, makeHarness, makeRemoteDir } from "./remote.test-helpers";
import { BotApiError, TELEGRAM_MAX_TEXT } from "./types";

const dirs: string[] = [];
let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function queueOver(api: FakeBotApi, onFallback?: (entry: OutboundEntry) => void): OutboundQueue {
  const dir = makeRemoteDir();
  dirs.push(dir);
  const queue = new OutboundQueue({ api, dir, now: () => 1, ...(onFallback === undefined ? {} : { onFallback }) });
  queue.load();
  return queue;
}

const parseFailure = (): BotApiError =>
  new BotApiError("rejected", "sendMessage: 400 Bad Request: can't parse entities: Can't find end tag corresponding to start tag \"b\"", { status: 400 });

describe("the outbound queue renders HTML at send time", () => {
  test("a reply goes out as HTML while the queued entry stays plain text", async () => {
    const api = new FakeBotApi();
    const queue = queueOver(api);
    queue.enqueue({ chatId: 1, text: "Result: **ok** with `a < b` & more" });
    expect(queue.pending()[0]?.text).toBe("Result: **ok** with `a < b` & more");
    await queue.flush();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.parseMode).toBe("HTML");
    expect(api.sent[0]?.text).toBe("Result: <b>ok</b> with <code>a &lt; b</code> &amp; more");
  });

  test("a 400 'can't parse entities' resends that part once as plain text and records it", async () => {
    const api = new FakeBotApi();
    const fallbacks: OutboundEntry[] = [];
    const queue = queueOver(api, (entry) => fallbacks.push(entry));
    queue.enqueue({ chatId: 1, text: "first **one**" });
    queue.enqueue({ chatId: 1, text: "second **two**" });
    api.failNext("sendMessage", parseFailure());
    const result = await queue.flush();
    expect(result).toMatchObject({ sent: 2, dropped: 0, remaining: 0 });
    expect(api.callCount("sendMessage")).toBe(3);
    expect(api.sent.map((message) => [message.text, message.parseMode])).toEqual([
      ["first **one**", undefined],
      ["second <b>two</b>", "HTML"],
    ]);
    expect(fallbacks.map((entry) => entry.text)).toEqual(["first **one**"]);
  });

  test("a part whose plain resend also fails is dropped like any rejected message, not retried forever", async () => {
    const api = new FakeBotApi();
    const dropped: string[] = [];
    const dir = makeRemoteDir();
    dirs.push(dir);
    const queue = new OutboundQueue({ api, dir, now: () => 1, onDrop: (_entry, reason) => dropped.push(reason) });
    queue.load();
    queue.enqueue({ chatId: 1, text: "x" });
    api.failNext("sendMessage", parseFailure(), 2);
    const result = await queue.flush();
    expect(result).toMatchObject({ sent: 0, dropped: 1, remaining: 0 });
    expect(api.callCount("sendMessage")).toBe(2);
    expect(dropped).toHaveLength(1);
  });

  test("a 400 that is not about entities is not resent as plain text", async () => {
    const api = new FakeBotApi();
    const queue = queueOver(api);
    queue.enqueue({ chatId: 1, text: "x" });
    api.failNext("sendMessage", new BotApiError("rejected", "sendMessage: 400 Bad Request: chat not found", { status: 400 }));
    await queue.flush();
    expect(api.callCount("sendMessage")).toBe(1);
  });

  test("a 5000+ character reply of 400 numbered lines goes out as several parts, each <= 4096 after rendering", async () => {
    const api = new FakeBotApi();
    const queue = queueOver(api);
    const text = Array.from({ length: 400 }, (_, i) => `${i + 1}. step **${i + 1}**: run \`task_${i}\` & check <out> (snake_case_ok)`).join("\n");
    expect(text.length).toBeGreaterThan(5000);
    const entries = queue.enqueue({ chatId: 1, text });
    expect(entries.length).toBe(formatReply(text).length);
    expect(entries.length).toBeGreaterThan(1);
    const result = await queue.flush();
    expect(result).toMatchObject({ sent: entries.length, dropped: 0, remaining: 0 });
    for (const message of api.sent) {
      const checked = checkTelegramHtml(message.text);
      expect(checked.ok).toBe(true);
      expect(message.parseMode).toBe("HTML");
      if (checked.ok) {
        expect(checked.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
      }
    }
    expect(api.sent.some((message) => message.text.includes("<b>1</b>"))).toBe(true);
  });

  test("a fenced block that crosses a split goes out as two valid pre blocks", async () => {
    const api = new FakeBotApi();
    const queue = queueOver(api);
    const code = Array.from({ length: 300 }, (_, i) => `if (a${i} < b && c > ${i}) { run(); }`).join("\n");
    queue.enqueue({ chatId: 1, text: `\`\`\`ts\n${code}\n\`\`\`` });
    await queue.flush();
    expect(api.sent.length).toBeGreaterThan(1);
    for (const message of api.sent) {
      expect(message.text).toContain('<pre><code class="language-ts">');
      expect(checkTelegramHtml(message.text).ok).toBe(true);
    }
  });
});

describe("every keryx text goes through the same path", () => {
  async function registered() {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "a<b>&c" });
    if (!reg.ok) {
      throw new Error("register failed");
    }
    await hub.start();
    await hub.flushOutbound();
    return { hub, reg };
  }

  test("status text sent with a session name that has < > & is HTML-escaped and valid", async () => {
    const { reg } = await registered();
    const sent = h?.api.sentTo(reg.threadId) ?? [];
    expect(sent.length).toBeGreaterThan(0);
    for (const message of sent) {
      expect(message.parseMode).toBe("HTML");
      expect(checkTelegramHtml(message.text).ok).toBe(true);
    }
    expect(sent.some((message) => message.text.includes("a&lt;b&gt;&amp;c"))).toBe(true);
  });

  test("a refused rendering of a hub send falls back to plain text and leaves a format-fallback event", async () => {
    const { hub, reg } = await registered();
    const api = h?.api as FakeBotApi;
    api.failNext("sendMessage", parseFailure());
    await hub.send("sess-one-0001", "answer with **bold** & <angle>");
    const last = api.sentTo(reg.threadId).at(-1);
    expect(last?.text).toBe("answer with **bold** & <angle>");
    expect(last?.parseMode).toBeUndefined();
    expect(hub.events().some((event) => event.type === "format-fallback")).toBe(true);
    expect(hub.outboundPending()).toBe(0);
  });

  test("the General message of a channel test is rendered, with the same fallback", async () => {
    const { hub } = await registered();
    const api = h?.api as FakeBotApi;
    await hub.sendGeneral("Keryx test message from my_host_1: Telegram is connected.");
    expect(api.sent.at(-1)?.parseMode).toBe("HTML");
    expect(api.sent.at(-1)?.text).toBe("Keryx test message from my_host_1: Telegram is connected.");
    api.failNext("sendMessage", parseFailure());
    await hub.sendGeneral("second **message**");
    expect(api.sent.at(-1)?.text).toBe("second **message**");
    expect(api.sent.at(-1)?.parseMode).toBeUndefined();
    expect(hub.events().filter((event) => event.type === "format-fallback")).toHaveLength(1);
  });
});

describe("the HTTP client", () => {
  test("sends parse_mode only when asked", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createHttpBotApi({ token: "123:abc", fetchImpl });
    await api.sendMessage({ chatId: 5, text: "plain" });
    await api.sendMessage({ chatId: 5, text: "<b>x</b>", parseMode: "HTML" });
    expect(bodies[0]).toEqual({ chat_id: 5, text: "plain" });
    expect(bodies[1]).toEqual({ chat_id: 5, text: "<b>x</b>", parse_mode: "HTML" });
  });

  test("a Telegram 400 about entities becomes a rejected BotApiError carrying the description", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const api = createHttpBotApi({ token: "123:abc", fetchImpl });
    const error = await api.sendMessage({ chatId: 5, text: "<x>", parseMode: "HTML" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BotApiError);
    expect((error as BotApiError).status).toBe(400);
    expect((error as BotApiError).message).toContain("can't parse entities");
  });
});

describe("the HTML path under the default `auto` mode (flow 395; AC5, AC9)", () => {
  test("a reply without a table is sent exactly as in 0.3.63: HTML, one sendMessage, no rich call", async () => {
    const api = new FakeBotApi();
    const queue = queueOver(api);
    queue.enqueue({ chatId: 1, text: "1. one\n2. two\n   - nested\n\n- [x] done\n- [ ] open\n\n---\n\n**end**" });
    await queue.flush();
    expect(api.callCount("sendRichMessage")).toBe(0);
    expect(api.callCount("sendMessage")).toBe(1);
    expect(api.sent[0]?.parseMode).toBe("HTML");
    expect(api.sent[0]?.text).toBe("1. one\n2. two\n   \u2022 nested\n\n\u2611 done\n\u2610 open\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n<b>end</b>");
  });

  test("a failed HTML resend in auto mode is recorded as html-to-plain with the same text", async () => {
    const api = new FakeBotApi();
    const steps: string[] = [];
    const dir = makeRemoteDir();
    dirs.push(dir);
    const queue = new OutboundQueue({ api, dir, now: () => 1, onFallback: (_entry, fallback) => steps.push(fallback.step) });
    queue.load();
    queue.enqueue({ chatId: 1, text: "see **this**" });
    api.failNext("sendMessage", parseFailure());
    await queue.flush();
    expect(steps).toEqual(["html-to-plain"]);
    expect(api.sent[0]).toMatchObject({ text: "see **this**" });
    expect(api.sent[0]?.parseMode).toBeUndefined();
  });

  test("a table in html mode is an aligned <pre>, one message, and never raw pipes", async () => {
    const api = new FakeBotApi();
    const dir = makeRemoteDir();
    dirs.push(dir);
    const queue = new OutboundQueue({ api, dir, now: () => 1, rendering: new RenderingState({ mode: () => "html" }) });
    queue.load();
    queue.enqueue({ chatId: 1, text: "| a | b |\n|---|---|\n| 1 | 2 |" });
    await queue.flush();
    expect(api.callCount("sendRichMessage")).toBe(0);
    expect(api.sent[0]?.text.startsWith("<pre>")).toBe(true);
    expect(api.sent[0]?.text).not.toContain("|---");
  });
});
