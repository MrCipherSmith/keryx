import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { PtyTab } from "../platform/panels";

// The host side and xterm are replaced: this checks the panel's wiring, not the PTY.
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
  ptyWrite: async (id: number, data: string) => void calls.push(["write", id, data]),
  ptyClose: async (id: number) => void calls.push(["close", id]),
  ptyResize: async () => {},
  ptyAttach: async () => tab(0),
  onAgentTerminal: async () => () => {},
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

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  TerminalPanel = (await import("./TerminalPanel")).TerminalPanel;
  ToastProvider = (await import("../components/Toasts")).ToastProvider;
  bus = await import("./panelBus");
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
