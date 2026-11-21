import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { LineComment } from "./lineComments";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let React: typeof import("react");
let Composer: typeof import("./Composer").Composer;
let ChangedFilesButton: typeof import("./GitStatus").ChangedFilesButton;
let prefs: typeof import("../lib/prefs");

beforeAll(async () => {
  registerDom();
  React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  Composer = (await import("./Composer")).Composer;
  ChangedFilesButton = (await import("./GitStatus")).ChangedFilesButton;
  prefs = await import("../lib/prefs");
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const COMMENT: LineComment = { path: "src/a.ts", startLine: 12, endLine: 14, side: "new", text: "Rename this variable" };

type Handle = import("./Composer").ComposerHandle;
function mount(over: Partial<import("react").ComponentProps<typeof Composer>> = {}) {
  const ref = React.createRef<Handle>();
  const calls: unknown[][] = [];
  const discarded: string[] = [];
  const render = (extra: typeof over = {}) =>
    root.render(
      React.createElement(Composer, {
        ref,
        sessionId: "s1",
        busy: false,
        disabledReason: null,
        commands: [],
        modes: null,
        model: undefined,
        sendKey: "enter",
        onSend: (...args: unknown[]) => (calls.push(args), true),
        discardFile: async (p: string) => void discarded.push(p),
        onStop: () => {},
        onMode: () => {},
        onModel: () => {},
        ...over,
        ...extra,
      } as never),
    );
  return { ref, calls, discarded, render };
}

const chip = () => host.querySelector('[aria-label="Local attachments"] .comment-chip');
async function send() {
  await act(async () => {
    host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

test("a line comment becomes a chip with path:range and the start of its text", async () => {
  const m = mount();
  await act(() => m.render());
  await act(async () => void m.ref.current!.addLineComment(COMMENT));
  expect(chip()?.textContent).toContain("src/a.ts:12-14 Rename this variable");
  expect(host.querySelector('[aria-label="Remove comment on src/a.ts:12-14"]')?.tagName).toBe("BUTTON");
});

test("removing the chip is not a file discard", async () => {
  const m = mount();
  await act(() => m.render({ sessionId: "remove" }));
  await act(async () => void m.ref.current!.addLineComment(COMMENT));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label^="Remove comment on"]')?.click());
  expect(chip()).toBeNull();
  expect(m.discarded).toEqual([]);
});

test("a comment alone can be sent, goes out as the fourth argument, and clears after success", async () => {
  const m = mount();
  await act(() => m.render({ sessionId: "sent" }));
  await act(async () => void m.ref.current!.addLineComment(COMMENT));
  await send();
  expect(m.calls).toEqual([["", [], [], [COMMENT]]]);
  expect(chip()).toBeNull();
  expect(m.discarded).toEqual([]);
});

test("a rejected send keeps the comment", async () => {
  const m = mount({ onSend: () => false });
  await act(() => m.render({ sessionId: "rejected" }));
  await act(async () => void m.ref.current!.addLineComment(COMMENT));
  await send();
  expect(chip()?.textContent).toContain("src/a.ts:12-14");
  expect(m.discarded).toEqual([]);
});

test("a send without comments keeps the original three arguments", async () => {
  const m = mount();
  await act(() => m.render({ sessionId: "plain" }));
  const area = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "hi");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await send();
  expect(m.calls).toEqual([["hi", [], []]]);
});

test("leaving the session does not try to discard a comment as a file", async () => {
  const m = mount();
  await act(() => m.render({ sessionId: "leave-a" }));
  await act(async () => void m.ref.current!.addLineComment(COMMENT));
  await act(() => m.render({ sessionId: "leave-b" }));
  expect(m.discarded).toEqual([]);
});

test("the footer's changed-files counter is a button that opens the Changes tab", async () => {
  prefs.setPrefs({ sidePanel: null });
  await act(() => root.render(React.createElement(ChangedFilesButton, { count: 3 })));
  const button = host.querySelector("button.git-dirty") as HTMLButtonElement;
  expect(button.type).toBe("button");
  expect(button.getAttribute("aria-label")).toBe("3 changed files: open the Changes tab");
  expect(button.textContent).toBe("3");
  await act(async () => button.click());
  expect(prefs.getPrefs().sidePanel).toBe("changes");
});
