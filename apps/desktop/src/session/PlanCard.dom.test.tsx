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

async function show(updatedAt: number | null, busy: boolean) {
  await act(() => root.render(createElement(PlanCard, { plan, updatedAt, busy })));
}

test("a plan the working agent has not moved for minutes says so in its header", async () => {
  await show(Date.now() - 12 * 60_000, true);
  expect(host.querySelector(".plan-count")?.textContent).toBe("1/3");
  expect(host.querySelector(".plan-stale")?.textContent).toBe("not updated for 12 min");
});

test("a fresh plan, or one whose agent is idle, shows no staleness", async () => {
  await show(Date.now() - 30_000, true);
  expect(host.querySelector(".plan-stale")).toBeNull();
  await show(Date.now() - 60 * 60_000, false);
  expect(host.querySelector(".plan-stale")).toBeNull();
});
