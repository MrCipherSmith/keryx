import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let Markdown: typeof import("../components/Markdown").Markdown;
let bus: typeof import("./panelBus");
let prefs: typeof import("../lib/prefs");
let transcript: typeof import("../session/Transcript");
let shell: typeof import("../shell/AppShell");

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
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

beforeEach(() => prefs.setPrefs({ sidePanel: null }));

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

test("a single-command bash block gets Run; clicking it opens the terminal and sends the command", async () => {
  const got: string[] = [];
  const off = bus.onRunRequest((c) => got.push(c));
  const md = "lead-in\n\n```bash\nbun run desktop:build\n```\n\n```bash\ncd a\nls\n```\n\n```js\nconsole.log(1)\n```";
  await act(() => root.render(createElement(Markdown, { text: md })));
  const blocks = Array.from(host.querySelectorAll(".code-block"));
  expect(blocks.length).toBe(3);
  expect(blocks.map((b) => b.querySelector("button.code-run") !== null)).toEqual([true, false, false]);
  await act(async () => {
    blocks[0]!.querySelector<HTMLButtonElement>("button.code-run")!.click();
  });
  expect(got).toEqual(["bun run desktop:build"]);
  expect(prefs.getPrefs().sidePanel).toBe("terminal");
  off();
});

test("a run requested before the terminal panel listens is delivered when it does", () => {
  bus.runInTerminal("echo early");
  const got: string[] = [];
  const off = bus.onRunRequest((c) => got.push(c));
  expect(got).toEqual(["echo early"]);
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
