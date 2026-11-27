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
  tab?: "subagents" | "tasks" | "schedules" | "runs";
  onRefreshTasks?: () => void;
  extensions?: string[];
  onTab?: (t: "subagents" | "tasks" | "schedules" | "runs") => void;
  githubAccount?: React.ComponentProps<typeof ActivityPanel>["githubAccount"];
  onProjectSettings?: () => void;
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
      onTab: o.onTab ?? (() => {}),
      subagentId: sel,
      onSubagent: setSel,
      onRefreshTasks: o.onRefreshTasks ?? (() => {}),
      githubAccount: o.githubAccount,
      onProjectSettings: o.onProjectSettings,
      pollMs: 10,
    });
  }
  await act(() => root.render(React.createElement(Panel)));
}

test("shows the selected project GitHub account and opens Project Settings", async () => {
  let opened = 0;
  const onProjectSettings = () => { opened++; };
  await renderPanel({ githubAccount: { eligible: true, configured: true, login: "work-user" }, onProjectSettings });
  await click(button("GitHub · @work-user"));
  expect(opened).toBe(1);
  await renderPanel({ githubAccount: { eligible: true, configured: true, login: "personal-user" }, onProjectSettings });
  expect(host.textContent).not.toContain("@work-user");
  expect(host.textContent).toContain("@personal-user");
});

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

test("a /delegate run (runtime external, no parent tool call) is marked as external in the list and the detail", async () => {
  const external: Subagent = { ...AGENT, id: "ext:1", label: "Claude", runtime: "external", parentToolCallId: undefined, detail: "delegated", model: undefined };
  await renderPanel({ tab: "subagents", subagents: [external] });
  const row = document.querySelector('[data-subagent="ext:1"]')!;
  expect(row.querySelector(".activity-label")!.textContent).toContain("Claude");
  // A tinted, outlined badge with a terminal glyph and an accent edge on the row, apart from the grey model badge.
  expect(row.querySelector(".badge-external")!.textContent).toBe("external");
  expect(row.querySelector(".badge-external svg")).not.toBeNull();
  expect(row.classList.contains("is-external")).toBe(true);
  await click(row);
  expect(document.querySelector('[data-subagent-detail="ext:1"] .field-hint')!.textContent).toBe("external");
  expect(document.querySelector('[data-subagent-detail="ext:1"] .subagent-title .badge-external')).not.toBeNull();
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

const extAgent = (over: Partial<Subagent> = {}): Subagent => ({
  id: "ext:1",
  label: "Claude · fix the build",
  status: "idle",
  detail: "turn 1 done",
  runtime: "external",
  agentId: "claude-cli",
  entries: [{ kind: "result", text: "The build was failing on a stale lockfile." }],
  ...over,
});

test("an idle external run reads \"waiting for you\" in its own colour class, and only running runs count on the tab", async () => {
  await renderPanel({ tab: "subagents", subagents: [extAgent(), extAgent({ id: "ext:2", status: "running", entries: [] })] });
  const rows = Array.from(document.querySelectorAll("[data-subagent]"));
  expect(rows[0]!.getAttribute("data-subagent")).toBe("ext:2");
  expect(rows[0]!.querySelector(".activity-status")!.className).toContain("status-running");
  expect(rows[1]!.querySelector(".activity-status")!.className).toContain("status-idle");
  expect(rows[1]!.querySelector(".activity-status")!.getAttribute("title")).toBe("waiting for you");
  // two external runs, one idle: the tab counts the running one only
  expect(document.querySelector('[role="tab"][aria-selected="true"] .tab-count')!.textContent).toBe("1");
});

test("the idle run's detail shows its status label and each turn's result", async () => {
  await renderPanel({ tab: "subagents", subagents: [extAgent()] });
  await click(document.querySelector("[data-subagent]")!);
  const detail = document.querySelector("[data-subagent-detail]")!;
  expect(detail.querySelector(".badge")!.textContent).toBe("waiting for you");
  expect(detail.querySelector(".entry-result")!.textContent).toContain("stale lockfile");
});

// ---- schedules ---------------------------------------------------------------------------------

const SCHEDULES_VIEW = {
  title: "Schedules",
  rows: [
    {
      id: "nightly",
      label: "nightly",
      status: "active",
      detail: "local schedule · every night at 02:00\nnext in 3h · last ok 1d ago",
      actions: [
        { label: "Pause", command: "/schedules pause nightly" },
        { label: "Run now", command: "/schedules run nightly", confirm: "Run nightly now?" },
        { label: "Delete", command: "/schedules delete nightly", confirm: "Delete schedule nightly?" },
      ],
    },
    { id: "old", label: "old", status: "paused", detail: "local schedule · hourly\nnext paused · last failed", actions: [{ label: "Resume", command: "/schedules resume old" }] },
  ],
};
const FORM_VIEW = {
  title: "Schedule",
  body: "usage",
  form: { submit: "/schedule --name {name}", submitLabel: "Create", fields: [{ id: "name", label: "Name", kind: "text", required: true }] },
};
const COMMAND_EXT = [...EXT, "_keryx/command"];
const commandLines = () => calls.filter((c) => c.method === "_keryx/command").map((c) => `${c.params.name} ${c.params.args}`.trim());
const setValue = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const keryx = (text: string, k: Record<string, unknown> = {}) => ({ text, _meta: { keryx: k } });
const schedulesHandler = () => {
  handler = (method, params) => {
    if (method !== "_keryx/command") return {};
    if (params.name === "schedules" && params.args === "") return keryx("", { view: SCHEDULES_VIEW });
    if (params.name === "schedule" && params.args === "") return keryx("", { view: FORM_VIEW });
    if (params.name === "schedule" && !String(params.args).startsWith("confirmed")) {
      return keryx("draft", { confirmAction: { label: "Confirm", confirm: "cadence: hourly", command: `/schedule confirmed ${params.args}` } });
    }
    return keryx("done");
  };
};

test("the Schedules tab is hidden unless _keryx/command is advertised", async () => {
  await renderPanel({ tab: "schedules" });
  expect(Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).not.toContain("Schedules");
  await renderPanel({ tab: "schedules", extensions: COMMAND_EXT });
  expect(Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).toContain("Schedules");
});

test("the Schedules tab lists the /schedules view rows with cadence, next run, last outcome and paused state", async () => {
  schedulesHandler();
  await renderPanel({ tab: "schedules", extensions: COMMAND_EXT });
  await wait(0);
  expect(commandLines()).toEqual(["schedules"]);
  const rows = Array.from(document.querySelectorAll("[data-schedule]"));
  expect(rows.map((r) => r.getAttribute("data-schedule"))).toEqual(["nightly", "old"]);
  expect(rows[0]!.textContent).toContain("every night at 02:00");
  expect(rows[0]!.textContent).toContain("next in 3h");
  expect(rows[0]!.textContent).toContain("last ok 1d ago");
  expect(rows[1]!.querySelector(".badge-warn")!.textContent).toBe("paused");
});

test("a plain action sends its command and re-lists; run and delete confirm first and Cancel sends nothing", async () => {
  schedulesHandler();
  await renderPanel({ tab: "schedules", extensions: COMMAND_EXT });
  await wait(0);
  await click(button("Resume"));
  await wait(0);
  expect(commandLines()).toEqual(["schedules", "schedules resume old", "schedules"]);

  calls = [];
  await click(button("Delete"));
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Delete schedule nightly?");
  await click(button("Cancel"));
  expect(commandLines()).toEqual([]);
  await click(button("Run now"));
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Run nightly now?");
  await click(Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === "Run now")!);
  await wait(0);
  expect(commandLines()).toEqual(["schedules run nightly", "schedules"]);
});

test("Add schedule shows the /schedule form; Create asks once with the draft card and Confirm sends the confirmed line", async () => {
  schedulesHandler();
  await renderPanel({ tab: "schedules", extensions: COMMAND_EXT });
  await wait(0);
  await click(button("Add schedule"));
  await wait(0);
  expect(document.querySelector("[data-schedules-form]")).not.toBeNull();
  const create = document.querySelector('button[type="submit"]') as HTMLButtonElement;
  expect(create.textContent).toBe("Create");
  await setValue(document.querySelector("[data-schedules-form] input") as HTMLInputElement, "check");
  calls = [];
  await click(document.querySelector('button[type="submit"]')!);
  await wait(0);
  expect(commandLines()).toEqual(["schedule --name check"]);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("cadence: hourly");
  await click(button("Confirm"));
  await wait(0);
  expect(commandLines()).toEqual(["schedule --name check", "schedule confirmed --name check", "schedules"]);
  expect(document.querySelector("[data-schedules-form]")).toBeNull();
});

// ---- runs ----------------------------------------------------------------------------------------

const RUNS_VIEW = {
  title: "Runs of nightly",
  body: "Newest first. Open a run for its report and log.",
  rows: [
    { id: "nightly/r2", label: "11/19 02:00", status: "failed", detail: "mode trust · $0.0234 · broke <b>x</b>", actions: [{ label: "Open", command: "/schedules run-log nightly r2" }] },
    { id: "nightly/r1", label: "11/18 02:00", status: "ok", detail: "mode trust · $0.0100 · fine", actions: [{ label: "Open", command: "/schedules run-log nightly r1" }] },
  ],
};
const RUN_VIEW = (over: Record<string, unknown> = {}) => ({
  title: "Run 11/19 02:00 of nightly",
  body: "failed · mode trust · $0.0234 · broke",
  rows: [
    { id: "report", label: "Report", status: "complete", detail: "# Heading\n<script>x</script>", actions: [] },
    { id: "log", label: "Run log (nightly-2026.log)", status: "truncated", detail: "line 1\nline 2\n", actions: [] },
  ],
  ...over,
});
const runsHandler = (detail: unknown = RUN_VIEW()) => {
  handler = (method, params) => {
    if (method !== "_keryx/command" || params.name !== "schedules") return {};
    const args = String(params.args);
    if (args.startsWith("runs")) return keryx("", { view: RUNS_VIEW });
    if (args.startsWith("run-log")) return keryx("", { view: detail });
    return keryx("", { view: SCHEDULES_VIEW });
  };
};

test("the Runs tab is offered with _keryx/command and lists each run with status, mode, cost and outcome", async () => {
  await renderPanel({ tab: "runs" });
  expect(Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).not.toContain("Runs");
  runsHandler();
  await renderPanel({ tab: "runs", extensions: COMMAND_EXT });
  await wait(0);
  expect(commandLines()).toEqual(["schedules runs"]);
  const rows = Array.from(document.querySelectorAll("[data-run]"));
  expect(rows.map((r) => r.getAttribute("data-run"))).toEqual(["nightly/r2", "nightly/r1"]);
  expect(rows[0]!.textContent).toContain("mode trust · $0.0234");
  expect(rows[0]!.querySelector(".badge-warn")!.textContent).toBe("failed");
  expect(rows[1]!.querySelector(".badge-ok")!.textContent).toBe("ok");
  // run text is plain text, never markup
  expect(rows[0]!.querySelector("b")).toBeNull();
});

test("opening a run reads its run-log command; report and log are plain text, the cut log says so, Refresh reads again", async () => {
  runsHandler();
  await renderPanel({ tab: "runs", extensions: COMMAND_EXT });
  await wait(0);
  await click(document.querySelector('[data-run="nightly/r2"]')!);
  await wait(0);
  expect(commandLines()).toEqual(["schedules runs", "schedules run-log nightly r2"]);
  const report = document.querySelector('[data-run-section="report"] pre')!;
  expect(report.textContent).toBe("# Heading\n<script>x</script>");
  expect(report.querySelector("script")).toBeNull();
  expect(document.querySelector('[data-run-section="log"] .badge-warn')!.textContent).toBe("last 64 KB only");
  expect(document.querySelector('[data-run-section="log"] pre')!.textContent).toBe("line 1\nline 2\n");
  await click(document.querySelector('button[aria-label="Refresh run"]')!);
  await wait(0);
  expect(commandLines().filter((l) => l.startsWith("schedules run-log"))).toHaveLength(2);
  await click(button("All runs"));
  expect(document.querySelector("[data-run]")).not.toBeNull();
});

test("a run with no report or log shows why in place of the text", async () => {
  runsHandler(
    RUN_VIEW({
      rows: [
        { id: "report", label: "Report", status: "missing", detail: "this run wrote no report", actions: [] },
        { id: "log", label: "Run log", status: "missing", detail: "no log for this run", actions: [] },
      ],
    }),
  );
  await renderPanel({ tab: "runs", extensions: COMMAND_EXT });
  await wait(0);
  await click(document.querySelector('[data-run="nightly/r1"]')!);
  await wait(0);
  expect(document.querySelector('[data-run-section="report"]')!.textContent).toContain("this run wrote no report");
  expect(document.querySelector('[data-run-section="log"] pre')).toBeNull();
});

test("a keryx refusal or a failure shows in the Runs tab", async () => {
  handler = () => keryx("No schedule named 'x'.", { refused: true });
  await renderPanel({ tab: "runs", extensions: COMMAND_EXT });
  await wait(0);
  expect(document.querySelector('[role="alert"]')!.textContent).toContain("No schedule named");
});

test("the Runs button of a schedule row opens the Runs tab for that schedule", async () => {
  schedulesHandler();
  const tabs: string[] = [];
  function Host() {
    const [tab, setTab] = React.useState<"schedules" | "runs">("schedules");
    return React.createElement(ActivityPanel, {
      sessionId: "s1", subagents: [], tasks: [], api: { ...api, extensions: COMMAND_EXT }, tab,
      onTab: (t: string) => { tabs.push(t); setTab(t as "runs"); },
      subagentId: null, onSubagent: () => {}, onRefreshTasks: () => {},
    });
  }
  await act(() => root.render(React.createElement(Host)));
  await wait(0);
  runsHandler();
  await click(document.querySelector('[data-schedule-runs="nightly"]')!);
  await wait(0);
  expect(tabs).toEqual(["runs"]);
  expect(commandLines().pop()).toBe("schedules runs nightly");
  expect(document.querySelector(".runs-bar")!.textContent).toContain("nightly · show all");
});

// ---- placement -------------------------------------------------------------------------------------

test("the panel has no resize handle or close button of its own: the side panel owns both", async () => {
  await renderPanel({ tab: "subagents" });
  expect(document.querySelector('.activity-panel [role="separator"]')).toBeNull();
  expect(document.querySelector('[aria-label="Hide activity"]')).toBeNull();
  expect(document.querySelector(".activity-panel")!.getAttribute("aria-label")).toBe("Activity");
});

test("an external run's detail offers Open terminal while its tab is open", async () => {
  const bus = await import("./delegateBus");
  const opened: string[] = [];
  bus.setDelegateApi({ focus: (id) => (opened.push(id), true), isOpen: (id) => id === "r1" });
  const ext = { id: "r1", label: "Claude", status: "running", runtime: "external", entries: [], detail: null } as unknown as Subagent;
  const Host = () => {
    const [sel, setSel] = React.useState<string | null>("r1");
    return React.createElement(ActivityPanel, {
      sessionId: "s1", subagents: [ext], tasks: [], api, tab: "subagents", onTab: () => {},
      subagentId: sel, onSubagent: setSel, onRefreshTasks: () => {},
    });
  };
  await act(() => root.render(React.createElement(Host)));
  await click(document.querySelector('[data-open-terminal="r1"]')!);
  expect(opened).toEqual(["r1"]);
  bus.setDelegateApi({ focus: () => false, isOpen: () => false });
  await wait(0);
  expect(document.querySelector("[data-open-terminal]")).toBeNull();
  bus.setDelegateApi(null);
});

test("the panel's content cannot widen it: the body clips x, long text wraps, a pre block scrolls inside itself", async () => {
  const css = ((await import("../styles/activity.css", { with: { type: "text" } })) as unknown as { default: string }).default;
  const rule = (sel: string) => css.split("\n").find((l: string) => l.startsWith(`${sel} {`)) ?? "";
  expect(rule(".activity-body")).toContain("overflow-x: hidden");
  expect(rule(".activity-body")).toContain("overflow-wrap: anywhere");
  expect(rule(".activity-body pre")).toContain("overflow: auto");
  expect(rule(".activity-body pre")).toContain("max-width: 100%");
  expect(rule(".activity-panel")).toContain("overflow: hidden");
  expect(css).not.toContain("--activity-w"); // no column of its own any more
});

test("a run restored from history shows in Subagents as done, from history, without Open terminal", async () => {
  const restored: Subagent = { id: "ext:1", label: "claude-cli", status: "done", detail: "from history", runtime: "external", agentId: "claude-cli", entries: [{ kind: "result", text: "the answer" }] };
  await act(() => root.render(React.createElement(ActivityPanel, { sessionId: "s1", subagents: [restored], tasks: [], api, tab: "subagents", onTab: () => {}, subagentId: "ext:1", onSubagent: () => {}, onRefreshTasks: () => {}, pollMs: 0 })));
  expect(document.querySelector("[data-subagent-detail='ext:1']")).not.toBeNull();
  expect(document.body.textContent).toContain("from history");
  expect(document.body.textContent).toContain("the answer");
  expect(document.querySelector("[data-open-terminal]")).toBeNull();
});
