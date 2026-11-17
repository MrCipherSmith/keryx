import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { SessionInfo } from "../acp/types";
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

async function render(calls: Calls, trashResult = true) {
  await act(() =>
    root.render(
      createElement(SessionSidebar, {
        sessions: SESSIONS,
        marks: {},
        loadingIds: [],
        currentId: "a",
        ready: true,
        canOrganize: true,
        onNew: () => {},
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
