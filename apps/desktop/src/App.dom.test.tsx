import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "./test/dom";
import type { View } from "./shell/AppShell";

let React: typeof import("react");
let RetainedView: typeof import("./App").RetainedView;
let MetaprojectWork: typeof import("./App").MetaprojectWork;
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  registerDom();
  React = await import("react");
  ({ RetainedView, MetaprojectWork } = await import("./App"));
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

test("a retained view is hidden while it is the work view under Settings, keeping its state, and shown when visible alone", async () => {
  // App.tsx passes active = the work view and visible = the shown view; Settings opened over the work view sets them apart.
  const render = (active: boolean, visible: boolean) => React.act(async () => {
    root.render(React.createElement(RetainedView, { active, visible, children: React.createElement(Draft) }));
  });
  await render(true, true);
  const input = host.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("Missing retained input");
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "under settings");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render(true, false);
  expect(host.querySelector("input")).toBe(input);
  expect(input.closest("[hidden]")).not.toBeNull();
  await render(false, true);
  expect(input.closest("[hidden]")).toBeNull();
  expect(input.value).toBe("under settings");
});

test("the Metaproject explorer is told it is hidden while another view or Settings is shown, and shown again on return", async () => {
  // A stand-in explorer records the `visible` it is given; the real one closes its Filters popover and re-reads its catalog on it.
  const given: Array<boolean | undefined> = [];
  const Explorer = ({ visible }: { visible?: boolean }) => { given.push(visible); return React.createElement("p", null, "Explorer"); };
  const render = (view: View, workView: Exclude<View, "settings">) => React.act(async () => {
    root.render(React.createElement(MetaprojectWork, { cwd: "/project", view, workView, onRebuild: async () => false, onDraft: async () => {}, explorer: Explorer }));
  });
  await render("metaproject", "metaproject");
  expect(host.textContent).toContain("Explorer");
  expect(given.at(-1)).toBe(true);
  await render("flows", "flows");
  // Still mounted, hidden: the explorer keeps its state and hears that it left the screen.
  expect(host.querySelector("p")?.closest("[hidden]")).not.toBeNull();
  expect(given.at(-1)).toBe(false);
  await render("metaproject", "metaproject");
  expect(given.at(-1)).toBe(true);
  // Settings opened over the explorer hides it too.
  await render("settings", "metaproject");
  expect(given.at(-1)).toBe(false);
});
