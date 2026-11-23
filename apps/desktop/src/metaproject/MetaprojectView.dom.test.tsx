import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { MetaprojectCatalog, MetaprojectEdge, MetaprojectRequest, MetaprojectResponse } from "../../../../src/integrations/metaproject-explorer-contract";
import { registerDom, unregisterDom } from "../test/dom";

let createElement: typeof import("react").createElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let View: typeof import("./MetaprojectView").MetaprojectView;
type ViewProps = import("react").ComponentProps<typeof View>;
let overlayOpen: typeof import("../components/ui").overlayOpen;
let root: Root;
let host: HTMLElement;
const page = { id: "page", kind: "wiki" as const, title: "Guide", path: "wiki/guide.md" };
const file = { id: "file", kind: "file" as const, title: "Client", path: "src/client.ts" };
const snapshot = { schemaVersion: 1 as const, snapshotId: "one" };
const catalog: MetaprojectCatalog = { ...snapshot, nodes: [page, file], edges: [], truncated: false, graph: "missing", hasWikiLayer: true, hasSymbolLayer: false, counts: { files: 1, wiki: 1, modules: 0 } };

beforeAll(async () => {
  registerDom();
  const react = await import("react"); createElement = react.createElement; act = react.act as typeof act;
  View = (await import("./MetaprojectView")).MetaprojectView;
  overlayOpen = (await import("../components/ui")).overlayOpen;
  host = document.createElement("div"); document.body.append(host); root = (await import("react-dom/client")).createRoot(host);
});
beforeEach(async () => { await act(() => root.render(null)); });
afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });

function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function listRow(title: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>(".metaproject-list button")].find(item => item.querySelector("strong")?.textContent === title);
  if (!found) throw new Error(`Missing list row ${title}`);
  return found;
}
async function openPanelTab(tab: "relationships" | "wiki" | "openspec") {
  const found = host.querySelector<HTMLButtonElement>(`[aria-label="Graph node details"] [role="tab"][data-tab="${tab}"]`);
  if (!found) throw new Error(`Missing panel tab ${tab}`);
  await act(async () => { found.click(); });
}
/** happy-dom has no 2D canvas: the explorer's graph gets a headless cytoscape through its test seam. */
async function headlessCytoscape() {
  const cytoscape = (await import("cytoscape")).default;
  return (options: import("cytoscape").CytoscapeOptions) => {
    const { container: _container, ...rest } = options;
    return cytoscape({ ...rest, headless: true });
  };
}
function request(_cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> {
  if (input.action === "catalog") return Promise.resolve(catalog);
  if (input.action === "detail") return Promise.resolve({ ...snapshot, node: input.id === page.id ? page : file, markdown: input.id === page.id ? "# Readable guide" : undefined });
  if (input.action === "search") return Promise.resolve({ ...snapshot, hits: [] });
  return Promise.resolve({ ...snapshot, root: input.id, nodes: [page, file], edges: [], truncated: false });
}

test("wiki stays readable without a graph and rebuild is explicit", async () => {
  let rebuilds = 0;
  await act(async () => { root.render(createElement(View, { cwd: "/project", request, onRebuild: async () => { rebuilds++; return false; } })); });
  expect(host.textContent).toContain("Graph is missing");
  await act(async () => { button("Wiki").click(); });
  expect(host.textContent).toContain("Readable guide");
  expect(rebuilds).toBe(0);
  await act(async () => { button("Rebuild graph").click(); });
  expect(rebuilds).toBe(1);
});

test("manual Wiki switching uses its own selection and Back restores the graph query", async () => {
  await act(async () => { root.render(createElement(View, { cwd: "/project", request, onRebuild: async () => false })); });
  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search project knowledge"]');
  if (!search) throw new Error("Missing search");
  await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; setter?.call(search, "client"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  const client = [...host.querySelectorAll("button")].find(item => item.textContent?.includes("Client"));
  if (!client) throw new Error("Missing client result");
  await act(async () => { client.click(); });
  await act(async () => { button("Wiki").click(); });
  expect(host.querySelector('[aria-label="Wiki article"]')?.textContent).toContain("Readable guide");
  expect(search.value).toBe("");
  await act(async () => { button("Back").click(); });
  expect(host.querySelector('[aria-label="Graph node details"]')?.textContent).toContain("src/client.ts");
  expect(search.value).toBe("client");
});

test("a previous project's late catalog is discarded", async () => {
  let release: (value: MetaprojectResponse) => void = () => {};
  const read = (cwd: string, input: MetaprojectRequest) => cwd === "/old" && input.action === "catalog" ? new Promise<MetaprojectResponse>(resolve => { release = resolve; }) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/old", request: read, onRebuild: async () => false })); });
  await act(async () => { root.render(createElement(View, { cwd: "/new", request: read, onRebuild: async () => false })); });
  await act(async () => { release({ ...catalog, nodes: [{ ...page, title: "Old private page" }] }); });
  expect(host.textContent).not.toContain("Old private page");
  expect(host.textContent).toContain("Guide");
});


test("direction, depth and type controls filter the accessible relationship list", async () => {
  const third = { id: "third", kind: "file" as const, title: "Server", path: "src/server.ts" };
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog" ? Promise.resolve({ ...catalog, nodes: [page, file, third], edges: [{ from: "page", to: "file", kind: "describes", evidence: ["guide:3"] }, { from: "file", to: "third", kind: "imports" }] }) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  // Re-selecting the shown node opens its panel, whose Relationships tab holds the list.
  await act(async () => { listRow("Guide").click(); });
  const relations = () => host.querySelector('[aria-label="Graph node details"] .metaproject-rel')?.textContent ?? "";
  expect(host.querySelector('[aria-label="Graph node details"] [data-direction="outgoing"]')?.textContent).toContain("Client");
  await openFilters();
  const direction = host.querySelector<HTMLSelectElement>('select[aria-label="Direction"]')!;
  const depth = host.querySelector<HTMLSelectElement>('select[aria-label="Depth"]')!;
  await act(async () => { depth.value = "2"; depth.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector('[aria-label="Graph node details"] [data-direction="second-step"]')?.textContent).toContain("Server");
  await act(async () => { direction.value = "incoming"; direction.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(relations()).not.toContain("Client");
  await act(async () => { direction.value = "outgoing"; direction.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { button("Open Server").click(); });
  expect(host.querySelector('[aria-label="Graph node details"] h2')?.textContent).toBe("Server");
});

test("full-text hits stay visible when local matches fill the result limit", async () => {
  const originalTimeout = window.setTimeout;
  let runTimer: () => void = () => {};
  window.setTimeout = ((callback: TimerHandler) => { if (typeof callback === "function") runTimer = () => callback(); return 1; }) as typeof window.setTimeout;
  const localMatches = Array.from({ length: 210 }, (_, index) => ({ ...file, id: `local-${index}`, title: "distinct", path: `src/${index}/distinct` }));
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve({ ...catalog, nodes: [page, ...localMatches] });
    if (input.action === "search") return Promise.resolve({ ...snapshot, hits: [{ node: page, section: "Setup", snippet: "distinct phrase" }] });
    return request(cwd, input);
  };
  try {
    await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search project knowledge"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "distinct"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { runTimer(); });
    expect(host.textContent).toContain("Setup: distinct phrase");
    expect(host.textContent).toContain("Guide");
    expect(host.querySelectorAll(".metaproject-list li")).toHaveLength(200);
  } finally { window.setTimeout = originalTimeout; }
});

test("snapshot mismatch offers a refresh and drops a selection absent from the refreshed catalog", async () => {
  let version = 0;
  const read = (_cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve(version === 0 ? catalog : { ...catalog, snapshotId: "two", nodes: [file] });
    if (input.action === "detail") return Promise.resolve({ schemaVersion: 1, snapshotId: "two", node: input.id === "page" ? page : file, markdown: "Fresh detail" });
    return Promise.resolve({ schemaVersion: 1, snapshotId: "two", hits: [] });
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  await act(async () => { button("Wiki").click(); });
  expect(host.textContent).toContain("Project knowledge changed while loading");
  expect(host.textContent).not.toContain("Fresh detail");
  version = 1;
  await act(async () => { button("Refresh catalog").click(); });
  expect(host.textContent).not.toContain("Project knowledge changed while loading");
  await act(async () => { button("Graph").click(); });
  expect(host.textContent).toContain("src/client.ts");
});

test("Wiki shows a pending status while the selected page loads", async () => {
  let resolveDetail: ((result: MetaprojectResponse) => void) | undefined;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "detail"
    ? new Promise(resolve => { resolveDetail = resolve; })
    : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  await act(async () => { button("Wiki").click(); });
  const panel = host.querySelector(".metaproject-content");
  expect(panel?.querySelector('[role="status"]')?.textContent).toBe("Loading item…");
  await act(async () => { resolveDetail?.({ ...snapshot, node: page, markdown: "Loaded article" }); });
  expect(panel?.querySelector('[role="status"]')).toBeNull();
  expect(panel?.textContent).toContain("Loaded article");
});

test("Wiki opens the article before the collapsed relationship list", async () => {
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog"
    ? Promise.resolve({ ...catalog, edges: [{ from: page.id, to: file.id, kind: "describes" }] })
    : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  await act(async () => { button("Wiki").click(); });
  const panel = host.querySelector(".metaproject-content");
  expect(panel?.firstElementChild?.tagName).toBe("ARTICLE");
  expect(panel?.querySelector("details")?.open).toBe(false);
});

test("old remote hits disappear immediately on a new query and mismatched search offers refresh", async () => {
  const originalTimeout = window.setTimeout;
  let runTimer: () => void = () => {};
  window.setTimeout = ((callback: TimerHandler) => { if (typeof callback === "function") runTimer = () => callback(); return 1; }) as typeof window.setTimeout;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "search"
    ? Promise.resolve(input.query === "first" ? { ...snapshot, hits: [{ node: page, snippet: "first remote match" }] } : { ...snapshot, snapshotId: "two", hits: [{ node: file, snippet: "wrong snapshot" }] })
    : request(cwd, input);
  try {
    await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search project knowledge"]')!;
    const type = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, value); search.dispatchEvent(new Event("input", { bubbles: true })); });
    await type("first");
    expect(host.textContent).toContain("Searching project knowledge");
    expect(host.textContent).not.toContain("No results.");
    await act(async () => { runTimer(); });
    expect(host.textContent).toContain("first remote match");
    await type("second");
    expect(host.textContent).not.toContain("first remote match");
    await act(async () => { runTimer(); });
    expect(host.textContent).not.toContain("wrong snapshot");
    expect(host.textContent).toContain("Refresh catalog");
  } finally { window.setTimeout = originalTimeout; }
});

test("mismatched neighbor snapshot offers refresh and default filters omit symbol layers", async () => {
  let requestedKinds: string[] = [];
  const read = (_cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve({ ...catalog, graph: "ready", truncated: true, hasSymbolLayer: true });
    if (input.action === "detail") return Promise.resolve({ ...snapshot, node: page });
    if (input.action === "neighbors") { requestedKinds = input.kinds; return Promise.resolve({ ...snapshot, snapshotId: "two", root: input.id, nodes: [page], edges: [], truncated: false }); }
    return Promise.resolve({ ...snapshot, hits: [] });
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  expect(requestedKinds).not.toContain("calls");
  expect(requestedKinds).not.toContain("defines");
  expect(host.textContent).toContain("Refresh catalog");
});

test("a wiki fragment scrolls only to a heading inside the current article", async () => {
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "detail"
    ? Promise.resolve({ ...snapshot, node: page, markdown: "[Jump](#installation)\n\n## Installation" }) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  await act(async () => { button("Wiki").click(); });
  const heading = host.querySelector<HTMLElement>("article .md h2");
  if (!heading) throw new Error("Missing heading");
  let scrolled = false;
  heading.scrollIntoView = () => { scrolled = true; };
  const link = host.querySelector<HTMLAnchorElement>('article a[href="#installation"]');
  if (!link) throw new Error("Missing fragment link");
  await act(async () => { link.click(); });
  expect(scrolled).toBe(true);
});

test("OpenSpec collection opens source and keeps repository Markdown inert", async () => {
  const { OpenSpecView } = await import("./OpenSpecView");
  const entry = { id: "spec-one", kind: "spec" as const, title: "Review", path: "openspec/specs/review/spec.md" };
  const source = { path: entry.path, digest: "abc", startLine: 3, endLine: 5 };
  const read = async (_cwd: string, input: { version: 2; action: string; [key: string]: unknown }): Promise<unknown> => {
    if (input.action === "openspec-list") return { schemaVersion: 2, snapshotId: "s", entries: [entry], openSpec: { availability: "ready", diagnostics: [], truncated: false } };
    if (input.action === "openspec-history") return { schemaVersion: 2, snapshotId: "s", entries: [] };
    return { schemaVersion: 2, snapshotId: "s", openSpec: { entry, artifacts: [source], artifact: { source, markdown: "### Requirement: Safe\n<script>danger()</script>\n![remote](https://example.invalid/image.png)", requirements: [{ title: "Safe", section: "section-safe", source, scenarios: [] }] }, diagnostics: [], partial: false, deltas: [{ specPath: entry.path, source, requirements: [{ title: "Updated", section: "delta", source, operation: "modified", scenarios: [] }] }] } };
  };
  await act(async () => { root.render(createElement(OpenSpecView, { cwd: "/project", query: "", request: read as unknown as NonNullable<import("react").ComponentProps<typeof OpenSpecView>["request"]>, onGraph: () => {} })); });
  const review = [...host.querySelectorAll("button")].find(item => item.textContent?.includes("Review") && item.textContent?.includes("openspec/specs"));
  if (!review) throw new Error("Missing OpenSpec entry");
  await act(async () => { review.click(); });
  expect(host.textContent).toContain("Requirement: Safe");
  expect(host.textContent).toContain("modified: Updated");
  expect(host.querySelector("img, script")).toBeNull();
  expect(host.textContent).toContain("openspec/specs/review/spec.md:3–5");
});

test("OpenSpec distinguishes missing source and discards a prior checkout response", async () => {
  const { OpenSpecView } = await import("./OpenSpecView");
  let release: (value: unknown) => void = () => {};
  const read = (cwd: string): Promise<unknown> => cwd === "/old" ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ schemaVersion: 2, snapshotId: "new", entries: [], openSpec: { availability: "missing", diagnostics: [], truncated: false } });
  await act(async () => { root.render(createElement(OpenSpecView, { cwd: "/old", query: "", request: read as unknown as NonNullable<import("react").ComponentProps<typeof OpenSpecView>["request"]>, onGraph: () => {} })); });
  await act(async () => { root.render(createElement(OpenSpecView, { cwd: "/new", query: "", request: read as unknown as NonNullable<import("react").ComponentProps<typeof OpenSpecView>["request"]>, onGraph: () => {} })); });
  await act(async () => { release({ schemaVersion: 2, snapshotId: "old", entries: [{ id: "old", title: "Old private entry", path: "old", kind: "spec" }], openSpec: { availability: "ready", diagnostics: [], truncated: false } }); });
  expect(host.textContent).toContain("OpenSpec missing");
  expect(host.textContent).not.toContain("Old private entry");
});

test("opening an OpenSpec search location requests and focuses the exact scenario", async () => {
  const { OpenSpecView } = await import("./OpenSpecView");
  const entry = { id: "spec-one", kind: "spec" as const, title: "Review", path: "openspec/specs/review/spec.md" };
  const source = { path: entry.path, digest: "d".repeat(64), startLine: 6, endLine: 8 };
  const seen: Record<string, unknown>[] = [];
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    seen.push(input);
    if (input.action === "openspec-list") return { schemaVersion: 2, snapshotId: "s", entries: [entry], openSpec: { availability: "ready", diagnostics: [], truncated: false } };
    if (input.action === "openspec-history") return { schemaVersion: 2, snapshotId: "s", entries: [] };
    if (input.action === "search") return { schemaVersion: 2, snapshotId: "s", hits: [], partial: false };
    return { schemaVersion: 2, snapshotId: "s", node: entry, openSpec: { entry, artifacts: [source], artifact: { source, markdown: "### Requirement: Review\n#### Scenario: Accepted", requirements: [{ title: "Review", section: "req", source, scenarios: [{ title: "Accepted", section: "scenario", source }] }] }, diagnostics: [], partial: false } };
  };
  await act(async () => { root.render(createElement(OpenSpecView, { cwd: "/project", query: "Accepted", location: { id: entry.id, collection: "spec", artifact: source.path, digest: source.digest, section: "scenario" }, request: read as unknown as NonNullable<import("react").ComponentProps<typeof OpenSpecView>["request"]>, onGraph: () => {} })); });
  expect(seen.some(input => input.action === "detail" && input.artifact === source.path && input.digest === source.digest && input.section === "scenario")).toBe(true);
  expect(document.activeElement?.textContent).toContain("Accepted");
  expect(host.textContent).toContain("openspec/specs/review/spec.md:6–8");
});

test("relationship list names an OpenSpec edge by its label and keeps its digest out of the row", async () => {
  const { RelationshipList } = await import("./RelationshipList");
  const digest = "a".repeat(64);
  const projection = {
    ...snapshot,
    root: page.id,
    nodes: [page, file],
    edges: [{ from: page.id, to: file.id, kind: "spec-context" as const, provenance: [{ path: ".metaproject/openspec/links.json", index: 2, digest }] }],
    truncated: false,
  };
  await act(async () => { root.render(createElement(RelationshipList, { projection, select: () => {} })); });
  expect(host.querySelector(".metaproject-rel-kind")?.textContent).toContain("Spec context");
  expect(host.textContent).toContain("Client");
  expect(host.textContent).not.toContain(digest);
});

test("OpenSpec Markdown follows fragments and only known project links", async () => {
  const { OpenSpecView } = await import("./OpenSpecView");
  const entry = { id: "spec", kind: "spec" as const, title: "Review", path: "openspec/specs/review/spec.md" };
  const source = { path: entry.path, digest: "a".repeat(64) };
  const linked = { id: "guide", kind: "wiki" as const, title: "Guide", path: "openspec/specs/guide.md" };
  const visited: string[] = [];
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    if (input.action === "openspec-list") return { schemaVersion: 2, snapshotId: "s", entries: [entry], openSpec: { availability: "ready", diagnostics: [], truncated: false } };
    if (input.action === "openspec-history") return { schemaVersion: 2, snapshotId: "s", entries: [] };
    // Happy DOM with DOMPurify strips the first element wrapper. The heading comes after the introduction.
    return { schemaVersion: 2, snapshotId: "s", node: entry, openSpec: { entry, artifacts: [source], artifact: { source, markdown: "Review guide.\n\n## Target\n[Jump](#target) [Guide](../guide.md#intro) [Unknown](../private.md)", requirements: [] }, diagnostics: [], partial: false } };
  };
  await act(async () => { root.render(createElement(OpenSpecView, { cwd: "/project", query: "", location: { id: entry.id, collection: "spec" }, nodes: [linked], onNavigate: (node: { id: string }, fragment?: string) => visited.push(`${node.id}#${fragment}`), request: read as unknown as NonNullable<import("react").ComponentProps<typeof OpenSpecView>["request"]>, onGraph: () => {} })); });
  const links = [...host.querySelectorAll(".md a")];
  await act(async () => { (links.find(link => link.textContent === "Jump") as HTMLElement).click(); });
  expect(document.activeElement?.textContent).toBe("Target");
  await act(async () => { (links.find(link => link.textContent === "Guide") as HTMLElement).click(); });
  await act(async () => { (links.find(link => link.textContent === "Unknown") as HTMLElement).click(); });
  expect(visited).toEqual(["guide#intro"]);
});

test("shared search loads the next page pinned to its snapshot", async () => {
  const originalTimeout = window.setTimeout;
  let runTimer: () => void = () => {};
  window.setTimeout = ((callback: TimerHandler) => { if (typeof callback === "function") runTimer = () => callback(); return 1; }) as typeof window.setTimeout;
  const wikiCatalog = { ...catalog, schemaVersion: 2 };
  let resolveCatalog: (value: typeof wikiCatalog) => void = () => {};
  const catalogRequest = new Promise<typeof wikiCatalog>(resolve => { resolveCatalog = resolve; });
  const seen: Record<string, unknown>[] = [];
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    seen.push(input);
    if (input.action === "catalog") return catalogRequest;
    if (input.action === "search") return { schemaVersion: 2, snapshotId: "one", hits: [{ node: input.cursor ? { ...page, id: "second-page", title: "Second Wiki page" } : page, scope: "wiki" }], ...(input.cursor ? {} : { nextCursor: "next" }), partial: false };
    if (input.action === "detail") return { ...snapshot, schemaVersion: 2, node: page };
    return { ...snapshot, schemaVersion: 2, root: page.id, nodes: [page], edges: [], truncated: false };
  };
  try {
    await act(async () => { root.render(createElement(View, { cwd: "/project", requestV2: read as unknown as NonNullable<import("react").ComponentProps<typeof View>["requestV2"]>, onRebuild: async () => false })); });
    // A Wiki search must preserve its scope when following the cursor.
    await act(async () => { button("Wiki").click(); resolveCatalog(wikiCatalog); });
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search project knowledge"]');
    if (!search) throw new Error("Missing search");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "query"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { runTimer(); });
    await act(async () => { button("Load more results").click(); });
    expect(seen.some(input => input.action === "search" && input.cursor === "next" && input.query === "query" && input.expectedSnapshotId === "one" && JSON.stringify(input.scopes) === '["wiki"]')).toBe(true);
    expect(host.textContent).toContain("Second Wiki page");
  } finally { window.setTimeout = originalTimeout; }
});

test("a cross-change artifact link resolves its indexed owner and fragment", async () => {
  const { OpenSpecView } = await import("./OpenSpecView");
  const current = { id: "first", kind: "change" as const, title: "First", path: "openspec/changes/first" };
  const other = { id: "other", kind: "change" as const, title: "Other", path: "openspec/changes/other" };
  const source = { path: `${current.path}/proposal.md`, digest: "a".repeat(64) };
  const target = { path: `${other.path}/proposal.md`, digest: "b".repeat(64) };
  const seen: Record<string, unknown>[] = [];
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    seen.push(input);
    if (input.action === "openspec-list") return { schemaVersion: 2, snapshotId: "s", entries: [current], openSpec: { availability: "ready", diagnostics: [], truncated: false } };
    if (input.action === "search") return { schemaVersion: 2, snapshotId: "s", hits: [{ node: other, scope: "change" }], partial: false };
    const entry = input.id === other.id ? other : current;
    return { schemaVersion: 2, snapshotId: "s", node: entry, openSpec: { entry, artifacts: [input.id === other.id ? target : source], artifact: { source: input.id === other.id ? target : source, markdown: input.id === other.id ? "Change proposal.\n\n## Details" : "[Other](../other/proposal.md#details)", requirements: [] }, diagnostics: [], partial: false } };
  };
  await act(async () => { root.render(createElement(OpenSpecView, { cwd: "/project", query: "", location: { id: current.id, collection: "change" }, request: read as unknown as NonNullable<import("react").ComponentProps<typeof OpenSpecView>["request"]>, onGraph: () => {} })); });
  const link = [...host.querySelectorAll<HTMLElement>(".md a")].find(item => item.textContent === "Other");
  if (!link) throw new Error("Missing cross-change link");
  await act(async () => { link.click(); });
  expect(seen.some(input => input.action === "search" && input.query === other.path && input.expectedSnapshotId === "s")).toBe(true);
  expect(seen.some(input => input.action === "detail" && input.id === other.id && input.artifact === target.path)).toBe(true);
  expect(document.activeElement?.textContent).toBe("Details");
});

test("a graph node opens its linked Wiki in place and Back restores the graph selection", async () => {
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog"
    ? Promise.resolve({ ...catalog, edges: [{ from: page.id, to: file.id, kind: "describes" }] })
    : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  await act(async () => { listRow("Client").click(); });
  const panel = host.querySelector('aside[aria-label="Graph node details"]');
  expect(panel?.textContent).toContain("Client");
  expect(host.querySelector('.metaproject-content article')).toBeNull();
  await openPanelTab("wiki");
  await act(async () => { button("Open in Wiki").click(); });
  expect(host.querySelector('[aria-label="Wiki article"]')?.textContent).toContain("Readable guide");
  await act(async () => { button("Back").click(); });
  expect(host.querySelector('aside[aria-label="Graph node details"]')?.textContent).toContain("Client");
});

test("an archive result opens its current spec directly and Back restores the archive search", async () => {
  const old = { id: "old", kind: "archive" as const, title: "Archived picker change", path: "openspec/changes/archive/2025-01-01-picker" };
  const current = { id: "current", kind: "spec" as const, title: "Current picker", path: "openspec/specs/picker/spec.md" };
  const openSpec = { availability: "ready", diagnostics: [], truncated: false };
  const seen: Record<string, unknown>[] = [];
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    seen.push(input);
    const base = { schemaVersion: 2, snapshotId: "one" };
    if (input.action === "catalog") return { ...catalog, ...base, nodes: [] };
    if (input.action === "openspec-list") return { ...base, entries: input.collection === "archive" ? [old] : [current], openSpec };
    if (input.action === "openspec-history") return { ...base, entries: [] };
    if (input.action === "search") return { ...base, hits: [{ node: old, scope: "archive" }] };
    const entry = input.id === old.id ? old : current;
    const source = { path: entry.kind === "archive" ? `${entry.path}/proposal.md` : entry.path, digest: "a".repeat(64) };
    return {
      ...base, node: entry,
      openSpec: { entry, artifacts: [source], artifact: { source, markdown: "Reader document", requirements: [] } },
      relationships: entry.id === old.id ? [{ node: current, edge: { kind: "changes-spec" } }] : [],
    };
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", requestV2: read as unknown as NonNullable<import("react").ComponentProps<typeof View>["requestV2"]>, onRebuild: async () => false })); });
  await act(async () => { button("OpenSpec").click(); });
  await act(async () => { button("Archive").click(); });
  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search project knowledge"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "picker change");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const result = host.querySelector<HTMLButtonElement>('[aria-label="OpenSpec results"] li button')!;
  await act(async () => { result.click(); });
  await act(async () => { button("Open current spec: Current picker").click(); });
  expect(button("OpenSpec").getAttribute("aria-pressed")).toBe("true");
  expect(button("Specs").getAttribute("aria-pressed")).toBe("true");
  expect(search.value).toBe("");
  expect(host.querySelector('[aria-label="OpenSpec detail"] h2')?.textContent).toBe(current.title);
  await act(async () => { button("Back").click(); });
  expect(button("Archive").getAttribute("aria-pressed")).toBe("true");
  expect(search.value).toBe("picker change");
  expect(host.querySelector('[aria-label="OpenSpec detail"] h2')?.textContent).toBe(old.title);
  expect(seen.filter(input => input.action === "search").map(input => input.scopes)).toEqual([["archive"]]);
});

function typeQuery(value: string) {
  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search project knowledge"]');
  if (!search) throw new Error("Missing search");
  return act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, value); search.dispatchEvent(new Event("input", { bubbles: true })); });
}
const panelTitle = () => host.querySelector('[aria-label="Graph node details"] h2')?.textContent;

test("Back steps through graph selections and typing in the search field adds no history entry", async () => {
  const [alpha, beta, gamma] = ["Alpha", "Beta", "Gamma"].map(title => ({ id: title.toLowerCase(), kind: "file" as const, title, path: `src/${title.toLowerCase()}.ts` }));
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog"
    ? Promise.resolve({ ...catalog, nodes: [page, alpha!, beta!, gamma!] }) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  const pick = async (title: string) => {
    const row = [...host.querySelectorAll<HTMLButtonElement>(".metaproject-list button")].find(item => item.querySelector("strong")?.textContent === title);
    if (!row) throw new Error(`Missing result ${title}`);
    await act(async () => { row.click(); });
  };
  await pick("Alpha");
  await pick("Beta");
  await pick("Gamma");
  await pick("Gamma");
  expect(panelTitle()).toBe("Gamma");
  await typeQuery("Gam");
  await act(async () => { button("Back").click(); });
  expect(panelTitle()).toBe("Beta");
  await act(async () => { button("Back").click(); });
  expect(panelTitle()).toBe("Alpha");
});

test("Find a Wiki page with no selected page shows an empty state naming the search instead of an article", async () => {
  await act(async () => { root.render(createElement(View, { cwd: "/project", request, onRebuild: async () => false })); });
  const client = [...host.querySelectorAll<HTMLButtonElement>(".metaproject-list button")].find(item => item.textContent?.includes("Client"));
  if (!client) throw new Error("Missing Client result");
  await act(async () => { client.click(); });
  await openPanelTab("wiki");
  await act(async () => { button("Find a Wiki page").click(); });
  const content = host.querySelector('[aria-label="Wiki article"]');
  expect(content?.querySelector("article")).toBeNull();
  expect(content?.querySelector(".empty-state")?.textContent).toContain("src/client.ts");
  expect(content?.textContent).not.toContain("Readable guide");
  // The search is still in flight (its debounce has not run), so the title must not claim "no match".
  expect(content?.querySelector(".empty-state h3")?.textContent).not.toContain("No Wiki page matches");
});

test("the Wiki relationships read uses fixed defaults whatever the Graph filters are", async () => {
  const reads: Extract<MetaprojectRequest, { action: "neighbors" }>[] = [];
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve({ ...catalog, graph: "ready", truncated: true });
    // A root that is never selected keeps the cytoscape canvas, which happy-dom cannot draw, unmounted.
    if (input.action === "neighbors") { reads.push(input); return Promise.resolve({ ...snapshot, root: "unselected", nodes: [], edges: [], truncated: false }); }
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  await openFilters();
  const depth = host.querySelector<HTMLSelectElement>('select[aria-label="Depth"]')!;
  await act(async () => { depth.value = "2"; depth.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { button("Imports").click(); });
  expect(reads.at(-1)).toMatchObject({ depth: 2 });
  await act(async () => { button("Wiki").click(); });
  expect(reads.at(-1)).toEqual({ action: "neighbors", id: page.id, depth: 1, direction: "both", kinds: ["imports", "asset", "describes", "links", "contains"] });
});

test("a rebuild re-enables its control and re-reads the catalog when the catalog reloaded meanwhile", async () => {
  let catalogReads = 0;
  let finish: (value: boolean) => void = () => {};
  const onRebuild = () => new Promise<boolean>(resolve => { finish = resolve; });
  const reader = () => (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") catalogReads++;
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: reader(), onRebuild })); });
  await act(async () => { button("Rebuild graph").click(); });
  expect(button("Rebuilding…").disabled).toBe(true);
  // A new reader identity reloads the catalog while the rebuild is still running.
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: reader(), onRebuild })); });
  const reads = catalogReads;
  await act(async () => { finish(true); });
  expect(button("Rebuild graph").disabled).toBe(false);
  expect(catalogReads).toBe(reads + 1);
});

test("a failed protocol negotiation offers Retry and loads the catalog once it succeeds", async () => {
  let attempts = 0;
  const negotiate = async () => { attempts++; if (attempts === 1) throw new Error("Negotiation refused by the CLI"); return 1 as const; };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request, negotiate, onRebuild: async () => false })); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Negotiation refused by the CLI");
  expect(host.textContent).not.toContain("Loading project knowledge");
  await act(async () => { button("OpenSpec").click(); });
  expect(host.textContent).not.toContain("Checking OpenSpec support");
  await act(async () => { button("Graph").click(); });
  await act(async () => { button("Retry").click(); });
  expect(attempts).toBe(2);
  expect(host.textContent).not.toContain("Negotiation refused by the CLI");
  expect(host.querySelector(".metaproject-list")?.textContent).toContain("Client");
});

test("a wiki link outside the loaded nodes is looked up once and an unknown path is named", async () => {
  const far = { id: "far", kind: "file" as const, title: "Far module", path: "src/far away.ts" };
  const searches: string[] = [];
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "detail" && input.id === page.id) return Promise.resolve({ ...snapshot, node: page, markdown: "Intro.\n\n[Far](../src/far%20away.ts) [Root](/src/client.ts) [Missing](missing%20page.md)" });
    if (input.action === "search") { searches.push(input.query); return Promise.resolve({ ...snapshot, hits: input.query === far.path ? [{ node: far }] : [] }); }
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  await act(async () => { button("Wiki").click(); });
  const link = (text: string) => {
    const found = [...host.querySelectorAll<HTMLElement>("article .md a")].find(item => item.textContent === text);
    if (!found) throw new Error(`Missing link ${text}`);
    return found;
  };
  await act(async () => { link("Missing").click(); });
  expect(searches).toEqual(["wiki/missing page.md"]);
  expect(host.querySelector('[aria-label="Wiki article"] article')?.textContent).toContain("wiki/missing page.md");
  await act(async () => { link("Far").click(); });
  expect(searches).toEqual(["wiki/missing page.md", "src/far away.ts"]);
  expect(panelTitle()).toBe("Far module");
  await act(async () => { button("Back").click(); });
  await act(async () => { link("Root").click(); });
  expect(searches).toHaveLength(2);
  expect(panelTitle()).toBe("Client");
});

test("Back to a node reached through a lookup shows its panel at once", async () => {
  const far = { id: "far", kind: "file" as const, title: "Far module", path: "src/far.ts" };
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "detail" && input.id === page.id) return Promise.resolve({ ...snapshot, node: page, markdown: "Intro.\n\n[Far](../src/far.ts)" });
    if (input.action === "search") return Promise.resolve({ ...snapshot, hits: input.query === far.path ? [{ node: far }] : [] });
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  await act(async () => { button("Wiki").click(); });
  const farLink = [...host.querySelectorAll<HTMLElement>("article .md a")].find(item => item.textContent === "Far");
  await act(async () => { farLink?.click(); });
  expect(panelTitle()).toBe("Far module");
  await act(async () => { listRow("Client").click(); });
  expect(panelTitle()).toBe("Client");
  await act(async () => { button("Back").click(); });
  expect(panelTitle()).toBe("Far module");
});

const third = { id: "third", kind: "file" as const, title: "Server", path: "src/server.ts" };
const linkedCatalog: MetaprojectCatalog = {
  ...catalog, graph: "ready", nodes: [page, file, third],
  edges: [{ from: page.id, to: file.id, kind: "describes" }, { from: file.id, to: third.id, kind: "imports" }],
};

test("Graph mode shows the relationship list in the panel, not under the canvas, with labelled filters", async () => {
  const createCytoscape = await headlessCytoscape();
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog" ? Promise.resolve(linkedCatalog) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, createCytoscape, onRebuild: async () => false })); });
  await act(async () => { listRow("Client").click(); });
  const content = host.querySelector(".metaproject-content");
  expect(content?.querySelector(".metaproject-rgraph")).not.toBeNull();
  expect(content?.querySelector(".metaproject-rel")).toBeNull();
  const panelList = host.querySelector('[aria-label="Graph node details"] .metaproject-rel');
  expect(panelList?.textContent).toContain("Guide");
  expect(panelList?.textContent).toContain("Server");
  await openFilters();
  expect(host.querySelector('select[aria-label="Direction"]')).not.toBeNull();
  expect(host.querySelector('select[aria-label="Depth"]')).not.toBeNull();
  const kinds = host.querySelector('[aria-label="Relationship types"]');
  expect([...kinds?.querySelectorAll("button") ?? []].map(item => item.textContent?.trim())).toContain("Wiki links");
  for (const label of ["Defines", "Calls"]) {
    const chip = button(label);
    expect(chip.disabled).toBe(true);
    const reason = document.getElementById(chip.getAttribute("aria-describedby") ?? "")?.textContent ?? chip.title;
    expect(reason).toContain("symbol layer");
  }
  // A changed filter offers Reset, which brings the defaults back.
  expect([...host.querySelectorAll("button")].some(item => item.textContent?.trim() === "Reset filters")).toBe(false);
  await act(async () => { button("Imports").click(); });
  expect(button("Imports").getAttribute("aria-pressed")).toBe("false");
  await act(async () => { button("Reset filters").click(); });
  expect(button("Imports").getAttribute("aria-pressed")).toBe("true");
});

/** The Filters button: in the graph header, or in a slim row of its own when no graph is drawn. */
function filtersButton() {
  const found = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  if (!found) throw new Error("Missing Filters button");
  return found;
}
const filtersDialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Graph filters"]');
async function openFilters() {
  if (!filtersDialog()) await act(async () => { filtersButton().click(); });
}
const linkedRead = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog" ? Promise.resolve(linkedCatalog) : request(cwd, input);
let linkedCytoscape: Awaited<ReturnType<typeof headlessCytoscape>> | undefined;
const noRebuild = async () => false;
/**
 * Renders the explorer over `linkedCatalog` with a drawn graph. The reader, graph factory and rebuild
 * keep their identity across calls, so calling it again with other `props` (`visible`, …) re-renders
 * the same explorer without reloading its catalog.
 */
async function renderFilters(props: Partial<ViewProps> = {}) {
  linkedCytoscape ??= await headlessCytoscape();
  const createCytoscape = linkedCytoscape;
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: linkedRead, createCytoscape, onRebuild: noRebuild, ...props })); });
}

test("graph filters sit behind a closed Filters button in the graph's header", async () => {
  await renderFilters();
  const toggle = filtersButton();
  expect(toggle.closest(".metaproject-rgraph-header")).not.toBeNull();
  expect(toggle.textContent?.trim()).toBe("Filters");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.title).toBe("Both · 1 step · 5 of 7 types");
  expect(filtersDialog()).toBeNull();
  expect(host.querySelector('select[aria-label="Direction"]')).toBeNull();
});

test("the Filters popover opens with focus inside and closes on the button, Escape and a press outside, focus back on the button", async () => {
  await renderFilters();
  await act(async () => { filtersButton().click(); });
  expect(filtersButton().getAttribute("aria-expanded")).toBe("true");
  expect(filtersDialog()?.contains(document.activeElement)).toBe(true);
  expect(filtersDialog()?.querySelector('select[aria-label="Direction"]')).not.toBeNull();
  expect(filtersDialog()?.querySelector('[aria-label="Relationship types"]')?.textContent).toContain("Wiki links");
  expect(filtersDialog()?.textContent).toContain("symbol layer");
  expect(filtersDialog()?.textContent).not.toContain("Reset filters");
  await act(async () => { filtersButton().click(); });
  expect(filtersDialog()).toBeNull();
  await openFilters();
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(filtersDialog()).toBeNull();
  expect(document.activeElement).toBe(filtersButton());
  await openFilters();
  await act(async () => { host.querySelector(".metaproject-list")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(filtersDialog()).toBeNull();
  expect(document.activeElement).toBe(filtersButton());
});

test("changed filters show their count and the pressed look on the button, and Reset brings the defaults back", async () => {
  await renderFilters();
  expect(filtersButton().dataset.changed).toBeUndefined();
  await openFilters();
  const depth = filtersDialog()!.querySelector<HTMLSelectElement>('select[aria-label="Depth"]')!;
  await act(async () => { depth.value = "2"; depth.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { button("Imports").click(); });
  expect(filtersButton().textContent?.trim()).toBe("Filters · 2");
  expect(filtersButton().dataset.changed).toBe("true");
  expect(filtersButton().title).toBe("Both · 2 steps · 4 of 7 types");
  await act(async () => { button("Reset filters").click(); });
  expect(filtersButton().textContent?.trim()).toBe("Filters");
  expect(filtersButton().dataset.changed).toBeUndefined();
  expect(filtersDialog()?.querySelector<HTMLSelectElement>('select[aria-label="Depth"]')?.value).toBe("1");
  expect(filtersDialog()?.textContent).not.toContain("Reset filters");
});

test("without a drawn graph the Filters button sits in a slim row of its own", async () => {
  await act(async () => { root.render(createElement(View, { cwd: "/project", request, onRebuild: async () => false })); });
  const toggle = filtersButton();
  expect(toggle.closest(".metaproject-filter-strip")).not.toBeNull();
  expect(host.querySelector(".metaproject-rgraph")).toBeNull();
});

test("the list header counts shown of total and the limited-catalog banner is gone", async () => {
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog"
    ? Promise.resolve({ ...catalog, truncated: true, counts: { files: 40, wiki: 9, modules: 3 } }) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => false })); });
  expect(host.querySelector(".metaproject-list h2")?.textContent).toBe("Catalog · 2 of 52");
  expect(host.textContent).not.toContain("Catalog is limited");
  await typeQuery("client");
  expect(host.querySelector(".metaproject-list h2")?.textContent).toBe("Results · 1");
});

test("the selected list row is scrolled into view when the selection changes from the panel", async () => {
  const scrolled: Element[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this); };
  try {
    const createCytoscape = await headlessCytoscape();
    const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog" ? Promise.resolve(linkedCatalog) : request(cwd, input);
    await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, createCytoscape, onRebuild: async () => false })); });
    await act(async () => { listRow("Client").click(); });
    scrolled.length = 0;
    const serverRow = host.querySelector<HTMLButtonElement>('[aria-label="Graph node details"] .metaproject-rel-row[title="src/server.ts"]');
    if (!serverRow) throw new Error("Missing Server relationship row");
    await act(async () => { serverRow.click(); });
    expect(panelTitle()).toBe("Server");
    expect(scrolled).toContain(listRow("Server"));
  } finally { HTMLElement.prototype.scrollIntoView = original; }
});

test("the previous graph stays rendered and busy while the next selection's relationships load", async () => {
  const createCytoscape = await headlessCytoscape();
  // The relationships read and the panel's linked-documents read of the new selection both wait.
  const waiting: (() => void)[] = [];
  const release = () => { for (const resolve of waiting.splice(0)) resolve(); };
  const read = (_cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve({ ...linkedCatalog, truncated: true });
    if (input.action === "neighbors") {
      const projection = { ...snapshot, root: input.id, nodes: [page, file], edges: [{ from: page.id, to: file.id, kind: "describes" as const }], truncated: false };
      return input.id === page.id ? Promise.resolve(projection) : new Promise(resolve => { waiting.push(() => resolve(projection)); });
    }
    return request(_cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, createCytoscape, onRebuild: async () => false })); });
  const graph = () => host.querySelector(".metaproject-content .metaproject-rgraph");
  expect(graph()?.querySelector(".metaproject-rgraph-title")?.textContent).toBe("Guide");
  expect(graph()?.getAttribute("aria-busy")).toBeNull();
  await act(async () => { listRow("Client").click(); });
  expect(graph()?.querySelector(".metaproject-rgraph-title")?.textContent).toBe("Guide");
  expect(graph()?.getAttribute("aria-busy")).toBe("true");
  await act(async () => { release(); });
  expect(graph()?.querySelector(".metaproject-rgraph-title")?.textContent).toBe("Client");
  expect(graph()?.getAttribute("aria-busy")).toBeNull();
});

test("explorer banners sit above the OpenSpec view and the freshness banner reads as one sentence", async () => {
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    if (input.action === "catalog") throw new Error("Catalog read failed");
    if (input.action === "openspec-list") return { schemaVersion: 2, snapshotId: "s", entries: [], openSpec: { availability: "ready", diagnostics: [], truncated: false } };
    return { schemaVersion: 2, snapshotId: "s", hits: [] };
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", requestV2: read as unknown as NonNullable<import("react").ComponentProps<typeof View>["requestV2"]>, onRebuild: async () => false })); });
  await act(async () => { button("OpenSpec").click(); });
  const alert = [...host.querySelectorAll('[role="alert"]')].find(item => item.textContent?.includes("Catalog read failed"));
  const view = host.querySelector(".openspec-view");
  if (!alert || !view) throw new Error("Missing banner or OpenSpec view");
  expect(alert.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  await act(async () => { root.render(null); });
  const createCytoscape = await headlessCytoscape();
  const stale = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog"
    ? Promise.resolve({ ...catalog, graph: "stale", graphReason: "an untracked file changed" }) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: stale, createCytoscape, onRebuild: async () => false })); });
  expect(freshnessBanner()?.textContent).toContain("Graph is stale.");
});

const freshnessBanner = () => [...host.querySelectorAll<HTMLElement>(".inline-banner")].find(item => item.textContent?.includes("Rebuild graph"));
function detailsButton() {
  return [...(freshnessBanner()?.querySelectorAll<HTMLButtonElement>("button[aria-expanded]") ?? [])].find(item => item.textContent?.trim() === "Details");
}
const longReason = "HEAD moved since the graph was built (built at abc, now def); a tracked file was modified since the graph was built: src/a.ts, src/b.ts (+1 more)";
async function renderFreshness(reason: string | undefined, onRebuild: () => Promise<boolean> = async () => false) {
  const createCytoscape = await headlessCytoscape();
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog"
    ? Promise.resolve({ ...catalog, graph: "stale", ...(reason === undefined ? {} : { graphReason: reason }) }) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, createCytoscape, onRebuild })); });
}

test("the freshness banner is one sentence with the reason hidden until Details opens it", async () => {
  await renderFreshness(longReason);
  const banner = freshnessBanner();
  expect(banner?.textContent).toContain("Graph is stale.");
  expect(banner?.textContent).not.toContain("HEAD moved");
  const details = detailsButton();
  if (!details) throw new Error("Missing Details button");
  expect(details.getAttribute("aria-expanded")).toBe("false");
  await act(async () => { details.click(); });
  expect(details.getAttribute("aria-expanded")).toBe("true");
  const reason = document.getElementById(details.getAttribute("aria-controls") ?? "");
  expect(reason?.textContent).toContain("HEAD moved since the graph was built");
  expect(banner?.contains(reason ?? null)).toBe(true);
  await act(async () => { details.click(); });
  expect(details.getAttribute("aria-expanded")).toBe("false");
  expect(freshnessBanner()?.textContent).not.toContain("HEAD moved");
});

test("open freshness details close again when the reason text changes", async () => {
  await renderFreshness(longReason);
  await act(async () => { detailsButton()?.click(); });
  expect(detailsButton()?.getAttribute("aria-expanded")).toBe("true");
  // A new reader identity for the same project reloads the catalog, now with another reason.
  await renderFreshness("an untracked file changed");
  expect(detailsButton()?.getAttribute("aria-expanded")).toBe("false");
  expect(freshnessBanner()?.textContent).not.toContain("an untracked file changed");
});

test("the freshness banner has no Details button without a reason, and Rebuild still runs", async () => {
  let rebuilds = 0;
  await renderFreshness(undefined, async () => { rebuilds++; return false; });
  expect(freshnessBanner()?.textContent).toContain("Graph is stale.");
  expect(detailsButton()).toBeUndefined();
  await act(async () => { button("Rebuild graph").click(); });
  expect(rebuilds).toBe(1);
});

/** happy-dom has no layout: give the window a height and an element a box. Each returns its undo. */
function stubWindowHeight(height: number) {
  const own = Object.getOwnPropertyDescriptor(window, "innerHeight");
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
  return () => { if (own) Object.defineProperty(window, "innerHeight", own); else Reflect.deleteProperty(window, "innerHeight"); };
}
function stubBox(element: HTMLElement, box: { top: number; bottom: number; left: number; right: number }) {
  const rect = { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box };
  element.getBoundingClientRect = () => rect as DOMRect;
}
/** The Filters popover's content height as a browser would measure it (happy-dom reports 0). */
function stubPopoverContentHeight(height: number) {
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const inherited = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("metaproject-filters-pop") ? height : inherited?.get?.call(this) ?? 0; },
  });
  return () => { if (own) Object.defineProperty(HTMLElement.prototype, "scrollHeight", own); else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight"); };
}
const px = (value: string | undefined) => Number.parseFloat(value ?? "");

test("the Filters popover stays 8 px inside a short window, scrolls inside and is placed again on resize", async () => {
  const restoreHeight = stubWindowHeight(480);
  try {
    await renderFilters();
    // The button where the live 720x480 check found it, with the freshness Details open above it.
    stubBox(filtersButton(), { left: 544, top: 277, right: 615, bottom: 301 });
    await openFilters();
    const style = filtersDialog()!.style;
    expect(px(style.top)).toBe(305);
    expect(px(style.left)).toBe(295);
    // The bottom edge is bounded at the window height minus 8 px; the rest scrolls inside (.menu).
    expect(px(style.top) + px(style.maxHeight)).toBe(480 - 8);
    await act(async () => { window.innerHeight = 400; window.dispatchEvent(new Event("resize")); });
    expect(px(filtersDialog()!.style.top)).toBe(305);
    expect(px(filtersDialog()!.style.top) + px(filtersDialog()!.style.maxHeight)).toBe(400 - 8);
  } finally { restoreHeight(); }
});

test("the Filters popover opens above a button low in the window when its content does not fit below", async () => {
  const restoreHeight = stubWindowHeight(480);
  const restoreContent = stubPopoverContentHeight(229);
  try {
    await renderFilters();
    stubBox(filtersButton(), { left: 544, top: 430, right: 615, bottom: 454 });
    await openFilters();
    const style = filtersDialog()!.style;
    expect(style.top).toBe("");
    // Its bottom edge sits 4 px above the button, and its height is bounded by the room above.
    expect(480 - px(style.bottom)).toBe(426);
    expect(px(style.maxHeight)).toBe(430 - 4 - 8);
  } finally { restoreContent(); restoreHeight(); }
});

test("leaving the explorer's view closes its Filters popover, leaving no Escape layer, and the return moves no focus", async () => {
  await renderFilters();
  await openFilters();
  expect(overlayOpen()).toBe(true);
  // A switch inside the explorer leaves the popover open.
  await act(async () => { button("Wiki").click(); });
  await act(async () => { button("Graph").click(); });
  expect(filtersDialog()).not.toBeNull();
  await renderFilters({ visible: false });
  expect(filtersDialog()).toBeNull();
  expect(overlayOpen()).toBe(false);
  // Another view's first Escape is its own.
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(false);
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  try {
    elsewhere.focus();
    await renderFilters({ visible: true });
    expect(filtersDialog()).toBeNull();
    expect(filtersButton().getAttribute("aria-expanded")).toBe("false");
    expect(overlayOpen()).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  } finally { elsewhere.remove(); }
});

test("shown again after being hidden, the explorer re-reads the catalog once and quietly, keeping its state", async () => {
  let catalogReads = 0;
  let detailReads = 0;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") {
      catalogReads++;
      // Same snapshot, but the graph went stale while the explorer was hidden.
      return Promise.resolve(catalogReads === 1 ? { ...catalog, graph: "ready" } : { ...catalog, graph: "stale", graphReason: "an untracked file changed" });
    }
    if (input.action === "detail") detailReads++;
    return request(cwd, input);
  };
  const createCytoscape = await headlessCytoscape();
  const show = (visible: boolean) => act(async () => { root.render(createElement(View, { cwd: "/project", request: read, createCytoscape, onRebuild: noRebuild, visible })); });
  await show(true);
  expect(catalogReads).toBe(1);
  expect(freshnessBanner()).toBeUndefined();
  await act(async () => { listRow("Client").click(); });
  await act(async () => { button("Wiki").click(); });
  const article = () => host.querySelector('[aria-label="Wiki article"] article')?.textContent ?? "";
  expect(article()).toContain("Readable guide");
  const details = detailReads;
  await show(true);
  await show(false);
  expect(catalogReads).toBe(1);
  await show(true);
  expect(catalogReads).toBe(2);
  expect(freshnessBanner()?.textContent).toContain("Graph is stale.");
  // Nothing that hangs on the catalog reloaded: no loading state, the article is the one left.
  expect(detailReads).toBe(details);
  expect(article()).toContain("Readable guide");
  expect(host.textContent).not.toContain("Loading");
  await act(async () => { button("Back").click(); });
  expect(panelTitle()).toBe("Client");
});

test("a return during a rebuild leaves the rebuild running, and its end still re-reads the catalog", async () => {
  let catalogReads = 0;
  let finish: (value: boolean) => void = () => {};
  const onRebuild = () => new Promise<boolean>(resolve => { finish = resolve; });
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") catalogReads++;
    return request(cwd, input);
  };
  const show = (visible: boolean) => act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild, visible })); });
  await show(true);
  await act(async () => { button("Rebuild graph").click(); });
  await show(false);
  await show(true);
  expect(catalogReads).toBe(2);
  expect(button("Rebuilding…").disabled).toBe(true);
  await act(async () => { finish(true); });
  expect(button("Rebuild graph").disabled).toBe(false);
  expect(catalogReads).toBe(3);
});

test("of several pending wiki-link lookups only the one started last opens its target or names a path", async () => {
  const first = { id: "first", kind: "file" as const, title: "First far", path: "src/first.ts" };
  const second = { id: "second", kind: "file" as const, title: "Second far", path: "src/second.ts" };
  const pending = new Map<string, () => void>();
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "detail" && input.id === page.id) return Promise.resolve({ ...snapshot, node: page, markdown: "Intro.\n\n[Missing](missing.md) [First](../src/first.ts) [Second](../src/second.ts)" });
    if (input.action === "search") {
      const query = input.query;
      const hits = query === first.path ? [{ node: first }] : query === second.path ? [{ node: second }] : [];
      return new Promise(resolve => { pending.set(query, () => resolve({ ...snapshot, hits })); });
    }
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild })); });
  await act(async () => { button("Wiki").click(); });
  const link = (text: string) => [...host.querySelectorAll<HTMLElement>("article .md a")].find(item => item.textContent === text)!;
  await act(async () => { link("Missing").click(); });
  await act(async () => { link("First").click(); });
  await act(async () => { link("Second").click(); });
  const article = () => host.querySelector('[aria-label="Wiki article"] article');
  await act(async () => { pending.get("wiki/missing.md")?.(); });
  expect(article()?.textContent).not.toContain("wiki/missing.md");
  await act(async () => { pending.get(first.path)?.(); });
  expect(article()).not.toBeNull();
  expect(panelTitle()).toBeUndefined();
  await act(async () => { pending.get(second.path)?.(); });
  expect(panelTitle()).toBe("Second far");
});

test("a render that changes no node list leaves the explorer's node memory alone", async () => {
  await act(async () => { root.render(createElement(View, { cwd: "/project", request, onRebuild: noRebuild })); });
  const original = Map.prototype.set;
  let writes = 0;
  Map.prototype.set = function <K, V>(this: Map<K, V>, key: K, value: V) {
    if (value === (page as unknown) || value === (file as unknown)) writes++;
    return original.call(this, key, value) as Map<K, V>;
  };
  try {
    // Opening and closing the Filters popover re-renders the explorer over the same nodes.
    await act(async () => { filtersButton().click(); });
    await act(async () => { filtersButton().click(); });
  } finally { Map.prototype.set = original; }
  expect(writes).toBe(0);
});

test("Back to an OpenSpec document restores the scroll it was left at, and the next one opens at its top", async () => {
  const alpha = { id: "spec-alpha", kind: "spec" as const, title: "Alpha spec", path: "openspec/specs/alpha/spec.md" };
  const beta = { id: "spec-beta", kind: "spec" as const, title: "Beta spec", path: "openspec/specs/beta/spec.md" };
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    const base = { schemaVersion: 2, snapshotId: "one" };
    if (input.action === "catalog") return { ...catalog, ...base, nodes: [] };
    if (input.action === "openspec-list") return { ...base, entries: [alpha, beta], openSpec: { availability: "ready", diagnostics: [], truncated: false } };
    if (input.action === "openspec-history") return { ...base, entries: [] };
    if (input.action === "search") return { ...base, hits: [] };
    const entry = input.id === alpha.id ? alpha : beta;
    const source = { path: entry.path, digest: "a".repeat(64) };
    return { ...base, node: entry, openSpec: { entry, artifacts: [source], artifact: { source, markdown: "Reader document", requirements: [] } } };
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", requestV2: read as unknown as NonNullable<ViewProps["requestV2"]>, onRebuild: noRebuild })); });
  await act(async () => { button("OpenSpec").click(); });
  const entry = (title: string) => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="OpenSpec results"] button')].find(item => item.querySelector("strong")?.textContent === title)!;
  const pane = () => host.querySelector<HTMLElement>('[aria-label="OpenSpec detail"]')!;
  const title = () => pane().querySelector("h2")?.textContent;
  await act(async () => { entry("Alpha spec").click(); });
  expect(title()).toBe("Alpha spec");
  pane().scrollTop = 120;
  await act(async () => { entry("Beta spec").click(); });
  expect(title()).toBe("Beta spec");
  expect(pane().scrollTop).toBe(0);
  await act(async () => { button("Back").click(); });
  expect(title()).toBe("Alpha spec");
  expect(pane().scrollTop).toBe(120);
});

// ---- Test strength after review round 1 (T20): each test pins one gate a surviving mutant removed. ----

/** A headless graph factory that also hands the test the live cytoscape instance. */
async function capturingCytoscape() {
  const base = await headlessCytoscape();
  const seen: { cy: import("cytoscape").Core | null } = { cy: null };
  const createCytoscape = (options: import("cytoscape").CytoscapeOptions) => (seen.cy = base(options));
  return { createCytoscape, graph: () => { if (!seen.cy) throw new Error("No graph was drawn"); return seen.cy; } };
}
function stubWindowWidth(width: number) {
  const own = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  return () => { if (own) Object.defineProperty(window, "innerWidth", own); else Reflect.deleteProperty(window, "innerWidth"); };
}
/** Replaces window.setTimeout so a test runs the search debounce when it chooses; returns the runner and the undo. */
function holdDebounce() {
  const originalTimeout = window.setTimeout;
  let runTimer: () => void = () => {};
  window.setTimeout = ((callback: TimerHandler) => { if (typeof callback === "function") runTimer = () => callback(); return 1; }) as typeof window.setTimeout;
  return { run: () => act(async () => { runTimer(); }), restore: () => { window.setTimeout = originalTimeout; } };
}
const wikiLink = (text: string) => {
  const found = [...host.querySelectorAll<HTMLElement>("article .md a")].find(item => item.textContent === text);
  if (!found) throw new Error(`Missing link ${text}`);
  return found;
};
const wikiArticle = () => host.querySelector('[aria-label="Wiki article"] article');
const panelTab = (tab: string) => host.querySelector<HTMLElement>(`[aria-label="Graph node details"] [role="tab"][data-tab="${tab}"]`);

test("Back stops after the 40 most recent history entries", async () => {
  const many = Array.from({ length: 42 }, (_, index) => ({ id: `n${index}`, kind: "file" as const, title: `Node ${String(index).padStart(2, "0")}`, path: `src/n${index}.ts` }));
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog"
    ? Promise.resolve({ ...catalog, nodes: many, counts: { files: many.length, wiki: 0, modules: 0 } }) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild })); });
  // Node 00 is shown already, so its row only opens the panel; each of the next 41 is a history entry.
  for (const node of many.slice(1)) await act(async () => { listRow(node.title).click(); });
  expect(panelTitle()).toBe("Node 41");
  for (let step = 0; step < 40; step++) await act(async () => { button("Back").click(); });
  expect(panelTitle()).toBe("Node 01");
  expect([...host.querySelectorAll("button")].some(item => item.textContent?.trim() === "Back")).toBe(false);
});

test("Back restores the details panel's scroll for the node it returns to", async () => {
  const createCytoscape = await headlessCytoscape();
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: linkedRead, createCytoscape, onRebuild: noRebuild })); });
  await act(async () => { listRow("Client").click(); });
  const body = () => host.querySelector<HTMLElement>('[aria-label="Graph node details"] [role="tabpanel"]')!;
  body().scrollTop = 140;
  await act(async () => { listRow("Server").click(); });
  expect(panelTitle()).toBe("Server");
  body().scrollTop = 0;
  await act(async () => { button("Back").click(); });
  expect(panelTitle()).toBe("Client");
  expect(body().scrollTop).toBe(140);
});

test("pressing the view that is already shown keeps its selection, panel and history", async () => {
  await act(async () => { root.render(createElement(View, { cwd: "/project", request, onRebuild: noRebuild })); });
  await act(async () => { listRow("Client").click(); });
  await act(async () => { button("Graph").click(); });
  expect(panelTitle()).toBe("Client");
  await act(async () => { button("Back").click(); });
  expect([...host.querySelectorAll("button")].some(item => item.textContent?.trim() === "Back")).toBe(false);
});

test("with protocol 2 the Wiki relationships read uses depth 1, both directions and every non-symbol kind of protocol 2", async () => {
  const createCytoscape = await headlessCytoscape();
  const reads: Record<string, unknown>[] = [];
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    const base = { schemaVersion: 2, snapshotId: "one" };
    if (input.action === "catalog") return { ...catalog, ...base, graph: "ready" };
    if (input.action === "neighbors") { reads.push(input); return { ...base, root: input.id, nodes: [page, file], edges: [], truncated: false }; }
    if (input.action === "detail") return { ...base, node: page, markdown: "# Readable guide" };
    return { ...base, hits: [] };
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", requestV2: read as unknown as NonNullable<ViewProps["requestV2"]>, createCytoscape, onRebuild: noRebuild })); });
  await openFilters();
  const select = (label: string, value: string) => act(async () => {
    const control = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    control.value = value; control.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await select("Direction", "incoming");
  await select("Depth", "2");
  await act(async () => { button("Imports").click(); });
  expect(reads.at(-1)).toMatchObject({ direction: "incoming", depth: 2 });
  await act(async () => { button("Wiki").click(); });
  const { METAPROJECT_EDGE_KINDS_V2 } = await import("../../../../src/integrations/metaproject-explorer-contract");
  expect(reads.at(-1)).toMatchObject({ action: "neighbors", id: page.id, depth: 1, direction: "both" });
  expect(reads.at(-1)?.kinds).toEqual(METAPROJECT_EDGE_KINDS_V2.filter(kind => kind !== "defines" && kind !== "calls"));
});

test("the list header never counts fewer than it lists, and in Wiki counts Wiki pages only", async () => {
  let counts = { files: 0, wiki: 0, modules: 0 };
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog" ? Promise.resolve({ ...catalog, counts }) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild })); });
  expect(host.querySelector(".metaproject-list h2")?.textContent).toBe("Catalog · 2 of 2");
  await act(async () => { root.render(null); });
  counts = { files: 40, wiki: 9, modules: 3 };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild })); });
  await act(async () => { button("Wiki").click(); });
  expect(host.querySelector(".metaproject-list h2")?.textContent).toBe("Catalog · 1 of 9");
});

test("after a failed relationships read the old graph is not shown again while the next selection loads", async () => {
  const createCytoscape = await headlessCytoscape();
  const read = (_cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve({ ...linkedCatalog, truncated: true });
    if (input.action === "neighbors") {
      if (input.id === page.id) return Promise.resolve({ ...snapshot, root: page.id, nodes: [page, file], edges: [{ from: page.id, to: file.id, kind: "describes" as const }], truncated: false });
      if (input.id === file.id) return Promise.reject(new Error("Relationships read failed"));
      return new Promise(() => {});
    }
    return request(_cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, createCytoscape, onRebuild: noRebuild })); });
  const graph = () => host.querySelector(".metaproject-content .metaproject-rgraph");
  expect(graph()).not.toBeNull();
  await act(async () => { listRow("Client").click(); });
  expect(host.textContent).toContain("Relationships read failed");
  await act(async () => { listRow("Server").click(); });
  expect(graph()).toBeNull();
  expect(host.querySelector(".metaproject-content")?.textContent).toContain("Loading relationships…");
});

test("with protocol 2 the graph is drawn even when the catalog reports the graph missing", async () => {
  const createCytoscape = await headlessCytoscape();
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    const base = { schemaVersion: 2, snapshotId: "one" };
    if (input.action === "catalog") return { ...linkedCatalog, ...base, graph: "missing" };
    if (input.action === "neighbors") return { ...base, root: input.id, nodes: [page, file], edges: [{ from: page.id, to: file.id, kind: "describes" }], truncated: false };
    return { ...base, hits: [] };
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", requestV2: read as unknown as NonNullable<ViewProps["requestV2"]>, createCytoscape, onRebuild: noRebuild })); });
  expect(host.textContent).toContain("Graph is missing.");
  expect(host.querySelector(".metaproject-content .metaproject-rgraph-title")?.textContent).toBe("Guide");
});

test("Draft is offered only on a ready graph whose linked-document read is complete", async () => {
  const createCytoscape = await headlessCytoscape();
  const drafted: string[] = [];
  const show = async (graph: "ready" | "stale", truncated: boolean) => {
    await act(async () => { root.render(null); });
    const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
      if (input.action === "catalog") return Promise.resolve({ ...catalog, graph, truncated: true });
      if (input.action === "neighbors") return Promise.resolve({ ...snapshot, root: input.id, nodes: [input.id === page.id ? page : file], edges: [], truncated });
      return request(cwd, input);
    };
    await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, createCytoscape, onRebuild: noRebuild, onDraft: async task => { drafted.push(task); } })); });
    await act(async () => { listRow("Client").click(); });
    await openPanelTab("wiki");
    return [...host.querySelectorAll("button")].some(item => item.textContent?.includes("Draft Wiki page"));
  };
  expect(await show("ready", false)).toBe(true);
  expect(await show("stale", false)).toBe(false);
  expect(await show("ready", true)).toBe(false);
});

test("a failed linked-document read shows its problem instead of a pending lookup", async () => {
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve({ ...catalog, truncated: true });
    if (input.action === "neighbors" && input.kinds.includes("describes") && !input.kinds.includes("imports")) return Promise.reject(new Error("Linked documents unavailable"));
    if (input.action === "neighbors") return Promise.resolve({ ...snapshot, root: input.id, nodes: [page, file], edges: [], truncated: false });
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild })); });
  await act(async () => { listRow("Client").click(); });
  await openPanelTab("wiki");
  const panel = host.querySelector('[aria-label="Graph node details"]')?.textContent ?? "";
  expect(panel).toContain("Linked documents unavailable");
  expect(panel).not.toContain("Looking for linked documents");
});

test("tapping a graph's “+N more” entry opens the panel on its Relationships tab", async () => {
  const neighbours = Array.from({ length: 14 }, (_, index) => ({ id: `out${index}`, kind: "file" as const, title: `Out ${index}`, path: `src/out${index}.ts` }));
  const crowded: MetaprojectCatalog = {
    ...catalog, graph: "ready", nodes: [file, page, ...neighbours],
    edges: neighbours.map(node => ({ from: file.id, to: node.id, kind: "imports" as const })),
  };
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog" ? Promise.resolve(crowded) : request(cwd, input);
  const { createCytoscape, graph } = await capturingCytoscape();
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, createCytoscape, onRebuild: noRebuild })); });
  const more = () => { const entry = graph().nodes(".overflow"); if (!entry.length) throw new Error("No “+N more” entry"); return entry[0]!; };
  expect(host.querySelector('[aria-label="Graph node details"]')).toBeNull();
  await act(async () => { more().emit("tap"); });
  expect(panelTitle()).toBe("Client");
  expect(panelTab("relationships")?.getAttribute("aria-selected")).toBe("true");
  await openPanelTab("wiki");
  expect(panelTab("relationships")?.getAttribute("aria-selected")).toBe("false");
  await act(async () => { more().emit("tap"); });
  expect(panelTab("relationships")?.getAttribute("aria-selected")).toBe("true");
});

test("a wiki-link lookup answered from another snapshot opens nothing and offers a refresh", async () => {
  const far = { id: "far", kind: "file" as const, title: "Far module", path: "src/far.ts" };
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "detail" && input.id === page.id) return Promise.resolve({ ...snapshot, node: page, markdown: "Intro.\n\n[Far](../src/far.ts)" });
    if (input.action === "search") return Promise.resolve({ ...snapshot, snapshotId: "two", hits: [{ node: far }] });
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild })); });
  await act(async () => { button("Wiki").click(); });
  await act(async () => { wikiLink("Far").click(); });
  expect(panelTitle()).toBeUndefined();
  expect(wikiArticle()?.textContent).toContain("Intro.");
  expect(host.textContent).toContain("Project knowledge changed while loading");
});

test("a wiki link that cannot be decoded is named as invalid and never looked up", async () => {
  const searches: string[] = [];
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "detail" && input.id === page.id) return Promise.resolve({ ...snapshot, node: page, markdown: "Intro.\n\n[Broken](bad%E0%A4%A.md)" });
    if (input.action === "search") { searches.push(input.query); return Promise.resolve({ ...snapshot, hits: [] }); }
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild })); });
  await act(async () => { button("Wiki").click(); });
  await act(async () => { wikiLink("Broken").click(); });
  expect(wikiArticle()?.querySelector('[role="status"]')?.textContent).toBe("The link bad%E0%A4%A.md is not a valid repository path.");
  expect(searches).toEqual([]);
});

test("an unresolved-link message belongs to its page and is gone on the next page", async () => {
  const second = { id: "second", kind: "wiki" as const, title: "Second guide", path: "wiki/second.md" };
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve({ ...catalog, nodes: [page, second, file] });
    if (input.action === "detail") return Promise.resolve({ ...snapshot, node: input.id === second.id ? second : page, markdown: input.id === second.id ? "Second body." : "Intro.\n\n[Missing](missing.md)" });
    if (input.action === "search") return Promise.resolve({ ...snapshot, hits: [] });
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild })); });
  await act(async () => { button("Wiki").click(); });
  await act(async () => { wikiLink("Missing").click(); });
  expect(wikiArticle()?.textContent).toContain("No indexed project file at wiki/missing.md.");
  await act(async () => { listRow("Second guide").click(); });
  expect(wikiArticle()?.textContent).toContain("Second body.");
  expect(wikiArticle()?.textContent).not.toContain("wiki/missing.md");
});

test("a changed Direction counts in the Filters button and its summary", async () => {
  await renderFilters();
  await openFilters();
  await act(async () => {
    const direction = host.querySelector<HTMLSelectElement>('select[aria-label="Direction"]')!;
    direction.value = "incoming"; direction.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(filtersButton().textContent?.trim()).toBe("Filters · 1");
  expect(filtersButton().title).toBe("Incoming · 1 step · 5 of 7 types");
});

test("pressing the Filters button of an open popover closes it, not closes and reopens it", async () => {
  await renderFilters();
  await openFilters();
  // A real press is a mousedown and then a click on the same button.
  await act(async () => { filtersButton().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await act(async () => { filtersButton().click(); });
  expect(filtersDialog()).toBeNull();
  expect(filtersButton().getAttribute("aria-expanded")).toBe("false");
});

test("the Filters popover is kept 8 px inside the window's left and right edges", async () => {
  const restoreWidth = stubWindowWidth(720);
  try {
    await renderFilters();
    stubBox(filtersButton(), { left: 130, top: 100, right: 200, bottom: 124 });
    await openFilters();
    expect(px(filtersDialog()!.style.left)).toBe(8);
    await act(async () => { filtersButton().click(); });
    stubBox(filtersButton(), { left: 690, top: 100, right: 760, bottom: 124 });
    await openFilters();
    expect(px(filtersDialog()!.style.left)).toBe(720 - 320 - 8);
  } finally { restoreWidth(); }
});

test("once the search settles, Find a Wiki page names the searched text in its empty state", async () => {
  const debounce = holdDebounce();
  try {
    await act(async () => { root.render(createElement(View, { cwd: "/project", request, onRebuild: noRebuild })); });
    await act(async () => { listRow("Client").click(); });
    await openPanelTab("wiki");
    await act(async () => { button("Find a Wiki page").click(); });
    await debounce.run();
    const content = host.querySelector('[aria-label="Wiki article"]');
    expect(content?.querySelector(".empty-state h3")?.textContent).toBe("No Wiki page matches “src/client.ts”");
    expect(content?.querySelector("article")).toBeNull();
  } finally { debounce.restore(); }
});

test("a Wiki page without relationships shows no Relationships disclosure", async () => {
  await act(async () => { root.render(createElement(View, { cwd: "/project", request, onRebuild: noRebuild })); });
  await act(async () => { button("Wiki").click(); });
  expect(wikiArticle()?.textContent).toContain("Readable guide");
  expect(host.querySelector(".metaproject-relationship-section")).toBeNull();
});

/** Renders the explorer with `props`, shown or hidden as the app does when the user leaves its view and returns. */
function showView(props: ViewProps, visible: boolean) {
  return act(async () => { root.render(createElement(View, { ...props, visible })); });
}
/** The explorer's catalog error banner: the alert whose Retry re-reads the catalog. */
const catalogErrorBanner = () => [...host.querySelectorAll<HTMLElement>('.inline-banner[role="alert"]')]
  .find(item => !item.closest(".metaproject-list, .metaproject-content"));

test("a Wiki page's Relationships disclosure counts the rows its list shows, and a self-link alone shows none", async () => {
  // A limited catalog of a built graph makes the explorer read the neighbourhood from the CLI, which this test answers.
  const limited = { ...catalog, truncated: true, graph: "ready" as const };
  const selfLink = { from: page.id, to: page.id, kind: "links" as const };
  const readWith = (edges: MetaprojectEdge[]) => (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve(limited);
    if (input.action === "neighbors") return Promise.resolve({ ...snapshot, root: input.id, nodes: [page, file], edges, truncated: false });
    return request(cwd, input);
  };
  const createCytoscape = await headlessCytoscape();
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: readWith([selfLink]), onRebuild: noRebuild, createCytoscape })); });
  await act(async () => { button("Wiki").click(); });
  expect(wikiArticle()?.textContent).toContain("Readable guide");
  // A count, not the element: a failing match would print the whole disclosure.
  expect(host.querySelectorAll(".metaproject-relationship-section").length).toBe(0);
  await act(async () => { root.render(null); });
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: readWith([selfLink, { from: page.id, to: file.id, kind: "describes" }]), onRebuild: noRebuild, createCytoscape })); });
  await act(async () => { button("Wiki").click(); });
  const section = host.querySelector(".metaproject-relationship-section");
  expect(section?.querySelector("summary .count-label")?.textContent).toBe("1");
  expect(section?.querySelectorAll(".metaproject-rel-row")).toHaveLength(1);
});

test("a wiki-link lookup in flight when the explorer is hidden and shown again still settles", async () => {
  const far = { id: "far", kind: "file" as const, title: "Far module", path: "src/far.ts" };
  const pending = new Map<string, () => void>();
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "detail" && input.id === page.id) return Promise.resolve({ ...snapshot, node: page, markdown: "Intro.\n\n[Missing](missing.md) [Far](../src/far.ts)" });
    if (input.action === "search") {
      const query = input.query;
      return new Promise(resolve => { pending.set(query, () => resolve({ ...snapshot, hits: query === far.path ? [{ node: far }] : [] })); });
    }
    return request(cwd, input);
  };
  const props: ViewProps = { cwd: "/project", request: read, onRebuild: noRebuild };
  await showView(props, true);
  await act(async () => { button("Wiki").click(); });
  await act(async () => { wikiLink("Missing").click(); });
  await showView(props, false);
  await showView(props, true);
  await act(async () => { pending.get("wiki/missing.md")?.(); });
  expect(wikiArticle()?.textContent).toContain("No indexed project file at wiki/missing.md.");
  await act(async () => { wikiLink("Far").click(); });
  await showView(props, false);
  await showView(props, true);
  await act(async () => { pending.get(far.path)?.(); });
  expect(panelTitle()).toBe("Far module");
});

test("a page of results in flight when the explorer is hidden and shown again is still appended", async () => {
  const debounce = holdDebounce();
  let releasePage: () => void = () => {};
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    if (input.action === "catalog") return { ...catalog, schemaVersion: 2 };
    if (input.action === "search") {
      if (!input.cursor) return { schemaVersion: 2, snapshotId: "one", hits: [{ node: page, scope: "wiki" }], nextCursor: "next", partial: false };
      return new Promise(resolve => { releasePage = () => resolve({ schemaVersion: 2, snapshotId: "one", hits: [{ node: { ...page, id: "second-page", title: "Second Wiki page" }, scope: "wiki" }], partial: false }); });
    }
    if (input.action === "detail") return { ...snapshot, schemaVersion: 2, node: page };
    return { ...snapshot, schemaVersion: 2, root: page.id, nodes: [page], edges: [], truncated: false };
  };
  const props: ViewProps = { cwd: "/project", requestV2: read as unknown as NonNullable<ViewProps["requestV2"]>, onRebuild: noRebuild, createCytoscape: await headlessCytoscape() };
  try {
    await showView(props, true);
    await act(async () => { button("Wiki").click(); });
    await typeQuery("query");
    await debounce.run();
    await act(async () => { button("Load more results").click(); });
    await showView(props, false);
    await showView(props, true);
    await act(async () => { releasePage(); });
    expect(host.querySelector(".metaproject-list")?.textContent).toContain("Second Wiki page");
  } finally { debounce.restore(); }
});

test("a failed quiet re-read on return shows no error and leaves the explorer as it was", async () => {
  let catalogReads = 0;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") {
      catalogReads++;
      return catalogReads === 1 ? Promise.resolve(catalog) : Promise.reject(new Error("The CLI is busy."));
    }
    return request(cwd, input);
  };
  const props: ViewProps = { cwd: "/project", request: read, onRebuild: noRebuild };
  await showView(props, true);
  await act(async () => { listRow("Client").click(); });
  await showView(props, false);
  await showView(props, true);
  expect(catalogReads).toBe(2);
  expect(host.textContent).not.toContain("The CLI is busy.");
  expect(catalogErrorBanner()).toBeUndefined();
  expect(freshnessBanner()?.textContent).toContain("Graph is missing.");
  expect(listRow("Client").getAttribute("aria-current")).toBe("true");
  expect(panelTitle()).toBe("Client");
});

test("a standing error, such as a failed rebuild's, survives a quiet re-read on return", async () => {
  let catalogReads = 0;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") catalogReads++;
    return request(cwd, input);
  };
  const props: ViewProps = { cwd: "/project", request: read, onRebuild: async () => { throw new Error("Rebuild failed: index locked."); } };
  await showView(props, true);
  await act(async () => { button("Rebuild graph").click(); });
  expect(catalogErrorBanner()?.textContent).toContain("Rebuild failed: index locked.");
  await showView(props, false);
  await showView(props, true);
  expect(catalogReads).toBe(2);
  expect(catalogErrorBanner()?.textContent).toContain("Rebuild failed: index locked.");
});

test("a return while a catalog reload is in flight starts no quiet read, and the reload's failure is still shown", async () => {
  let catalogReads = 0;
  let failReload: () => void = () => {};
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") {
      catalogReads++;
      if (catalogReads === 2) return new Promise((_resolve, reject) => { failReload = () => reject(new Error("The index is being written.")); });
    }
    return request(cwd, input);
  };
  const props: ViewProps = { cwd: "/project", request: read, onRebuild: async () => true };
  await showView(props, true);
  // A successful rebuild reloads the catalog; that reload is held.
  await act(async () => { button("Rebuild graph").click(); });
  expect(catalogReads).toBe(2);
  await showView(props, false);
  await showView(props, true);
  expect(catalogReads).toBe(2);
  await act(async () => { failReload(); });
  expect(catalogErrorBanner()?.textContent).toContain("The index is being written.");
});

test("the Filters popover stays under its button when its content fits on neither side and there is less room above", async () => {
  const restoreHeight = stubWindowHeight(480);
  const restoreContent = stubPopoverContentHeight(500);
  try {
    await renderFilters();
    // 294 px below the button, 138 px above it: neither holds 500 px, so the larger room, below, wins.
    stubBox(filtersButton(), { left: 544, top: 150, right: 615, bottom: 174 });
    await openFilters();
    const style = filtersDialog()!.style;
    expect(style.bottom).toBe("");
    expect(px(style.top)).toBe(174 + 4);
    expect(px(style.maxHeight)).toBe(480 - 8 - 178);
  } finally { restoreContent(); restoreHeight(); }
});

test("in a tall window the Filters popover keeps the menu's 420 px height cap, under its button and above it", async () => {
  const restoreHeight = stubWindowHeight(900);
  const restoreContent = stubPopoverContentHeight(229);
  try {
    await renderFilters();
    // 764 px of room below the button.
    stubBox(filtersButton(), { left: 544, top: 100, right: 615, bottom: 124 });
    await openFilters();
    expect(px(filtersDialog()!.style.top)).toBe(128);
    expect(px(filtersDialog()!.style.maxHeight)).toBe(420);
    await act(async () => { filtersButton().click(); });
    // 264 px below cannot hold the content; 788 px above can.
    stubBox(filtersButton(), { left: 544, top: 800, right: 615, bottom: 824 });
    await openFilters();
    expect(filtersDialog()!.style.top).toBe("");
    expect(px(filtersDialog()!.style.bottom)).toBe(900 - 800 + 4);
    expect(px(filtersDialog()!.style.maxHeight)).toBe(420);
  } finally { restoreContent(); restoreHeight(); }
});

test("a Filters button at the window's bottom edge keeps the popover above it 8 px inside the window", async () => {
  const restoreHeight = stubWindowHeight(480);
  const restoreContent = stubPopoverContentHeight(229);
  try {
    await renderFilters();
    stubBox(filtersButton(), { left: 544, top: 478, right: 615, bottom: 502 });
    await openFilters();
    expect(filtersDialog()!.style.top).toBe("");
    expect(px(filtersDialog()!.style.bottom)).toBe(8);
  } finally { restoreContent(); restoreHeight(); }
});

test("in a window too short for any room beside its button, the Filters popover gets no negative height", async () => {
  const restoreHeight = stubWindowHeight(30);
  try {
    await renderFilters();
    // 6 px short below the button and 12 px short above it.
    stubBox(filtersButton(), { left: 544, top: 0, right: 615, bottom: 24 });
    await openFilters();
    expect(px(filtersDialog()!.style.top)).toBe(28);
    expect(px(filtersDialog()!.style.maxHeight)).toBe(0);
  } finally { restoreHeight(); }
});

test("a closed Filters popover no longer measures its button when the window is resized", async () => {
  await renderFilters();
  const toggle = filtersButton();
  stubBox(toggle, { left: 544, top: 100, right: 615, bottom: 124 });
  const box = toggle.getBoundingClientRect;
  let measured = 0;
  toggle.getBoundingClientRect = () => { measured++; return box(); };
  await openFilters();
  const opened = measured;
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(measured).toBe(opened + 1);
  await act(async () => { toggle.click(); });
  expect(filtersDialog()).toBeNull();
  const closed = measured;
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(measured).toBe(closed);
});

test("shown again after the project's knowledge changed, the explorer shows the new catalog", async () => {
  const server = { id: "server", kind: "file" as const, title: "Server", path: "src/server.ts" };
  let snapshotId = "one";
  let catalogReads = 0;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") {
      catalogReads++;
      return Promise.resolve(snapshotId === "one" ? catalog : { ...catalog, snapshotId, nodes: [page, file, server], counts: { files: 2, wiki: 1, modules: 0 } });
    }
    return request(cwd, input).then(result => ({ ...result, snapshotId }));
  };
  const props: ViewProps = { cwd: "/project", request: read, onRebuild: noRebuild };
  await showView(props, true);
  expect(host.querySelector(".metaproject-list")?.textContent).not.toContain("Server");
  await showView(props, false);
  snapshotId = "two";
  await showView(props, true);
  expect(catalogReads).toBe(2);
  expect(listRow("Server").textContent).toContain("src/server.ts");
  expect(host.textContent).not.toContain("Project knowledge changed while loading");
});

test("a graph gone stale while hidden shows its reason under Details, and a rebuild's ready reload clears it", async () => {
  let graph: "ready" | "stale" = "ready";
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog"
    ? Promise.resolve(graph === "ready" ? { ...catalog, graph } : { ...catalog, graph, graphReason: "an untracked file changed" })
    : request(cwd, input);
  const props: ViewProps = { cwd: "/project", request: read, onRebuild: async () => true, createCytoscape: await headlessCytoscape() };
  await showView(props, true);
  expect(freshnessBanner()).toBeUndefined();
  await showView(props, false);
  graph = "stale";
  await showView(props, true);
  expect(freshnessBanner()?.textContent).toContain("Graph is stale.");
  await act(async () => { detailsButton()?.click(); });
  expect(detailsButton()?.getAttribute("aria-expanded")).toBe("true");
  expect(freshnessBanner()?.textContent).toContain("an untracked file changed");
  graph = "ready";
  await act(async () => { button("Rebuild graph").click(); });
  expect(freshnessBanner()).toBeUndefined();
});

test("after a quiet re-read on return, a rebuild's failed catalog reload is still shown", async () => {
  let catalogReads = 0;
  let failing = false;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") {
      catalogReads++;
      if (failing) return Promise.reject(new Error("The index is being written."));
    }
    return request(cwd, input);
  };
  const props: ViewProps = { cwd: "/project", request: read, onRebuild: async () => true };
  await showView(props, true);
  await showView(props, false);
  await showView(props, true);
  expect(catalogReads).toBe(2);
  failing = true;
  await act(async () => { button("Rebuild graph").click(); });
  expect(catalogReads).toBe(3);
  expect(catalogErrorBanner()?.textContent).toContain("The index is being written.");
});

test("a return after a failed first catalog read starts no read, and its failure and Retry stay", async () => {
  let catalogReads = 0;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") {
      catalogReads++;
      return catalogReads === 1 ? Promise.reject(new Error("The CLI is not ready.")) : Promise.resolve(catalog);
    }
    return request(cwd, input);
  };
  const props: ViewProps = { cwd: "/project", request: read, onRebuild: noRebuild };
  await showView(props, true);
  expect(catalogErrorBanner()?.textContent).toContain("The CLI is not ready.");
  await showView(props, false);
  await showView(props, true);
  expect(catalogReads).toBe(1);
  expect(catalogErrorBanner()?.textContent).toContain("The CLI is not ready.");
  await act(async () => { button("Retry").click(); });
  expect(catalogReads).toBe(2);
  expect(catalogErrorBanner()).toBeUndefined();
  expect(listRow("Client").textContent).toContain("src/client.ts");
});

test("a node known only from a search hit keeps its panel once the search is cleared, and Back returns to it at once", async () => {
  const far = { id: "far", kind: "file" as const, title: "Far module", path: "src/far.ts" };
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "search"
    ? Promise.resolve({ ...snapshot, hits: input.query === "far" ? [{ node: far, snippet: "far away" }] : [] })
    : request(cwd, input);
  const debounce = holdDebounce();
  try {
    await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild })); });
    await typeQuery("far");
    await debounce.run();
    await act(async () => { listRow("Far module").click(); });
    expect(panelTitle()).toBe("Far module");
    // The hit is gone from the list; the node is in neither the catalog nor any read the explorer holds now.
    await typeQuery("");
    expect(host.querySelector(".metaproject-list")?.textContent).not.toContain("Far module");
    expect(panelTitle()).toBe("Far module");
    await act(async () => { listRow("Client").click(); });
    expect(panelTitle()).toBe("Client");
    await act(async () => { button("Back").click(); });
    expect(panelTitle()).toBe("Far module");
  } finally { debounce.restore(); }
});

// ---- Fix round 3 (T24): a quiet re-read and the catalog error, and test strength of fix round 2. ----

test("a quiet re-read that succeeds after a failed catalog reload removes its banner, whether the snapshot changed or not", async () => {
  const server = { id: "server", kind: "file" as const, title: "Server", path: "src/server.ts" };
  let snapshotId = "one";
  let failure = "";
  let catalogReads = 0;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") {
      catalogReads++;
      if (failure) return Promise.reject(new Error(failure));
      return Promise.resolve(snapshotId === "one" ? catalog : { ...catalog, snapshotId, nodes: [page, file, server], counts: { files: 2, wiki: 1, modules: 0 } });
    }
    return request(cwd, input).then(result => ({ ...result, snapshotId }));
  };
  const props: ViewProps = { cwd: "/project", request: read, onRebuild: async () => true };
  await showView(props, true);
  // The reload after a rebuild fails: its banner and Retry show above the catalog still loaded.
  failure = "The index is being written.";
  await act(async () => { button("Rebuild graph").click(); });
  expect(catalogErrorBanner()?.textContent).toContain("The index is being written.");
  // A failed quiet re-read on return neither removes that banner nor replaces its message.
  failure = "The CLI is busy.";
  await showView(props, false);
  await showView(props, true);
  expect(catalogReads).toBe(3);
  expect(catalogErrorBanner()?.textContent).toContain("The index is being written.");
  expect(host.textContent).not.toContain("The CLI is busy.");
  // The catalog can be read again, with the same snapshot: the banner goes.
  failure = "";
  await showView(props, false);
  await showView(props, true);
  expect(catalogReads).toBe(4);
  expect(catalogErrorBanner()?.textContent).toBeUndefined();
  expect(freshnessBanner()?.textContent).toContain("Graph is missing.");
  // A failed Retry shows the banner again; the next quiet read finds a changed snapshot, shows it, and the banner goes.
  failure = "The CLI is not ready.";
  await act(async () => { button("Rebuild graph").click(); });
  expect(catalogErrorBanner()?.textContent).toContain("The CLI is not ready.");
  await act(async () => { button("Retry").click(); });
  expect(catalogReads).toBe(6);
  expect(catalogErrorBanner()?.textContent).toContain("The CLI is not ready.");
  failure = "";
  snapshotId = "two";
  await showView(props, false);
  await showView(props, true);
  expect(catalogReads).toBe(7);
  expect(catalogErrorBanner()?.textContent).toBeUndefined();
  expect(listRow("Server").textContent).toContain("src/server.ts");
});

test("a failed rebuild's message outlives a catalog read that was already in flight and then succeeds", async () => {
  let release: () => void = () => {};
  let catalogReads = 0;
  const reader = (hold: boolean) => (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") {
      catalogReads++;
      if (hold) return new Promise(resolve => { release = () => resolve(catalog); });
    }
    return request(cwd, input);
  };
  const onRebuild = async (): Promise<boolean> => { throw new Error("Rebuild failed: index locked."); };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: reader(false), onRebuild })); });
  // A new reader identity reloads the catalog, loudly; that read is held while a rebuild fails.
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: reader(true), onRebuild })); });
  expect(catalogReads).toBe(2);
  await act(async () => { button("Rebuild graph").click(); });
  expect(catalogErrorBanner()?.textContent).toContain("Rebuild failed: index locked.");
  await act(async () => { release(); });
  expect(catalogErrorBanner()?.textContent).toContain("Rebuild failed: index locked.");
});

test("a rebuild's catalog reload retires a wiki-link lookup in flight: it neither opens its target nor names a path", async () => {
  const far = { id: "far", kind: "file" as const, title: "Far module", path: "src/far.ts" };
  const pending = new Map<string, () => void>();
  let catalogReads = 0;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") catalogReads++;
    if (input.action === "detail" && input.id === page.id) return Promise.resolve({ ...snapshot, node: page, markdown: "Intro.\n\n[Missing](missing.md) [Far](../src/far.ts)" });
    if (input.action === "search") {
      const query = input.query;
      return new Promise(resolve => { pending.set(query, () => resolve({ ...snapshot, hits: query === far.path ? [{ node: far }] : [] })); });
    }
    return request(cwd, input);
  };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: async () => true })); });
  await act(async () => { button("Wiki").click(); });
  await act(async () => { wikiLink("Missing").click(); });
  await act(async () => { button("Rebuild graph").click(); });
  expect(catalogReads).toBe(2);
  await act(async () => { pending.get("wiki/missing.md")?.(); });
  expect(wikiArticle()?.textContent).toContain("Intro.");
  expect(wikiArticle()?.textContent).not.toContain("No indexed project file");
  await act(async () => { wikiLink("Far").click(); });
  await act(async () => { button("Rebuild graph").click(); });
  expect(catalogReads).toBe(3);
  await act(async () => { pending.get(far.path)?.(); });
  expect(panelTitle()).toBeUndefined();
  expect(button("Wiki").getAttribute("aria-pressed")).toBe("true");
  expect(wikiArticle()?.querySelector("h2")?.textContent).toBe("Guide");
});

test("a rebuild's catalog reload retires a page of results in flight: it is not appended", async () => {
  const debounce = holdDebounce();
  let releasePage: () => void = () => {};
  let catalogReads = 0;
  const read = async (_cwd: string, input: Record<string, unknown>): Promise<unknown> => {
    if (input.action === "catalog") { catalogReads++; return { ...catalog, schemaVersion: 2 }; }
    if (input.action === "search") {
      if (!input.cursor) return { schemaVersion: 2, snapshotId: "one", hits: [{ node: page, scope: "wiki" }], nextCursor: "next", partial: false };
      return new Promise(resolve => { releasePage = () => resolve({ schemaVersion: 2, snapshotId: "one", hits: [{ node: { ...page, id: "second-page", title: "Second Wiki page" }, scope: "wiki" }], partial: false }); });
    }
    if (input.action === "detail") return { ...snapshot, schemaVersion: 2, node: page };
    return { ...snapshot, schemaVersion: 2, root: page.id, nodes: [page], edges: [], truncated: false };
  };
  const props: ViewProps = { cwd: "/project", requestV2: read as unknown as NonNullable<ViewProps["requestV2"]>, onRebuild: async () => true, createCytoscape: await headlessCytoscape() };
  try {
    await showView(props, true);
    await act(async () => { button("Wiki").click(); });
    await typeQuery("query");
    await debounce.run();
    await act(async () => { button("Load more results").click(); });
    await act(async () => { button("Rebuild graph").click(); });
    expect(catalogReads).toBe(2);
    await act(async () => { releasePage(); });
    expect(host.querySelector(".metaproject-list")?.textContent).toContain("Guide");
    expect(host.querySelector(".metaproject-list")?.textContent).not.toContain("Second Wiki page");
  } finally { debounce.restore(); }
});

test("a Wiki page's Relationships disclosure counts a second-step row with the adjacent ones", async () => {
  // A limited catalog of a built graph makes the explorer read the neighbourhood from the CLI, which this test answers.
  const limited = { ...catalog, truncated: true, graph: "ready" as const };
  const edges: MetaprojectEdge[] = [{ from: page.id, to: file.id, kind: "describes" }, { from: file.id, to: third.id, kind: "imports" }];
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") return Promise.resolve(limited);
    if (input.action === "neighbors") return Promise.resolve({ ...snapshot, root: input.id, nodes: [page, file, third], edges, truncated: false });
    return request(cwd, input);
  };
  const createCytoscape = await headlessCytoscape();
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild: noRebuild, createCytoscape })); });
  await act(async () => { button("Wiki").click(); });
  const section = host.querySelector(".metaproject-relationship-section");
  expect(section?.querySelector("summary .count-label")?.textContent).toBe("2");
  expect(section?.querySelectorAll('[data-direction="outgoing"] .metaproject-rel-row')).toHaveLength(1);
  expect(section?.querySelector('[data-direction="second-step"] summary')?.textContent?.replace(/\s+/g, " ").trim()).toBe("Second step 1");
  expect(section?.querySelectorAll('[data-direction="second-step"] .metaproject-rel-second')).toHaveLength(1);
});

test("a rebuild the user starts removes a failed catalog read's banner, and one that reloads nothing leaves it gone", async () => {
  let catalogReads = 0;
  let finish: (value: boolean) => void = () => {};
  let rebuilds = 0;
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => {
    if (input.action === "catalog") {
      catalogReads++;
      if (catalogReads === 2) return Promise.reject(new Error("The index is being written."));
    }
    return request(cwd, input);
  };
  const onRebuild = () => { rebuilds++; return rebuilds === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { finish = resolve; }); };
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, onRebuild })); });
  await act(async () => { button("Rebuild graph").click(); });
  expect(catalogErrorBanner()?.textContent).toContain("The index is being written.");
  await act(async () => { button("Rebuild graph").click(); });
  expect(button("Rebuilding…").disabled).toBe(true);
  expect(catalogErrorBanner()?.textContent).toBeUndefined();
  await act(async () => { finish(false); });
  expect(catalogReads).toBe(2);
  expect(catalogErrorBanner()?.textContent).toBeUndefined();
});
