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
let MAX_TREE_READS: number;
/** Desktop's answer when every read permit is taken, as the transport defines it. */
let PERMIT_REFUSAL: string;
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
  onStale?: () => void;
  /** Stands for the explorer's catalog: a new value re-reads the reads parked stale. */
  reload?: number;
  wait?: (ms: number) => Promise<void>;
}) {
  const model = useTree({
    cwd: "/project", snapshot: props.snapshot ?? SNAPSHOT, request: props.request, onStale: props.onStale ?? (() => {}),
    reload: props.reload ?? 0, ...(props.wait && { wait: props.wait }),
  });
  return createElement(Tree, {
    scope: props.scope ?? "graph", label: "Project files", model,
    selection: props.selection ?? "", selected: props.selected, onSelect: props.onSelect ?? (() => {}),
  });
}

beforeAll(async () => {
  registerDom();
  const react = await import("react"); createElement = react.createElement; act = react.act as typeof act;
  Tree = (await import("./MetaprojectTree")).MetaprojectTree;
  ({ useMetaprojectTree: useTree, MAX_TREE_READS } = await import("./useMetaprojectTree"));
  ({ METAPROJECT_PERMIT_REFUSAL: PERMIT_REFUSAL } = await import("../platform/metaproject"));
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
  // The failure is announced like the loading row it replaced.
  expect(error.querySelector('[role="status"]')?.textContent).toBe("Could not load. source-unavailable: graph read failed");
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
  // A module folder carries the Module kind label; a plain folder does not.
  expect(item("src").querySelector(".metaproject-meta")?.textContent).toBe("Module");
  expect(item("docs").querySelector(".metaproject-meta")).toBeNull();
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
  // Up on the first row stays there.
  await key(first, "ArrowUp");
  expect(focused()).toBe("docs");
  await key(first, "ArrowDown");
  expect(focused()).toBe("src");
  await key(document.activeElement!, "ArrowUp");
  expect(focused()).toBe("docs");
  await key(document.activeElement!, "ArrowDown");
  expect(focused()).toBe("src");
  await key(document.activeElement!, "ArrowRight");
  expect(item("src").getAttribute("aria-expanded")).toBe("true");
  expect(focused()).toBe("src");
  await key(document.activeElement!, "ArrowRight");
  expect(focused()).toBe("client.ts");
  await key(document.activeElement!, "ArrowDown");
  expect(focused()).toBe("server.ts");
  await key(document.activeElement!, "ArrowUp");
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
    // The data did arrive, and focus stayed where it was.
    expect(item("client.ts")).not.toBeNull();
    expect(items().some(row => row.textContent === "Loading…")).toBe(false);
    expect(document.activeElement === outside).toBe(true);
  } finally { outside.remove(); }
});

test("a graph that is not built shows an empty-state line", async () => {
  const tree = reader({ "|": { entries: [], partial: true } });
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  expect(host.querySelector('[role="tree"]')).toBeNull();
  expect(host.textContent).toContain("The graph is not built yet.");
});

test("a built graph without files and a wiki without pages show their own empty-state lines", async () => {
  const graph = reader({ "|": { entries: [], partial: false } });
  await act(async () => { root.render(createElement(Harness, { request: graph.request })); });
  expect(host.querySelector('[role="tree"]')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("No indexed files.");
  await act(async () => { root.render(null); });
  const wiki = reader({ "|": { entries: [], partial: false } }, "wiki");
  await act(async () => { root.render(createElement(Harness, { request: wiki.request, scope: "wiki" })); });
  expect(host.querySelector('[role="tree"]')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("No Wiki pages.");
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

test("Home on the first row and End on the last leave nothing that a later render could act on", async () => {
  const tree = reader({ "|": ROOT_PAGE, "src|": SRC_PAGE });
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    await act(async () => { item("docs").focus(); });
    await key(item("docs"), "Home");
    expect(focused()).toBe("docs");
    await act(async () => { outside.focus(); });
    // A selection made elsewhere re-renders the tree with no keyboard input.
    await act(async () => { root.render(createElement(Harness, { request: tree.request, selection: client.id, selected: client })); });
    expect(item("client.ts").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement === outside).toBe(true);
    await act(async () => { item("README.md").focus(); });
    await key(item("README.md"), "End");
    expect(focused()).toBe("README.md");
    await act(async () => { outside.focus(); });
    await act(async () => { root.render(createElement(Harness, { request: tree.request, selection: server.id, selected: server })); });
    expect(item("server.ts").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement === outside).toBe(true);
  } finally { outside.remove(); }
});

test("a keyboard Retry keeps focus on the folder's status row, then on the first row read", async () => {
  const tree = reader({ "|": { entries: [folder("src", 2)], partial: false }, "src|": new Error("source-unavailable: graph read failed") });
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  await act(async () => { item("Could not load.").focus(); });
  tree.answers["src|"] = SRC_PAGE;
  tree.hold.add("src|");
  await key(item("Could not load."), "Enter");
  expect(document.activeElement?.getAttribute("role")).toBe("treeitem");
  expect(document.activeElement?.textContent).toBe("Loading…");
  await act(async () => { tree.release("src|"); });
  expect(item("client.ts")).not.toBeNull();
  expect(focused()).toBe("client.ts");
});

test("a keyboard Show more keeps focus in the tree: on the row while it loads, then on the first row appended", async () => {
  const tree = reader({
    "|": { entries: [leaf(readme)], nextCursor: "next", partial: false },
    "|next": { entries: [leaf(client), leaf(server)], partial: false },
  });
  tree.hold.add("|next");
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("Show more").focus(); });
  await key(item("Show more"), "Enter");
  expect(document.activeElement?.getAttribute("role")).toBe("treeitem");
  expect(document.activeElement?.textContent).toBe("Loading…");
  await act(async () => { tree.release("|next"); });
  expect(items().some(row => row.textContent === "Show more")).toBe(false);
  expect(focused()).toBe("client.ts");
});

test("a focused Loading row replaced by children and a Show more row hands focus to the first child", async () => {
  const tree = reader({ "|": { entries: [folder("src", 3)], partial: false }, "src|": { entries: [leaf(client)], nextCursor: "next", partial: false } });
  tree.hold.add("src|");
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  await act(async () => { item("Loading…").focus(); });
  await act(async () => { tree.release("src|"); });
  expect(item("Show more")).not.toBeNull();
  expect(focused()).toBe("client.ts");
});

test("two folders answering in one commit keep focus in the folder whose Loading row had it", async () => {
  const guides = ["one", "two", "three"].map(name => leaf(node(name, `docs/${name}.md`)));
  const tree = reader({ "|": ROOT_PAGE, "docs|": { entries: guides, partial: false }, "src|": SRC_PAGE });
  tree.hold.add("docs|");
  tree.hold.add("src|");
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("docs").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  const loading = items().filter(row => row.textContent === "Loading…");
  expect(loading).toHaveLength(2);
  await act(async () => { loading[1]!.focus(); }); // [1] is src's: the second of the two Loading rows checked above.
  await act(async () => { tree.release("docs|"); tree.release("src|"); });
  expect(item("three.md")).not.toBeNull();
  expect(focused()).toBe("client.ts");
});

test("a focused Show more whose page lands with the children of the folder above it hands focus to the first row appended", async () => {
  // Before the page: src, src's Loading row, Show more. src's children and the root's next page land in one commit.
  const tree = reader({
    "|": { entries: [folder("src", 2)], nextCursor: "next", partial: false },
    "src|": SRC_PAGE,
    "|next": { entries: [leaf(readme)], partial: false },
  });
  tree.hold.add("src|");
  tree.hold.add("|next");
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  await act(async () => { item("Show more").focus(); });
  await key(item("Show more"), "Enter");
  expect(items().map(row => row.textContent)).toEqual(["src2", "Loading…", "Loading…"]);
  await act(async () => { tree.release("src|"); tree.release("|next"); });
  expect(items().map(row => row.querySelector(".metaproject-tree-name")?.textContent)).toEqual(["src", "client.ts", "server.ts", "README.md"]);
  expect(focused()).toBe("README.md");
});

test("a focused Show more whose page appends nothing hands focus back to its parent's last entry, not to a row of another folder", async () => {
  // Before the page: src (expanded), its two files, the root's Show more. The page adds no root entry.
  const tree = reader({
    "|": { entries: [folder("src", 2)], nextCursor: "next", partial: false },
    "src|": SRC_PAGE,
    "|next": { entries: [], partial: false },
  });
  tree.hold.add("|next");
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  await act(async () => { item("Show more").focus(); });
  await key(item("Show more"), "Enter");
  expect(document.activeElement?.textContent).toBe("Loading…");
  await act(async () => { tree.release("|next"); });
  expect(items().map(row => row.querySelector(".metaproject-tree-name")?.textContent)).toEqual(["src", "client.ts", "server.ts"]);
  expect(focused()).toBe("src");
});

test("a focused row that leaves with the row before it hands focus to the row now at its old index", async () => {
  // Before: docs, src (expanded), client.ts, server.ts, README.md, zeta.md. Focus is on server.ts (index 3),
  // whose hand-off anchor is client.ts. Collapsing src removes both in one commit, so the anchor is not shown.
  const zeta = node("zeta", "zeta.md");
  const tree = reader({ "|": { entries: [folder("docs", 1), folder("src", 2), leaf(readme), leaf(zeta)], partial: false }, "src|": SRC_PAGE });
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  await act(async () => { item("server.ts").focus(); });
  // A click does not focus in this DOM, so the collapse leaves focus on the removed row.
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  expect(items().map(row => row.querySelector(".metaproject-tree-name")?.textContent)).toEqual(["docs", "src", "README.md", "zeta.md"]);
  expect(focused()).toBe("zeta.md");
});

test("focus that left the tree stays outside when the focused Show more row's page arrives", async () => {
  const tree = reader({
    "|": { entries: [leaf(readme)], nextCursor: "next", partial: false },
    "|next": { entries: [leaf(client), leaf(server)], partial: false },
  });
  tree.hold.add("|next");
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    await act(async () => { item("Show more").focus(); });
    await key(item("Show more"), "Enter");
    expect(document.activeElement?.textContent).toBe("Loading…");
    await act(async () => { outside.focus(); });
    await act(async () => { tree.release("|next"); });
    expect(item("server.ts")).not.toBeNull();
    expect(items().some(row => row.textContent === "Show more")).toBe(false);
    expect(document.activeElement === outside).toBe(true);
  } finally { outside.remove(); }
});

test("focus that left the tree stays outside when the focused Loading row is replaced by children", async () => {
  const tree = reader({ "|": ROOT_PAGE, "src|": SRC_PAGE });
  tree.hold.add("src|");
  await act(async () => { root.render(createElement(Harness, { request: tree.request })); });
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    await act(async () => { item("src").focus(); });
    await key(item("src"), "ArrowRight");
    await key(item("src"), "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Loading…");
    await act(async () => { outside.focus(); });
    await act(async () => { tree.release("src|"); });
    expect(item("client.ts")).not.toBeNull();
    expect(document.activeElement === outside).toBe(true);
  } finally { outside.remove(); }
});

test("a next page refused as stale-snapshot tells the explorer and leaves no dead Retry row", async () => {
  const { MetaprojectRequestError } = await import("../../../../src/integrations/metaproject-explorer-contract");
  const tree = reader({
    "|": { entries: [leaf(readme)], nextCursor: "next", partial: false },
    "|next": new MetaprojectRequestError("stale-snapshot", "Project knowledge changed while loading."),
  });
  let stale = 0;
  await act(async () => { root.render(createElement(Harness, { request: tree.request, onStale: () => { stale++; } })); });
  await act(async () => { item("Show more").click(); });
  expect(stale).toBe(1);
  expect(items().some(row => row.textContent?.startsWith("Could not load."))).toBe(false);
  expect(item("README.md")).not.toBeNull();
});

/** A reader that refuses `src`'s first `refusals` reads with `failure`, then answers. */
function refusing(refusals: number, failure = PERMIT_REFUSAL) {
  const calls: MetaprojectTreeRequest[] = [];
  const request = (_cwd: string, input: MetaprojectTreeRequest): Promise<MetaprojectTreeV2> => {
    calls.push(input);
    if (input.parent === "src" && calls.filter(call => call.parent === "src").length <= refusals) return Promise.reject(new Error(failure));
    const answer = input.parent === "src" ? SRC_PAGE : ROOT_PAGE;
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ schemaVersion: 2, snapshotId: input.expectedSnapshotId ?? SNAPSHOT, scope: "graph", parent: input.parent ?? null, ...answer });
  };
  return { request, calls };
}

test("a read refused for want of a read permit is retried after a short wait", async () => {
  const tree = refusing(2);
  const waits: number[] = [];
  const wait = (ms: number) => { waits.push(ms); return Promise.resolve(); };
  await act(async () => { root.render(createElement(Harness, { request: tree.request, wait })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  expect(item("client.ts")).not.toBeNull();
  expect(tree.calls.filter(call => call.parent === "src")).toHaveLength(3);
  expect(waits).toHaveLength(2);
  expect(waits.every(ms => ms > 0)).toBe(true);
});

test("a permit refusal that outlasts the retries, or another unavailable answer, marks the folder failed", async () => {
  const wait = () => Promise.resolve();
  const exhausted = refusing(3);
  await act(async () => { root.render(createElement(Harness, { request: exhausted.request, wait })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  expect(item("Could not load.").textContent).toContain("Too many Metaproject reads");
  expect(exhausted.calls.filter(call => call.parent === "src")).toHaveLength(3);
  await act(async () => { root.render(null); });
  const other = refusing(1, "unavailable: The selected CLI did not complete the Metaproject read.");
  await act(async () => { root.render(createElement(Harness, { request: other.request, wait })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  expect(item("Could not load.").textContent).toContain("did not complete");
  expect(other.calls.filter(call => call.parent === "src")).toHaveLength(1);
});

test("a read refused a permit is not sent again under a snapshot retired during its wait", async () => {
  const tree = refusing(1);
  let resume: () => void = () => {};
  const wait = () => new Promise<void>(resolve => { resume = resolve; });
  await act(async () => { root.render(createElement(Harness, { request: tree.request, wait })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  const next = "b".repeat(64);
  await act(async () => { root.render(createElement(Harness, { request: tree.request, wait, snapshot: next })); });
  await act(async () => { resume(); });
  expect(tree.calls.filter(call => call.parent === "src" && call.expectedSnapshotId === SNAPSHOT)).toHaveLength(1);
  expect(tree.calls.filter(call => call.parent === "src" && call.expectedSnapshotId === next)).toHaveLength(1);
  expect(item("client.ts")).not.toBeNull();
});

test("a permit refusal that arrives after its snapshot was retired is not waited on or retried", async () => {
  const tree = refusing(0);
  let refuse: () => void = () => {};
  const request = (cwd: string, input: MetaprojectTreeRequest) => input.parent === "src" && input.expectedSnapshotId === SNAPSHOT
    ? new Promise<MetaprojectTreeV2>((_resolve, reject) => { tree.calls.push(input); refuse = () => reject(new Error(PERMIT_REFUSAL)); })
    : tree.request(cwd, input);
  let waits = 0;
  const wait = () => { waits++; return Promise.resolve(); };
  await act(async () => { root.render(createElement(Harness, { request, wait })); });
  await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
  const next = "b".repeat(64);
  await act(async () => { root.render(createElement(Harness, { request, wait, snapshot: next })); });
  await act(async () => { refuse(); });
  expect(waits).toBe(0);
  expect(tree.calls.filter(call => call.parent === "src" && call.expectedSnapshotId === SNAPSHOT)).toHaveLength(1);
  expect(item("client.ts")).not.toBeNull();
});

test("an unexpected throw while handling a read's failure is reported, not dropped", async () => {
  const { MetaprojectRequestError } = await import("../../../../src/integrations/metaproject-explorer-contract");
  const tree = reader({ "|": ROOT_PAGE, "src|": new MetaprojectRequestError("stale-snapshot", "Project knowledge changed while loading.") });
  const reported: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { reported.push(args); };
  try {
    const onStale = () => { throw new Error("banner failed"); };
    await act(async () => { root.render(createElement(Harness, { request: tree.request, onStale })); });
    await act(async () => { item("src").querySelector<HTMLElement>(".metaproject-tree-chevron")?.click(); });
    await act(async () => {});
  } finally { console.error = original; }
  expect(reported.some(args => args.some(arg => arg instanceof Error && arg.message === "banner failed"))).toBe(true);
});

test("tree reads run at most three at a time, and queued reads of a retired snapshot never start", async () => {
  const names = ["a", "b", "c", "d", "e", "f"];
  const answers: Record<string, Answer> = {
    "|": { entries: names.map(name => folder(name, 1)), partial: false },
    ...Object.fromEntries(names.map(name => [name, { entries: [leaf(node(`${name}-file`, `${name}/${name}.ts`))], partial: false }])),
  };
  const calls: MetaprojectTreeRequest[] = [];
  const waiting: (() => void)[] = [];
  let holdAll = false;
  let inFlight = 0;
  let peak = 0;
  const request = (_cwd: string, input: MetaprojectTreeRequest): Promise<MetaprojectTreeV2> => {
    calls.push(input);
    peak = Math.max(peak, ++inFlight);
    const settle = (): MetaprojectTreeV2 => {
      inFlight--;
      const answer = answers[input.parent ?? "|"];
      if (!answer || answer instanceof Error) throw new Error(`No answer for ${input.parent}`);
      return { schemaVersion: 2, snapshotId: input.expectedSnapshotId ?? SNAPSHOT, scope: "graph", parent: input.parent ?? null, ...answer };
    };
    if (!holdAll) return Promise.resolve().then(settle);
    return new Promise(resolve => { waiting.push(() => resolve(settle())); });
  };
  const releaseAll = async () => {
    while (waiting.length) await act(async () => { for (const release of waiting.splice(0)) release(); });
  };
  await act(async () => { root.render(createElement(Harness, { request })); });
  for (const name of names) await act(async () => { item(name).click(); });
  expect(names.every(name => item(name).getAttribute("aria-expanded") === "true")).toBe(true);
  peak = 0;
  holdAll = true;
  const second = "b".repeat(64);
  await act(async () => { root.render(createElement(Harness, { request, snapshot: second })); });
  await act(async () => { waiting.shift()?.(); });
  expect(peak <= MAX_TREE_READS).toBe(true);
  expect(calls.filter(call => call.expectedSnapshotId === second && call.parent)).toHaveLength(3);
  // The snapshot changes again before those reads answer: the three still queued never start.
  const third = "c".repeat(64);
  await act(async () => { root.render(createElement(Harness, { request, snapshot: third })); });
  await releaseAll();
  expect(peak <= MAX_TREE_READS).toBe(true);
  expect(calls.filter(call => call.expectedSnapshotId === second && call.parent)).toHaveLength(3);
  expect(calls.filter(call => call.expectedSnapshotId === third && call.parent).map(call => call.parent).sort()).toEqual(names);
  for (const name of names) expect(item(`${name}.ts`)).not.toBeNull();
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
