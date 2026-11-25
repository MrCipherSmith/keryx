import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { SessionUpdate } from "../acp/types";
import type { Action, Item, TerminalRunItem } from "./reducer";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let Transcript: typeof import("./Transcript").Transcript;
let bus: typeof import("./terminalRunBus");
let reducerMod: typeof import("./reducer");

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  Transcript = (await import("./Transcript")).Transcript;
  bus = await import("./terminalRunBus");
  reducerMod = await import("./reducer");
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});
beforeEach(() => bus.setTerminalRunApi(null));
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const run = (over: Partial<TerminalRunItem> = {}): TerminalRunItem => ({
  kind: "terminalRun", id: 1, runId: "run-1", command: "bun test src", state: "running", tabOpen: true, ...over,
});
const render = (items: Item[]) => act(() => root.render(createElement(Transcript, { items, busy: false, replaying: false, empty: null, sessionId: "s1" })));
const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel) as T | null;
const status = () => q("[data-run-status]")!.textContent;
const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });

test("a running run: the command, 'running…', Show tab and Send output now; no exit code yet", async () => {
  await render([run()]);
  expect(q("[data-run]")!.getAttribute("data-run-state")).toBe("running");
  expect(q(".run-card-command")!.textContent).toBe("bun test src");
  expect(status()).toBe("running…");
  expect(q("[data-run-exit]")).toBeNull();
  expect(q("[data-run-show]")).not.toBeNull();
  expect(q("[data-run-send-now]")).not.toBeNull();
});

test("each state says where the result stands", async () => {
  const cases: Array<[Partial<TerminalRunItem>, string]> = [
    [{ state: "starting", tabOpen: false }, "starting…"],
    [{ state: "waiting", exitCode: 0 }, "waiting for the agent's turn to end"],
    [{ state: "sent", exitCode: 0 }, "sent to the agent"],
    [{ state: "sent-while-running" }, "output sent to the agent while it was running"],
    [{ state: "closed", tabOpen: false }, "closed before it finished"],
    [{ state: "start-failed", tabOpen: false, error: "no such file: /bin/zsh" }, "could not start: no such file: /bin/zsh"],
    [{ state: "not-sent", exitCode: 0, error: "this keryx does not take run results" }, "not sent: this keryx does not take run results"],
  ];
  for (const [over, words] of cases) {
    await render([run(over)]);
    expect(status()).toBe(words);
    // Send output now only while it runs and nothing was sent.
    expect(q("[data-run-send-now]")).toBeNull();
  }
});

test("the exit code reads ok or failed, with the duration", async () => {
  await render([run({ state: "sent", exitCode: 0, durationMs: 1500, tabOpen: false })]);
  expect(q("[data-run-exit]")!.textContent).toBe("exit 0");
  expect(q("[data-run-exit]")!.classList.contains("badge-ok")).toBe(true);
  expect(q("[data-run-duration]")!.textContent).toBe("1.5 s");
  await render([run({ state: "sent", exitCode: 2, durationMs: 80, tabOpen: false })]);
  expect(q("[data-run-exit]")!.textContent).toBe("exit 2");
  expect(q("[data-run-exit]")!.classList.contains("badge-danger")).toBe(true);
  await render([run({ state: "sent", exitCode: null, tabOpen: false })]);
  expect(q("[data-run-exit]")!.textContent).toBe("ended by a signal");
  expect(q("[data-run-exit]")!.classList.contains("badge-danger")).toBe(true);
});

test("the output tail is collapsed; it opens as text, never markup", async () => {
  await render([run({ state: "sent", exitCode: 1, output: "<b>boom</b>\nline 2", tabOpen: false })]);
  expect(q("[data-run-output]")).toBeNull();
  const toggle = q<HTMLButtonElement>("[data-run-output-toggle]")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await click(toggle);
  const out = q("[data-run-output]")!;
  expect(out.textContent).toBe("<b>boom</b>\nline 2");
  expect(out.querySelector("b")).toBeNull();
  expect(q<HTMLButtonElement>("[data-run-output-toggle]")!.getAttribute("aria-expanded")).toBe("true");
});

test("Show tab and Send output now go to the window's run tracker; Show tab goes once the tab is closed", async () => {
  const shown: string[] = [];
  const now: string[] = [];
  bus.setTerminalRunApi({ showTab: (id) => (shown.push(id), true), sendNow: (id) => void now.push(id) });
  await render([run()]);
  await click(q("[data-run-show]")!);
  await click(q("[data-run-send-now]")!);
  expect(shown).toEqual(["run-1"]);
  expect(now).toEqual(["run-1"]);
  await render([run({ state: "sent", exitCode: 0, tabOpen: false })]);
  expect(q("[data-run-show]")).toBeNull();
});

test("AC7: replayed terminalResult chunks draw run cards in a sent state with no actions; the continuation line draws nothing; no turn", async () => {
  const { applyUpdates, newConv } = reducerMod;
  const replayed = applyUpdates(newConv("s1", { replaying: true }), [
    { at: 1, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Fix the tests." }, _meta: { keryx: { parentTurn: 1 } } } },
    { at: 2, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Run this:" } } },
    {
      at: 3,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "$ bun test\n2 failed" },
        _meta: { keryx: { parentTurn: 1, terminalResult: { runId: "run-a", command: "bun test", state: "exited", exitCode: 1, durationMs: 2300, output: "2 failed" } } },
      },
    },
    {
      at: 4,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "$ bun run dev\nready" },
        _meta: { keryx: { parentTurn: 1, terminalResult: { runId: "run-b", command: "bun run dev", state: "running", durationMs: 900, output: "ready" } } },
      },
    },
    {
      at: 5,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "The commands you proposed ran in the operator's terminal; their results are in the terminal run notes above." },
        _meta: { keryx: { parentTurn: 2, terminalContinuation: true } },
      },
    },
    { at: 6, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Two tests fail." } } },
  ]);
  expect(replayed.busy).toBe(false);
  expect(replayed.parentTurn).toBe(2);
  const kinds = replayed.items.map((i) => i.kind);
  expect(kinds).toEqual(["user", "agent", "terminalRun", "terminalRun", "agent"]);
  expect(replayed.items[2]).toMatchObject({ runId: "run-a", command: "bun test", state: "sent", exitCode: 1, durationMs: 2300, output: "2 failed", replayed: true, tabOpen: false });
  expect(replayed.items[3]).toMatchObject({ runId: "run-b", state: "sent-while-running", output: "ready", replayed: true });
  expect((replayed.items[3] as TerminalRunItem).exitCode).toBeUndefined();

  await render(replayed.items);
  const cards = Array.from(host.querySelectorAll("[data-run]"));
  expect(cards.map((c) => c.getAttribute("data-run"))).toEqual(["run-a", "run-b"]);
  expect(cards[0]!.querySelector(".run-card-command")!.textContent).toBe("bun test");
  expect(cards[0]!.querySelector("[data-run-exit]")!.textContent).toBe("exit 1");
  expect(host.querySelectorAll(".turn-user")).toHaveLength(1); // the operator's own message only
  expect(host.textContent).not.toContain("The commands you proposed ran");
  expect(host.querySelector("[data-run-show], [data-run-send-now]")).toBeNull();
  // The follow-up reply is its own message, labelled as a new turn.
  expect(Array.from(host.querySelectorAll(".turn-agent.turn-start > .md")).map((m) => m.textContent?.trim())).toEqual(["Run this:", "Two tests fail."]);
});

/** A window with s1 shown, and helpers that play keryx's stream into it. */
function liveSession() {
  const { initialState, reducer } = reducerMod;
  let win = reducer({ ...initialState, phase: "ready" }, { t: "created", sessionId: "s1", show: true });
  let at = 0;
  const update = (u: SessionUpdate) => {
    win = reducer(win, { t: "updates", updates: [{ sessionId: "s1", at: ++at, update: u }] });
  };
  return {
    act: (a: Action) => void (win = reducer(win, a)),
    agent: (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
    tool: (toolCallId: string) => update({ sessionUpdate: "tool_call", toolCallId, title: "read", kind: "read", status: "completed" }),
    items: () => win.convs.s1!.items,
  };
}

test("a live delivery draws no user bubble: the card shows sent and the agent's reply streams after it as its own message", async () => {
  const s = liveSession();
  s.act({ t: "busy", sessionId: "s1", busy: true });
  s.agent("Run `ls`.");
  s.act({ t: "terminalRun", sessionId: "s1", run: { runId: "run-1", command: "ls", state: "running", tabOpen: true } });
  s.agent(" More text.");
  s.act({ t: "busy", sessionId: "s1", busy: false });
  s.act({ t: "terminalRun", sessionId: "s1", run: { runId: "run-1", command: "ls", state: "sent", exitCode: 0, durationMs: 40, output: "a", tabOpen: true } });
  s.act({ t: "terminalSent", sessionId: "s1", runIds: ["run-1"] });
  s.act({ t: "busy", sessionId: "s1", busy: true });
  s.agent("Found a.");
  const items = s.items();
  // DEG2-2: the reply the card was clicked in stays one message.
  expect(items.map((i) => i.kind)).toEqual(["agent", "terminalRun", "agent"]);
  expect(items[0]).toMatchObject({ kind: "agent", text: "Run `ls`. More text." });
  await render(items);
  expect(host.querySelector(".turn-user")).toBeNull();
  expect(status()).toBe("sent to the agent");
  expect(host.querySelector(".run-card + .turn-agent.turn-start, [data-run] + .turn-agent.turn-start")).not.toBeNull();
});

test("DEG-1: a Run clicked while the turn streams does not cut the reply: one message, one label, the card after the turn's stream", async () => {
  const s = liveSession();
  s.act({ t: "busy", sessionId: "s1", busy: true });
  s.agent("Run this:\n\n```bash\nbun test");
  s.act({ t: "terminalRun", sessionId: "s1", run: { runId: "run-1", command: "bun test", state: "starting", tabOpen: false } });
  s.agent(" src\n```\n\nThen look at the output.");
  s.tool("call-1");
  s.agent("Done reading.");
  const items = s.items();
  expect(items.map((i) => i.kind)).toEqual(["agent", "tool", "agent", "terminalRun"]);
  expect(items[0]).toMatchObject({ text: "Run this:\n\n```bash\nbun test src\n```\n\nThen look at the output." });
  // A fresh mount: a message the previous render showed would stream its new text in on a frame.
  await act(() => root.render(null));
  await act(() => root.render(createElement(Transcript, { items, busy: true, replaying: false, empty: null, sessionId: "s1" })));
  // One agent turn: one label, the whole fence in one code block, the live message still streaming.
  expect(host.querySelectorAll(".agent-label")).toHaveLength(1);
  expect(host.querySelectorAll(".code-block")).toHaveLength(1);
  expect(host.querySelector(".code-block code")!.textContent).toContain("bun test src");
  expect(host.querySelectorAll(".md.is-streaming")).toHaveLength(1);
  expect(host.querySelector(".md.is-streaming")!.textContent).toContain("Done reading.");
  expect(host.querySelector(".working")).toBeNull();
  const order = Array.from(host.querySelectorAll(".transcript-inner > *")).map((el) => (el.matches("[data-run]") ? "card" : el.className));
  expect(order.at(-1)).toBe("card");
});

test("FE-W1-002: a card not delivered yet opens no new agent turn; a delivered one does", async () => {
  const s = liveSession();
  s.agent("First.");
  s.act({ t: "terminalRun", sessionId: "s1", run: { runId: "run-1", command: "ls", state: "closed", tabOpen: false } });
  s.agent(" Second.");
  await render(s.items());
  expect(host.querySelectorAll(".agent-label")).toHaveLength(1);
  s.act({ t: "terminalRun", sessionId: "s1", run: { runId: "run-2", command: "pwd", state: "sent", exitCode: 0, tabOpen: false } });
  s.agent("Reply to the result.");
  await render(s.items());
  expect(host.querySelectorAll(".agent-label")).toHaveLength(2);
});

test("UX-001: a live card's status line is a live region in every state (assertive where the result will not reach the agent); a replayed one is none", async () => {
  await render([run()]);
  expect(q("[data-run-status]")!.getAttribute("role")).toBe("status");
  expect(q("[data-run-status]")!.getAttribute("aria-live")).toBe("polite");
  for (const state of ["not-sent", "closed", "start-failed"] as const) {
    await render([run({ state, tabOpen: false, error: "x" })]);
    expect(q("[data-run-status]")!.getAttribute("role")).toBe("status");
    expect(q("[data-run-status]")!.getAttribute("aria-live")).toBe("assertive");
  }
  await render([run({ state: "sent", exitCode: 0, tabOpen: false, replayed: true })]);
  expect(q("[data-run-status]")!.hasAttribute("role")).toBe(false);
  expect(q("[data-run-status]")!.hasAttribute("aria-live")).toBe(false);
});

/**
 * What a screen reader says while `change` runs, by the live-region rules: an alert is said when it is
 * inserted; any other live region only when the text of one already present changes.
 */
async function announced(change: () => Promise<void>): Promise<Array<{ politeness: string; text: string }>> {
  const live = "[role=status], [role=alert], [aria-live]:not([aria-live=off])";
  const before = new Map(Array.from(host.querySelectorAll(live)).map((el) => [el, el.textContent]));
  await change();
  const said: Array<{ politeness: string; text: string }> = [];
  for (const el of Array.from(host.querySelectorAll(live))) {
    const alert = el.getAttribute("role") === "alert";
    const politeness = el.getAttribute("aria-live") ?? (alert ? "assertive" : "polite");
    const text = el.textContent ?? "";
    if (before.has(el) ? before.get(el) !== text : alert && text !== "") said.push({ politeness, text });
  }
  return said;
}

test("R2-FE-002: a kept card remounted by a reload (a new id) or a session switch announces nothing; no alert is created", async () => {
  const unsent = run({ state: "not-sent", exitCode: 0, tabOpen: false, error: "this keryx does not take run results" });
  await render([unsent]);
  // keepLiveRuns gives a kept card a new id on every loadDone: a new key, a fresh mount.
  expect(await announced(() => render([{ ...unsent, id: 7 }]))).toEqual([]);
  // A session switch remounts the whole transcript.
  expect(await announced(async () => {
    await act(() => root.render(null));
    await render([{ ...unsent, id: 8 }]);
  })).toEqual([]);
  expect(host.querySelector("[role=alert]")).toBeNull();
});

test("R2-FE-002: a change of state is still announced: politely, and assertively into a state whose result will not reach the agent", async () => {
  await render([run()]);
  expect(await announced(() => render([run({ state: "waiting", exitCode: 0 })]))).toEqual([{ politeness: "polite", text: "waiting for the agent's turn to end" }]);
  expect(await announced(() => render([run({ state: "not-sent", exitCode: 0, error: "invalid params" })]))).toEqual([{ politeness: "assertive", text: "not sent: invalid params" }]);
});

test("UX-002: Send output now keeps the keyboard focus in the card when its button goes away, also after the card moves", async () => {
  bus.setTerminalRunApi({ showTab: () => true, sendNow: () => {} });
  const other: Item = { kind: "notice", id: 2, level: "info", text: "later line" };
  await render([run(), other]);
  const button = q<HTMLButtonElement>("[data-run-send-now]")!;
  button.focus();
  await click(button);
  await render([run({ state: "sent-while-running" }), other]);
  expect(q("[data-run-send-now]")).toBeNull();
  expect(document.activeElement).toBe(q("[data-run-status]"));
  // terminalSent moves the card to the end: the focus stays on it.
  await render([other, run({ state: "sent-while-running" })]);
  expect(document.activeElement).toBe(q("[data-run-status]"));
});

test("UX-002: a card does not take the focus the user moved elsewhere", async () => {
  bus.setTerminalRunApi({ showTab: () => true, sendNow: () => {} });
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  await render([run()]);
  await click(q<HTMLButtonElement>("[data-run-send-now]")!);
  elsewhere.focus();
  await render([run({ state: "sent-while-running" })]);
  expect(document.activeElement).toBe(elsewhere);
  elsewhere.remove();
});

test("the card's styles use the theme tokens", async () => {
  const css = ((await import("../styles/runs.css", { with: { type: "text" } })) as unknown as { default: string }).default;
  expect(css).toContain(".run-card {");
  expect(css).toMatch(/\.run-card \{[^}]*var\(--border\)/);
  expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  // UX-005: the duration is small text, so it takes the muted foreground (4.5:1 on the surface), not the subtle one.
  expect(css).toMatch(/\.run-card-dur \{[^}]*color: var\(--fg-muted\)/);
});
