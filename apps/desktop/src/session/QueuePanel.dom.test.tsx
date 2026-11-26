import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { QueuedPrompt } from "./reducer";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let QueuePanel: typeof import("./QueuePanel").QueuePanel;
let createElement: typeof import("react").createElement;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  QueuePanel = (await import("./QueuePanel")).QueuePanel;
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const queue: QueuedPrompt[] = [
  { id: 1, text: "Check for pull requests on this task" },
  { id: 2, text: "Then run the tests" },
  { id: 3, text: "Start the issue", issueLaunchId: "launch-1" },
];
const calls: string[] = [];
const mount = (items: QueuedPrompt[], busy = true) =>
  act(() => root.render(createElement(QueuePanel, { queue: items, busy,
    onForce: (i: number) => calls.push("force " + i), onEdit: (i: number) => calls.push("edit " + i), onRemove: (i: number) => calls.push("remove " + i) })));
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

test("an empty queue shows no panel", async () => {
  await mount([]);
  expect(host.querySelector(".queue-panel")).toBeNull();
});

test("each queued message is a row, in order, with Send now, Edit and Delete", async () => {
  calls.length = 0;
  await mount(queue);
  expect(host.querySelector(".queue-panel-title")?.textContent).toBe("Queued · 3");
  expect([...host.querySelectorAll(".queue-row-text")].map(el => el.textContent)).toEqual(queue.map(q => q.text));
  await act(() => button("Send queued message 2 now")!.click());
  await act(() => button("Edit queued message 1")!.click());
  await act(() => button("Delete queued message 3")!.click());
  expect(calls).toEqual(["force 1", "edit 0", "remove 2"]);
});

test("a message the app queued itself cannot be edited", async () => {
  await mount(queue);
  expect(button("Edit queued message 3")).toBeNull();
  expect(button("Send queued message 3 now")).not.toBeNull();
});

test("while a turn runs the panel says Send now stops it", async () => {
  await mount(queue, true);
  expect(host.querySelector(".queue-panel-help")?.textContent).toContain("stops the turn");
  await mount(queue, false);
  expect(host.querySelector(".queue-panel-help")?.textContent).toBe("Sent in order.");
});
