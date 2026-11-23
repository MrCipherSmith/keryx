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
  test("host actions render in the header row, left of the zoom controls", async () => {
    await render({ projection: moduleProjection(), actions: createElement("button", { type: "button" }, "Filters") });
    const header = host.querySelector(".metaproject-rgraph-header");
    const action = [...header?.querySelectorAll("button") ?? []].find((item) => item.textContent === "Filters");
    const zoom = header?.querySelector('[aria-label="Graph zoom"]');
    if (!action || !zoom) throw new Error("Missing action or zoom controls in the header");
    expect(action.compareDocumentPosition(zoom) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await render({ projection: moduleProjection() });
    expect(host.querySelector(".metaproject-rgraph-actions")).toBeNull();
  });

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

/** Gives the canvas container a layout size, as a browser would; happy-dom reports 0. */
function sizeViewport(width: number, height: number): void {
  const viewport = host.querySelector<HTMLElement>(".metaproject-rgraph-viewport");
  if (!viewport) throw new Error("Missing graph viewport");
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: height });
}

async function click(label: string, times = 1): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button ${label}`);
  for (let index = 0; index < times; index++) await act(async () => { button.click(); });
}

/** A headless instance whose zoom requests are recorded, so the levels the component asks for can be checked. */
function recordingZoom(levels: number[]): (options: cytoscapeModule.CytoscapeOptions) => cytoscapeModule.Core {
  return (options) => {
    const instance = headless(options);
    const zoom = instance.zoom.bind(instance) as (arg?: unknown) => unknown;
    const spy = (arg?: unknown) => {
      if (typeof arg === "object" && arg !== null && "level" in arg) levels.push(Number((arg as { level: unknown }).level));
      return arg === undefined ? zoom() : zoom(arg);
    };
    instance.zoom = spy as unknown as typeof instance.zoom;
    return instance;
  };
}

function styledInstance(options: cytoscapeModule.CytoscapeOptions): cytoscapeModule.Core {
  const { container: _container, ...rest } = options;
  const instance = cytoscape({ ...rest, headless: true, styleEnabled: true });
  instances.push(instance);
  return instance;
}

describe("RelationshipGraph viewport (F-012)", () => {
  test("Fit on a sized container applies the computed zoom and pan", async () => {
    const projection = moduleProjection();
    await render({ projection });
    sizeViewport(440, 194);
    await click("Fit graph");
    const expected = layout.computeViewport(layout.layoutNeighborhood(projection), 440, 194);
    expect(expected.usable).toBeTrue();
    const cy = instances[0]!;
    expect(cy.zoom()).toBe(expected.zoom);
    expect(cy.pan()).toEqual(expected.pan);
  });

  test("Fit on a zero-sized container leaves the user's viewport alone", async () => {
    await render({ projection: moduleProjection() });
    const cy = instances[0]!;
    cy.viewport({ zoom: 2, pan: { x: 5, y: 7 } });
    await click("Fit graph");
    expect(cy.zoom()).toBe(2);
    expect(cy.pan()).toEqual({ x: 5, y: 7 });
  });

  test("Zoom in and Zoom out never ask for a level outside 0.3..2.5", async () => {
    const levels: number[] = [];
    await render({ projection: moduleProjection(), createCytoscape: recordingZoom(levels) });
    sizeViewport(440, 194);
    await click("Zoom in", 12);
    expect(levels.length).toBe(12);
    expect(Math.max(...levels)).toBe(2.5);
    expect(levels[levels.length - 1]).toBe(2.5);
    levels.length = 0;
    await click("Zoom out", 20);
    expect(Math.min(...levels)).toBe(0.3);
    expect(levels[levels.length - 1]).toBe(0.3);
  });
});

describe("RelationshipGraph interaction and styling (F-013)", () => {
  test("a '+N more' entry without a valid side asks for nothing", async () => {
    const sides: string[] = [];
    await render({ projection: moduleProjection(), onShowHidden: (side) => sides.push(side) });
    const overflow = instances[0]!.nodes(".overflow");
    overflow.data("side", "sideways");
    overflow.emit("tap");
    expect(sides).toEqual([]);
  });

  test("hovering a node fades everything outside its neighbourhood except captions, and shows a pointer", async () => {
    await render({ projection: moduleProjection() });
    const cy = instances[0]!;
    const viewport = host.querySelector<HTMLElement>(".metaproject-rgraph-viewport")!;
    cy.$id("file:1").emit("mouseover");
    expect(viewport.style.cursor).toBe("pointer");
    expect(cy.$id("file:1").hasClass("highlight")).toBeTrue();
    expect(cy.$id("module:root").hasClass("faded")).toBeFalse();
    expect(cy.$id("file:2").hasClass("faded")).toBeTrue();
    expect(cy.$id("module:0").hasClass("faded")).toBeTrue();
    expect(cy.nodes(".caption").filter((item) => item.hasClass("faded")).length).toBe(0);
    cy.$id("file:1").emit("mouseout");
    expect(viewport.style.cursor).toBe("");
    expect(cy.elements(".faded, .highlight").length).toBe(0);
  });

  test("hovering a '+N more' entry shows a pointer but fades nothing", async () => {
    await render({ projection: moduleProjection() });
    const cy = instances[0]!;
    cy.nodes(".overflow").emit("mouseover");
    expect(host.querySelector<HTMLElement>(".metaproject-rgraph-viewport")!.style.cursor).toBe("pointer");
    expect(cy.elements(".faded, .highlight").length).toBe(0);
  });

  test("the root gets at least a 2 px border whatever its kind; other nodes keep their kind's width", async () => {
    const projection: MetaprojectNeighbors = { ...snapshot, root: "a", nodes: [node("a"), node("b")], edges: [edge("a", "b", "imports")], truncated: false };
    await render({ projection });
    const cy = instances[0]!;
    expect(cy.$id("a").data("borderWidth")).toBe(2);
    expect(cy.$id("b").data("borderWidth")).toBe(1);
  });

  test("edges between two non-root nodes carry the second-step class", async () => {
    const projection: MetaprojectNeighbors = { ...snapshot, root: "a", nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b", "imports"), edge("b", "c", "imports")], truncated: false };
    await render({ projection });
    const cy = instances[0]!;
    const classed = cy.edges().map((item) => `${item.data("source")}>${item.data("target")}:${item.hasClass("second-step")}`).sort();
    expect(classed).toEqual(["a>b:false", "b>c:true"]);
  });
});

describe("RelationshipGraph theme changes (F-013, AC6)", () => {
  function themeSheet(css: string): HTMLStyleElement {
    const sheet = document.createElement("style");
    sheet.textContent = css;
    document.head.append(sheet);
    return sheet;
  }

  test("changing data-palette alone re-colours labels in place", async () => {
    const sheet = themeSheet(':root { --fg: #1c2b23; } :root[data-palette="ocean"] { --fg: #e1ece5; }');
    try {
      await render({ projection: moduleProjection(), createCytoscape: styledInstance });
      const cy = instances[0]!;
      expect(cy.$id("file:1").style("color")).toBe("rgb(28,43,35)");
      await act(async () => {
        document.documentElement.setAttribute("data-palette", "ocean");
        await Promise.resolve();
      });
      expect(instances.length).toBe(1);
      expect(cy.$id("file:1").style("color")).toBe("rgb(225,236,229)");
    } finally {
      await act(async () => {
        document.documentElement.removeAttribute("data-palette");
        sheet.remove();
        await Promise.resolve();
      });
    }
  });

  test("a system colour-scheme change re-colours labels and the listener is removed on unmount", async () => {
    const sheet = themeSheet(":root { --fg: #1c2b23; }");
    const listeners = new Set<() => void>();
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      await render({ projection: moduleProjection(), createCytoscape: styledInstance });
      const cy = instances[0]!;
      expect(cy.$id("file:1").style("color")).toBe("rgb(28,43,35)");
      expect(listeners.size).toBe(1);
      sheet.textContent = ":root { --fg: #e1ece5; }";
      await act(async () => { for (const listener of listeners) listener(); });
      expect(cy.$id("file:1").style("color")).toBe("rgb(225,236,229)");
      await act(() => root.render(null));
      expect(listeners.size).toBe(0);
    } finally {
      window.matchMedia = original;
      sheet.remove();
    }
  });
});
