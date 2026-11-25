import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { PtyTab } from "../platform/panels";
import type { Item } from "../session/reducer";
import type { RunOrigin, RunRequest } from "./panelBus";

// The host side and xterm are replaced, as in SidePanels.dom.test.tsx: bun's module mocks hold for the
// whole test run, so every export other files import is stubbed too.
const calls: Array<[string, ...unknown[]]> = [];
let tabs: PtyTab[] = [];
let nextId = 1;
let failOpenCommand: string | null = null;
/** Holds the panel's tab list until released; the list is the one taken when it was asked for. */
let listGate: Promise<void> | null = null;
const tab = (id: number, title = "zsh"): PtyTab => ({ id, title, owner: "user", cwd: "/proj", running: true, exitCode: null });

mock.module("../platform/panels", () => ({
  ptyList: async () => {
    calls.push(["list"]);
    const taken = tabs;
    if (listGate) await listGate;
    return taken;
  },
  ptyOpen: async (cwd: string) => {
    calls.push(["open", cwd]);
    const t = tab(nextId++);
    tabs = [...tabs, t];
    return t;
  },
  ptyOpenRun: async (cwd: string, argv: string[], title: string) => {
    calls.push(["openrun", cwd, argv, title]);
    return tab(nextId++, title);
  },
  ptyOpenCommand: async (cwd: string, command: string, title: string, cols: number, rows: number) => {
    calls.push(["opencommand", cwd, command, title, cols, rows]);
    if (failOpenCommand !== null) throw new Error(failOpenCommand);
    const t = tab(nextId++, title);
    tabs = [...tabs, t];
    return t;
  },
  ptyTail: async () => "",
  onPtyExit: async () => () => {},
  ptyWrite: async (id: number, data: string) => void calls.push(["write", id, data]),
  ptyClose: async (id: number) => void calls.push(["close", id]),
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
  browserFrames: async () => {},
  browserFrame: async () => new ArrayBuffer(0),
  browserInput: async () => {},
  browserPick: async () => null,
  browserPickCancel: async () => {},
  isPicked: (r: unknown) => typeof r === "object" && r !== null,
  cookieProfiles: async () => [],
  cookieScan: async () => [],
  cookieImport: async () => ({ imported: 0, skipped: 0 }),
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
let Markdown: typeof import("../components/Markdown").Markdown;
let bus: typeof import("./panelBus");
let prefs: typeof import("../lib/prefs");
let transcript: typeof import("../session/Transcript");
let shell: typeof import("../shell/AppShell");
let TerminalPanel: typeof import("./TerminalPanel").TerminalPanel;
let ToastProvider: typeof import("../components/Toasts").ToastProvider;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  Markdown = (await import("../components/Markdown")).Markdown;
  bus = await import("./panelBus");
  prefs = await import("../lib/prefs");
  transcript = await import("../session/Transcript");
  shell = await import("../shell/AppShell");
  TerminalPanel = (await import("./TerminalPanel")).TerminalPanel;
  ToastProvider = (await import("../components/Toasts")).ToastProvider;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  bus.setRunTracker(null);
  await act(() => root.unmount());
  await unregisterDom();
});

beforeEach(async () => {
  await act(() => root.render(null));
  prefs.setPrefs({ sidePanel: null });
  calls.length = 0;
  tabs = [];
  nextId = 1;
  failOpenCommand = null;
  listGate = null;
  bus.setRunTracker(null);
});

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

/** A run tracker that records what the Run buttons and the panel tell it. */
function tracker() {
  const requested: Array<{ command: string; origin: RunOrigin }> = [];
  const opened: Array<[string, number]> = [];
  const failed: Array<[string, string]> = [];
  bus.setRunTracker({
    requested: (command, origin) => (requested.push({ command, origin }), `run-${requested.length}`),
    opened: (runId, t) => void opened.push([runId, t.id]),
    failed: (runId, error) => void failed.push([runId, error]),
  });
  return { requested, opened, failed };
}

const MESSAGE = "lead-in\n\n```bash\nbun run desktop:build\n```\n\n```bash\ncd a\nls\n```\n\n```js\nconsole.log(1)\n```";
const TOOL: Item = {
  kind: "tool", id: 2, toolCallId: "call-1", title: "execute", toolKind: "execute", status: "completed",
  content: [{ type: "content", content: { type: "text", text: "On branch main" } }], rawInput: { command: "git status" },
  autoApproved: false, startedAt: 1, endedAt: 2,
};

test("runnableCommand takes one command, a continued one, and drops a $ prompt", () => {
  expect(bus.runnableCommand("ls -la\n")).toBe("ls -la");
  expect(bus.runnableCommand("$ bun test src")).toBe("bun test src");
  expect(bus.runnableCommand("docker run \\\n  -it alpine")).toBe("docker run \\\n  -it alpine");
  expect(bus.runnableCommand("cd a\nls")).toBeNull();
  expect(bus.runnableCommand("   ")).toBeNull();
  expect(bus.runnableCommand("rm -rf ‮ x")).toBeNull();
  expect(bus.runnableCommand("echo \u0007")).toBeNull();
  expect(bus.isShellLang("Bash")).toBe(true);
  expect(bus.isShellLang("js")).toBe(false);
});

test("a run tab's title is the command, shortened to one line", () => {
  expect(bus.runTabTitle("bun test")).toBe("bun test");
  expect(bus.runTabTitle("docker run \\\n  -it alpine")).toBe("docker run -it alpine");
  const long = bus.runTabTitle(`echo ${"a".repeat(80)}`);
  expect(long.length).toBeLessThanOrEqual(32);
  expect(long.endsWith("…")).toBe(true);
});

test("LG3-001: a shortened title never ends inside a surrogate pair (the host's JSON parse refuses a lone one)", () => {
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // The 31st UTF-16 unit of this command is the first half of 🚀.
  const title = bus.runTabTitle('git commit -m "feat: add test 🚀 for runs"');
  expect(loneSurrogate.test(title)).toBe(false);
  expect(Array.from(title).length).toBeLessThanOrEqual(32);
  expect(title.endsWith("…")).toBe(true);
  for (let pad = 0; pad < 4; pad++) {
    expect(loneSurrogate.test(bus.runTabTitle(`${"x".repeat(26 + pad)} 🚀🎉👍 done and more`))).toBe(false);
  }
});

test("a single-command bash block gets Run; outside a session the click is just a run request with no origin", async () => {
  const t = tracker();
  const got: RunRequest[] = [];
  const off = bus.onRunRequest((r) => got.push(r));
  await act(() => root.render(createElement(Markdown, { text: MESSAGE })));
  const blocks = Array.from(host.querySelectorAll(".code-block"));
  expect(blocks.length).toBe(3);
  expect(blocks.map((b) => b.querySelector("button.code-run") !== null)).toEqual([true, false, false]);
  await act(async () => {
    blocks[0]!.querySelector<HTMLButtonElement>("button.code-run")!.click();
  });
  expect(got).toEqual([{ command: "bun run desktop:build" }]);
  expect(t.requested).toEqual([]);
  expect(prefs.getPrefs().sidePanel).toBe("terminal");
  off();
});

test("a run requested before the terminal panel listens is delivered when it does", () => {
  bus.runInTerminal("echo early");
  const got: RunRequest[] = [];
  const off = bus.onRunRequest((r) => got.push(r));
  expect(got).toEqual([{ command: "echo early" }]);
  off();
});

test("execute tool calls are runnable only when the command reads as it runs", () => {
  const t = transcript.runnableToolCommand;
  expect(t({ toolKind: "execute", rawInput: { command: "git status" } })).toBe("git status");
  expect(t({ toolKind: "execute", rawInput: { command: ["ls", "my dir"] } })).toBe('ls "my dir"');
  expect(t({ toolKind: "read", rawInput: { command: "git status" } })).toBeNull();
  expect(t({ toolKind: "execute", rawInput: { command: "echo a\nrm b" } })).toBeNull();
  expect(t({ toolKind: "execute", rawInput: { command: "echo ‮x" } })).toBeNull();
});

async function mountSession() {
  await act(async () =>
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(TerminalPanel, { cwd: "/proj" }),
        createElement(transcript.Transcript, {
          items: [{ kind: "agent", id: 1, text: MESSAGE }, TOOL],
          busy: false, replaying: false, empty: null, sessionId: "s1",
        }),
      ),
    ),
  );
  await flush();
}

test("AC1: Run on a message block and on an execute tool card each open a new tab running exactly that command; the active tab gets no input", async () => {
  const t = tracker();
  await mountSession();
  expect(calls).toContainEqual(["open", "/proj"]); // the panel's own first shell tab
  const shellTab = 1;

  await act(async () => host.querySelector<HTMLButtonElement>("button.code-run")!.click());
  await flush();
  expect(calls).toContainEqual(["opencommand", "/proj", "bun run desktop:build", "bun run desktop:build", 80, 24]);
  expect(t.requested).toEqual([{ command: "bun run desktop:build", origin: { sessionId: "s1" } }]);
  expect(t.opened).toEqual([["run-1", 2]]);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain("bun run desktop:build");
  expect(host.querySelector('[data-term="2"]')!.hasAttribute("hidden")).toBe(false);
  expect(host.querySelector(`[data-term="${shellTab}"]`)!.hasAttribute("hidden")).toBe(true);

  // The tool card's Run, from its expanded body.
  await act(async () => host.querySelector<HTMLButtonElement>(".tool-row")!.click());
  await act(async () => host.querySelector<HTMLButtonElement>("button.tool-run")!.click());
  await flush();
  expect(calls).toContainEqual(["opencommand", "/proj", "git status", "git status", 80, 24]);
  expect(t.requested[1]).toEqual({ command: "git status", origin: { sessionId: "s1" } });
  expect(t.opened).toEqual([["run-1", 2], ["run-2", 3]]);

  // Nothing was ever typed into a tab.
  expect(calls.filter((c) => c[0] === "write")).toEqual([]);
  expect(host.querySelectorAll("[data-term]")).toHaveLength(3);
});

test("UX-004: in a session's transcript both Run buttons say the result goes back to the agent; elsewhere only that it runs", async () => {
  tracker();
  await mountSession();
  const tracked = bus.runButtonTitle(true);
  expect(tracked).toContain("agent");
  expect(host.querySelector("button.code-run")!.getAttribute("title")).toBe(tracked);
  await act(async () => host.querySelector<HTMLButtonElement>(".tool-row")!.click());
  expect(host.querySelector("button.tool-run")!.getAttribute("title")).toBe(tracked);
  await act(() => root.render(createElement(Markdown, { text: MESSAGE })));
  expect(host.querySelector("button.code-run")!.getAttribute("title")).toBe(bus.runButtonTitle(false));
  expect(bus.runButtonTitle(false)).not.toContain("agent");
});

test("AC8: a shell that cannot start shows the 'Could not run the command' toast and the tracker hears the error", async () => {
  const t = tracker();
  await mountSession();
  failOpenCommand = "no such file: /bin/zsh";
  await act(async () => host.querySelector<HTMLButtonElement>("button.code-run")!.click());
  await flush();
  const toast = host.querySelector(".toast.toast-error")!;
  expect(toast.textContent).toContain("Could not run the command");
  expect(toast.textContent).toContain("no such file: /bin/zsh");
  expect(t.failed).toEqual([["run-1", "no such file: /bin/zsh"]]);
  expect(t.opened).toEqual([]);
  expect(calls.filter((c) => c[0] === "write")).toEqual([]);
});

test("a Run outside a session (no origin) still opens its own tab, and nothing is tracked", async () => {
  const t = tracker();
  await act(async () => root.render(createElement(ToastProvider, null, createElement(TerminalPanel, { cwd: "/proj" }), createElement(Markdown, { text: MESSAGE }))));
  await flush();
  await act(async () => host.querySelector<HTMLButtonElement>("button.code-run")!.click());
  await flush();
  expect(calls).toContainEqual(["opencommand", "/proj", "bun run desktop:build", "bun run desktop:build", 80, 24]);
  expect(t.requested).toEqual([]);
  expect(t.opened).toEqual([]);
});

test("a Run that opens the panel opens only the run tab, not an extra shell tab", async () => {
  const t = tracker();
  bus.runInTerminal("bun test", { sessionId: "s1" });
  await act(async () => root.render(createElement(ToastProvider, null, createElement(TerminalPanel, { cwd: "/proj" }))));
  await flush();
  expect(calls.filter((c) => c[0] === "open")).toEqual([]);
  expect(calls).toContainEqual(["opencommand", "/proj", "bun test", "bun test", 80, 24]);
  expect(host.querySelectorAll("[data-term]")).toHaveLength(1);
  expect(t.opened).toHaveLength(1);
});

test("TP-004: a tab list taken before a run tab opened keeps the run tab, shown, next to the listed ones", async () => {
  tabs = [tab(1)];
  nextId = 2;
  let release = () => {};
  listGate = new Promise<void>((r) => (release = r));
  await act(async () => root.render(createElement(ToastProvider, null, createElement(TerminalPanel, { cwd: "/proj" }))));
  await act(async () => bus.runInTerminal("bun test"));
  await flush();
  expect(host.querySelectorAll("[data-term]")).toHaveLength(1);
  await act(async () => release());
  await flush();
  expect(Array.from(host.querySelectorAll("[data-term]")).map((t) => t.getAttribute("data-term"))).toEqual(["1", "2"]);
  expect(host.querySelector('[data-term="2"]')!.hasAttribute("hidden")).toBe(false);
  expect(calls.filter((c) => c[0] === "open")).toEqual([]);
});

test("shortcuts: Ctrl+` is the terminal, Cmd+Shift+B the browser; toggling closes the open tab", () => {
  const k = (o: Partial<KeyboardEvent>) => ({ code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  expect(shell.sidePanelShortcut(k({ code: "Backquote", ctrlKey: true }))).toBe("terminal");
  expect(shell.sidePanelShortcut(k({ code: "KeyB", metaKey: true, shiftKey: true }))).toBe("browser");
  expect(shell.sidePanelShortcut(k({ code: "KeyB", metaKey: true }))).toBeNull();
  shell.toggleSidePanel("terminal", null);
  expect(prefs.getPrefs().sidePanel).toBe("terminal");
  shell.toggleSidePanel("browser", "terminal");
  expect(prefs.getPrefs().sidePanel).toBe("browser");
  shell.toggleSidePanel("browser", "browser");
  expect(prefs.getPrefs().sidePanel).toBeNull();
});

test("menu shortcuts: palette opens; a menu toggle right after the page's own toggle is the same key press", async () => {
  let palettes = 0;
  shell.onMenuPanel("palette", () => palettes++);
  expect(palettes).toBe(1);
  shell.toggleSidePanel("terminal", null);
  shell.onMenuPanel("terminal", () => {});
  expect(prefs.getPrefs().sidePanel).toBe("terminal");
  await new Promise((r) => setTimeout(r, 300));
  shell.onMenuPanel("browser", () => {});
  expect(prefs.getPrefs().sidePanel).toBe("browser");
});
