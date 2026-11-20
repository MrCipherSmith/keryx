import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let ContextMeter: typeof import("./ContextMeter").ContextMeter;
let contextFill: typeof import("./ContextMeter").contextFill;
let createElement: typeof import("react").createElement;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  const mod = await import("./ContextMeter");
  ContextMeter = mod.ContextMeter;
  contextFill = mod.contextFill;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const usage = (used: number, size: number) => ({ used, size }) as import("./reducer").Usage;

test("contextFill is null without a window size and picks the tone by share", () => {
  expect(contextFill(null)).toBeNull();
  expect(contextFill(usage(10, 0))).toBeNull();
  expect(contextFill(usage(50, 100))).toEqual({ pct: 50, tone: "ok" });
  expect(contextFill(usage(70, 100))?.tone).toBe("warn");
  expect(contextFill(usage(90, 100))?.tone).toBe("high");
  expect(contextFill(usage(500, 100))?.pct).toBe(100);
});

test("nothing renders when the window size is unknown", async () => {
  await act(() => root.render(createElement(ContextMeter, { usage: usage(10, 0), busy: false, onCompact() {}, onDetails() {} })));
  expect(host.querySelector(".context-meter")).toBeNull();
});

test("the menu runs Compact outside a turn and keeps it disabled during one", async () => {
  let compacted = 0;
  let details = 0;
  const render = (busy: boolean) =>
    act(() => root.render(createElement(ContextMeter, { usage: usage(80, 100), busy, onCompact: () => compacted++, onDetails: () => details++ })));
  await render(false);
  const btn = host.querySelector(".context-meter") as HTMLButtonElement;
  expect(btn.className).toContain("is-warn");
  expect(btn.title).toBe("Last call: 80 of 100 tokens");
  await act(() => btn.click());
  const items = () => Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[];
  const compact = items().find((b) => b.textContent?.includes("Compact"))!;
  await act(() => compact.click());
  expect(compacted).toBe(1);

  await render(true);
  await act(() => (host.querySelector(".context-meter") as HTMLButtonElement).click());
  const busyCompact = items().find((b) => b.textContent?.includes("Compact"))!;
  expect(busyCompact.disabled || busyCompact.getAttribute("aria-disabled") === "true").toBe(true);
  await act(() => items().find((b) => b.textContent?.includes("Details"))!.click());
  expect(details).toBe(1);
});
