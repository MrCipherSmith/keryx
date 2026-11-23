import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";
import type { MetaprojectDetail, MetaprojectNeighbors } from "../../../../src/integrations/metaproject-explorer-contract";
import { registerDom, unregisterDom } from "../test/dom";

let createElement: typeof import("react").createElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let Panel: typeof import("./NodeDetailsPanel").NodeDetailsPanel;
let preview: typeof import("./NodeDetailsPanel").markdownPreview;
let root: Root;
let host: HTMLElement;
let frame: HTMLElement;

const client = { id: "client", kind: "file" as const, title: "Client", path: "src/client.ts", module: "module:src" };
const guide = { id: "guide", kind: "wiki" as const, title: "Guide", path: "wiki/guide.md", status: "current" };
const app = { id: "app", kind: "file" as const, title: "App", path: "src/app.ts" };
const server = { id: "server", kind: "file" as const, title: "Server", path: "src/server.ts" };
const api = { id: "api", kind: "file" as const, title: "Api", path: "src/api.ts" };
const snapshot = { schemaVersion: 1 as const, snapshotId: "one" };
const COVERS_PAGE = [
  "---",
  "title: Guide",
  "---",
  "# Guide",
  "",
  "> **Covers:** `src/client.ts`, _the client_",
  "",
  "The **client** sends `requests` to the _server_ and retries __twice__ on *failure*.",
  "",
  "- a list item",
].join("\n");

const relationships: MetaprojectNeighbors = {
  ...snapshot,
  root: client.id,
  nodes: [client, guide, app, server, api],
  edges: [
    { from: guide.id, to: client.id, kind: "describes" },
    { from: app.id, to: client.id, kind: "imports" },
    { from: client.id, to: server.id, kind: "imports" },
    { from: client.id, to: api.id, kind: "imports" },
    { from: server.id, to: api.id, kind: "calls" },
  ],
  truncated: false,
};
const documents: MetaprojectNeighbors = {
  ...snapshot, root: client.id, nodes: [client, guide], edges: [{ from: guide.id, to: client.id, kind: "describes" }], truncated: false,
};

type Props = ComponentProps<typeof import("./NodeDetailsPanel").NodeDetailsPanel>;
function props(overrides: Partial<Props> = {}): Props {
  return {
    node: client,
    relationships,
    relationshipsPending: false,
    relationshipsProblem: "",
    documents,
    documentsPending: false,
    documentsProblem: "",
    openSpec: true,
    readPreview: (id: string): Promise<MetaprojectDetail> => Promise.resolve({ ...snapshot, node: id === guide.id ? guide : client, markdown: COVERS_PAGE }),
    onResize: () => {},
    onClose: () => {},
    onSelect: () => {},
    onOpen: () => {},
    onFind: () => {},
    onRetry: () => {},
    ...overrides,
  };
}

beforeAll(async () => {
  registerDom();
  const react = await import("react"); createElement = react.createElement; act = react.act as typeof act;
  const module = await import("./NodeDetailsPanel");
  Panel = module.NodeDetailsPanel; preview = module.markdownPreview;
  frame = document.createElement("div"); document.body.append(frame);
  host = document.createElement("div"); frame.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});
beforeEach(async () => { await act(() => root.render(null)); });
afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });

function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function tab(name: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.dataset.tab === name);
  if (!found) throw new Error(`Missing tab ${name}`);
  return found;
}
function render(overrides: Partial<Props> = {}) {
  return act(async () => { root.render(createElement(Panel, props(overrides))); });
}

test("the header shows a kind badge, the title and the path, and Copy path writes the path", async () => {
  const copied: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  try {
    await render();
    const panel = host.querySelector('aside[aria-label="Graph node details"]');
    expect(panel?.querySelector("header .badge")?.textContent).toBe("File");
    expect(panel?.querySelector("h2")?.textContent).toBe("Client");
    expect(panel?.querySelector("header code")?.textContent).toBe("src/client.ts");
    await act(async () => { button("Copy path").click(); });
    expect(copied).toEqual(["src/client.ts"]);
    expect(host.textContent).toContain("Copied");
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("relationship counts come from the root-adjacent edges and say when they are limited", async () => {
  // Root-adjacent edges only: the fact reads exactly as AC7 states (second-step counts: F-007 test below).
  const adjacentOnly = { ...relationships, edges: relationships.edges.filter(edge => edge.from === client.id || edge.to === client.id) };
  await render({ relationships: adjacentOnly });
  const facts = host.querySelector(".metaproject-details-facts");
  expect(facts?.textContent).toContain("2 incoming · 2 outgoing");
  expect(facts?.textContent).not.toContain("limited");
  await render({ relationships: { ...adjacentOnly, truncated: true } });
  expect(host.querySelector(".metaproject-details-facts")?.textContent).toContain("2 incoming · 2 outgoing · limited");
});

test("the Module fact shows the module path as a control that selects the module", async () => {
  const selected: string[] = [];
  await render({ onSelect: id => selected.push(id) });
  const facts = host.querySelector(".metaproject-details-facts")!;
  expect(facts.textContent).not.toContain("module:src");
  const control = [...facts.querySelectorAll("button")].find(item => item.textContent === "src");
  if (!control) throw new Error("Missing module control");
  await act(async () => { control.click(); });
  expect(selected).toEqual(["module:src"]);
});

test("the counts fact is labelled Relationships, like the tab", async () => {
  await render();
  const keys = [...host.querySelectorAll(".metaproject-details-facts .info-key")].map(item => item.textContent);
  expect(keys).toContain("Relationships");
  expect(keys).not.toContain("Relations");
});

test("Relationships is the default tab, grouped by direction, and a row selects the neighbour", async () => {
  const selected: string[] = [];
  await render({ onSelect: id => selected.push(id) });
  expect(tab("relationships").getAttribute("aria-selected")).toBe("true");
  const body = host.querySelector('[role="tabpanel"]');
  expect([...body!.querySelectorAll("h3")].map(item => item.textContent?.replace(/\s+/g, " ").trim()))
    .toEqual(["Incoming 2", "Outgoing 2", "Second step 1"]);
  await act(async () => { body!.querySelector<HTMLButtonElement>('button[title="src/server.ts"]')!.click(); });
  await act(async () => { button("Open Api").click(); });
  expect(selected).toEqual(["server", "api"]);
});

test("an OpenSpec node still opens on the Relationships tab", async () => {
  await render({ node: { id: "spec", kind: "spec", title: "Picker", path: "openspec/specs/picker/spec.md" }, relationships: null, relationshipsPending: true });
  expect(tab("relationships").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('[role="tabpanel"] [role="status"]')?.textContent).toContain("Loading relationships");
});

test("a relationships failure shows the message and Retry", async () => {
  let retries = 0;
  await render({ relationships: null, relationshipsProblem: "Graph read failed", onRetry: () => { retries++; } });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Graph read failed");
  await act(async () => { button("Retry").click(); });
  expect(retries).toBe(1);
});

test("a new revealRelationships value switches back to the Relationships tab", async () => {
  await render({ revealRelationships: 1 });
  await act(async () => { tab("wiki").click(); });
  expect(tab("wiki").getAttribute("aria-selected")).toBe("true");
  await render({ revealRelationships: 1 });
  expect(tab("wiki").getAttribute("aria-selected")).toBe("true");
  await render({ revealRelationships: 2 });
  expect(tab("relationships").getAttribute("aria-selected")).toBe("true");
});

test("the Wiki tab lists linked pages with a clean preview and one primary action", async () => {
  const opened: string[] = [];
  await render({ onOpen: node => opened.push(node.id) });
  await act(async () => { tab("wiki").click(); });
  const body = host.querySelector('[role="tabpanel"]');
  const text = body?.querySelector(".metaproject-details-preview")?.textContent ?? "";
  expect(text).toBe("The client sends requests to the server and retries twice on failure.");
  expect(text).not.toMatch(/[>*`_]/);
  expect(text).not.toContain("Covers");
  expect(body?.querySelectorAll(".btn-primary")).toHaveLength(1);
  await act(async () => { button("Open in Wiki").click(); });
  expect(opened).toEqual(["guide"]);
});

test("an unlinked node offers Find and Draft, and OpenSpec without support explains why", async () => {
  const found: string[] = [];
  await render({ documents: { ...documents, nodes: [client], edges: [] }, onFind: kind => found.push(kind), onDraft: async () => {} });
  await act(async () => { tab("wiki").click(); });
  expect(host.textContent).toContain("No Wiki page is linked to this node.");
  expect(host.querySelectorAll('[role="tabpanel"] .btn-primary')).toHaveLength(1);
  await act(async () => { button("Find a Wiki page").click(); });
  expect(found).toEqual(["wiki"]);
  expect(button("Draft Wiki page").classList.contains("btn-primary")).toBe(false);
  await render({ openSpec: false });
  await act(async () => { tab("openspec").click(); });
  expect(host.textContent).toContain("This CLI does not support OpenSpec");
});

test("Escape closes, the resize handle answers the keyboard, and the docked panel leaves focus alone", async () => {
  let closed = 0;
  const widths: number[] = [];
  const outside = document.createElement("button"); document.body.append(outside); outside.focus();
  try {
    await render({ width: 380, onClose: () => { closed++; }, onResize: width => widths.push(width) });
    expect(document.activeElement).toBe(outside);
    const separator = host.querySelector<HTMLElement>('[role="separator"]')!;
    await act(async () => { separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(widths).toEqual([412]);
    await act(async () => { button("Close graph node details").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(closed).toBe(1);
  } finally { outside.remove(); }
});

test("in a narrow host the panel is a drawer that takes focus and gives it back on close", async () => {
  const outside = document.createElement("button"); document.body.append(outside); outside.focus();
  Object.defineProperty(host, "clientWidth", { configurable: true, get: () => 700 });
  try {
    await render();
    const panel = host.querySelector("aside");
    expect(panel?.classList.contains("compact")).toBe(true);
    expect(host.querySelector('[role="separator"]')).toBeNull();
    expect(panel?.contains(document.activeElement)).toBe(true);
    await act(async () => { root.render(null); });
    expect(document.activeElement).toBe(outside);
  } finally {
    Reflect.deleteProperty(host, "clientWidth");
    outside.remove();
  }
});

test("markdownPreview drops metadata and Markdown markers", () => {
  expect(preview(COVERS_PAGE)).toBe("The client sends requests to the server and retries twice on failure.");
  expect(preview("Version: 2\nStatus: draft\n\n1. Use [the guide](wiki/guide.md) for ~~old~~ setup")).toBe("Use the guide for old setup");
  expect(preview("snake_case names stay intact")).toBe("snake_case names stay intact");
});

test("the Relationships fact adds the second-step count when there is one, and reads as before when there is none", async () => {
  await render({ relationships: { ...relationships, truncated: true } });
  expect(host.querySelector(".metaproject-details-facts")?.textContent).toContain("2 incoming · 2 outgoing · 1 second-step · limited");
  expect(tab("relationships").querySelector(".tab-count")?.textContent).toBe("5");
  const adjacentOnly = { ...relationships, edges: relationships.edges.filter(edge => edge.from === client.id || edge.to === client.id) };
  await render({ relationships: adjacentOnly });
  const facts = host.querySelector(".metaproject-details-facts")?.textContent ?? "";
  expect(facts).toContain("2 incoming · 2 outgoing");
  expect(facts).not.toContain("second-step");
});

test("Escape that another handler already handled does not close the panel", async () => {
  let closed = 0;
  await render({ onClose: () => { closed++; } });
  const target = button("Copy path");
  const handled = (event: Event) => event.preventDefault();
  target.addEventListener("keydown", handled);
  try {
    await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(closed).toBe(0);
  } finally { target.removeEventListener("keydown", handled); }
});

test("Draft runs once while a session is opening, and a draft error is cleared by choosing another tab", async () => {
  const drafts: string[] = [];
  let finish: () => void = () => {};
  await render({ documents: { ...documents, nodes: [client], edges: [] }, onDraft: task => { drafts.push(task); return new Promise<void>(resolve => { finish = resolve; }); } });
  await act(async () => { tab("wiki").click(); });
  const draft = button("Draft Wiki page");
  await act(async () => { draft.click(); });
  expect(draft.textContent).toContain("Opening session");
  await act(async () => { draft.click(); });
  expect(drafts).toHaveLength(1);
  await act(async () => { finish(); });
  await render({ documents: { ...documents, nodes: [client], edges: [] }, onDraft: () => Promise.reject(new Error("No session could be opened")) });
  await act(async () => { button("Draft Wiki page").click(); });
  expect(host.querySelector('[role="tabpanel"] [role="alert"]')?.textContent).toBe("No session could be opened");
  await act(async () => { tab("openspec").click(); });
  expect(host.textContent).not.toContain("No session could be opened");
});

test("a preview answered for another document is not shown", async () => {
  await render({ readPreview: () => Promise.resolve({ ...snapshot, node: app, markdown: "Stale paragraph" }) });
  await act(async () => { tab("wiki").click(); });
  expect(host.textContent).not.toContain("Stale paragraph");
});

test("no preview is read while the Relationships tab is shown", async () => {
  const reads: unknown[] = [];
  await render({ readPreview: id => { reads.push(id); return Promise.resolve({ ...snapshot, node: guide, markdown: "Text" }); } });
  expect(reads).toEqual([]);
  await act(async () => { tab("wiki").click(); });
  expect(reads).toEqual(["guide"]);
});

test("a tab chosen for one node does not carry over to the next node", async () => {
  await render();
  await act(async () => { tab("wiki").click(); });
  await render({ node: server });
  expect(tab("relationships").getAttribute("aria-selected")).toBe("true");
});

test("arrow keys, Home and End move between tabs and focus the chosen one", async () => {
  await render();
  const list = host.querySelector<HTMLElement>('[role="tablist"]')!;
  const press = (key: string) => act(async () => { list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  await press("ArrowRight");
  expect(tab("wiki").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tab("wiki"));
  await press("ArrowRight");
  expect(tab("openspec").getAttribute("aria-selected")).toBe("true");
  await press("ArrowRight");
  expect(tab("relationships").getAttribute("aria-selected")).toBe("true");
  await press("ArrowLeft");
  expect(tab("openspec").getAttribute("aria-selected")).toBe("true");
  await press("Home");
  expect(tab("relationships").getAttribute("aria-selected")).toBe("true");
  await press("End");
  expect(tab("openspec").getAttribute("aria-selected")).toBe("true");
});

test("the Wiki count leaves out a suggested component page", async () => {
  const page = { id: "page", kind: "wiki" as const, title: "Client page", path: "wiki/client.md" };
  await render({ documents: { ...documents, nodes: [client], edges: [] }, suggestedWiki: page });
  expect(tab("wiki").querySelector(".tab-count")?.textContent).toBe("0");
  await act(async () => { tab("wiki").click(); });
  expect(host.textContent).toContain("Matching component page");
});

test("a failed copy says so, and copy feedback does not follow to another node", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let fail = true;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { if (fail) throw new Error("denied"); } } });
  try {
    await render();
    await act(async () => { button("Copy path").click(); });
    expect(host.querySelector(".metaproject-details-copied")?.textContent).toBe("Could not copy");
    fail = false;
    await act(async () => { button("Copy path").click(); });
    expect(host.querySelector(".metaproject-details-copied")?.textContent).toBe("Copied");
    await render({ node: server });
    expect(host.querySelector(".metaproject-details-copied")?.textContent).toBe("");
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("dragging the handle left widens the panel and ArrowRight narrows it", async () => {
  const widths: number[] = [];
  await render({ width: 380, onResize: width => widths.push(width) });
  const separator = host.querySelector<HTMLElement>('[role="separator"]')!;
  Object.defineProperty(separator, "setPointerCapture", { configurable: true, value: () => {} });
  await act(async () => {
    separator.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 500, bubbles: true }));
    separator.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 460, bubbles: true }));
  });
  expect(widths).toEqual([420]);
  await act(async () => { separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(widths).toEqual([420, 348]);
});

test("markdownPreview skips fenced code, prefers prose after a leading list, and cuts long text", () => {
  const page = ["- first item", "- second item", "", "```", "const notProse = true;", "```", "", "The prose paragraph."].join("\n");
  expect(preview(page)).toBe("The prose paragraph.");
  const long = "word ".repeat(80).trim();
  const cut = preview(long);
  expect(cut).toHaveLength(360);
  expect(cut.endsWith("…")).toBe(true);
  expect(preview("x".repeat(360))).toHaveLength(360);
});
