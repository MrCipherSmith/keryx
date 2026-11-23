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
      { from: app.id, to: client.id, kind: "imports" },
      { from: pkg.id, to: client.id, kind: "contains" },
      { from: client.id, to: server.id, kind: "imports" },
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

test("groups root-adjacent relationships by direction, then kind, with counts", async () => {
  await act(async () => { root.render(createElement(List, { projection: projection(), select: () => {} })); });
  expect(groupHeadings("h3")).toEqual(["Incoming 3", "Outgoing 2", "Second step 1"]);
  const incoming = host.querySelector('[data-direction="incoming"]');
  expect([...incoming!.querySelectorAll("h4")].map(item => item.textContent?.replace(/\s+/g, " ").trim()))
    .toEqual(["imports 1", "describes 1", "contains 1"]);
  const outgoing = host.querySelector('[data-direction="outgoing"]');
  expect([...outgoing!.querySelectorAll("h4")].map(item => item.textContent?.replace(/\s+/g, " ").trim())).toEqual(["imports 2"]);
  // Rows inside a kind group are sorted by title.
  expect([...outgoing!.querySelectorAll(".metaproject-rel-title")].map(item => item.textContent)).toEqual(["Api", "Server"]);
});

test("a row names the neighbour with a kind badge and path, and selects it", async () => {
  const selected: string[] = [];
  await act(async () => { root.render(createElement(List, { projection: projection(), select: id => selected.push(id) })); });
  const row = host.querySelector<HTMLButtonElement>('[data-direction="incoming"] button[title="wiki/guide.md"]');
  expect(row?.querySelector(".metaproject-rel-title")?.textContent).toBe("Guide");
  expect(row?.querySelector(".badge")?.textContent).toBe("wiki");
  expect(row?.querySelector(".metaproject-rel-path")?.textContent).toBe("wiki/guide.md");
  await act(async () => { row!.click(); });
  expect(selected).toEqual(["guide"]);
});

test("evidence shows at most two example lines and never a provenance digest", async () => {
  await act(async () => { root.render(createElement(List, { projection: projection(), select: () => {} })); });
  const evidence = [...host.querySelectorAll(".metaproject-rel-evidence li")].map(item => item.textContent);
  expect(evidence).toEqual(["guide:3", "guide:9", "and 1 more"]);
  expect(host.textContent).not.toContain("d".repeat(64));
});

test("second-step relationships name both ends and can open either", async () => {
  const selected: string[] = [];
  await act(async () => { root.render(createElement(List, { projection: projection(), select: id => selected.push(id) })); });
  const second = host.querySelector('[data-direction="second-step"]');
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
