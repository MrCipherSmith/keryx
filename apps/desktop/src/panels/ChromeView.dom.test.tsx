import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { BrowserFrame, BrowserInput } from "../platform/panels";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let ChromeView: typeof import("./ChromeView").ChromeView;

const sent: { tab: number; e: BrowserInput }[] = [];
const io = {
  frames: async (_on: (f: BrowserFrame) => void) => {},
  frame: async () => new ArrayBuffer(0),
  input: async (tab: number, e: BrowserInput) => void sent.push({ tab, e }),
};

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ChromeView = (await import("./ChromeView")).ChromeView;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
  await act(() => root.render(createElement(ChromeView, { tab: 5, io })));
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const keyDowns = () => sent.filter((s) => s.e.kind === "key" && s.e.type === "keyDown").map((s) => (s.e as { key: string }).key);

test("a press on the page takes the keyboard, and the keys typed then go to the page's tab", () => {
  const canvas = host.querySelector("canvas")!;
  const keys = host.querySelector("textarea")!;
  (document.activeElement as HTMLElement | null)?.blur?.();
  canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
  expect(document.activeElement).toBe(keys);
  for (const key of ["k", "e", "y"]) {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true }));
  }
  expect(keyDowns()).toEqual(["k", "e", "y"]);
  expect(sent.every((s) => s.tab === 5)).toBe(true);
  expect(sent.some((s) => s.e.kind === "mouse" && s.e.type === "mousePressed")).toBe(true);
});

test("keys reach the page when the view itself holds the focus", () => {
  sent.length = 0;
  const view = host.querySelector<HTMLElement>(".chrome-view")!;
  view.focus();
  expect(document.activeElement).toBe(view);
  view.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }));
  expect(keyDowns()).toEqual(["a"]);
});

test("app shortcuts are left to the app", () => {
  sent.length = 0;
  host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", metaKey: true, bubbles: true, cancelable: true }));
  expect(sent).toEqual([]);
});

test("a native select-all consumed by WebKit reaches Chromium before paste", () => {
  sent.length = 0;
  const canvas = host.querySelector("canvas")!;
  const keys = host.querySelector("textarea")!;
  canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  keys.select();
  keys.dispatchEvent(new Event("select"));
  keys.dispatchEvent(new Event("select"));
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => "replacement" } });
  keys.dispatchEvent(paste);
  expect(sent.map(item => item.e).filter(event => event.kind !== "mouse")).toEqual([
    { kind: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65, modifiers: 4 },
    { kind: "key", type: "keyUp", key: "a", code: "KeyA", keyCode: 65, modifiers: 4 },
    { kind: "text", text: "replacement" },
  ]);
});
