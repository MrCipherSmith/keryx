import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { MetaprojectCatalog, MetaprojectRequest, MetaprojectResponse } from "../../../../src/integrations/metaproject-explorer-contract";
import { registerDom, unregisterDom } from "../test/dom";

let createElement: typeof import("react").createElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let View: typeof import("./MetaprojectView").MetaprojectView;
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
async function renderFilters() {
  const createCytoscape = await headlessCytoscape();
  const read = (cwd: string, input: MetaprojectRequest): Promise<MetaprojectResponse> => input.action === "catalog" ? Promise.resolve(linkedCatalog) : request(cwd, input);
  await act(async () => { root.render(createElement(View, { cwd: "/project", request: read, createCytoscape, onRebuild: async () => false })); });
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
  expect(host.textContent).toContain("Graph is stale: an untracked file changed");
});
