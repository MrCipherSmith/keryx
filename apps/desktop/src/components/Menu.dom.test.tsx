import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let Menu: typeof import("./Menu").Menu;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  Menu = (await import("./Menu")).Menu;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `Item ${i}`, onSelect: () => {} }));
const anchorButton = () => {
  const b = document.createElement("button");
  b.textContent = "anchor";
  document.body.append(b);
  return b;
};

test("selecting an item gives focus back to the anchor", async () => {
  const anchor = anchorButton();
  let open = true;
  const show = () => act(() => root.render(open ? createElement(Menu, { anchor, items: items(2), onClose: () => { open = false; }, label: "T" }) : null));
  await show();
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  await act(async () => { (document.activeElement as HTMLElement).click(); });
  await show();
  expect(document.activeElement).toBe(anchor);
  anchor.remove();
});

test("Tab closes the menu without taking focus back", async () => {
  const anchor = anchorButton();
  let open = true;
  const show = () => act(() => root.render(open ? createElement(Menu, { anchor, items: items(2), onClose: () => { open = false; }, label: "T" }) : null));
  await show();
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  await show();
  expect(document.activeElement).not.toBe(anchor);
  anchor.remove();
});

test("a re-render with a new item count or a new onClose keeps the focused item", async () => {
  const anchor = anchorButton();
  await act(() => root.render(createElement(Menu, { anchor, items: items(2), onClose: () => {}, label: "T" })));
  const second = document.querySelectorAll<HTMLElement>('[role="menuitem"]')[1];
  second?.focus();
  expect(document.activeElement).toBe(second);
  await act(() => root.render(createElement(Menu, { anchor, items: items(3), onClose: () => {}, label: "T" })));
  expect(document.activeElement).toBe(document.querySelectorAll('[role="menuitem"]')[1]);
  await act(() => root.render(null));
  anchor.remove();
});

test("a scroll that moves the anchor calls the latest onClose, once per frame", async () => {
  const anchor = anchorButton();
  let top = 0;
  anchor.getBoundingClientRect = () => ({ top, left: 0, bottom: top + 10, right: 10, width: 10, height: 10, x: 0, y: top, toJSON() {} }) as DOMRect;
  const calls: string[] = [];
  await act(() => root.render(createElement(Menu, { anchor, items: items(1), onClose: () => calls.push("old"), label: "T", closeOnScroll: true })));
  await act(() => root.render(createElement(Menu, { anchor, items: items(1), onClose: () => calls.push("new"), label: "T", closeOnScroll: true })));
  top = 50;
  window.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("scroll"));
  await new Promise((r) => setTimeout(r, 60));
  expect(calls).toEqual(["new"]);
  await act(() => root.render(null));
  anchor.remove();
});
