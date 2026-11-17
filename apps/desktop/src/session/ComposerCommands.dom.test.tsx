import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { AvailableCommand } from "../acp/types";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let Composer: typeof import("./Composer").Composer;
let createElement: typeof import("react").createElement;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  Composer = (await import("./Composer")).Composer;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const cmd = (name: string, group: string, hint?: string): AvailableCommand => ({
  name,
  description: `Description of ${name}`,
  input: hint ? { hint } : null,
  _meta: { keryx: { group, surface: "text", busy: "run" } },
});
// 12 commands: more than the old cap of 8.
const COMMANDS = [
  ...Array.from({ length: 10 }, (_, i) => cmd(`aa${i}`, "Alpha")),
  cmd("tasks", "Work", "[kill <id>]"),
  cmd("compact", "Work"),
];

function mount(over: Partial<import("react").ComponentProps<typeof Composer>> = {}) {
  const sent: string[] = [];
  const onSend = (t: string) => {
    sent.push(t);
    return true;
  };
  const render = (extra: typeof over = {}) =>
    root.render(
      createElement(Composer, {
        sessionId: "s1",
        busy: false,
        disabledReason: null,
        commands: COMMANDS,
        modes: null,
        model: undefined,
        sendKey: "enter",
        onSend,
        onStop: () => {},
        onMode: () => {},
        onModel: () => {},
        ...over,
        ...extra,
      }),
    );
  return { sent, render };
}

const area = () => host.querySelector("textarea")!;

async function type(value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(area(), value);
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    area().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

const options = () => Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
const names = () => options().map((o) => o.querySelector(".slash-name")!.textContent);

test("typing / lists every command grouped, uncapped, with hint and description", async () => {
  const m = mount();
  await act(() => m.render());
  await type("/");
  expect(options()).toHaveLength(12);
  expect(Array.from(host.querySelectorAll(".slash-group")).map((g) => g.textContent)).toEqual(["Alpha", "Work"]);
  const tasks = options().find((o) => o.textContent!.includes("/tasks"))!;
  expect(tasks.querySelector(".slash-hint")!.textContent).toBe("[kill <id>]");
  expect(tasks.querySelector(".slash-desc")!.textContent).toBe("Description of tasks");
});

test("the list filters as the name is typed", async () => {
  const m = mount();
  await act(() => m.render());
  await type("/ta");
  expect(names()).toEqual(["/tasks"]);
  await type("/zzz");
  expect(options()).toHaveLength(0);
});

test("arrow keys move the selection and Tab completes the name", async () => {
  const m = mount();
  await act(() => m.render());
  await type("/");
  await key("ArrowUp"); // wraps to the last
  expect(options().at(-1)!.getAttribute("aria-selected")).toBe("true");
  await key("Tab");
  expect(area().value).toBe("/compact ");
  expect(options()).toHaveLength(0); // the space closes the list
});

test("Enter on a partial name completes it, Enter on a complete command line runs it", async () => {
  const m = mount();
  await act(() => m.render());
  await type("/tas");
  await key("Enter");
  expect(m.sent).toHaveLength(0);
  expect(area().value).toBe("/tasks ");
  await key("Enter");
  expect(m.sent).toEqual(["/tasks"]);
  expect(area().value).toBe("");
});

test("Enter on an exactly typed command runs it without a space", async () => {
  const m = mount();
  await act(() => m.render());
  await type("/compact");
  await key("Enter");
  expect(m.sent).toEqual(["/compact"]);
});

test("normal text keeps Enter to send and Shift+Enter for a newline", async () => {
  const m = mount();
  await act(() => m.render());
  await type("hello");
  await key("Enter", { shiftKey: true });
  expect(m.sent).toHaveLength(0);
  await key("Enter");
  expect(m.sent).toEqual(["hello"]);
});

test("text with a leading space reaches onSend unchanged at the front", async () => {
  const m = mount();
  await act(() => m.render());
  await type(" /tasks");
  expect(options()).toHaveLength(0);
  await key("Enter");
  expect(m.sent).toEqual([" /tasks"]);
});

test("a refused send keeps the draft", async () => {
  const m = mount({ onSend: () => false });
  await act(() => m.render());
  await type("/tasks kill t9");
  await key("Enter");
  expect(area().value).toBe("/tasks kill t9");
});

test("while a turn runs Enter still submits (the parent queues it)", async () => {
  const m = mount({ busy: true });
  await act(() => m.render());
  await type("later");
  await key("Enter");
  expect(m.sent).toEqual(["later"]);
  expect(area().value).toBe("");
});
