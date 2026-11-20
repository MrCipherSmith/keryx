import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { PtyTab } from "../platform/panels";
import type { Subagent } from "../session/activity";
import type { Item } from "../session/reducer";

// One right-hand panel with Terminal, Browser, Activity and Info tabs. The host side is replaced as in
// SidePanels.dom.test.tsx (bun's module mocks hold for the whole run, so every export is stubbed).
const tab = (id: number): PtyTab => ({ id, title: "zsh", owner: "user", cwd: "/p", running: true, exitCode: null });
mock.module("../platform/panels", () => ({
  ptyList: async () => [],
  ptyOpen: async () => tab(1),
  ptyOpenRun: async () => tab(1),
  onPtyExit: async () => () => {},
  ptyWrite: async () => {},
  ptyClose: async () => {},
  ptyResize: async () => {},
  ptyAttach: async () => tab(0),
  onAgentTerminal: async () => () => {},
  onBrowserEvent: async () => () => {},
  browserEngine: async () => "webkit",
  onConsent: async () => () => {},
  onConsentClosed: async () => () => {},
  browserConsentAnswer: async () => {},
  browserList: async () => [],
  browserOpen: async () => ({ id: 9, url: "http://localhost:3000/", title: "", loading: true, active: true }),
  browserNavigate: async () => {},
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
let React: typeof import("react");
let SessionView: typeof import("../session/SessionView").SessionView;
let prefs: typeof import("../lib/prefs");
let reducer: typeof import("../session/reducer");
let shell: typeof import("../shell/AppShell");
let ToastProvider: typeof import("../components/Toasts").ToastProvider;
let delegateBus: typeof import("../session/delegateBus");

beforeAll(async () => {
  registerDom();
  React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  SessionView = (await import("../session/SessionView")).SessionView;
  prefs = await import("../lib/prefs");
  reducer = await import("../session/reducer");
  shell = await import("../shell/AppShell");
  ToastProvider = (await import("../components/Toasts")).ToastProvider;
  delegateBus = await import("../session/delegateBus");
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

beforeEach(async () => {
  await act(() => root.render(null));
  prefs.setPrefs({ sidePanel: null, sessionSidebar: false });
});

const click = (el: Element) => act(async () => void (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
const tabBtn = (label: string) => Array.from(document.querySelectorAll('.side-switch [role="tab"]')).find((b) => b.textContent!.trim().startsWith(label))!;
const setTab = (t: import("../lib/prefs").SidePanelTab | null) => act(() => void prefs.setPrefs({ sidePanel: t }));

const AGENT: Subagent = {
  id: "a1", label: "reviewer", status: "running", parentToolCallId: "call-7", detail: null, model: undefined, runtime: undefined,
  entries: [{ kind: "task", text: "Review the diff" }],
} as unknown as Subagent;
const ITEMS: Item[] = [
  { kind: "tool", id: 2, toolCallId: "call-7", title: "spawn_subagent", toolKind: "other", status: "in_progress", content: [], autoApproved: false, startedAt: 1, endedAt: null },
];

async function mount(over: { subagents?: Subagent[]; items?: Item[] } = {}) {
  const state = { ...reducer.shownView(reducer.initialState), phase: "ready" as const, sessionId: "s1", held: true, items: over.items ?? [], subagents: over.subagents ?? [] };
  const s = new Proxy(
    { state, extensions: [] as string[], rpc: async () => ({}), fatal: null, marks: {}, focusDelegateTerminal: () => false, refreshTasks: async () => {} },
    { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : () => {}) },
  );
  await act(() =>
    root.render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(shell.AppShell, {
          cwd: "/p", recents: [], projects: ["/p"], live: [], view: "session", title: "Session", hasSession: true,
          status: { tone: "ok", label: "Ready" }, flowsActive: 0, activity: "idle",
          onView: () => {}, onRemoveProject: () => {}, onOpenFolder: () => {}, onSwitchProject: () => {},
          onNewWindow: () => {}, onCloseProject: () => {}, onPalette: () => {},
          children: React.createElement(SessionView, {
            s: s as never, cwd: "/p", projectName: "p", onGoFlows: () => {}, onGoSettings: () => {}, narrow: false, onProviders: () => {},
          }),
        }),
      ),
    ),
  );
}

test("one panel holds the Terminal, Browser, Activity and Info tabs", async () => {
  await mount();
  await setTab("terminal");
  expect(Array.from(document.querySelectorAll('.side-switch [role="tab"]')).map((b) => b.textContent!.trim())).toEqual(["Terminal", "Browser", "Activity", "Info"]);
  expect(document.querySelectorAll(".activity-panel")).toHaveLength(0);
});

test("switching tabs shows Activity and Info in the same panel, with Activity's sub-tabs", async () => {
  await mount({ subagents: [AGENT] });
  await setTab("browser");
  await click(tabBtn("Activity"));
  expect(prefs.getPrefs().sidePanel).toBe("activity");
  expect(document.querySelector(".side-panel .activity-panel")).not.toBeNull();
  expect(Array.from(document.querySelectorAll(".activity-tabs [role=tab]")).map((b) => b.textContent!.trim().replace(/\d+$/, ""))).toEqual(["Subagents"]);
  expect(tabBtn("Activity").querySelector(".tab-count")!.textContent).toBe("1"); // the running badge
  await click(tabBtn("Info"));
  expect(prefs.getPrefs().sidePanel).toBe("info");
  expect(document.querySelector(".side-panel .info-panel")).not.toBeNull();
  expect(document.querySelector(".activity-panel")).toBeNull();
  await click(tabBtn("Terminal"));
  expect(document.querySelector(".info-panel")).toBeNull();
});

test("there is no separate Activity or info column or resize handle any more", async () => {
  await mount();
  await setTab("activity");
  const view = document.querySelector(".session-view")!;
  expect(view.className).not.toContain("with-activity");
  expect(view.className).not.toContain("with-info");
  expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1); // the side panel's own
});

test("Activity and collapsed sessions are accessible from the main header without a second toolbar", async () => {
  await mount({ subagents: [AGENT] });
  const activityButton = document.querySelector('.titlebar-right [aria-label="Activity"]')!;
  expect(activityButton.querySelector(".tab-count")?.textContent).toBe("1");
  expect(document.querySelector(".session-topbar")).toBeNull();
  await click(activityButton);
  expect(prefs.getPrefs().sidePanel).toBe("activity");
  expect(activityButton.getAttribute("aria-pressed")).toBe("true");
  expect(tabBtn("Activity").getAttribute("aria-selected")).toBe("true");
  await click(activityButton);
  expect(prefs.getPrefs().sidePanel).toBeNull();
  await click(document.querySelector('.titlebar-left [aria-label="Show sessions"]')!);
  expect(prefs.getPrefs().sessionSidebar).toBe(true);
});

test("Show subagent on a tool card opens Activity on that subagent, even from the Browser tab", async () => {
  await mount({ subagents: [AGENT], items: ITEMS });
  await setTab("browser");
  await click(document.querySelector(".tool-link")!);
  expect(prefs.getPrefs().sidePanel).toBe("activity");
  expect(document.querySelector('.side-panel [data-subagent-detail="a1"]')).not.toBeNull();
});

test("a delegate run's Open terminal button brings the side panel to Terminal", async () => {
  const ext = { ...AGENT, id: "ext:1", runtime: "external", parentToolCallId: undefined, detail: "delegated" } as Subagent;
  await mount({ subagents: [ext] });
  await act(() => delegateBus.setDelegateApi({ isOpen: () => true, focus: () => (prefs.setPrefs({ sidePanel: "terminal" }), true) }));
  await setTab("activity");
  await click(document.querySelector('[data-subagent="ext:1"]')!);
  await click(document.querySelector('[data-open-terminal="ext:1"]')!);
  expect(prefs.getPrefs().sidePanel).toBe("terminal");
  expect(tabBtn("Terminal").getAttribute("aria-selected")).toBe("true");
  delegateBus.setDelegateApi(null);
});

test("the title-bar session info toggle selects the Info tab", async () => {
  await mount();
  await act(() => shell.toggleSidePanel("info", null));
  expect(tabBtn("Info").getAttribute("aria-selected")).toBe("true");
  await act(() => shell.toggleSidePanel("info", "info"));
  expect(prefs.getPrefs().sidePanel).toBeNull();
});

test("the old infoPanel preference opens the Info tab; activityWidth is dropped", () => {
  const p = prefs.parsePrefs(JSON.stringify({ infoPanel: true, activityWidth: 500 }));
  expect(p.sidePanel).toBe("info");
  expect("activityWidth" in p).toBe(false);
  expect(prefs.parsePrefs(JSON.stringify({ infoPanel: true, sidePanel: "browser" })).sidePanel).toBe("browser");
  expect(prefs.parsePrefs(JSON.stringify({ sidePanel: "nonsense" })).sidePanel).toBeNull();
});
