import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { PtyTab } from "../platform/panels";

// The host side and xterm are replaced: this checks the panel's wiring, not the PTY. bun's module
// mocks hold for the whole test run, so every export other files import is stubbed too.
const calls: Array<[string, ...unknown[]]> = [];
let tabs: PtyTab[] = [];
let nextId = 1;
const tab = (id: number, running = true): PtyTab => ({ id, title: "zsh", owner: "user", cwd: "/p", running, exitCode: null });

mock.module("../platform/panels", () => ({
  ptyList: async () => (calls.push(["list"]), tabs),
  ptyOpen: async (cwd: string) => {
    calls.push(["open", cwd]);
    const t = tab(nextId++);
    tabs = [...tabs, t];
    return t;
  },
  ptyOpenRun: async (cwd: string, argv: string[], title: string) => {
    calls.push(["openrun", cwd, argv, title]);
    const t = { ...tab(nextId++), title };
    tabs = [...tabs, t];
    return t;
  },
  onPtyExit: async () => () => {},
  ptyWrite: async (id: number, data: string) => void calls.push(["write", id, data]),
  ptyClose: async (id: number) => void calls.push(["close", id]),
  ptyResize: async () => {},
  ptyAttach: async () => tab(0),
  onAgentTerminal: async () => () => {},
  onBrowserEvent: async () => () => {},
  browserList: async () => [],
  browserOpen: async (cwd: string, url: string) => (calls.push(["bopen", cwd, url]), { id: 9, url: "http://localhost:3000/", title: "", loading: true, active: true }),
  browserNavigate: async (id: number, url: string) => void calls.push(["bnav", id, url]),
  browserGo: async () => {},
  browserClose: async () => {},
  browserSelect: async () => {},
  browserLayout: async () => {},
  panelMcpServers: async () => [],
}));
mock.module("./TermView", () => ({
  TermView: ({ id, active }: { id: number; active: boolean }) => {
    const React = require("react") as typeof import("react");
    return React.createElement("div", { "data-term": id, hidden: !active });
  },
}));

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let TerminalPanel: typeof import("./TerminalPanel").TerminalPanel;
let ToastProvider: typeof import("../components/Toasts").ToastProvider;
let bus: typeof import("./panelBus");
let browser: typeof import("./BrowserPanel");

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  TerminalPanel = (await import("./TerminalPanel")).TerminalPanel;
  ToastProvider = (await import("../components/Toasts")).ToastProvider;
  bus = await import("./panelBus");
  browser = await import("./BrowserPanel");
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

test("the panel opens a first tab in the project, runs commands in the active tab, and a new tab after exit", async () => {
  await act(() => root.render(createElement(ToastProvider, null, createElement(TerminalPanel, { cwd: "/proj" }))));
  await flush();
  expect(calls).toContainEqual(["open", "/proj"]);
  expect(host.querySelectorAll("[data-term]").length).toBe(1);

  await act(async () => bus.runInTerminal("bun test"));
  await flush();
  expect(calls).toContainEqual(["write", 1, "bun test\r"]);

  // A second tab becomes active and takes the next command.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New terminal"]')!.click());
  await flush();
  await act(async () => bus.runInTerminal("ls"));
  await flush();
  expect(calls).toContainEqual(["write", 2, "ls\r"]);

  // Closing the active tab closes its PTY and activates the remaining one.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close zsh"]:last-of-type')!.click());
  await flush();
  expect(calls.some((c) => c[0] === "close")).toBe(true);
  expect(host.querySelectorAll("[data-term]").length).toBe(1);
});

test("reopening the panel reattaches to running tabs instead of starting a shell", async () => {
  await act(() => root.render(createElement("div")));
  calls.length = 0;
  tabs = [tab(7)];
  await act(() => root.render(createElement(ToastProvider, null, createElement(TerminalPanel, { cwd: "/proj" }))));
  await flush();
  expect(calls.some((c) => c[0] === "open")).toBe(false);
  expect(host.querySelector('[data-term="7"]')).not.toBeNull();
});

test("the browser opens a tab from the address bar, then navigates that tab", async () => {
  await act(() => root.render(createElement("div")));
  calls.length = 0;
  await act(() => root.render(createElement(browser.BrowserPanel, { cwd: "/proj", visible: true })));
  await flush();
  const addr = host.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
  const form = host.querySelector<HTMLFormElement>("form.browser-bar")!;
  const type = async (v: string) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(addr, v);
      addr.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => form.requestSubmit());
    await flush();
  };
  await type("localhost:3000");
  expect(calls).toContainEqual(["bopen", "/proj", "localhost:3000"]);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain("localhost:3000");
  await type("localhost:3000/about");
  expect(calls).toContainEqual(["bnav", 9, "localhost:3000/about"]);
});

test("browser tab labels and updates", () => {
  const t = { id: 1, url: "http://localhost:5173/x", title: "", loading: false, active: false };
  expect(browser.tabLabel(t)).toBe("localhost:5173");
  expect(browser.tabLabel({ ...t, title: " App " })).toBe("App");
  const list = browser.applyBrowserTab([t], { ...t, title: "Loaded" });
  expect(list).toHaveLength(1);
  expect(list[0]!.title).toBe("Loaded");
  expect(browser.applyBrowserTab(list, { ...t, id: 2 })).toHaveLength(2);
});

test("a tab the app opens (/delegate) is added and focused, the panel opens on Terminal, and closing it is announced", async () => {
  await act(() => root.render(createElement("div")));
  calls.length = 0;
  tabs = [tab(20)];
  const prefs = await import("../lib/prefs");
  prefs.setPrefs({ sidePanel: null });
  await act(() => root.render(createElement(ToastProvider, null, createElement(TerminalPanel, { cwd: "/proj" }))));
  await flush();
  const closed: number[] = [];
  const off = bus.onTabClosed((id) => closed.push(id));
  const run: PtyTab = { id: 21, title: "Claude · fix the build", owner: "user", cwd: "/proj", running: true, exitCode: null };
  await act(async () => bus.showTerminalTab(run));
  await flush();
  expect(prefs.getPrefs().sidePanel).toBe("terminal");
  expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain("Claude · fix the build");
  expect(host.querySelector('[data-term="21"]')!.hasAttribute("hidden")).toBe(false);
  expect(host.querySelector('[data-term="20"]')!.hasAttribute("hidden")).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close Claude · fix the build"]')!.click());
  await flush();
  expect(closed).toEqual([21]);
  off();
});

test("a tab requested before the terminal panel listens is delivered when it does", async () => {
  await act(() => root.render(createElement("div")));
  const run: PtyTab = { id: 30, title: "Codex · x", owner: "user", cwd: "/p", running: true, exitCode: null };
  bus.showTerminalTab(run);
  const got: number[] = [];
  const off = bus.onShowTab((t) => got.push(t.id));
  expect(got).toEqual([30]);
  off();
});
