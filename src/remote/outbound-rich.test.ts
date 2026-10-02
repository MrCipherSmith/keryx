// Rich messages on the way out (flow 395; AC5): `auto` sends a reply with a table through
// sendRichMessage and its edit through editMessageText with rich_message; every refusal falls to
// HTML once, then to plain text once; nothing is dropped; each fallback is recorded with its
// reason. All against the fake Bot API; no socket is opened.

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { FakeBotApi } from "./fake-bot-api";
import { OutboundQueue, type OutboundEntry } from "./outbound-queue";
import { editRendered, MAX_REASON_LENGTH, type RenderFallback, RenderingState, RICH_PAUSE_MS, RICH_SERVER_ATTEMPTS, sendRendered } from "./rendering";
import { makeRemoteDir } from "./remote.test-helpers";
import { type RenderMode } from "./rendering-mode";
import { type BotApi, BotApiError } from "./types";

const TABLE = "| step | result |\n|---|--:|\n| build | ok |\n| smoke | **failed** |";
const PROSE = "Everything is **fine**.";
const CHAT = { chatId: 1 };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(mode: RenderMode = "auto"): { api: FakeBotApi; state: RenderingState; clock: { now: number }; seen: RenderFallback[]; hooks: { state: RenderingState; onFallback: (fallback: RenderFallback) => void } } {
  const api = new FakeBotApi({ chatId: 1 });
  const clock = { now: 1_000 };
  const state = new RenderingState({ now: () => clock.now, mode: () => mode });
  const seen: RenderFallback[] = [];
  return { api, state, clock, seen, hooks: { state, onFallback: (fallback) => seen.push(fallback) } };
}

const rejected = (method: string, status: number, message: string): BotApiError => new BotApiError("rejected", `${method}: ${status} ${message}`, { status });
const parseFailure = (): BotApiError => rejected("sendMessage", 400, "Bad Request: can't parse entities: Can't find end tag corresponding to start tag \"b\"");

describe("auto mode picks the step from the reply", () => {
  test("a reply with a table goes through sendRichMessage as a table block", async () => {
    const { api, hooks, seen } = setup();
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    expect(api.callCount("sendRichMessage")).toBe(1);
    expect(api.callCount("sendMessage")).toBe(0);
    const message = api.sent[0];
    expect(message?.parseMode).toBeUndefined();
    expect(message?.richMessage?.blocks[0]?.type).toBe("table");
    expect(seen).toEqual([]);
  });

  test("a reply without a table stays on the HTML path", async () => {
    const { api, hooks } = setup();
    await sendRendered(api, { ...CHAT, text: PROSE }, hooks);
    expect(api.callCount("sendRichMessage")).toBe(0);
    expect(api.sent[0]).toMatchObject({ parseMode: "HTML", text: "Everything is <b>fine</b>." });
  });

  test("the thread and the keyboard ride on the rich message", async () => {
    const { api, hooks } = setup();
    const topic = await api.createForumTopic({ chatId: 1, name: "t" });
    await sendRendered(
      api,
      { chatId: 1, messageThreadId: topic.message_thread_id, text: TABLE, inlineKeyboard: [[{ text: "Yes", callback_data: "y" }]] },
      hooks,
    );
    expect(api.sent[0]).toMatchObject({ messageThreadId: topic.message_thread_id });
    expect(api.sent[0]?.inlineKeyboard).toEqual([[{ text: "Yes", callback_data: "y" }]]);
  });
});

describe("explicit modes", () => {
  test("rich sends even a reply with no table as a rich message", async () => {
    const { api, hooks } = setup("rich");
    await sendRendered(api, { ...CHAT, text: PROSE }, hooks);
    expect(api.callCount("sendRichMessage")).toBe(1);
    expect(api.sent[0]?.richMessage?.blocks[0]).toMatchObject({ type: "paragraph" });
  });

  test("html never tries rich, even for a table, and sends an aligned <pre>", async () => {
    const { api, hooks } = setup("html");
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    expect(api.callCount("sendRichMessage")).toBe(0);
    expect(api.sent[0]?.parseMode).toBe("HTML");
    expect(api.sent[0]?.text.startsWith("<pre>")).toBe(true);
  });

  test("plain sends no parse mode and no markup, with a table laid out as aligned lines", async () => {
    const { api, hooks } = setup("plain");
    await sendRendered(api, { ...CHAT, text: `${PROSE}\n\n${TABLE}` }, hooks);
    expect(api.sent[0]?.parseMode).toBeUndefined();
    expect(api.sent[0]?.text).toContain("Everything is **fine**.");
    expect(api.sent[0]?.text).not.toContain("|");
  });

  test("the mode is read for every message, so a change applies without a restart", async () => {
    const api = new FakeBotApi();
    let mode: RenderMode = "html";
    const state = new RenderingState({ mode: () => mode });
    await sendRendered(api, { ...CHAT, text: TABLE }, { state });
    mode = "rich";
    await sendRendered(api, { ...CHAT, text: TABLE }, { state });
    expect(api.sent.map((message) => message.richMessage !== undefined)).toEqual([false, true]);
  });

  test("a mode reader that throws counts as the default and never stops sending", async () => {
    const api = new FakeBotApi();
    const state = new RenderingState({
      mode: () => {
        throw new Error("config unreadable");
      },
    });
    expect(state.mode()).toBe("auto");
    await sendRendered(api, { ...CHAT, text: TABLE }, { state });
    expect(api.callCount("sendRichMessage")).toBe(1);
  });
});

function queueOver(api: FakeBotApi, state: RenderingState): OutboundQueue {
  const dir = makeRemoteDir();
  dirs.push(dir);
  const queue = new OutboundQueue({ api, dir, now: () => 1, rendering: state });
  queue.load();
  return queue;
}

describe("a refusal falls to HTML, once, with the same text (AC5)", () => {
  test("a 400 on the blocks resends the part as HTML and records why", async () => {
    const { api, hooks, seen, state } = setup();
    api.failNext("sendRichMessage", rejected("sendRichMessage", 400, "Bad Request: rich_message is invalid"));
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    expect(api.callCount("sendRichMessage")).toBe(1);
    expect(api.callCount("sendMessage")).toBe(1);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.parseMode).toBe("HTML");
    expect(api.sent[0]?.text.startsWith("<pre>")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ step: "rich-to-html", at: 1_000 });
    expect(seen[0]?.reason).toContain("rich_message is invalid");
    expect(state.lastFallback()).toEqual(seen[0] as RenderFallback);
  });

  test("a 400 about one part does not pause rich: the next table goes rich again", async () => {
    const { api, hooks } = setup();
    api.failNext("sendRichMessage", rejected("sendRichMessage", 400, "Bad Request: rich_message is invalid"));
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    expect(api.callCount("sendRichMessage")).toBe(2);
    expect(api.sent[1]?.richMessage).toBeDefined();
  });

  for (const support of ["unsupported", "forbidden"] as const) {
    test(`a bot that cannot send rich messages (${support}) gets HTML, and rich is paused for ten minutes`, async () => {
      const { api, hooks, seen, clock, state } = setup();
      api.setRichSupport(support);
      await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
      expect(api.sent).toHaveLength(1);
      expect(api.sent[0]?.parseMode).toBe("HTML");
      expect(seen[0]?.step).toBe("rich-to-html");
      expect(state.richPausedReason()).toBeDefined();
      expect(state.snapshot().richPausedUntil).toBe(clock.now + RICH_PAUSE_MS);

      // Inside the window rich is not tried again, but the fallback is still recorded.
      await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
      expect(api.callCount("sendRichMessage")).toBe(1);
      expect(seen).toHaveLength(2);
      expect(seen[1]?.reason).toContain("paused");

      // After the window it is tried again; once the server allows it, rich works.
      clock.now += RICH_PAUSE_MS + 1;
      api.setRichSupport("allowed");
      await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
      expect(api.callCount("sendRichMessage")).toBe(2);
      expect(api.sent[2]?.richMessage).toBeDefined();
      expect(state.richPausedReason()).toBeUndefined();
    });
  }

  test("a client with no rich method at all falls to HTML", async () => {
    const fake = new FakeBotApi();
    const bare: BotApi = {
      sendMessage: (params: Parameters<BotApi["sendMessage"]>[0]) => fake.sendMessage(params),
      editMessageText: (params: Parameters<BotApi["editMessageText"]>[0]) => fake.editMessageText(params),
    } as unknown as BotApi;
    const { hooks, seen } = setup();
    await sendRendered(bare, { ...CHAT, text: TABLE }, hooks);
    expect(fake.sent[0]?.parseMode).toBe("HTML");
    expect(seen[0]).toMatchObject({ step: "rich-to-html" });
  });

  test("a part that cannot be a rich message (over the block limit) is sent as HTML", async () => {
    const { api, hooks, seen } = setup("rich");
    const many = Array.from({ length: 520 }, (_, i) => `l${i}`).join("\n");
    await sendRendered(api, { ...CHAT, text: many }, hooks);
    expect(api.callCount("sendRichMessage")).toBe(0);
    expect(api.sent[0]?.parseMode).toBe("HTML");
    expect(seen[0]?.reason).toContain("blocks");
  });
});

describe("then plain, once (AC5)", () => {
  test("rich refused, then HTML refused as unparseable: the text goes out as plain, both steps recorded", async () => {
    const { api, hooks, seen, state } = setup();
    api.failNext("sendRichMessage", rejected("sendRichMessage", 400, "Bad Request: rich_message is invalid"));
    api.failNext("sendMessage", parseFailure());
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    expect(api.callCount("sendRichMessage")).toBe(1);
    expect(api.callCount("sendMessage")).toBe(2);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.parseMode).toBeUndefined();
    expect(api.sent[0]?.text).toContain("build");
    expect(api.sent[0]?.text).not.toContain("|");
    expect(seen.map((fallback) => fallback.step)).toEqual(["rich-to-html", "html-to-plain"]);
    expect(state.lastFallback()?.step).toBe("html-to-plain");
  });

  test("an HTML-only reply refused as unparseable goes out as plain", async () => {
    const { api, hooks, seen } = setup();
    api.failNext("sendMessage", parseFailure());
    await sendRendered(api, { ...CHAT, text: PROSE }, hooks);
    expect(api.sent[0]?.text).toBe(PROSE);
    expect(seen.map((fallback) => fallback.step)).toEqual(["html-to-plain"]);
  });

  test("a plain resend that is also refused is thrown, not swallowed: nothing is silently dropped", async () => {
    const { api, hooks } = setup();
    api.failNext("sendRichMessage", rejected("sendRichMessage", 400, "Bad Request: rich_message is invalid"));
    api.failNext("sendMessage", parseFailure(), 2);
    await expect(sendRendered(api, { ...CHAT, text: TABLE }, hooks)).rejects.toBeInstanceOf(BotApiError);
    expect(api.callCount("sendMessage")).toBe(2);
  });
});

describe("failures that are not refusals are left for the queue to retry", () => {
  for (const [name, error] of [
    ["a network error", new BotApiError("network", "sendRichMessage: network down")],
    ["a 5xx", new BotApiError("server", "sendRichMessage: 502 Bad Gateway", { status: 502 })],
    ["a 429", new BotApiError("rate-limited", "sendRichMessage: 429 Too Many Requests", { status: 429, retryAfterSec: 3 })],
  ] as const) {
    test(`${name} is thrown, with no fallback recorded and no HTML resend`, async () => {
      const { api, hooks, seen, state } = setup();
      api.failNext("sendRichMessage", error);
      await expect(sendRendered(api, { ...CHAT, text: TABLE }, hooks)).rejects.toBe(error);
      expect(api.callCount("sendMessage")).toBe(0);
      expect(seen).toEqual([]);
      expect(state.lastFallback()).toBeUndefined();
      expect(state.richPausedReason()).toBeUndefined();
    });
  }

  test("a throwing observer never costs the message", async () => {
    const { api, state } = setup();
    api.failNext("sendRichMessage", rejected("sendRichMessage", 400, "Bad Request: rich_message is invalid"));
    await sendRendered(
      api,
      { ...CHAT, text: TABLE },
      {
        state,
        onFallback: () => {
          throw new Error("observer broke");
        },
      },
    );
    expect(api.sent).toHaveLength(1);
  });

  test("a recorded reason never carries a bot token", async () => {
    const { api, hooks, seen } = setup();
    api.failNext("sendRichMessage", rejected("sendRichMessage", 400, "Bad Request: see https://relay.invalid/bot123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_0123456789/sendRichMessage"));
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    expect(seen[0]?.reason).not.toContain("ABCdefGHIjklMNOpqrSTUvwxYZ_0123456789");
  });
});

describe("editing a rich message (AC5)", () => {
  async function sentTable(api: FakeBotApi, hooks: { state: RenderingState }): Promise<number> {
    const sent = await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    return sent.message_id;
  }

  test("the edit of a reply with a table goes through editMessageText with rich_message", async () => {
    const { api, hooks, seen } = setup();
    const id = await sentTable(api, hooks);
    await editRendered(api, { chatId: 1, messageId: id, text: `${TABLE}\n| done | **yes** |` }, hooks);
    expect(api.callCount("editRichMessage")).toBe(1);
    expect(api.callCount("editMessageText")).toBe(0);
    expect(api.edits[0]).toMatchObject({ messageId: id, kind: "rich" });
    expect(api.edits[0]?.richMessage?.blocks[0]?.type).toBe("table");
    expect(seen).toEqual([]);
  });

  test("an edit of a reply without a table is an HTML edit", async () => {
    const { api, hooks } = setup();
    const sent = await sendRendered(api, { ...CHAT, text: PROSE }, hooks);
    await editRendered(api, { chatId: 1, messageId: sent.message_id, text: "Edited **text**" }, hooks);
    expect(api.callCount("editRichMessage")).toBe(0);
    expect(api.edits[0]).toMatchObject({ kind: "text", text: "Edited <b>text</b>" });
  });

  test("a refused rich edit is made once as an HTML edit and recorded", async () => {
    const { api, hooks, seen } = setup();
    const id = await sentTable(api, hooks);
    api.failNext("editRichMessage", rejected("editMessageText", 400, "Bad Request: rich_message is invalid"));
    await editRendered(api, { chatId: 1, messageId: id, text: `${TABLE}\n| more | x |` }, hooks);
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]?.kind).toBe("text");
    expect(api.edits[0]?.text?.startsWith("<pre>")).toBe(true);
    expect(seen.map((fallback) => fallback.step)).toEqual(["rich-to-html"]);
  });

  test("then plain, when the HTML edit is refused as unparseable", async () => {
    const { api, hooks, seen } = setup();
    const id = await sentTable(api, hooks);
    api.failNext("editRichMessage", rejected("editMessageText", 400, "Bad Request: rich_message is invalid"));
    api.failNext("editMessageText", rejected("editMessageText", 400, "Bad Request: can't parse entities: unexpected end tag"));
    await editRendered(api, { chatId: 1, messageId: id, text: `${TABLE}\n| more | x |` }, hooks);
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]?.text).not.toContain("<pre>");
    expect(seen.map((fallback) => fallback.step)).toEqual(["rich-to-html", "html-to-plain"]);
  });

  test("'message is not modified' on a rich edit is the state we wanted: thrown as it is, not a fallback", async () => {
    const { api, hooks, seen } = setup();
    const id = await sentTable(api, hooks);
    await expect(editRendered(api, { chatId: 1, messageId: id, text: TABLE }, hooks)).rejects.toMatchObject({ message: expect.stringContaining("not modified") });
    expect(api.callCount("editMessageText")).toBe(0);
    expect(seen).toEqual([]);
  });

  test("a network error on a rich edit is thrown for the caller to retry", async () => {
    const { api, hooks, seen } = setup();
    const id = await sentTable(api, hooks);
    const error = new BotApiError("network", "editMessageText: network down");
    api.failNext("editRichMessage", error);
    await expect(editRendered(api, { chatId: 1, messageId: id, text: `${TABLE}\n| more | x |` }, hooks)).rejects.toBe(error);
    expect(seen).toEqual([]);
  });
});

describe("the durable queue", () => {
  function queueOver(api: FakeBotApi, state: RenderingState, onFallback?: (entry: OutboundEntry, fallback: RenderFallback) => void): OutboundQueue {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const queue = new OutboundQueue({ api, dir, now: () => 1, rendering: state, ...(onFallback === undefined ? {} : { onFallback }) });
    queue.load();
    return queue;
  }

  test("a table reply is stored as plain text and sent as a rich message", async () => {
    const { api, state } = setup();
    const queue = queueOver(api, state);
    queue.enqueue({ chatId: 1, text: TABLE });
    expect(queue.pending()[0]?.text).toBe(TABLE);
    await queue.flush();
    expect(api.sent[0]?.richMessage?.blocks[0]?.type).toBe("table");
  });

  test("a refusal is resent as HTML in the same flush, nothing is dropped, and the observer is told", async () => {
    const { api, state } = setup();
    const told: [OutboundEntry, RenderFallback][] = [];
    const queue = queueOver(api, state, (entry, fallback) => told.push([entry, fallback]));
    queue.enqueue({ chatId: 1, text: TABLE });
    queue.enqueue({ chatId: 1, text: PROSE });
    api.setRichSupport("forbidden");
    expect(await queue.flush()).toMatchObject({ sent: 2, dropped: 0, remaining: 0 });
    expect(api.sent.map((message) => message.parseMode)).toEqual(["HTML", "HTML"]);
    expect(told).toHaveLength(1);
    expect(told[0]?.[0].text).toBe(TABLE);
    expect(told[0]?.[1].step).toBe("rich-to-html");
  });

  test("a network error keeps the entry and retries it in the same mode", async () => {
    const { api, state } = setup();
    const queue = queueOver(api, state);
    queue.enqueue({ chatId: 1, text: TABLE });
    api.failNext("sendRichMessage", new BotApiError("network", "sendRichMessage: network down"));
    expect(await queue.flush()).toMatchObject({ sent: 0, remaining: 1 });
    expect(api.sent).toHaveLength(0);
    expect(await queue.flush()).toMatchObject({ sent: 1, remaining: 0 });
    expect(api.sent[0]?.richMessage).toBeDefined();
  });

  test("a long table is split into numbered parts and each is sent as a rich table with the header", async () => {
    const { api, state } = setup();
    const queue = queueOver(api, state);
    const rows = Array.from({ length: 300 }, (_, i) => `| row ${i} | value number ${i} |`);
    queue.enqueue({ chatId: 1, text: ["| id | value |", "|---|---|", ...rows].join("\n") });
    await queue.flush();
    expect(api.sent.length).toBeGreaterThan(1);
    for (const message of api.sent) {
      const table = message.richMessage?.blocks.find((block) => block.type === "table");
      expect(table).toBeDefined();
      if (table?.type === "table") {
        expect(table.cells[0]?.[0]?.text).toBe("id");
      }
    }
  });
});

describe("an error of one chat or topic is not a refusal of rich (R-4)", () => {
  const A = 11;

  for (const [name, status, text] of [
    ["403 bot kicked", 403, "Forbidden: bot was kicked from the supergroup chat"],
    ["403 bot blocked", 403, "Forbidden: bot was blocked by the user"],
    ["404 chat not found", 404, "Not Found: chat not found"],
    ["400 thread not found", 400, "Bad Request: message thread not found"],
  ] as const) {
    test(`${name} for topic A leaves topic B on rich, with nothing paused or recorded`, async () => {
      const { api, hooks, seen, state } = setup();
      api.failNext("sendRichMessage", rejected("sendRichMessage", status, text));
      api.failNext("sendMessage", rejected("sendMessage", status, text));
      await expect(sendRendered(api, { ...CHAT, messageThreadId: A, text: TABLE }, hooks)).rejects.toBeInstanceOf(BotApiError);
      expect(state.richPausedReason()).toBeUndefined();
      expect(state.lastFallback()).toBeUndefined();
      expect(seen).toEqual([]);

      const topicB = await api.createForumTopic({ chatId: 1, name: "B" });
      await sendRendered(api, { ...CHAT, messageThreadId: topicB.message_thread_id, text: TABLE }, hooks);
      expect(api.callCount("sendRichMessage")).toBe(2);
      expect(api.sent.at(-1)?.richMessage).toBeDefined();
      expect(seen).toEqual([]);
    });
  }

  test("a bare 404 is the method missing: rich is paused for every chat", async () => {
    const { api, hooks, state } = setup();
    api.setRichSupport("unsupported");
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    expect(state.richPausedReason()).toBeDefined();
  });
});

describe("a rich gateway that stays down does not stall the queue (R-5)", () => {
  test(`a 502 on the rich method is retried ${RICH_SERVER_ATTEMPTS - 1} times by the queue, then the part goes as HTML and the head is acked`, async () => {
    const { api, state } = setup();
    const queue = queueOver(api, state);
    queue.enqueue({ chatId: 1, text: TABLE });
    api.failNext("sendRichMessage", new BotApiError("server", "sendRichMessage: 502 Bad Gateway", { status: 502 }), 99);
    for (let attempt = 1; attempt < RICH_SERVER_ATTEMPTS; attempt += 1) {
      expect(await queue.flush()).toMatchObject({ sent: 0, remaining: 1 });
    }
    expect(await queue.flush()).toMatchObject({ sent: 1, remaining: 0 });
    expect(api.callCount("sendRichMessage")).toBe(RICH_SERVER_ATTEMPTS);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.parseMode).toBe("HTML");
    expect(state.lastFallback()?.step).toBe("rich-to-html");
  });

  test("a different message starts its own count", async () => {
    const { api, hooks } = setup();
    const gateway = new BotApiError("server", "sendRichMessage: 502 Bad Gateway", { status: 502 });
    api.failNext("sendRichMessage", gateway, 99);
    for (let attempt = 1; attempt < RICH_SERVER_ATTEMPTS; attempt += 1) {
      await expect(sendRendered(api, { ...CHAT, text: TABLE }, hooks)).rejects.toBe(gateway);
    }
    await expect(sendRendered(api, { ...CHAT, text: `${TABLE}\n| more | row |` }, hooks)).rejects.toBe(gateway);
    expect(api.sent).toHaveLength(0);
  });
});

describe("the stored reason is short and never echoes the message (S-001)", () => {
  test("only the status and the text before the first quotation mark are kept, at most 200 characters", async () => {
    const { api, hooks, seen } = setup();
    const echoed = `Bad Request: can't parse entities: Can't find end tag corresponding to start tag "${"secret text ".repeat(60)}"`;
    api.failNext("sendRichMessage", rejected("sendRichMessage", 400, "Bad Request: rich_message is invalid"));
    api.failNext("sendMessage", rejected("sendMessage", 400, echoed));
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    expect(seen.map((fallback) => fallback.step)).toEqual(["rich-to-html", "html-to-plain"]);
    const reason = seen[1]?.reason ?? "";
    expect(reason).toBe("400 Bad Request: can't parse entities: Can't find end tag corresponding to start tag");
    expect(reason).not.toContain("secret");
  });

  test("a description without a quote is capped at 200 characters", async () => {
    const { api, hooks, seen } = setup();
    api.failNext("sendRichMessage", rejected("sendRichMessage", 400, `Bad Request: ${"x".repeat(900)}`));
    await sendRendered(api, { ...CHAT, text: TABLE }, hooks);
    expect(seen[0]?.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
  });
});
