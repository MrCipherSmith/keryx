import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";

const ID = "cc97ac39-1fe3-4afb-af64-fe19043dd176";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let React: typeof import("react");
let SessionInfoPanel: typeof import("./SessionInfoPanel").SessionInfoPanel;
let ToastProvider: typeof import("../components/Toasts").ToastProvider;
let reducer: typeof import("./reducer");
let written: string[];
let failCopy: boolean;

beforeAll(async () => {
  registerDom();
  React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  SessionInfoPanel = (await import("./SessionInfoPanel")).SessionInfoPanel;
  ToastProvider = (await import("../components/Toasts")).ToastProvider;
  reducer = await import("./reducer");
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});
beforeEach(async () => {
  written = [];
  failCopy = false;
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: (t: string) => (failCopy ? Promise.reject(new Error("denied")) : (written.push(t), Promise.resolve())) },
    configurable: true,
  });
  await act(() => root.render(null));
});
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const MODEL = {
  id: "model", name: "Model", category: "model", type: "select", currentValue: "claude-opus-5-5",
  options: [{ value: "claude-opus-5-5", name: "Opus 5.5" }],
};

async function mount(sessionId: string | null = ID) {
  const state = { ...reducer.shownView(reducer.initialState), sessionId, held: true, configOptions: [MODEL] } as unknown as import("./reducer").SessionState;
  await act(() =>
    root.render(React.createElement(ToastProvider, null, React.createElement(SessionInfoPanel, { state, cwd: "/Users/me/work/app", projectName: "app" }))),
  );
}
const btn = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });

test("the Id row shows the short form and Copy session id puts the full id on the clipboard, with a toast", async () => {
  await mount();
  const row = btn("Copy session id")!.closest(".info-row")!;
  expect(row.querySelector(".info-val")!.textContent).toBe("043dd176");
  await click(btn("Copy session id")!);
  expect(written).toEqual([ID]);
  const toast = document.querySelector(".toast-ok")!;
  expect(toast.textContent).toContain("Copied session id");
  expect(toast.textContent).toContain(ID);
});

test("the folder path and the model id copy their full values, not what the row shows", async () => {
  await mount();
  await click(btn("Copy folder path")!);
  await click(btn("Copy model id")!);
  expect(written).toEqual(["/Users/me/work/app", "claude-opus-5-5"]);
});

test("a failed copy says so in an error toast", async () => {
  failCopy = true;
  await mount();
  await click(btn("Copy session id")!);
  await act(() => Promise.resolve());
  expect(document.querySelector(".toast-error")!.textContent).toContain("Could not copy the session id");
});

test("with no session there is no Id row and no session id copy button", async () => {
  await mount(null);
  expect(btn("Copy session id")).toBeNull();
});

test("info values are on the selectable allowlist", async () => {
  const css = ((await import("../styles.css", { with: { type: "text" } })) as unknown as { default: string }).default;
  const allow = css.slice(css.indexOf("/* Content people read or copy stays selectable. */"), css.indexOf("user-select: text"));
  expect(allow).toContain(".info-val");
});
