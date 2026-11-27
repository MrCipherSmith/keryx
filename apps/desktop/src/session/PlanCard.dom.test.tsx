import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { PlanEntry } from "../acp/types";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let PlanCard: typeof import("./PlanCard").PlanCard;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ({ PlanCard } = await import("./PlanCard"));
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const plan: PlanEntry[] = [
  { content: "Collect PR comments and context", priority: "medium", status: "completed" },
  { content: "Dispatch reviewers", priority: "medium", status: "in_progress" },
  { content: "Consolidate report", priority: "medium", status: "pending" },
];

async function show(updatedAt: number | null, busy: boolean, turnStartedAt: number | null = null, entries: PlanEntry[] = plan) {
  await act(() => root.render(createElement(PlanCard, { plan: entries, updatedAt, turnStartedAt, busy })));
}

test("a plan the working agent has not moved for minutes says so in its header", async () => {
  await show(Date.now() - 12 * 60_000, true);
  expect(host.querySelector(".plan-count")?.textContent).toBe("1/3");
  expect(host.querySelector(".plan-stale")?.textContent).toBe("not updated for 12 min");
});

test("a fresh plan, or one whose agent is idle, shows no staleness", async () => {
  await show(Date.now() - 30_000, true);
  expect(host.querySelector(".plan-count")?.textContent).toBe("1/3");
  expect(host.querySelector(".plan-stale")).toBeNull();
  await show(Date.now() - 60 * 60_000, false);
  expect(host.querySelector(".plan-count")?.textContent).toBe("1/3");
  expect(host.querySelector(".plan-stale")).toBeNull();
});

test("a plan left from the previous turn is not stale the moment the next turn starts", async () => {
  // Last written 20 minutes ago; the operator sent the next prompt a minute ago.
  await show(Date.now() - 20 * 60_000, true, Date.now() - 60_000);
  expect(host.querySelector(".plan-count")?.textContent).toBe("1/3");
  expect(host.querySelector(".plan-stale")).toBeNull();
  await show(Date.now() - 20 * 60_000, true, Date.now() - 4 * 60_000);
  expect(host.querySelector(".plan-stale")?.textContent).toBe("not updated for 4 min");
});

test("the list keeps the step in progress in view, with the step before it only while both fit", async () => {
  const steps: PlanEntry[] = Array.from({ length: 8 }, (_, i) => ({
    content: `Step ${i}`, priority: "medium", status: i < 5 ? "completed" : i === 5 ? "in_progress" : "pending",
  }));
  // happy-dom has no layout: give every row a height and the list a viewport, as a browser would.
  const rowHeight = (i: number) => (i === 4 ? 140 : 30);
  const restore = [
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop"),
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  ];
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get(this: HTMLElement) {
    const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
    let top = 0;
    for (let i = 0; i < index; i++) top += rowHeight(i);
    return top;
  } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) {
    return this.parentElement ? rowHeight([...this.parentElement.children].indexOf(this)) : 0;
  } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 160; } });
  try {
    await act(() => root.render(createElement("div")));
    await show(Date.now(), false, null, steps);
    const list = host.querySelector<HTMLOListElement>(".plan-list")!;
    // Current step 5 starts at 4*30 + 140 = 260. Its predecessor (140px tall, at 120) cannot fit in 160px with it,
    // so the list lands where the current step's bottom (290) meets the fold: 290 - 160 = 130.
    expect(list.scrollTop).toBe(130);
    // With short rows only, the step before it stays in view: step 6 at 290, its predecessor at 260 → 256.
    const short: PlanEntry[] = steps.map((step, i) => ({ ...step, status: i < 6 ? "completed" : i === 6 ? "in_progress" : "pending" }));
    await act(() => root.render(createElement("div")));
    await show(Date.now(), false, null, short);
    expect(host.querySelector<HTMLOListElement>(".plan-list")!.scrollTop).toBe(256);
  } finally {
    const [top, height, client] = restore;
    if (top) Object.defineProperty(HTMLElement.prototype, "offsetTop", top);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop;
    if (height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    if (client) Object.defineProperty(HTMLElement.prototype, "clientHeight", client);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  }
});
