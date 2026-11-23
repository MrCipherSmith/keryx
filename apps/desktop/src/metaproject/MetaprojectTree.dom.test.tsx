import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type {
  MetaprojectNode,
  MetaprojectTreeEntry,
  MetaprojectTreeScope,
  MetaprojectTreeV2,
} from "../../../../src/integrations/metaproject-explorer-contract";
import type { MetaprojectTreeRequest } from "../platform/metaproject";
import { registerDom, unregisterDom } from "../test/dom";

let createElement: typeof import("react").createElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let Tree: typeof import("./MetaprojectTree").MetaprojectTree;
let useTree: typeof import("./useMetaprojectTree").useMetaprojectTree;
let root: Root;
let host: HTMLElement;

const SNAPSHOT = "a".repeat(64);
const node = (id: string, path: string, kind: MetaprojectNode["kind"] = "file", extra: Partial<MetaprojectNode> = {}): MetaprojectNode =>
  ({ id, kind, title: path.split("/").at(-1) ?? path, path, ...extra });
const folder = (path: string, files: number, module?: MetaprojectNode): MetaprojectTreeEntry =>
  ({ type: "folder", path, name: path.split("/").at(-1) ?? path, files, ...(module && { module }) });
const leaf = (item: MetaprojectNode): MetaprojectTreeEntry => ({ type: "node", node: item });

const readme = node("readme", "README.md");
const client = node("client", "src/client.ts");
const server = node("server", "src/server.ts");
const docsGuide = node("guide", "docs/guide.md");
const srcModule = node("module:src", "src", "module", { title: "src" });

type Answer = Omit<MetaprojectTreeV2, "schemaVersion" | "snapshotId" | "scope" | "parent"> | Error;

/** A tree reader whose answers are keyed by `parent|cursor`; a held key answers only when released. */
function reader(answers: Record<string, Answer>, scope: MetaprojectTreeScope = "graph") {
  const calls: MetaprojectTreeRequest[] = [];
  const held = new Map<string, () => void>();
  const hold = new Set<string>();
  const request = (_cwd: string, input: MetaprojectTreeRequest): Promise<MetaprojectTreeV2> => {
    calls.push(input);
    const key = `${input.parent ?? ""}|${input.cursor ?? ""}`;
    const settle = () => {
      const answer = answers[key];
      if (!answer) return Promise.reject(new Error(`No answer for ${key}`));
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ schemaVersion: 2 as const, snapshotId: input.expectedSnapshotId ?? SNAPSHOT, scope, parent: input.parent ?? null, ...answer });
    };
    if (!hold.has(key)) return settle();
    return new Promise((resolve, reject) => { held.set(key, () => { void settle().then(resolve, reject); }); });
  };
  return { request, calls, answers, hold, release: (key: string) => held.get(key)?.() };
}

function Harness(props: {
  snapshot?: string;
  request: (cwd: string, input: MetaprojectTreeRequest) => Promise<MetaprojectTreeV2>;
  scope?: MetaprojectTreeScope;
  selection?: string;
  selected?: MetaprojectNode;
  onSelect?: (node: MetaprojectNode) => void;
}) {
  const model = useTree({ cwd: "/project", snapshot: props.snapshot ?? SNAPSHOT, request: props.request, onStale: () => {} });
  return createElement(Tree, {
    scope: props.scope ?? "graph", label: "Project files", model,
    selection: props.selection ?? "", selected: props.selected, onSelect: props.onSelect ?? (() => {}),
  });
}

beforeAll(async () => {
  registerDom();
  const react = await import("react"); createElement = react.createElement; act = react.act as typeof act;
  Tree = (await import("./MetaprojectTree")).MetaprojectTree;
  useTree = (await import("./useMetaprojectTree")).useMetaprojectTree;
  host = document.createElement("div"); document.body.append(host); root = (await import("react-dom/client")).createRoot(host);
});
beforeEach(async () => { await act(() => root.render(null)); });
afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });

const items = () => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
function item(text: string) {
  const found = items().find(row => row.querySelector(".metaproject-tree-name")?.textContent === text || row.textContent?.startsWith(text));
  if (!found) throw new Error(`Missing tree row ${text}; rows: ${items().map(row => row.textContent).join(" | ")}`);
  return found;
}
const key = (target: Element, name: string) => act(async () => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
});
const focused = () => (document.activeElement as HTMLElement | null)?.querySelector(".metaproject-tree-name")?.textContent
  ?? document.activeElement?.textContent;

const ROOT_PAGE: Answer = { entries: [folder("docs", 1), folder("src", 2, srcModule), leaf(readme)], partial: false };
const SRC_PAGE: Answer = { entries: [leaf(client), leaf(server)], partial: false };
const DOCS_PAGE: Answer = { entries: [leaf(docsGuide)], partial: false };

test("renders a named WAI-ARIA tree with levels, positions, expansion, selection and one tab stop", async () => {
  const tree = reader({ "|": ROOT_PAGE, "src|": SRC_PAGE });
  await act(async () => { root.render(createElement(Harness, { request: tree.request, selection: readme.id })); });
  const list = host.querySelector('[role="tree"]');
  expect(list?.getAttribute("aria-label")).toBe("Project files");
  const docs = item("docs");
  expect(docs.getAttribute("aria-level")).toBe("1");
  expect(docs.getAttribute("aria-posinset")).toBe("1");
  expect(docs.getAttribute("aria-setsize")).toBe("3");
  expect(docs.getAttribute("aria-expanded")).toBe("false");
  expect(docs.textContent).toContain("1");
  const file = item("README.md");
  expect(file.getAttribute("aria-selected")).toBe("true");
  expect(file.getAttribute("aria-expanded")).toBeNull();
  expect(file.textContent).toContain("File");
  expect(items().filter(row => row.tabIndex === 0)).toEqual([file]);
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  expect(item("src").getAttribute("aria-expanded")).toBe("true");
  expect(item("client.ts").getAttribute("aria-level")).toBe("2");
  expect(item("server.ts").getAttribute("aria-posinset")).toBe("2");
});

test("expanding reads a folder once and shows one loading row until it arrives", async () => {
  const tree = reader({ "|": ROOT_PAGE, "src|": SRC_PAGE });
  tree.hold.add("src|");
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  const chevron = () => item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")!;
  await act(async () => { chevron().click(); });
  expect(items().filter(row => row.textContent === "Loading…")).toHaveLength(1);
  // Collapse and expand again while the read is pending: no second read.
  await act(async () => { chevron().click(); });
  await act(async () => { chevron().click(); });
  expect(tree.calls.filter(call => call.parent === "src")).toHaveLength(1);
  expect(tree.calls.find(call => call.parent === "src")?.expectedSnapshotId).toBe(SNAPSHOT);
  await act(async () => { tree.release("src|"); });
  expect(items().some(row => row.textContent === "Loading…")).toBe(false);
  expect(item("client.ts")).not.toBeNull();
  // Loaded children are kept: collapsing and expanding reads nothing.
  await act(async () => { chevron().click(); });
  await act(async () => { chevron().click(); });
  expect(tree.calls.filter(call => call.parent === "src")).toHaveLength(1);
});

test("a failed folder read shows an inline error whose Retry re-reads only that folder", async () => {
  const tree = reader({ "|": ROOT_PAGE, "src|": new Error("source-unavailable: graph read failed"), "docs|": DOCS_PAGE });
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("docs").click(); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  const error = item("Could not load.");
  expect(error.textContent).toContain("graph read failed");
  expect(error.getAttribute("aria-level")).toBe("2");
  expect(item("guide.md")).not.toBeNull();
  tree.answers["src|"] = SRC_PAGE;
  const before = tree.calls.length;
  await act(async () => { [...error.querySelectorAll("button")].find(button => button.textContent === "Retry")?.click(); });
  expect(tree.calls.slice(before)).toEqual([{ scope: "graph", parent: "src", expectedSnapshotId: SNAPSHOT }]);
  expect(item("client.ts")).not.toBeNull();
  expect(item("guide.md")).not.toBeNull();
});

test("Show more appends the next page in order without duplicates", async () => {
  const extra = node("z", "zeta.md");
  const tree = reader({
    "|": { entries: [leaf(readme), leaf(client)], nextCursor: "next-1", partial: false },
    "|next-1": { entries: [leaf(client), leaf(server)], nextCursor: "next-2", partial: false },
    "|next-2": { entries: [leaf(extra)], partial: false },
  });
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  expect(item("README.md").getAttribute("aria-setsize")).toBe("-1");
  await act(async () => { item("Show more").click(); });
  await act(async () => { item("Show more").click(); });
  const titles = items().map(row => row.querySelector(".metaproject-tree-name")?.textContent);
  expect(titles).toEqual(["README.md", "client.ts", "server.ts", "zeta.md"]);
  expect(tree.calls.map(call => call.cursor)).toEqual([undefined, "next-1", "next-2"]);
  expect(items().some(row => row.textContent === "Show more")).toBe(false);
  expect(item("zeta.md").getAttribute("aria-setsize")).toBe("4");
});

test("selecting a node row calls the selection callback; a module folder selects on its name and toggles on its chevron", async () => {
  const chosen: string[] = [];
  const tree = reader({ "|": ROOT_PAGE, "src|": SRC_PAGE });
  await act(async () => { root.render(createElement(Harness, { request: tree.request, onSelect: picked => chosen.push(picked.id) })); });
  await act(async () => { item("README.md").click(); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-name")?.click(); });
  expect(chosen).toEqual([readme.id, srcModule.id]);
  expect(item("src").getAttribute("aria-expanded")).toBe("false");
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  expect(item("src").getAttribute("aria-expanded")).toBe("true");
  await key(item("client.ts"), "Enter");
  expect(chosen).toEqual([readme.id, srcModule.id, client.id]);
});

test("keys move, expand, collapse and select as a WAI-ARIA tree", async () => {
  const chosen: string[] = [];
  const tree = reader({ "|": ROOT_PAGE, "src|": SRC_PAGE, "docs|": DOCS_PAGE });
  await act(async () => { root.render(createElement(Harness, { request: tree.request, onSelect: picked => chosen.push(picked.id) })); });
  const first = item("docs");
  expect(first.tabIndex).toBe(0);
  await act(async () => { first.focus(); });
  await key(first, "ArrowDown");
  expect(focused()).toBe("src");
  await key(document.activeElement!, "ArrowRight");
  expect(item("src").getAttribute("aria-expanded")).toBe("true");
  expect(focused()).toBe("src");
  await key(document.activeElement!, "ArrowRight");
  expect(focused()).toBe("client.ts");
  await key(document.activeElement!, "ArrowDown");
  expect(focused()).toBe("server.ts");
  await key(document.activeElement!, " ");
  expect(chosen).toEqual([server.id]);
  await key(document.activeElement!, "ArrowLeft");
  expect(focused()).toBe("src");
  await key(document.activeElement!, "ArrowLeft");
  expect(item("src").getAttribute("aria-expanded")).toBe("false");
  await key(document.activeElement!, "End");
  expect(focused()).toBe("README.md");
  await key(document.activeElement!, "Home");
  expect(focused()).toBe("docs");
  await key(document.activeElement!, "Enter");
  expect(item("docs").getAttribute("aria-expanded")).toBe("true");
  await key(document.activeElement!, " ");
  expect(item("docs").getAttribute("aria-expanded")).toBe("false");
  // Space on a module folder toggles it; Enter selects its module.
  await key(document.activeElement!, "ArrowDown");
  await key(document.activeElement!, " ");
  expect(item("src").getAttribute("aria-expanded")).toBe("true");
  await key(document.activeElement!, "Enter");
  expect(chosen).toEqual([server.id, srcModule.id]);
  expect(items().filter(row => row.tabIndex === 0)).toHaveLength(1);
});

test("data arriving never moves focus", async () => {
  const tree = reader({ "|": ROOT_PAGE, "src|": SRC_PAGE });
  tree.hold.add("src|");
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
    outside.focus();
    await act(async () => { tree.release("src|"); });
    expect(document.activeElement).toBe(outside);
  } finally { outside.remove(); }
});

test("a graph that is not built shows an empty-state line", async () => {
  const tree = reader({ "|": { entries: [], partial: true } });
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  expect(host.querySelector('[role="tree"]')).toBeNull();
  expect(host.textContent).toContain("The graph is not built yet.");
});

test("wiki groups show their page counts and hold their pages", async () => {
  const page = node("page", "wiki/flows/login.md", "wiki", { title: "Login flow", pageType: "flow" });
  const tree = reader({
    "|": { entries: [{ type: "group", key: "flow", name: "Flow", pages: 1 }], partial: false },
    "flow|": { entries: [leaf(page)], partial: false },
  }, "wiki");
  const chosen: string[] = [];
  await act(async () => { root.render(createElement(Harness, { request: tree.request, scope: "wiki", onSelect: picked => chosen.push(picked.id) })); });
  expect(item("Flow").textContent).toContain("1");
  await act(async () => { item("Flow").click(); });
  expect(item("Login flow").textContent).toContain("Wiki page");
  await act(async () => { item("Login flow").click(); });
  expect(chosen).toEqual(["page"]);
});

test("a selection made elsewhere expands its ancestors, pages until found and scrolls without focus", async () => {
  const deep = node("deep", "src/lib/deep.ts");
  const tree = reader({
    "|": { entries: [folder("docs", 1)], nextCursor: "root-2", partial: false },
    "|root-2": { entries: [folder("src", 2)], partial: false },
    "src|": { entries: [folder("src/lib", 1)], partial: false },
    "src/lib|": { entries: [leaf(deep)], partial: false },
  });
  const scrolled: string[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.textContent ?? ""); };
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
    outside.focus();
    await act(async () => { root.render(createElement(Harness, { request: tree.request, selection: deep.id, selected: deep })); });
    expect(item("src").getAttribute("aria-expanded")).toBe("true");
    expect(item("lib").getAttribute("aria-expanded")).toBe("true");
    expect(item("deep.ts").getAttribute("aria-selected")).toBe("true");
    expect(scrolled.some(text => text.startsWith("deep.ts"))).toBe(true);
    expect(document.activeElement).toBe(outside);
  } finally { HTMLElement.prototype.scrollIntoView = original; outside.remove(); }
});

test("reveal stops at a failed folder without reading it again", async () => {
  const deep = node("deep", "src/deep.ts");
  const tree = reader({ "|": { entries: [folder("src", 1)], partial: false }, "src|": new Error("read failed") });
  await act(async () => { root.render(createElement(Harness, { request: tree.request, selection: deep.id, selected: deep })); });
  await act(async () => {});
  expect(item("Could not load.")).not.toBeNull();
  expect(tree.calls.filter(call => call.parent === "src")).toHaveLength(1);
});

test("a module selected elsewhere is revealed as its own folder row, which stays collapsed", async () => {
  const lib = node("module:src/lib", "src/lib", "module", { title: "lib" });
  const tree = reader({
    "|": { entries: [folder("src", 2)], partial: false },
    "src|": { entries: [folder("src/lib", 1, lib)], partial: false },
  });
  const scrolled: string[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.dataset.row ?? ""); };
  try {
    await act(async () => { root.render(createElement(Harness, { request: tree.request, selection: lib.id, selected: lib })); });
    expect(item("src").getAttribute("aria-expanded")).toBe("true");
    expect(item("lib").getAttribute("aria-expanded")).toBe("false");
    expect(item("lib").getAttribute("aria-selected")).toBe("true");
    expect(scrolled).toEqual(["d:src/lib"]);
    expect(tree.calls.filter(call => call.parent === "src/lib")).toHaveLength(0);
  } finally { HTMLElement.prototype.scrollIntoView = original; }
});

test("a failed next page shows an inline error whose Retry asks for the same page again", async () => {
  const tree = reader({
    "|": { entries: [leaf(readme)], nextCursor: "next", partial: false },
    "|next": new Error("source-unavailable: page read failed"),
  });
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("Show more").click(); });
  const error = item("Could not load.");
  expect(error.textContent).toContain("page read failed");
  expect(item("README.md")).not.toBeNull();
  tree.answers["|next"] = { entries: [leaf(client)], partial: false };
  await act(async () => { [...error.querySelectorAll("button")].find(button => button.textContent === "Retry")?.click(); });
  expect(tree.calls.map(call => call.cursor)).toEqual([undefined, "next", "next"]);
  expect(items().map(row => row.querySelector(".metaproject-tree-name")?.textContent)).toEqual(["README.md", "client.ts"]);
});

test("an expanded folder that is not found after a new snapshot is forgotten quietly", async () => {
  const { MetaprojectRequestError } = await import("../../../../src/integrations/metaproject-explorer-contract");
  const tree = reader({ "|": ROOT_PAGE, "docs|": DOCS_PAGE });
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("docs").click(); });
  expect(item("guide.md")).not.toBeNull();
  tree.answers["docs|"] = new MetaprojectRequestError("not-found", "docs");
  const next = "b".repeat(64);
  await act(async () => { root.render(createElement(Harness, { request: tree.request, snapshot: next })); });
  await act(async () => {});
  expect(tree.calls.filter(call => call.parent === "docs" && call.expectedSnapshotId === next)).toHaveLength(1);
  expect(item("docs").getAttribute("aria-expanded")).toBe("false");
  expect(items().some(row => row.textContent?.startsWith("Could not load."))).toBe(false);
  expect(items().some(row => row.textContent === "Loading…")).toBe(false);
});
