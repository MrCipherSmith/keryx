import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { SessionInfo } from "../acp/types";
import type { Subagent } from "./activity";
import type { SessionMark } from "./reducer";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let SessionSidebar: typeof import("./SessionSidebar").SessionSidebar;
let createElement: typeof import("react").createElement;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  SessionSidebar = (await import("./SessionSidebar")).SessionSidebar;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const now = new Date().toISOString();
const SESSIONS: SessionInfo[] = [
  { sessionId: "a", cwd: "/p", title: "Alpha", updatedAt: now },
  { sessionId: "b", cwd: "/p", title: "Beta", updatedAt: now, _meta: { keryx: { pinnedAt: now } } },
  { sessionId: "c", cwd: "/p", title: "Gamma", updatedAt: now, _meta: { keryx: { archivedAt: now } } },
];

interface Calls {
  flags: Array<[string, Record<string, boolean>]>;
  trash: string[];
}

async function render(calls: Calls, trashResult = true, extra: { marks?: Record<string, SessionMark>; onShowSubagent?: (sid: string, id: string) => void } = {}) {
  await act(() =>
    root.render(
      createElement(SessionSidebar, {
        sessions: SESSIONS,
        marks: extra.marks ?? {},
        loadingIds: [],
        currentId: "a",
        ready: true,
        canOrganize: true,
        onNew: () => {},
        onShowSubagent: extra.onShowSubagent ?? (() => {}),
        onLoad: () => {},
        onCollapse: () => {},
        onSetFlags: (id, change) => calls.flags.push([id, change as Record<string, boolean>]),
        onTrash: async (id) => {
          calls.trash.push(id);
          return trashResult;
        },
      }),
    ),
  );
}

const titles = (): string[] => Array.from(host.querySelectorAll(".session-item-title")).map((e) => e.textContent ?? "");
const buttonByText = (root: ParentNode, text: string): HTMLButtonElement =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

/** Opens a row's ⋯ menu and clicks one of its items (each step in its own act: nested acts do not flush). */
async function menuAction(title: string, item: string): Promise<void> {
  const more = host.querySelector(`[aria-label="More for ${title}"]`) as HTMLButtonElement;
  await act(async () => more.click());
  const menu = host.querySelector('[role="menu"]') as HTMLElement;
  await act(async () => buttonByText(menu, item).click());
}

test("active view: Pinned group first, archived left out; the switch shows archived ones", async () => {
  await render({ flags: [], trash: [] });
  expect(Array.from(host.querySelectorAll(".session-bucket span:first-of-type")).map((e) => e.textContent)).toEqual(["Pinned", "Today"]);
  expect(titles()).toEqual(["Beta", "Alpha"]);
  await act(async () => buttonByText(host, "Archived").click());
  expect(titles()).toEqual(["Gamma"]);
  await act(async () => buttonByText(host, "Active").click());
});

test("the ⋯ menu pins and archives through onSetFlags", async () => {
  const calls: Calls = { flags: [], trash: [] };
  await render(calls);
  await menuAction("Alpha", "Pin");
  await menuAction("Beta", "Archive");
  expect(calls.flags).toEqual([
    ["a", { pinned: true }],
    ["b", { archived: true }],
  ]);
});

test("Move to Trash asks first; Cancel calls nothing, confirming calls onTrash", async () => {
  const calls: Calls = { flags: [], trash: [] };
  await render(calls);
  await menuAction("Alpha", "Move to Trash");
  const dialog = () => host.querySelector('[role="dialog"]') as HTMLElement | null;
  expect(dialog()?.textContent).toContain("Alpha");
  await act(async () => buttonByText(dialog()!, "Cancel").click());
  expect(dialog()).toBeNull();
  expect(calls.trash).toEqual([]);

  await menuAction("Alpha", "Move to Trash");
  await act(async () => buttonByText(dialog()!, "Move to Trash").click());
  expect(calls.trash).toEqual(["a"]);
  expect(dialog()).toBeNull();
});

test("a group folds and unfolds; its rows hide while folded", async () => {
  await render({ flags: [], trash: [] });
  const pinned = () => buttonByText(host, "Pinned");
  await act(async () => pinned().click());
  expect(pinned().getAttribute("aria-expanded")).toBe("false");
  expect(titles()).toEqual(["Alpha"]);
  await act(async () => pinned().click());
  expect(titles()).toEqual(["Beta", "Alpha"]);
});

const sub = (id: string, over: Partial<Subagent> = {}): Subagent => ({ id, label: id, status: "done", entries: [], ...over });
const mark = (subagents: Subagent[], held = true): SessionMark => ({ busy: false, waiting: false, held, lostReason: null, title: null, running: 0, subagents });
const children = (): string[] => Array.from(host.querySelectorAll(".session-child-label")).map((e) => e.textContent ?? "");
const twist = (): HTMLButtonElement => host.querySelector(".session-agents") as HTMLButtonElement;

test("subagents render as children under their session; none for a released or childless one", async () => {
  localStorage.removeItem("keryx.prefs.v1");
  const { setPrefs } = await import("../lib/prefs");
  await act(async () => setPrefs({ subagentTree: {} }));
  await render({ flags: [], trash: [] }, true, {
    marks: {
      a: mark([sub("s1", { label: "Researcher", status: "running", model: "m-1" }), sub("s2", { label: "Codex", runtime: "external", status: "failed" })]),
      b: mark([sub("gone")], false),
    },
  });
  // running one: open by default; the node is a child of Alpha's list item
  expect(children()).toEqual(["Researcher", "Codex"]);
  const node = host.querySelector(".session-children")!.closest("li.session-node")!;
  expect(node.querySelector(".session-item-title")?.textContent).toBe("Alpha");
  expect(host.querySelectorAll(".session-agents").length).toBe(1);
  // the pill sits in the row, shows the count and a running dot; session rows carry no chevron of their own
  const pill = node.querySelector(".session-row .session-agents")!;
  expect(pill.textContent).toBe("2 agents");
  expect(pill.querySelector(".session-agents-dot")).not.toBeNull();
  expect(node.querySelector(".session-row .session-twist")).toBeNull();
  expect(node.querySelector(".session-row .session-item svg")).toBeNull();
  expect(pill.querySelector("svg")).toBeNull();
  expect(host.querySelector(".session-child-model")?.textContent).toBe("m-1");
  expect(host.querySelectorAll(".session-children .badge")).toHaveLength(1);
  expect(host.querySelector(".session-children .badge")?.textContent).toBe("external");
  expect(Array.from(host.querySelectorAll(".session-child-dot")).map((e) => e.getAttribute("aria-label"))).toEqual(["running", "failed"]);
  expect(host.textContent).not.toContain("gone");
});

test("the fold toggles, is remembered per session and defaults to folded when nothing runs", async () => {
  const { setPrefs } = await import("../lib/prefs");
  await act(async () => setPrefs({ subagentTree: {} }));
  const marks = { a: mark([sub("s1", { label: "Done one" })]) };
  await render({ flags: [], trash: [] }, true, { marks });
  expect(children()).toEqual([]);
  expect(twist().getAttribute("aria-expanded")).toBe("false");
  await act(async () => twist().click());
  expect(twist().getAttribute("aria-expanded")).toBe("true");
  expect(children()).toEqual(["Done one"]);
  expect(JSON.parse(localStorage.getItem("keryx.prefs.v1")!).subagentTree).toEqual({ a: true });
  // a remount keeps the choice
  await act(async () => root.render(createElement("div")));
  await render({ flags: [], trash: [] }, true, { marks });
  expect(children()).toEqual(["Done one"]);
  await act(async () => twist().click());
  expect(children()).toEqual([]);
  expect(JSON.parse(localStorage.getItem("keryx.prefs.v1")!).subagentTree).toEqual({ a: false });
});

test("clicking a child asks to show that subagent of that session", async () => {
  const { setPrefs } = await import("../lib/prefs");
  await act(async () => setPrefs({ subagentTree: {} }));
  const shown: Array<[string, string]> = [];
  await render({ flags: [], trash: [] }, true, {
    marks: { b: mark([sub("x9", { label: "Runner", status: "running" })]) },
    onShowSubagent: (sid, id) => shown.push([sid, id]),
  });
  await act(async () => (host.querySelector(".session-child") as HTMLButtonElement).click());
  expect(shown).toEqual([["b", "x9"]]);
});

test("the children list is indented with a thin guide line and smaller text; the pill is a button with aria-expanded", async () => {
  const css = ((await import("../styles/activity.css", { with: { type: "text" } })) as unknown as { default: string }).default;
  const rule = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
  expect(rule(".session-children")).toMatch(/border-left:\s*1px solid/);
  expect(rule(".session-children")).toMatch(/margin:[^;]*14px|padding:[^;]*8px/);
  expect(rule(".session-child")).toContain("font-size: var(--fs-xs)");
  expect(css).not.toContain(".session-twist");
  const { setPrefs } = await import("../lib/prefs");
  await act(async () => setPrefs({ subagentTree: {} }));
  await render({ flags: [], trash: [] }, true, { marks: { a: mark([sub("s1")]) } });
  expect(twist().tagName).toBe("BUTTON");
  expect(twist().textContent).toBe("1 agent");
  expect(twist().querySelector(".session-agents-dot")).toBeNull();
  expect(twist().getAttribute("aria-controls")).toBe("subagents-a");
});
