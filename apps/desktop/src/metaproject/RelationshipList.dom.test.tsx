import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { MetaprojectNeighbors } from "../../../../src/integrations/metaproject-explorer-contract";
import { registerDom, unregisterDom } from "../test/dom";

let createElement: typeof import("react").createElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let List: typeof import("./RelationshipList").RelationshipList;
let summarize: typeof import("./RelationshipList").summarizeRelationships;
let root: Root;
let host: HTMLElement;

const client = { id: "client", kind: "file" as const, title: "Client", path: "src/client.ts" };
const guide = { id: "guide", kind: "wiki" as const, title: "Guide", path: "wiki/guide.md" };
const app = { id: "app", kind: "file" as const, title: "App", path: "src/app.ts" };
const server = { id: "server", kind: "file" as const, title: "Server", path: "src/server.ts" };
const api = { id: "api", kind: "file" as const, title: "Api", path: "src/api.ts" };
const pkg = { id: "pkg", kind: "module" as const, title: "src", path: "src" };

function projection(overrides: Partial<MetaprojectNeighbors> = {}): MetaprojectNeighbors {
  return {
    schemaVersion: 1,
    snapshotId: "one",
    root: client.id,
    nodes: [client, guide, app, server, api, pkg],
    edges: [
      { from: guide.id, to: client.id, kind: "describes", evidence: ["guide:3", "guide:9", "guide:20"], provenance: [{ path: "wiki/guide.md", digest: "d".repeat(64) }] },
      { from: app.id, to: client.id, kind: "imports", evidence: ["key-files", "src/app.ts"] },
      { from: pkg.id, to: client.id, kind: "contains" },
      { from: client.id, to: server.id, kind: "imports", count: 7, evidence: ["src/client.ts:4"] },
      { from: client.id, to: api.id, kind: "imports" },
      { from: server.id, to: api.id, kind: "calls" },
    ],
    truncated: false,
    ...overrides,
  };
}

beforeAll(async () => {
  registerDom();
  const react = await import("react"); createElement = react.createElement; act = react.act as typeof act;
  const module = await import("./RelationshipList");
  List = module.RelationshipList; summarize = module.summarizeRelationships;
  host = document.createElement("div"); document.body.append(host); root = (await import("react-dom/client")).createRoot(host);
});
beforeEach(async () => { await act(() => root.render(null)); });
afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });

function groupHeadings(selector: string) {
  return [...host.querySelectorAll(selector)].map(item => item.textContent?.replace(/\s+/g, " ").trim());
}

test("groups root-adjacent relationships by direction, then kind, with counts and readable kind names", async () => {
  await act(async () => { root.render(createElement(List, { projection: projection(), select: () => {} })); });
  expect(groupHeadings("h3")).toEqual(["Incoming 3", "Outgoing 2", "Second step 1"]);
  const incoming = host.querySelector('[data-direction="incoming"]');
  expect([...incoming!.querySelectorAll("h4")].map(item => item.textContent?.replace(/\s+/g, " ").trim()))
    .toEqual(["Imports 1", "Describes 1", "Contains 1"]);
  const outgoing = host.querySelector('[data-direction="outgoing"]');
  expect([...outgoing!.querySelectorAll("h4")].map(item => item.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Imports 2"]);
  // Rows inside a kind group are sorted by title.
  expect([...outgoing!.querySelectorAll(".metaproject-rel-title")].map(item => item.textContent)).toEqual(["Api", "Server"]);
});

test("a row is one line: title, readable kind badge and a truncated path with the full path in its title", async () => {
  const selected: string[] = [];
  await act(async () => { root.render(createElement(List, { projection: projection(), select: id => selected.push(id) })); });
  const row = host.querySelector<HTMLButtonElement>('[data-direction="incoming"] button[title="wiki/guide.md"]');
  expect(row?.querySelector(".metaproject-rel-title")?.textContent).toBe("Guide");
  expect(row?.querySelector(".badge")?.textContent).toBe("Wiki page");
  const path = row?.querySelector(".metaproject-rel-path");
  expect(path?.textContent).toBe("wiki/guide.md");
  expect(path?.classList.contains("truncate")).toBe(true);
  expect(row?.querySelector(".metaproject-rel-title")?.classList.contains("truncate")).toBe(true);
  await act(async () => { row!.click(); });
  expect(selected).toEqual(["guide"]);
});

test("evidence is a closed disclosure with at most two example lines and never a provenance digest", async () => {
  await act(async () => { root.render(createElement(List, { projection: projection(), select: () => {} })); });
  const toggle = host.querySelector<HTMLButtonElement>('[data-direction="incoming"] .metaproject-rel-toggle');
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector(".metaproject-rel-evidence")).toBeNull();
  await act(async () => { toggle!.click(); });
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  const evidence = [...host.querySelectorAll(".metaproject-rel-evidence li")].map(item => item.textContent);
  expect(evidence).toEqual(["guide:3", "guide:9", "and 1 more"]);
  expect(host.textContent).not.toContain("d".repeat(64));
});

test("a module import's disclosure is labelled with its count", async () => {
  await act(async () => { root.render(createElement(List, { projection: projection(), select: () => {} })); });
  const toggle = host.querySelector<HTMLButtonElement>('[data-direction="outgoing"] .metaproject-rel-toggle');
  expect(toggle?.textContent?.trim()).toBe("7 imports");
});

test("evidence that only repeats the neighbour's path becomes an origin tag, not lines", async () => {
  await act(async () => { root.render(createElement(List, { projection: projection(), select: () => {} })); });
  const item = host.querySelector('[data-direction="incoming"] button[title="src/app.ts"]')!.closest("li")!;
  expect(item.querySelector(".metaproject-rel-origin")?.textContent).toBe("key-files");
  expect(item.querySelector(".metaproject-rel-toggle")).toBeNull();
});

test("second-step relationships sit in a closed disclosure with their count and can open either end", async () => {
  const selected: string[] = [];
  await act(async () => { root.render(createElement(List, { projection: projection(), select: id => selected.push(id) })); });
  const second = host.querySelector<HTMLDetailsElement>('details[data-direction="second-step"]');
  expect(second?.open).toBe(false);
  expect(second?.querySelector("summary")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Second step 1");
  second!.open = true;
  expect(second?.textContent).toContain("Server");
  expect(second?.textContent).toContain("calls");
  expect(second?.textContent).toContain("Api");
  const buttons = [...second!.querySelectorAll("button")];
  expect(buttons.map(item => item.textContent?.trim())).toEqual(["Open Server", "Open Api"]);
  await act(async () => { buttons[0]!.click(); });
  await act(async () => { buttons[1]!.click(); });
  expect(selected).toEqual(["server", "api"]);
});

test("limited and empty projections say so", async () => {
  await act(async () => { root.render(createElement(List, { projection: projection({ truncated: true }), select: () => {} })); });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("limited");
  await act(async () => { root.render(createElement(List, { projection: projection({ edges: [] }), select: () => {} })); });
  expect(host.textContent).toContain("No relationships for these filters.");
  expect(host.querySelector("h3")).toBeNull();
});

test("summary counts incoming and outgoing root-adjacent edges only", () => {
  expect(summarize(projection())).toMatchObject({ incoming: 3, outgoing: 2, secondStep: 1, truncated: false });
});
