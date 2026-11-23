import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "./test/dom";

let React: typeof import("react");
let RetainedView: typeof import("./App").RetainedView;
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  registerDom();
  React = await import("react");
  RetainedView = (await import("./App")).RetainedView;
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});
afterAll(async () => { await React.act(() => root.unmount()); await unregisterDom(); });

function Draft() {
  const [value, setValue] = React.useState("");
  return React.createElement("input", { "aria-label": "Draft", value, onChange: (event: { target: { value: string } }) => setValue(event.target.value) });
}

test("a retained view mounts on its first visit and keeps its state while hidden", async () => {
  const show = (active: boolean) => React.act(async () => {
    root.render(React.createElement(RetainedView, { active, visible: active, children: React.createElement(Draft) }));
  });
  await show(false);
  expect(host.querySelector("input")).toBeNull();
  await show(true);
  const input = host.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("Missing retained input");
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "kept query");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await show(false);
  expect(host.querySelector("input")).toBe(input);
  expect(input.closest("[hidden]")).not.toBeNull();
  await show(true);
  expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("kept query");
  expect(input.closest("[hidden]")).toBeNull();
});
