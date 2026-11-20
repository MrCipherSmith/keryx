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

const plus = () => host.querySelector<HTMLButtonElement>('[aria-label="Add to message"]');
const menuItem = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
  .find((item) => item.textContent?.trim() === label);

test("the plus menu offers files, folders and slash commands without erasing the draft", async () => {
  const m = mount({ pickAttachmentFolder: async () => null, saveFile: async () => "/tmp/files/notes.txt" });
  await act(() => m.render());
  await type("keep this draft");
  await act(() => plus()?.click());
  expect(menuItem("Add files or images")?.disabled).toBe(false);
  expect(menuItem("Add folder")?.disabled).toBe(false);
  await act(() => menuItem("Slash commands")?.click());
  expect(names()).toContain("/tasks");
  expect(area().value).toBe("keep this draft");
  await key("Escape");
  expect(options()).toHaveLength(0);
});

test("the explicit slash picker preserves arguments and closes across sessions", async () => {
  const m = mount({ sessionId: "slash-first" });
  await act(() => m.render());
  await type("/tasks  kill t9\nmore");
  await act(() => plus()?.click());
  await act(() => menuItem("Slash commands")?.click());
  await key("ArrowUp");
  await key("Tab");
  expect(area().value).toBe("/compact  kill t9\nmore");
  await act(() => plus()?.click());
  await act(() => menuItem("Slash commands")?.click());
  expect(options().length).toBeGreaterThan(0);
  await act(() => m.render({ sessionId: "slash-second" }));
  await act(() => m.render());
  expect(options()).toHaveLength(0);
  expect(area().value).toBe("/compact  kill t9\nmore");
});

test("a folder chosen from the plus menu is attached and sent without a caption", async () => {
  const sent: unknown[] = [];
  const m = mount({ pickAttachmentFolder: async () => "/project/folder", onSend: (...args) => { sent.push(args); return true; } });
  await act(() => m.render({ sessionId: "folder-picker" }));
  await act(() => plus()?.click());
  await act(async () => menuItem("Add folder")?.click());
  expect(host.querySelector('[aria-label="Remove folder"]')?.tagName).toBe("BUTTON");
  await key("Enter");
  expect(sent).toEqual([["", [], [{ kind: "folder", label: "folder", path: "/project/folder" }]]]);
});

test("choosing a file from the plus menu saves it and sends its path", async () => {
  const stored: string[][] = [];
  const sent: unknown[] = [];
  const path = "/tmp/keryx-chat-images-test/file-123.txt";
  const m = mount({
    saveFile: async (extension, data) => { stored.push([extension, data]); return path; },
    onSend: (...args) => { sent.push(args); return true; },
  });
  await act(() => m.render({ sessionId: "file-picker" }));
  await act(() => plus()?.click());
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  const opened: string[] = [];
  input?.addEventListener("click", () => { opened.push("opened"); });
  await act(() => menuItem("Add files or images")?.click());
  expect(opened).toEqual(["opened"]);
  Object.defineProperty(input, "files", { value: [new File(["hello"], "notes.TXT", { type: "text/plain" })] });
  await act(async () => { input?.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(stored).toEqual([["txt", "aGVsbG8="]]);
  expect(host.querySelector('[aria-label="Remove notes.TXT"]')?.tagName).toBe("BUTTON");
  await key("Enter");
  expect(sent).toEqual([["", [], [{ kind: "file", label: "notes.TXT", path }]]]);
});

test("discard releases unsent files but sending retains stored attachments", async () => {
  const discarded: string[] = [];
  let stored = 0;
  const m = mount({ sessionId: "discard-draft", saveFile: async () => `/tmp/file-${++stored}.txt`,
    discardFile: async (path) => { discarded.push(path); } });
  await act(() => m.render());
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("File input is missing");
  Object.defineProperty(input, "files", { value: [new File(["draft"], "draft.txt", { type: "text/plain" })] });
  const select = () => act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await select();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove draft.txt"]')?.click());
  expect(discarded).toEqual(["/tmp/file-1.txt"]);
  expect(host.querySelector('[aria-label="Remove draft.txt"]')).toBeNull();
  await select();
  await key("Enter");
  expect(m.sent).toEqual([""]);
  expect(discarded).toEqual(["/tmp/file-1.txt"]);
});

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
