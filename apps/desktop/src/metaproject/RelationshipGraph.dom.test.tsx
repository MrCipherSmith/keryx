import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type cytoscapeModule from "cytoscape";
import type { Root } from "react-dom/client";
import type {
  MetaprojectEdge,
  MetaprojectEdgeKind,
  MetaprojectNeighbors,
  MetaprojectNode,
  MetaprojectNodeKind,
} from "../../../../src/integrations/metaproject-explorer-contract";
import { registerDom, unregisterDom } from "../test/dom";

type Cytoscape = typeof cytoscapeModule;
let createElement: typeof import("react").createElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let Graph: typeof import("./RelationshipGraph").RelationshipGraph;
let layout: typeof import("./graphLayout");
let cytoscape: Cytoscape;
let root: Root;
let host: HTMLElement;

/** happy-dom has no 2D canvas, so the component gets a headless cytoscape through its factory seam. */
const instances: cytoscapeModule.Core[] = [];
function headless(options: cytoscapeModule.CytoscapeOptions): cytoscapeModule.Core {
  const { container: _container, ...rest } = options;
  const instance = cytoscape({ ...rest, headless: true });
  instances.push(instance);
  return instance;
}

beforeAll(async () => {
  registerDom();
  const react = await import("react");
  createElement = react.createElement;
  act = react.act as typeof act;
  cytoscape = (await import("cytoscape")).default;
  Graph = (await import("./RelationshipGraph")).RelationshipGraph;
  layout = await import("./graphLayout");
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});
beforeEach(async () => {
  await act(() => root.render(null));
  instances.length = 0;
});
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const snapshot = { schemaVersion: 1 as const, snapshotId: "snap" };
const node = (id: string, kind: MetaprojectNodeKind = "file", title = id): MetaprojectNode => ({ id, kind, title, path: `src/${id}` });
const edge = (from: string, to: string, kind: MetaprojectEdgeKind): MetaprojectEdge => ({ from, to, kind });

function moduleProjection(truncated = false): MetaprojectNeighbors {
  const rootNode = node("module:root", "module", "apps/desktop/src");
  const files = Array.from({ length: 18 }, (_, index) => node(`file:${index}`, "file", `file-${String(index).padStart(2, "0")}.ts`));
  const importers = Array.from({ length: 12 }, (_, index) => node(`module:${index}`, "module", `importer-${index}`));
  return {
    ...snapshot,
    root: rootNode.id,
    nodes: [rootNode, ...files, ...importers],
    edges: [
      ...files.map((file) => edge(rootNode.id, file.id, "contains")),
      ...files.slice(0, 3).map((file) => edge(file.id, rootNode.id, "imports")),
      ...importers.map((importer) => edge(importer.id, rootNode.id, "imports")),
    ],
    truncated,
  };
}

async function render(props: Partial<Parameters<typeof Graph>[0]> & { projection: MetaprojectNeighbors }) {
  await act(async () => {
    root.render(createElement(Graph, { onSelect: () => {}, createCytoscape: headless, ...props }));
  });
}

function legendItems(): string[] {
  return [...host.querySelectorAll('[aria-label="Graph legend"] li')].map((item) => item.textContent?.trim() ?? "");
}

describe("RelationshipGraph overlay (AC4)", () => {
  test("the caption names the root and the incoming and outgoing counts", async () => {
    await render({ projection: moduleProjection() });
    const caption = host.querySelector(".metaproject-rgraph-caption")?.textContent ?? "";
    expect(caption).toContain("apps/desktop/src");
    expect(caption).toContain("15 incoming");
    expect(caption).toContain("18 outgoing");
    expect(caption).not.toContain("limited");
  });

  test("a truncated projection says limited", async () => {
    await render({ projection: moduleProjection(true) });
    expect(host.querySelector(".metaproject-rgraph-caption")?.textContent).toContain("limited");
  });

  test("the legend names exactly the node kinds and line styles present", async () => {
    await render({ projection: moduleProjection() });
    expect(legendItems()).toEqual(["Module", "File", "Solid line: Imports", "Dotted line: Contains"]);
  });

  test("the legend follows the projection: wiki pages, specs and dashed links", async () => {
    const projection: MetaprojectNeighbors = {
      ...snapshot,
      root: "page",
      nodes: [node("page", "wiki", "Guide"), node("spec", "spec", "auth"), node("change", "change", "add-login")],
      edges: [edge("page", "spec", "links"), edge("change", "spec", "changes-spec")],
      truncated: false,
    };
    await render({ projection });
    expect(legendItems()).toEqual(["Wiki page", "Spec", "Change", "Dashed line: Wiki links, Changes spec"]);
  });

  test("G1: the zoom controls sit in the caption row, right of the caption, not over the canvas", async () => {
    await render({ projection: moduleProjection() });
    const zoom = host.querySelector('[aria-label="Graph zoom"]');
    const header = host.querySelector(".metaproject-rgraph-header");
    expect(zoom?.parentElement).toBe(header);
    expect(header?.firstElementChild?.classList.contains("metaproject-rgraph-caption")).toBeTrue();
    expect(header?.lastElementChild).toBe(zoom);
    expect(zoom?.closest(".metaproject-rgraph-stage")).toBeNull();
  });

  test("G8: the component fills its host instead of clamping its own height", () => {
    const css = readFileSync(new URL("./graph.css", import.meta.url), "utf8");
    const block = /\.metaproject-rgraph\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).not.toContain("clamp(");
    expect(block).not.toContain("block-size: clamp");
    expect(block).toContain("flex: 1 1 auto;");
    expect(block).toContain("min-block-size: 200px;");
  });

  test("the canvas is hidden from assistive technology; caption and legend are text", async () => {
    await render({ projection: moduleProjection(), busy: true });
    expect(host.querySelector(".metaproject-rgraph-canvas")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".metaproject-rgraph-caption")?.closest('[aria-hidden="true"]')).toBeNull();
    expect(host.querySelector(".metaproject-rgraph")?.getAttribute("aria-busy")).toBe("true");
    const zoom = [...host.querySelectorAll('[aria-label="Graph zoom"] button')].map((button) => button.getAttribute("aria-label"));
    expect(zoom).toEqual(["Zoom in", "Zoom out", "Fit graph"]);
  });
});

describe("style mapping (AC4)", () => {
  test("each of the seven node kinds has a distinct shape-or-border treatment", () => {
    const kinds: MetaprojectNodeKind[] = ["module", "file", "symbol", "wiki", "spec", "change", "archive"];
    const treatments = new Set(kinds.map((kind) => {
      const style = layout.nodeKindStyle(kind);
      return `${style.shape}|${style.borderStyle}|${style.borderWidth}`;
    }));
    expect(treatments.size).toBe(7);
    for (const kind of kinds) expect(layout.nodeKindStyle(kind).label.length).toBeGreaterThan(0);
  });

  test("the nine relationship kinds map onto solid, dashed and dotted lines", () => {
    const expected: Record<MetaprojectEdgeKind, string> = {
      imports: "solid", calls: "solid", asset: "solid",
      describes: "dashed", links: "dashed", "changes-spec": "dashed", "spec-context": "dashed",
      contains: "dotted", defines: "dotted",
    };
    const kinds = Object.keys(expected) as MetaprojectEdgeKind[];
    expect(kinds.length).toBe(9);
    for (const kind of kinds) expect(layout.edgeKindStyle(kind).lineStyle).toBe(expected[kind]);
  });
});

describe("RelationshipGraph lifecycle", () => {
  test("draws the laid-out nodes, captions and overflow entry at preset positions", async () => {
    await render({ projection: moduleProjection() });
    const [cy] = instances;
    expect(cy).not.toBeUndefined();
    expect(cy!.nodes(".graph-node").length).toBe(1 + 12 + 12);
    expect(cy!.nodes(".caption").length).toBe(2);
    expect(cy!.nodes(".overflow").length).toBe(1);
    expect(cy!.$id("module:root").position()).toEqual({ x: 0, y: 0 });
    expect(0).toBeGreaterThan(cy!.$id("module:0").position().x);
  });

  test("tapping a node selects it; tapping '+N more' asks for the hidden side", async () => {
    const selected: string[] = [];
    const sides: string[] = [];
    await render({ projection: moduleProjection(), onSelect: (id) => selected.push(id), onShowHidden: (side) => sides.push(side) });
    const [cy] = instances;
    cy!.$id("file:1").emit("tap");
    cy!.nodes(".overflow").emit("tap");
    expect(selected).toEqual(["file:1"]);
    expect(sides).toEqual(["outgoing"]);
  });

  test("a new callback identity reuses the instance and the newest callback is called", async () => {
    const calls: string[] = [];
    await render({ projection: moduleProjection(), onSelect: () => calls.push("old") });
    const projection = moduleProjection();
    await render({ projection, onSelect: () => calls.push("new") });
    expect(instances.length).toBe(1);
    instances[0]!.$id("file:2").emit("tap");
    expect(calls).toEqual(["new"]);
  });

  test("a new projection replaces the elements in the same instance", async () => {
    await render({ projection: moduleProjection() });
    const next: MetaprojectNeighbors = { ...snapshot, root: "a", nodes: [node("a"), node("b")], edges: [edge("a", "b", "imports")], truncated: false };
    await render({ projection: next });
    expect(instances.length).toBe(1);
    expect(instances[0]!.nodes(".graph-node").map((item) => item.id()).sort()).toEqual(["a", "b"]);
    expect(instances[0]!.edges().length).toBe(1);
    expect(host.querySelector(".metaproject-rgraph-caption")?.textContent).toContain("0 incoming · 1 outgoing");
  });

  test("a zero-sized container is never fitted", async () => {
    await render({ projection: moduleProjection() });
    const before = instances[0]!.zoom();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Fit graph"]')?.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click(); });
    expect(instances[0]!.zoom()).toBe(before);
  });

  test("tokens resolve to opaque colours and a theme change re-colours labels in place", async () => {
    const tokens: Record<string, string> = { "--fg": "#1c2b23", "--bg-sunken": "#ffffff", "--bg-selected": "rgba(0, 0, 0, 0.5)", "--text-scale": "1.25" };
    const style = document.documentElement.style;
    for (const [key, value] of Object.entries(tokens)) style.setProperty(key, value);
    try {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
      try {
        await render({
          projection: moduleProjection(),
          createCytoscape: (options) => {
            const { container: _container, ...rest } = options;
            const instance = cytoscape({ ...rest, headless: true, styleEnabled: true });
            instances.push(instance);
            return instance;
          },
        });
      } finally {
        console.warn = original;
      }
      expect(warnings).toEqual([]);
      const cy = instances[0]!;
      expect(cy.$id("file:1").style("color")).toBe("rgb(28,43,35)");
      expect(cy.$id("module:root").style("background-color")).toBe("rgb(128,128,128)");
      expect(cy.$id("file:1").style("font-size")).toBe("15px");
      await act(async () => {
        style.setProperty("--fg", "#e1ece5");
        document.documentElement.setAttribute("data-theme", "dark");
        await Promise.resolve();
      });
      expect(instances.length).toBe(1);
      expect(cy.$id("file:1").style("color")).toBe("rgb(225,236,229)");
    } finally {
      await act(async () => {
        for (const key of Object.keys(tokens)) style.removeProperty(key);
        document.documentElement.removeAttribute("data-theme");
        await Promise.resolve();
      });
    }
  });

  test("unmounting destroys the instance", async () => {
    await render({ projection: moduleProjection() });
    await act(() => root.render(null));
    expect(instances[0]!.destroyed()).toBe(true);
  });
});
