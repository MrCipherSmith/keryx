import { describe, expect, test } from "bun:test";
import type {
  MetaprojectEdge,
  MetaprojectEdgeKind,
  MetaprojectNeighbors,
  MetaprojectNode,
  MetaprojectNodeKind,
} from "../../../../src/integrations/metaproject-explorer-contract";
import {
  COLUMN_CAP,
  computeViewport,
  edgeKindStyle,
  layoutNeighborhood,
  legendFor,
  nodeKindStyle,
  shortenMiddle,
  toOpaqueColor,
  type LayoutBox,
  type NeighborhoodLayout,
} from "./graphLayout";

const snapshot = { schemaVersion: 1 as const, snapshotId: "snap" };

function node(id: string, kind: MetaprojectNodeKind = "file", title = id): MetaprojectNode {
  return { id, kind, title, path: `src/${id}` };
}

function edge(from: string, to: string, kind: MetaprojectEdgeKind): MetaprojectEdge {
  return { from, to, kind };
}

function projection(
  root: string,
  nodes: MetaprojectNode[],
  edges: MetaprojectEdge[],
  truncated = false,
): MetaprojectNeighbors {
  return { ...snapshot, root, nodes, edges, truncated };
}

/** A module with 30 neighbours: 18 contained files (3 of them also import the module) and 12 importing modules. */
function depthOneModule(): MetaprojectNeighbors {
  const root = node("module:root", "module", "apps/desktop/src");
  const files = Array.from({ length: 18 }, (_, index) => node(`file:${index}`, "file", `component-${String(index).padStart(2, "0")}.tsx`));
  const importers = Array.from({ length: 12 }, (_, index) => node(`module:in-${index}`, "module", `module-${index}`));
  const edges = [
    ...files.map((file) => edge(root.id, file.id, "contains")),
    ...files.slice(0, 3).map((file) => edge(file.id, root.id, "imports")),
    ...importers.map((module) => edge(module.id, root.id, "imports")),
  ];
  return projection(root.id, [root, ...files, ...importers], edges);
}

/** Deterministic pseudo-random sequence so the large fixture is the same on every run. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** 200 nodes, 269 edges, depth 2, truncated: the size measured on this repository. */
function depthTwoProjection(): MetaprojectNeighbors {
  const random = sequence(7);
  const root = node("module:apps/desktop/src", "module", "apps/desktop/src");
  const kinds: MetaprojectNodeKind[] = ["file", "symbol", "wiki", "module", "spec", "change", "archive"];
  const outgoing = Array.from({ length: 25 }, (_, index) => node(`out-${index}`, "file", `outgoing-file-${index}.ts`));
  const incoming = Array.from({ length: 15 }, (_, index) => node(`in-${index}`, "module", `incoming-module-${index}`));
  const first = [...outgoing, ...incoming];
  const second = Array.from({ length: 159 }, (_, index) => node(`second-${index}`, kinds[index % kinds.length], `second-step-node-with-a-long-name-${index}.tsx`));
  const edges: MetaprojectEdge[] = [
    ...outgoing.map((target) => edge(root.id, target.id, "contains")),
    ...incoming.map((source) => edge(source.id, root.id, "imports")),
  ];
  const seen = new Set(edges.map((item) => `${item.from}>${item.to}`));
  const secondKinds: MetaprojectEdgeKind[] = ["imports", "contains", "describes", "defines", "links"];
  second.forEach((item, index) => {
    const anchor = first[Math.floor(random() * first.length)] ?? outgoing[0]!;
    const kind = secondKinds[index % secondKinds.length]!;
    const forward = random() < 0.5;
    const added = forward ? edge(anchor.id, item.id, kind) : edge(item.id, anchor.id, kind);
    edges.push(added);
    seen.add(`${added.from}>${added.to}`);
  });
  const nonRoot = [...first, ...second];
  while (edges.length < 269) {
    const from = nonRoot[Math.floor(random() * nonRoot.length)]!;
    const to = nonRoot[Math.floor(random() * nonRoot.length)]!;
    if (from.id === to.id || seen.has(`${from.id}>${to.id}`)) continue;
    seen.add(`${from.id}>${to.id}`);
    edges.push(edge(from.id, to.id, "imports"));
  }
  return projection(root.id, [root, ...first, ...second], edges, true);
}

function boxes(layout: NeighborhoodLayout): (LayoutBox & { id: string })[] {
  return [
    ...(layout.root ? [layout.root] : []),
    ...layout.nodes,
    ...layout.captions,
    ...layout.overflow,
  ];
}

function overlapping(layout: NeighborhoodLayout): string[] {
  const all = boxes(layout);
  const found: string[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      const apart =
        Math.abs(a.x - b.x) >= (a.width + b.width) / 2 ||
        Math.abs(a.y - b.y) >= (a.height + b.height) / 2;
      if (!apart) found.push(`${a.id} × ${b.id}`);
    }
  }
  return found;
}

function nodesPerColumn(layout: NeighborhoodLayout): Map<number, number> {
  const counts = new Map<number, number>();
  for (const item of layout.nodes) counts.set(item.column, (counts.get(item.column) ?? 0) + 1);
  return counts;
}

describe("layoutNeighborhood — depth 1 (AC1, AC2)", () => {
  const input = depthOneModule();
  const layout = layoutNeighborhood(input);

  test("incoming-only neighbours sit left of the root and outgoing ones right of it", () => {
    expect(layout.root?.id).toBe("module:root");
    const rootX = layout.root?.x ?? 0;
    const placed = new Map(layout.nodes.map((item) => [item.id, item]));
    for (let index = 0; index < 12; index++) {
      const item = placed.get(`module:in-${index}`);
      expect(item?.side).toBe("incoming");
      expect(rootX).toBeGreaterThan(item!.x);
    }
    const right = layout.nodes.filter((item) => item.id.startsWith("file:"));
    expect(right.length).toBe(COLUMN_CAP);
    for (const item of right) {
      expect(item.side).toBe("outgoing");
      expect(item.x).toBeGreaterThan(rootX);
    }
  });

  test("a neighbour with edges in both directions is placed with outgoing", () => {
    const both = layout.nodes.find((item) => item.id === "file:0");
    expect(both?.side).toBe("outgoing");
  });

  test("no two boxes overlap: nodes, group captions and overflow entries", () => {
    expect(layout.captions.length).toBeGreaterThan(0);
    expect(layout.overflow.length).toBe(1);
    expect(overlapping(layout)).toEqual([]);
  });

  test("an over-full column shows 12 nodes and one '+N more' entry with the hidden count", () => {
    const outgoingColumn = layout.nodes.filter((item) => item.column === 1);
    expect(outgoingColumn.length).toBe(12);
    const [overflow] = layout.overflow;
    expect(overflow?.side).toBe("outgoing");
    expect(overflow?.hidden).toBe(18 - 12);
    expect(overflow?.text).toBe("+6 more");
    expect(overflow!.y).toBeGreaterThan(Math.max(...outgoingColumn.map((item) => item.y)));
  });

  test("a column at exactly the cap has no overflow entry", () => {
    expect(layout.nodes.filter((item) => item.column === -1).length).toBe(12);
    expect(layout.overflow.some((item) => item.side === "incoming")).toBe(false);
  });

  test("groups follow the relationship-kind order with a caption per group, sorted by title", () => {
    const right = layout.captions.filter((item) => item.column === 1).map((item) => item.text);
    expect(right).toEqual(["Contains · 18"]);
    expect(layout.captions.filter((item) => item.column === -1).map((item) => item.text)).toEqual(["Imports · 12"]);
    const titles = layout.nodes.filter((item) => item.column === -1).sort((a, b) => a.y - b.y).map((item) => item.node.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  test("counts are the root-adjacent relationships per direction", () => {
    expect(layout.incoming).toBe(15);
    expect(layout.outgoing).toBe(18);
  });

  test("edges to hidden neighbours are not drawn; drawn edges name both ends", () => {
    const drawn = new Set([layout.root!.id, ...layout.nodes.map((item) => item.id)]);
    for (const item of layout.edges) {
      expect(drawn.has(item.from)).toBe(true);
      expect(drawn.has(item.to)).toBe(true);
    }
    expect(layout.edges.length).toBe(12 + 12 + 3);
  });

  test("a depth-1 layout fits a 440 px wide canvas at zoom 0.8 or more", () => {
    const viewport = computeViewport(layout, 440, 194);
    expect(layout.bounds.width * 0.8 <= 440 - 2 * viewport.padding).toBeTrue();
    expect(viewport.zoom >= 0.8).toBeTrue();
  });
});

describe("layoutNeighborhood — depth 2 (AC2, AC3)", () => {
  const input = depthTwoProjection();
  const layout = layoutNeighborhood(input);

  test("the fixture is the measured size", () => {
    expect(input.nodes.length).toBe(200);
    expect(input.edges.length).toBe(269);
  });

  test("no two boxes overlap and no column holds more than 12 nodes", () => {
    expect(overlapping(layout)).toEqual([]);
    for (const count of nodesPerColumn(layout).values()) expect(count <= COLUMN_CAP).toBeTrue();
  });

  test("every over-full column has exactly one overflow entry with the hidden count", () => {
    for (const overflow of layout.overflow) {
      const shown = layout.nodes.filter((item) => item.column === overflow.column).length;
      expect(shown).toBe(COLUMN_CAP);
      expect(overflow.hidden).toBe(overflow.total - COLUMN_CAP);
    }
    expect(new Set(layout.overflow.map((item) => item.column)).size).toBe(layout.overflow.length);
    const outgoing = layout.overflow.find((item) => item.column === 1);
    expect(outgoing?.hidden).toBe(25 - 12);
    expect(outgoing?.side).toBe("outgoing");
  });

  test("every second-step node is in the outer column on its first-step node's side, beyond every first-step node", () => {
    const first = new Map(layout.nodes.filter((item) => item.role === "first").map((item) => [item.id, item]));
    const second = layout.nodes.filter((item) => item.role === "second");
    expect(second.length).toBeGreaterThan(0);
    const firstIds = new Set(input.nodes.filter((item) => item.id.startsWith("out-") || item.id.startsWith("in-")).map((item) => item.id));
    for (const item of second) {
      expect(item.via).not.toBeUndefined();
      expect(firstIds.has(item.via!)).toBe(true);
      expect(input.edges.some((link) => (link.from === item.id && link.to === item.via) || (link.to === item.id && link.from === item.via))).toBe(true);
      const expectedSide = item.via!.startsWith("in-") ? "incoming" : "outgoing";
      expect(item.side).toBe(expectedSide);
      expect(item.column).toBe(expectedSide === "incoming" ? -2 : 2);
      const sameSide = [...first.values()].filter((other) => other.side === item.side);
      for (const other of sameSide) {
        expect(Math.abs(item.x) - item.width / 2).toBeGreaterThan(Math.abs(other.x) + other.width / 2);
      }
    }
  });

  test("second-step edges are marked so they can be drawn fainter", () => {
    const rootId = layout.root!.id;
    for (const item of layout.edges) expect(item.secondStep).toBe(item.from !== rootId && item.to !== rootId);
    expect(layout.edges.some((item) => item.secondStep)).toBe(true);
  });

  test("the projection's truncation is carried to the layout", () => {
    expect(layout.truncated).toBe(true);
  });
});

describe("layoutNeighborhood — small and degenerate inputs", () => {
  test("a second-step node attached to an incoming neighbour goes to the outer left column", () => {
    const input = projection(
      "root",
      [node("root"), node("a"), node("b"), node("c"), node("d")],
      [edge("a", "root", "imports"), edge("root", "b", "imports"), edge("c", "a", "imports"), edge("b", "d", "calls")],
    );
    const layout = layoutNeighborhood(input);
    const placed = new Map(layout.nodes.map((item) => [item.id, item]));
    expect(placed.get("c")).toMatchObject({ role: "second", side: "incoming", column: -2, via: "a" });
    expect(placed.get("d")).toMatchObject({ role: "second", side: "outgoing", column: 2, via: "b" });
    expect(placed.get("a")!.x).toBeGreaterThan(placed.get("c")!.x);
    expect(placed.get("d")!.x).toBeGreaterThan(placed.get("b")!.x);
    expect(overlapping(layout)).toEqual([]);
  });

  test("a projection without its root node lays out nothing", () => {
    const layout = layoutNeighborhood(projection("missing", [node("a")], []));
    expect(layout.root).toBeNull();
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
  });

  test("a lone root is centred at the origin", () => {
    const layout = layoutNeighborhood(projection("root", [node("root")], []));
    expect(layout.root).toMatchObject({ x: 0, y: 0, role: "root", column: 0 });
    expect(layout.incoming).toBe(0);
    expect(layout.outgoing).toBe(0);
  });

  test("a larger text scale widens nodes without overlaps", () => {
    const normal = layoutNeighborhood(depthOneModule());
    const large = layoutNeighborhood(depthOneModule(), { textScale: 1.3 });
    expect(large.root!.width).toBeGreaterThan(normal.root!.width);
    expect(overlapping(large)).toEqual([]);
  });

  test("a column cap below one is refused", () => {
    expect(() => layoutNeighborhood(depthOneModule(), { columnCap: 0 })).toThrow("columnCap must be a positive integer, got 0");
  });
});

describe("layoutNeighborhood — live-preview polish (G2, G3, G4, G6)", () => {
  function column(layout: NeighborhoodLayout, index: number) {
    return layout.nodes.filter((item) => item.column === index).sort((a, b) => a.y - b.y);
  }

  test("G2: a kind group is never hidden behind another: the containing module and the describing page stay drawn", () => {
    const rootNode = node("src/bus/leases.ts", "file", "leases.ts");
    const importers = Array.from({ length: 14 }, (_, index) => node(`importer-${index}`, "file", `importer-${String(index).padStart(2, "0")}.ts`));
    const module = node("module:src/bus", "module", "src/bus");
    const page = node("wiki:agent-bus", "wiki", "Agent Bus");
    const layout = layoutNeighborhood(projection(rootNode.id, [rootNode, ...importers, module, page], [
      ...importers.map((item) => edge(item.id, rootNode.id, "imports")),
      edge(module.id, rootNode.id, "contains"),
      edge(page.id, rootNode.id, "describes"),
    ]));
    const left = column(layout, -1);
    expect(left.length).toBe(12);
    expect(left.map((item) => item.id)).toContain(module.id);
    expect(left.map((item) => item.id)).toContain(page.id);
    expect(left.filter((item) => item.group === "imports").length).toBe(10);
    expect(layout.overflow).toHaveLength(1);
    expect(layout.overflow[0]?.hidden).toBe(16 - 12);
    expect(layout.captions.filter((item) => item.column === -1).map((item) => item.text)).toEqual(["Imports · 14", "Describes · 1", "Contains · 1"]);
    expect(overlapping(layout)).toEqual([]);
  });

  test("G2: every group gets two slots first, then the leftover slots go in kind order", () => {
    const rootNode = node("root", "module");
    const group = (kind: MetaprojectEdgeKind) => Array.from({ length: 10 }, (_, index) => node(`${kind}-${index}`));
    const imports = group("imports");
    const links = group("links");
    const contains = group("contains");
    const layout = layoutNeighborhood(projection(rootNode.id, [rootNode, ...imports, ...links, ...contains], [
      ...imports.map((item) => edge(rootNode.id, item.id, "imports")),
      ...links.map((item) => edge(rootNode.id, item.id, "links")),
      ...contains.map((item) => edge(rootNode.id, item.id, "contains")),
    ]));
    const right = column(layout, 1);
    const count = (kind: MetaprojectEdgeKind) => right.filter((item) => item.group === kind).length;
    expect(right.length).toBe(12);
    expect([count("imports"), count("links"), count("contains")]).toEqual([8, 2, 2]);
    expect(layout.overflow[0]?.hidden).toBe(30 - 12);
  });

  test("G3: inside a group, nodes are ordered by edge count descending, then title", () => {
    const rootNode = node("root", "module", "root");
    const modules = Array.from({ length: 15 }, (_, index) => node(`m-${index}`, "module", `module-${String.fromCharCode(97 + index)}`));
    const counts = [1, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 88];
    const layout = layoutNeighborhood(projection(rootNode.id, [rootNode, ...modules], modules.map((item, index) => ({ ...edge(rootNode.id, item.id, "imports"), count: counts[index] }))));
    const titles = column(layout, 1).map((item) => item.node.title);
    expect(titles.slice(0, 4)).toEqual(["module-o", "module-c", "module-a", "module-b"]);
    expect(titles).toHaveLength(12);
    expect(titles).not.toContain("module-n");
  });

  test("G4: drawn nodes that share a title get the shortest path suffix that tells them apart", () => {
    const rootNode = node("root", "module", "root");
    const a = { ...node("module:src/commands", "module", "commands"), path: "src/commands" };
    const b = { ...node("module:packages/hub/commands", "module", "commands"), path: "packages/hub/commands" };
    const c = { ...node("module:src/agents", "module", "agents"), path: "src/agents" };
    const layout = layoutNeighborhood(projection(rootNode.id, [rootNode, a, b, c], [edge(rootNode.id, a.id, "imports"), edge(b.id, rootNode.id, "imports"), edge(rootNode.id, c.id, "imports")]));
    const labels = new Map(layout.nodes.map((item) => [item.id, item.label]));
    expect(labels.get(a.id)).toBe("src/commands");
    expect(labels.get(b.id)).toBe("hub/commands");
    expect(labels.get(c.id)).toBe("agents");
  });

  test("G4: shared titles whose paths do not end in the title keep the title in front", () => {
    const rootNode = node("root", "file", "root");
    const first = { ...node("symbol:a#run", "symbol", "run"), path: "src/a.ts" };
    const second = { ...node("symbol:b#run", "symbol", "run"), path: "src/b.ts" };
    const layout = layoutNeighborhood(projection(rootNode.id, [rootNode, first, second], [edge(rootNode.id, first.id, "defines"), edge(rootNode.id, second.id, "defines")]));
    expect(layout.nodes.map((item) => item.label).sort()).toEqual(["run · a.ts", "run · b.ts"]);
  });

  test("G6: incoming columns are flush right and outgoing columns flush left, captions and overflow included", () => {
    const layout = layoutNeighborhood(depthOneModule());
    const right = (box: LayoutBox) => box.x + box.width / 2;
    const left = (box: LayoutBox) => box.x - box.width / 2;
    const incoming = [...layout.nodes.filter((item) => item.column === -1), ...layout.captions.filter((item) => item.column === -1)];
    const outgoing = [...layout.nodes.filter((item) => item.column === 1), ...layout.captions.filter((item) => item.column === 1), ...layout.overflow.filter((item) => item.column === 1)];
    expect(new Set(incoming.map((box) => left(box).toFixed(3))).size).toBeGreaterThan(1);
    expect(new Set(incoming.map((box) => right(box).toFixed(3))).size).toBe(1);
    expect(new Set(outgoing.map((box) => left(box).toFixed(3))).size).toBe(1);
    const second = layoutNeighborhood(depthTwoProjection());
    for (const index of [-2, 2]) {
      const boxes = [...second.nodes, ...second.captions, ...second.overflow].filter((item) => item.column === index);
      expect(new Set(boxes.map((box) => (index < 0 ? right(box) : left(box)).toFixed(3))).size).toBe(1);
    }
  });
});

describe("shortenMiddle", () => {
  test("G5: cuts at a dot boundary and keeps the longest dotted tail that fits in half the budget", () => {
    expect(shortenMiddle("imagePreview.dom.test.ts", 17)).toBe("imagePre….test.ts");
  });

  test("G5: a dotted tail longer than half the budget falls back to the plain middle cut", () => {
    const short = shortenMiddle("a.verylongextension", 8);
    expect(short).toHaveLength(8);
    expect(short).toContain("…");
  });

  test("keeps a short label unchanged", () => {
    expect(shortenMiddle("index.ts", 20)).toBe("index.ts");
  });

  test("shortens in the middle and keeps the file extension", () => {
    const short = shortenMiddle("useExplorerNavigation.test.tsx", 16);
    expect(short.length).toBe(16);
    expect(short).toContain("…");
    expect(short.endsWith(".tsx")).toBe(true);
    expect(short.startsWith("useEx")).toBe(true);
  });

  test("a one-character budget is the ellipsis", () => {
    expect(shortenMiddle("abcdef", 1)).toBe("…");
  });

  test("a budget below one is refused", () => {
    expect(() => shortenMiddle("abc", 0)).toThrow("maxChars must be a positive integer, got 0");
  });
});

describe("computeViewport", () => {
  test("zoom is clamped to 1.15 for a tiny layout", () => {
    const layout = layoutNeighborhood(projection("root", [node("root")], []));
    expect(computeViewport(layout, 800, 600).zoom).toBe(1.15);
  });

  test("zoom never drops below 0.8 and centres the root when the layout does not fit", () => {
    const layout = layoutNeighborhood(depthTwoProjection());
    const viewport = computeViewport(layout, 440, 194);
    expect(viewport.zoom).toBe(0.8);
    expect(Math.abs(viewport.pan.x - 220) < 1e-6).toBeTrue();
    expect(Math.abs(viewport.pan.y - 97) < 1e-6).toBeTrue();
  });

  test("a zero-sized box gives no viewport", () => {
    const layout = layoutNeighborhood(depthOneModule());
    expect(computeViewport(layout, 0, 0).usable).toBe(false);
  });
});

describe("human-readable labels (G7)", () => {
  test("captions and legend use the shared labels", () => {
    const input = projection("root", [node("root", "module"), node("a"), node("b", "wiki")], [edge("root", "a", "asset"), edge("root", "b", "links"), edge("a", "root", "imports")]);
    const captions = layoutNeighborhood(input).captions.map((item) => item.text).sort();
    expect(captions).toEqual(["Assets · 1", "Wiki links · 1"]);
    expect(legendFor(input).lines.map((line) => `${line.label}: ${line.kinds.join(", ")}`)).toEqual(["Solid line: Imports, Assets", "Dashed line: Wiki links"]);
  });
});

describe("style mapping", () => {
  const kinds: MetaprojectNodeKind[] = ["module", "file", "symbol", "wiki", "spec", "change", "archive"];

  test("each of the seven node kinds has a distinct shape-or-border treatment", () => {
    const treatments = kinds.map((kind) => {
      const style = nodeKindStyle(kind);
      return `${style.shape}|${style.borderStyle}|${style.borderWidth}`;
    });
    expect(new Set(treatments).size).toBe(7);
  });

  test("the nine relationship kinds map onto solid, dashed and dotted lines", () => {
    const styles = {
      imports: "solid", calls: "solid", asset: "solid",
      describes: "dashed", links: "dashed", "changes-spec": "dashed", "spec-context": "dashed",
      contains: "dotted", defines: "dotted",
    } as const;
    for (const [kind, line] of Object.entries(styles)) {
      expect(edgeKindStyle(kind as MetaprojectEdgeKind).lineStyle).toBe(line);
    }
  });
});

describe("toOpaqueColor", () => {
  test("an opaque colour is returned as rgb", () => {
    expect(toOpaqueColor("#265f50", "#ffffff")).toBe("rgb(38, 95, 80)");
  });

  test("a translucent colour is blended over the background", () => {
    expect(toOpaqueColor("rgba(0, 0, 0, 0.5)", "#ffffff")).toBe("rgb(128, 128, 128)");
    expect(toOpaqueColor("#00000080", "rgb(255 255 255)")).toBe("rgb(127, 127, 127)");
  });

  test("an unparsable colour is passed through unchanged", () => {
    expect(toOpaqueColor("color(display-p3 1 0 0)", "#ffffff")).toBe("color(display-p3 1 0 0)");
  });

  test("three-digit hex colours are expanded", () => {
    expect(toOpaqueColor("#fff", "#000000")).toBe("rgb(255, 255, 255)");
    expect(toOpaqueColor("#0008", "#ffffff")).toBe("rgb(119, 119, 119)");
  });

  test("percentage channels and alpha are read as fractions of their range", () => {
    expect(toOpaqueColor("rgb(100% 0% 50%)", "#ffffff")).toBe("rgb(255, 0, 128)");
    expect(toOpaqueColor("rgba(0, 0, 0, 50%)", "#ffffff")).toBe("rgb(128, 128, 128)");
  });

  test("an alpha outside 0..1 is clamped instead of over- or under-shooting the channels", () => {
    expect(toOpaqueColor("rgba(0, 0, 0, 1.5)", "#ffffff")).toBe("rgb(0, 0, 0)");
    expect(toOpaqueColor("rgba(0, 0, 0, 150%)", "#ffffff")).toBe("rgb(0, 0, 0)");
  });
});

describe("layoutNeighborhood — review round 1 fixtures (F-021)", () => {
  test("a root self-loop is neither a neighbour, a drawn edge nor a counted relationship", () => {
    const input = projection("root", [node("root"), node("a")], [edge("root", "root", "imports"), edge("root", "a", "imports")]);
    const layout = layoutNeighborhood(input);
    expect(layout.nodes.map((item) => item.id)).toEqual(["a"]);
    expect(layout.edges.map((item) => `${item.from}>${item.to}`)).toEqual(["root>a"]);
    expect([layout.incoming, layout.outgoing]).toEqual([0, 1]);
  });

  test("AC3: a second-step node is attached to a drawn first-step neighbour before a hidden one", () => {
    const outgoing = Array.from({ length: 13 }, (_, index) => node(`out-${String(index).padStart(2, "0")}`));
    const input = projection(
      "root",
      [node("root"), ...outgoing, node("in-b"), node("x"), node("z")],
      [
        ...outgoing.map((item) => edge("root", item.id, "contains")),
        edge("in-b", "root", "imports"),
        edge("out-12", "x", "imports"),
        edge("x", "in-b", "imports"),
        edge("x", "z", "imports"),
      ],
    );
    const layout = layoutNeighborhood(input);
    const placed = new Map(layout.nodes.map((item) => [item.id, item]));
    expect(placed.has("out-12")).toBe(false);
    expect(placed.get("x")).toMatchObject({ role: "second", via: "in-b", side: "incoming", column: -2 });
    expect(placed.get("z")).toMatchObject({ role: "second", via: "x", side: "incoming", column: -2 });
  });

  test("edge width grows with the import count and is capped", () => {
    const input = projection("root", [node("root"), node("a"), node("b"), node("c")], [
      { ...edge("root", "a", "imports"), count: 16 },
      { ...edge("root", "b", "imports"), count: 1 },
      { ...edge("root", "c", "imports"), count: 1 << 20 },
    ]);
    const widths = new Map(layoutNeighborhood(input).edges.map((item) => [item.to, item.width]));
    expect([widths.get("a"), widths.get("b"), widths.get("c")]).toEqual([3, 1, 3]);
  });

  test("the group order uses a neighbour's largest count, not its last edge's", () => {
    const input = projection("root", [node("root"), node("m", "module", "zeta"), node("n", "module", "alpha")], [
      { ...edge("root", "m", "imports"), count: 50 },
      edge("root", "m", "contains"),
      { ...edge("root", "n", "imports"), count: 10 },
    ]);
    const right = layoutNeighborhood(input).nodes.filter((item) => item.column === 1).sort((a, b) => a.y - b.y);
    expect(right.map((item) => item.id)).toEqual(["m", "n"]);
  });

  test("a layout that fits is centred in the box, not on the root", () => {
    const layout = layoutNeighborhood(projection("root", [node("root"), node("a", "file", "a-much-longer-neighbour.ts")], [edge("root", "a", "imports")]));
    const viewport = computeViewport(layout, 800, 600);
    const renderedLeft = viewport.pan.x + viewport.zoom * layout.bounds.x1;
    const renderedRight = viewport.pan.x + viewport.zoom * layout.bounds.x2;
    expect(Math.abs((renderedLeft + renderedRight) / 2 - 400) < 1e-6).toBeTrue();
    expect(Math.abs(viewport.pan.x - 400) > 1).toBeTrue();
  });

  test("a non-integer column cap is refused", () => {
    expect(() => layoutNeighborhood(depthOneModule(), { columnCap: 2.5 })).toThrow("columnCap must be a positive integer, got 2.5");
  });

  test("a text scale of zero or below falls back to 1", () => {
    const normal = layoutNeighborhood(depthOneModule());
    expect(layoutNeighborhood(depthOneModule(), { textScale: 0 })).toEqual(normal);
    expect(layoutNeighborhood(depthOneModule(), { textScale: -2 })).toEqual(normal);
  });
});
