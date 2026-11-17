import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { TaskInfo } from "../acp/providers";
import type { Subagent } from "./activity";
import type { Item } from "./reducer";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let React: typeof import("react");
let ActivityPanel: typeof import("./ActivityPanel").ActivityPanel;
let Transcript: typeof import("./Transcript").Transcript;

beforeAll(async () => {
  registerDom();
  React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  ActivityPanel = (await import("./ActivityPanel")).ActivityPanel;
  Transcript = (await import("./Transcript")).Transcript;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const EXT = ["_keryx/tasks/list", "_keryx/tasks/output", "_keryx/tasks/kill"];
const task = (over: Partial<TaskInfo> = {}): TaskInfo => ({
  id: "t1",
  command: "sleep 30",
  status: "running",
  phase: "background",
  description: null,
  startedAt: Date.now() - 5000,
  endedAt: null,
  exitCode: null,
  ...over,
});

interface Call {
  method: string;
  params: Record<string, unknown>;
}
let calls: Call[];
let handler: (method: string, params: Record<string, unknown>) => unknown;
const api = {
  extensions: EXT,
  request: (async (method: string, params?: unknown) => {
    calls.push({ method, params: params as Record<string, unknown> });
    return handler(method, params as Record<string, unknown>);
  }) as <T>(method: string, params?: unknown) => Promise<T>,
};

beforeEach(async () => {
  await act(() => root.render(null));
  calls = [];
  handler = () => ({});
});

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const click = (el: Element) => act(async () => void (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent!.trim() === label)!;
const outputCalls = () => calls.filter((c) => c.method === "_keryx/tasks/output");

interface PanelOver {
  tasks?: TaskInfo[];
  subagents?: Subagent[];
  tab?: "subagents" | "tasks";
  onRefreshTasks?: () => void;
  extensions?: string[];
}
async function renderPanel(o: PanelOver = {}) {
  const panelApi = o.extensions ? { ...api, extensions: o.extensions } : api;
  function Panel() {
    const [sel, setSel] = React.useState<string | null>(null);
    return React.createElement(ActivityPanel, {
      sessionId: "s1",
      subagents: o.subagents ?? [],
      tasks: o.tasks ?? [],
      api: panelApi,
      tab: o.tab ?? "tasks",
      onTab: () => {},
      subagentId: sel,
      onSubagent: setSel,
      onRefreshTasks: o.onRefreshTasks ?? (() => {}),
      onClose: () => {},
      pollMs: 10,
    });
  }
  await act(() => root.render(React.createElement(Panel)));
}

test("a task row shows command, status, phase, elapsed and the exit code", async () => {
  await renderPanel({ tasks: [task(), task({ id: "t2", command: "make", status: "failed", phase: "background", endedAt: Date.now(), exitCode: 2 })] });
  const rows = Array.from(document.querySelectorAll("[data-task]"));
  expect(rows.map((r) => r.getAttribute("data-task"))).toEqual(["t1", "t2"]);
  expect(rows[0]!.textContent).toContain("sleep 30");
  expect(rows[0]!.textContent).toContain("running · background · 5s");
  expect(rows[1]!.textContent).toContain("exit 2");
  // the Tasks tab carries the running count
  expect(document.querySelector('[role="tab"][aria-selected="true"] .tab-count')!.textContent).toBe("1");
});

test("selecting a running task polls its output by cursor, marks a gap, and stops once it exits", async () => {
  let n = 0;
  let refreshed = 0;
  handler = (method) => {
    if (method !== "_keryx/tasks/output") return {};
    n++;
    if (n === 1) return { output: "one\n", nextCursor: "c1", missed: false, status: "running" };
    if (n === 2) return { output: "two\n", nextCursor: "c2", missed: true, status: "running" };
    return { output: "three\n", nextCursor: "c3", missed: false, status: "completed" };
  };
  await renderPanel({ tasks: [task()], onRefreshTasks: () => void refreshed++ });
  await click(document.querySelector("[data-task]")!);
  await wait(120);
  const oc = outputCalls();
  expect(oc[0]!.params).toEqual({ sessionId: "s1", taskId: "t1" }); // no cursor on the first read
  expect(oc[1]!.params).toEqual({ sessionId: "s1", taskId: "t1", since: "c1" });
  expect(oc[2]!.params).toEqual({ sessionId: "s1", taskId: "t1", since: "c2" });
  const out = document.querySelector(".task-output")!;
  expect(out.textContent).toContain("one");
  expect(out.querySelector(".task-gap")).not.toBeNull();
  expect(out.textContent).toContain("three");
  expect(refreshed).toBe(1);
  // exited: no further polls
  const count = outputCalls().length;
  await wait(80);
  expect(outputCalls().length).toBe(count);
});

test("polling stops when the row is no longer shown", async () => {
  handler = () => ({ output: "", nextCursor: "c", status: "running" });
  await renderPanel({ tasks: [task()] });
  await click(document.querySelector("[data-task]")!);
  await wait(60);
  expect(outputCalls().length).toBeGreaterThan(2);
  await click(button("All tasks"));
  const count = outputCalls().length;
  await wait(60);
  expect(outputCalls().length).toBe(count);
  // and on unmount
  await click(document.querySelector("[data-task]")!);
  await wait(40);
  await act(() => root.render(null));
  const after = outputCalls().length;
  await wait(60);
  expect(outputCalls().length).toBe(after);
});

test("an exited task is read once, not polled", async () => {
  handler = () => ({ output: "done\n", nextCursor: "c1", status: "completed" });
  await renderPanel({ tasks: [task({ status: "completed", exitCode: 0, endedAt: Date.now() })] });
  await click(document.querySelector("[data-task]")!);
  await wait(60);
  expect(outputCalls()).toHaveLength(1);
  expect(document.querySelector(".task-output")!.textContent).toContain("done");
  expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Kill")).toBe(false);
});

test("Kill asks first and sends _keryx/tasks/kill only after the confirmation", async () => {
  let refreshed = 0;
  handler = (method) => (method === "_keryx/tasks/output" ? { output: "", nextCursor: "c", status: "running" } : { status: "killed" });
  await renderPanel({ tasks: [task()], onRefreshTasks: () => void refreshed++ });
  await click(document.querySelector("[data-task]")!);
  await click(button("Kill"));
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Kill t1?");
  expect(calls.some((c) => c.method === "_keryx/tasks/kill")).toBe(false);
  await click(button("Cancel"));
  expect(calls.some((c) => c.method === "_keryx/tasks/kill")).toBe(false);
  await click(button("Kill"));
  const confirmBtn = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === "Kill")!;
  await click(confirmBtn);
  expect(calls.find((c) => c.method === "_keryx/tasks/kill")!.params).toEqual({ sessionId: "s1", taskId: "t1" });
  expect(refreshed).toBeGreaterThan(0);
});

test("a keryx without the tasks methods shows no Tasks tab", async () => {
  await renderPanel({ extensions: [], tab: "tasks" });
  expect(Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).toEqual(["Subagents"]);
  expect(document.body.textContent).toContain("No subagents");
});

const AGENT: Subagent = {
  id: "a1",
  label: "reviewer",
  status: "running",
  model: "m-1",
  task: "Review the diff",
  parentToolCallId: "call-7",
  entries: [
    { kind: "task", text: "Review the diff" },
    { kind: "text", text: "Looking **closely** now" },
    { kind: "reasoning", text: "private thoughts" },
    { kind: "tool", text: "read_file a.ts" },
    { kind: "result", text: "1 file" },
  ],
};

test("a subagent shows its task and transcript entries by kind", async () => {
  await renderPanel({ tab: "subagents", subagents: [AGENT, { ...AGENT, id: "a2", label: "tester", status: "done", entries: [] }] });
  expect(document.querySelector('[role="tab"][aria-selected="true"] .tab-count')!.textContent).toBe("1");
  await click(document.querySelector('[data-subagent="a1"]')!);
  const d = document.querySelector('[data-subagent-detail="a1"]')!;
  expect(d.querySelector(".subagent-task-text")!.textContent).toBe("Review the diff");
  expect(d.querySelector(".entry-text strong")!.textContent).toBe("closely"); // markdown
  const reasoning = d.querySelector("details.entry-reasoning") as HTMLDetailsElement;
  expect(reasoning.open).toBe(false);
  expect(d.querySelector(".entry-tool pre")!.textContent).toBe("read_file a.ts");
  expect(d.querySelector(".entry-result pre")!.textContent).toBe("1 file");
});

test("the Show subagent link on a spawn_subagent tool card opens the subagent whose parentToolCallId matches", async () => {
  const items: Item[] = [
    { kind: "tool", id: 1, toolCallId: "call-1", title: "read", toolKind: "read", status: "completed", content: [], autoApproved: false, startedAt: 1, endedAt: 2 },
    { kind: "tool", id: 2, toolCallId: "call-7", title: "spawn_subagent", toolKind: "other", status: "in_progress", content: [], autoApproved: false, startedAt: 1, endedAt: null },
  ];
  const agents: Subagent[] = [{ ...AGENT, id: "other", label: "other", parentToolCallId: "call-9" }, AGENT];
  function Harness() {
    const [sel, setSel] = React.useState<string | null>(null);
    return React.createElement(
      "div",
      null,
      React.createElement(Transcript, { items, busy: false, replaying: false, empty: null, subagents: agents, onShowSubagent: setSel }),
      React.createElement(ActivityPanel, {
        sessionId: "s1",
        subagents: agents,
        tasks: [],
        api,
        tab: "subagents",
        onTab: () => {},
        subagentId: sel,
        onSubagent: setSel,
        onRefreshTasks: () => {},
        onClose: () => {},
      }),
    );
  }
  await act(() => root.render(React.createElement(Harness)));
  // only the spawning card has the link
  expect(document.querySelectorAll(".tool-link")).toHaveLength(1);
  expect(document.querySelectorAll(".tool")[0]!.querySelector(".tool-link")).toBeNull();
  await click(document.querySelector(".tool-link")!);
  expect(document.querySelector("[data-subagent-detail]")!.getAttribute("data-subagent-detail")).toBe("a1");
});
