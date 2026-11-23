/**
 * Pure, DOM-free layout of a Metaproject neighbourhood in direction columns:
 * second-step incoming · incoming · root · outgoing · second-step outgoing.
 * The result is handed to cytoscape as `preset` positions (box centres).
 */
import {
  METAPROJECT_EDGE_KINDS_V2,
  type MetaprojectEdge,
  type MetaprojectEdgeKind,
  type MetaprojectNeighbors,
  type MetaprojectNode,
  type MetaprojectNodeKind,
} from "../../../../src/integrations/metaproject-explorer-contract";
import { NODE_KIND_LABELS, RELATIONSHIP_KIND_LABELS } from "./labels";

export const COLUMN_CAP = 12;
/** Each relationship-kind group of an over-full column keeps at least this many slots while slots remain. */
export const GROUP_MIN_SLOTS = 2;

/** Model-space sizes in px at zoom 1 and `--text-scale` 1. */
export const GRAPH_GEOMETRY = {
  nodeHeight: 24,
  rowGap: 6,
  captionHeight: 16,
  captionGap: 4,
  groupGap: 10,
  overflowHeight: 20,
  columnGap: 40,
  nodeMinWidth: 44,
  nodeMaxWidth: 128,
  rootMaxWidth: 168,
  labelPadding: 8,
  labelCharWidth: 6.4,
  captionPadding: 4,
  captionCharWidth: 6.2,
  labelFontSize: 12,
  captionFontSize: 11,
} as const;

export const AUTO_ZOOM = { min: 0.8, max: 1.15 } as const;
export const VIEWPORT_PADDING = 16;

export type GraphSide = "incoming" | "outgoing";
/** -2 second-step incoming, -1 incoming, 0 root, 1 outgoing, 2 second-step outgoing. */
export type GraphColumn = -2 | -1 | 0 | 1 | 2;

/** A box by its centre, as cytoscape positions nodes. */
export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutNode extends LayoutBox {
  id: string;
  node: MetaprojectNode;
  label: string;
  role: "root" | "first" | "second";
  side: GraphSide | null;
  column: GraphColumn;
  /** The relationship kind the node is grouped under; absent for the root. */
  group?: MetaprojectEdgeKind;
  /** For a second-step node: the neighbour it is attached to. */
  via?: string;
}

export interface LaidOutCaption extends LayoutBox {
  id: string;
  text: string;
  kind: MetaprojectEdgeKind;
  side: GraphSide;
  column: GraphColumn;
}

export interface LaidOutOverflow extends LayoutBox {
  id: string;
  text: string;
  side: GraphSide;
  column: GraphColumn;
  /** Nodes of the column that are not drawn. */
  hidden: number;
  /** Nodes assigned to the column, drawn or not. */
  total: number;
}

export interface LaidOutEdge {
  id: string;
  from: string;
  to: string;
  kind: MetaprojectEdgeKind;
  /** Line width in px; module imports with a `count` are thicker. */
  width: number;
  /** Neither end is the root: drawn fainter. */
  secondStep: boolean;
}

export interface LayoutBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
}

export interface NeighborhoodLayout {
  root: LaidOutNode | null;
  nodes: LaidOutNode[];
  captions: LaidOutCaption[];
  overflow: LaidOutOverflow[];
  edges: LaidOutEdge[];
  /** Root-adjacent relationships pointing at the root. */
  incoming: number;
  /** Root-adjacent relationships the root points at. */
  outgoing: number;
  truncated: boolean;
  bounds: LayoutBounds;
}

export interface LayoutOptions {
  columnCap?: number;
  textScale?: number;
}

interface Entry {
  node: MetaprojectNode;
  side: GraphSide;
  group: MetaprojectEdgeKind;
  /** The largest edge `count` linking the node into its column; 0 when the edges carry none. */
  weight: number;
  via?: string;
}

interface ColumnSelection {
  /** Drawn entries, in group order and, inside a group, by weight then title. */
  shown: Entry[];
  totals: Map<MetaprojectEdgeKind, number>;
  total: number;
  side: GraphSide | null;
}

interface StackedColumn {
  nodes: LaidOutNode[];
  captions: LaidOutCaption[];
  overflow: LaidOutOverflow | null;
  width: number;
}

interface ColumnSpan {
  left: number;
  right: number;
}

const KIND_ORDER = new Map<MetaprojectEdgeKind, number>(METAPROJECT_EDGE_KINDS_V2.map((kind, index) => [kind, index]));

function kindRank(kind: MetaprojectEdgeKind): number {
  return KIND_ORDER.get(kind) ?? METAPROJECT_EDGE_KINDS_V2.length;
}

function firstKind(kinds: Iterable<MetaprojectEdgeKind>): MetaprojectEdgeKind | undefined {
  let best: MetaprojectEdgeKind | undefined;
  for (const kind of kinds) if (best === undefined || kindRank(kind) < kindRank(best)) best = kind;
  return best;
}

/** The dotted tails of the last path segment, longest first: "a.dom.test.ts" → [".dom.test.ts", ".test.ts", ".ts"]. */
function dottedTails(text: string): string[] {
  const base = text.slice(text.lastIndexOf("/") + 1);
  const tails: string[] = [];
  for (let index = base.indexOf(".", 1); index > 0; index = base.indexOf(".", index + 1)) tails.push(base.slice(index));
  return tails;
}

/**
 * Shortens `text` to `maxChars` characters with an ellipsis in the middle. When the name has dots,
 * the cut keeps the longest dotted tail that fits in half the budget, so ".test.ts" survives.
 */
export function shortenMiddle(text: string, maxChars: number): string {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError(`maxChars must be a positive integer, got ${maxChars}`);
  }
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  const available = maxChars - 1;
  const dotted = dottedTails(text).find((tail) => {
    const length = Array.from(tail).length;
    return length <= Math.floor(maxChars / 2) && length <= available - 1;
  });
  const tail = dotted !== undefined ? Array.from(dotted).length : Math.max(0, Math.min(available - 1, Math.floor(available * 0.4)));
  const head = available - tail;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

function nodeBox(title: string, maxWidth: number, textScale: number): { label: string; width: number } {
  const g = GRAPH_GEOMETRY;
  const charWidth = g.labelCharWidth * textScale;
  const maxChars = Math.max(1, Math.floor((maxWidth - 2 * g.labelPadding) / charWidth));
  const label = shortenMiddle(title, maxChars);
  const width = Math.min(maxWidth, Math.max(g.nodeMinWidth, Array.from(label).length * charWidth + 2 * g.labelPadding));
  return { label, width };
}

function textWidth(text: string, textScale: number): number {
  const g = GRAPH_GEOMETRY;
  return Array.from(text).length * g.captionCharWidth * textScale + 2 * g.captionPadding;
}

/** Splits root-adjacent neighbours into sides; a neighbour with edges both ways goes with outgoing. */
function firstStep(rootId: string, edges: readonly MetaprojectEdge[]): Map<string, Omit<Entry, "node">> {
  type Seen = { kinds: Set<MetaprojectEdgeKind>; weight: number };
  const incoming = new Map<string, Seen>();
  const outgoing = new Map<string, Seen>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const [bucket, other] = edge.from === rootId ? [outgoing, edge.to] : edge.to === rootId ? [incoming, edge.from] : [null, ""];
    if (!bucket) continue;
    const seen = bucket.get(other) ?? { kinds: new Set<MetaprojectEdgeKind>(), weight: 0 };
    seen.kinds.add(edge.kind);
    seen.weight = Math.max(seen.weight, edge.count ?? 0);
    bucket.set(other, seen);
  }
  const result = new Map<string, Omit<Entry, "node">>();
  for (const [id, seen] of outgoing) result.set(id, { side: "outgoing", group: firstKind(seen.kinds) ?? "imports", weight: seen.weight });
  for (const [id, seen] of incoming) {
    if (!result.has(id)) result.set(id, { side: "incoming", group: firstKind(seen.kinds) ?? "imports", weight: seen.weight });
  }
  return result;
}

/**
 * Attaches every other node to a first-step neighbour (a drawn one first, in edge order),
 * then, for a truncated projection, to an already attached second-step node.
 */
function secondStep(
  rootId: string,
  edges: readonly MetaprojectEdge[],
  nodes: ReadonlyMap<string, MetaprojectNode>,
  first: ReadonlyMap<string, { side: GraphSide }>,
  drawnFirst: ReadonlySet<string>,
): Entry[] {
  const attached = new Map<string, Entry>();
  const candidates = (preferDrawn: boolean, anchors: ReadonlyMap<string, { side: GraphSide }>) => {
    let progress = false;
    for (const edge of edges) {
      for (const [self, other] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
        if (self === rootId || first.has(self) || attached.has(self) || self === other) continue;
        const anchor = anchors.get(other);
        const node = nodes.get(self);
        if (!anchor || !node || (preferDrawn && !drawnFirst.has(other))) continue;
        attached.set(self, { node, side: anchor.side, group: edge.kind, weight: edge.count ?? 0, via: other });
        progress = true;
      }
    }
    return progress;
  };
  candidates(true, first);
  candidates(false, first);
  while (candidates(false, attached));
  return [...attached.values()];
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort(
    (a, b) =>
      kindRank(a.group) - kindRank(b.group) ||
      b.weight - a.weight ||
      a.node.title.localeCompare(b.node.title) ||
      a.node.id.localeCompare(b.node.id),
  );
}

/**
 * Chooses the drawn entries of one column. Every group gets up to GROUP_MIN_SLOTS slots in kind
 * order while slots remain; the slots left over are filled in kind order.
 */
function selectColumn(entries: Entry[], cap: number): ColumnSelection {
  const groups = new Map<MetaprojectEdgeKind, Entry[]>();
  for (const entry of sortEntries(entries)) {
    const group = groups.get(entry.group) ?? [];
    group.push(entry);
    groups.set(entry.group, group);
  }
  const slots = new Map<MetaprojectEdgeKind, number>();
  let left = cap;
  for (const [kind, group] of groups) {
    const take = Math.min(GROUP_MIN_SLOTS, group.length, left);
    slots.set(kind, take);
    left -= take;
  }
  for (const [kind, group] of groups) {
    const taken = slots.get(kind) ?? 0;
    const extra = Math.min(group.length - taken, left);
    slots.set(kind, taken + extra);
    left -= extra;
  }
  const totals = new Map([...groups].map(([kind, group]) => [kind, group.length]));
  return {
    shown: [...groups].flatMap(([kind, group]) => group.slice(0, slots.get(kind) ?? 0)),
    totals,
    total: entries.length,
    side: entries[0]?.side ?? null,
  };
}

/**
 * Labels drawn nodes by title; nodes that share a title get the shortest path suffix that tells
 * them apart ("src/commands", "hub/commands"), prefixed by the title when the path does not end in it.
 */
function distinctTitles(nodes: readonly MetaprojectNode[]): Map<string, string> {
  const byTitle = new Map<string, MetaprojectNode[]>();
  for (const node of nodes) byTitle.set(node.title, [...(byTitle.get(node.title) ?? []), node]);
  const titles = new Map<string, string>();
  for (const [title, group] of byTitle) {
    if (group.length < 2) {
      for (const node of group) titles.set(node.id, title);
      continue;
    }
    const segments = group.map((node) => node.path.split("/").filter(Boolean));
    const longest = Math.max(1, ...segments.map((parts) => parts.length));
    let depth = 1;
    while (depth < longest && new Set(segments.map((parts) => parts.slice(-depth).join("/"))).size < group.length) depth++;
    group.forEach((node, index) => {
      const parts = segments[index] ?? [];
      const suffix = parts.slice(-depth).join("/") || node.id;
      const base = parts[parts.length - 1] ?? "";
      const endsInTitle = base === title || base.startsWith(`${title}.`);
      titles.set(node.id, endsInTitle ? suffix : `${title} · ${suffix}`);
    });
  }
  return titles;
}

/** Stacks one column top to bottom (captions, nodes, overflow), centred on y = 0, x still 0. */
function stackColumn(
  selection: ColumnSelection,
  column: GraphColumn,
  role: "first" | "second",
  textScale: number,
  titles: ReadonlyMap<string, string>,
): StackedColumn {
  const g = GRAPH_GEOMETRY;
  const nodes: LaidOutNode[] = [];
  const captions: LaidOutCaption[] = [];
  let cursor = 0;
  let group: MetaprojectEdgeKind | undefined;
  for (const entry of selection.shown) {
    if (entry.group !== group) {
      if (group !== undefined) cursor += g.groupGap;
      group = entry.group;
      const text = `${edgeKindLabel(group)} · ${selection.totals.get(group) ?? 0}`;
      captions.push({
        id: `caption:${column}:${group}`,
        text,
        kind: group,
        side: entry.side,
        column,
        x: 0,
        y: cursor + g.captionHeight / 2,
        width: textWidth(text, textScale),
        height: g.captionHeight,
      });
      cursor += g.captionHeight + g.captionGap;
    } else {
      cursor += g.rowGap;
    }
    const box = nodeBox(titles.get(entry.node.id) ?? entry.node.title, g.nodeMaxWidth, textScale);
    nodes.push({
      id: entry.node.id,
      node: entry.node,
      label: box.label,
      role,
      side: entry.side,
      column,
      group: entry.group,
      ...(entry.via !== undefined && { via: entry.via }),
      x: 0,
      y: cursor + g.nodeHeight / 2,
      width: box.width,
      height: g.nodeHeight,
    });
    cursor += g.nodeHeight;
  }
  let overflow: LaidOutOverflow | null = null;
  if (selection.total > selection.shown.length && selection.side) {
    cursor += g.rowGap;
    const hidden = selection.total - selection.shown.length;
    const text = `+${hidden} more`;
    overflow = {
      id: `overflow:${column}`,
      text,
      side: selection.side,
      column,
      hidden,
      total: selection.total,
      x: 0,
      y: cursor + g.overflowHeight / 2,
      width: textWidth(text, textScale) + 2 * g.captionPadding,
      height: g.overflowHeight,
    };
    cursor += g.overflowHeight;
  }
  const shift = -cursor / 2;
  for (const box of [...nodes, ...captions, ...(overflow ? [overflow] : [])]) box.y += shift;
  const width = Math.max(0, ...nodes.map((item) => item.width), ...captions.map((item) => item.width), overflow?.width ?? 0);
  return { nodes, captions, overflow, width };
}

/** Horizontal extent of each column outward from the root; an empty column takes no space. */
function columnSpans(widths: Record<GraphColumn, number>): Record<GraphColumn, ColumnSpan> {
  const gap = GRAPH_GEOMETRY.columnGap;
  const half = widths[0] / 2;
  const innerLeft = widths[1] > 0 ? half + gap : half;
  const innerRight = innerLeft + widths[1];
  const outerLeft = (widths[1] > 0 ? innerRight : half) + gap;
  const outerRight = outerLeft + widths[2];
  const mirrorInnerLeft = widths[-1] > 0 ? half + gap : half;
  const mirrorInnerRight = mirrorInnerLeft + widths[-1];
  const mirrorOuterLeft = (widths[-1] > 0 ? mirrorInnerRight : half) + gap;
  const mirrorOuterRight = mirrorOuterLeft + widths[-2];
  return {
    [-2]: { left: -mirrorOuterRight, right: -mirrorOuterLeft },
    [-1]: { left: -mirrorInnerRight, right: -mirrorInnerLeft },
    0: { left: -half, right: half },
    1: { left: innerLeft, right: innerRight },
    2: { left: outerLeft, right: outerRight },
  } as Record<GraphColumn, ColumnSpan>;
}

/** Boxes sit flush against the column edge that faces the root. */
function alignedX(column: GraphColumn, span: ColumnSpan, width: number): number {
  if (column < 0) return span.right - width / 2;
  if (column > 0) return span.left + width / 2;
  return 0;
}

function boundsOf(boxes: readonly LayoutBox[]): LayoutBounds {
  if (boxes.length === 0) return { x1: 0, y1: 0, x2: 0, y2: 0, width: 0, height: 0 };
  const x1 = Math.min(...boxes.map((box) => box.x - box.width / 2));
  const x2 = Math.max(...boxes.map((box) => box.x + box.width / 2));
  const y1 = Math.min(...boxes.map((box) => box.y - box.height / 2));
  const y2 = Math.max(...boxes.map((box) => box.y + box.height / 2));
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

function edgeWidth(edge: MetaprojectEdge): number {
  return edge.count !== undefined && edge.count > 1 ? 1 + Math.min(2, Math.log2(edge.count) / 2) : 1;
}

function emptyLayout(projection: MetaprojectNeighbors): NeighborhoodLayout {
  return { root: null, nodes: [], captions: [], overflow: [], edges: [], incoming: 0, outgoing: 0, truncated: projection.truncated, bounds: boundsOf([]) };
}

/** Lays out the neighbourhood of `projection.root` in direction columns. */
export function layoutNeighborhood(projection: MetaprojectNeighbors, options: LayoutOptions = {}): NeighborhoodLayout {
  const cap = options.columnCap ?? COLUMN_CAP;
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`columnCap must be a positive integer, got ${cap}`);
  const textScale = options.textScale && options.textScale > 0 ? options.textScale : 1;
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  const rootNode = nodes.get(projection.root);
  if (!rootNode) return emptyLayout(projection);

  const first = firstStep(rootNode.id, projection.edges);
  const firstEntries: Entry[] = [];
  for (const [id, placement] of first) {
    const node = nodes.get(id);
    if (node) firstEntries.push({ node, ...placement });
  }
  const selections = new Map<GraphColumn, ColumnSelection>();
  for (const [column, side] of [[-1, "incoming"], [1, "outgoing"]] as const) {
    selections.set(column, selectColumn(firstEntries.filter((entry) => entry.side === side), cap));
  }
  const drawnFirst = new Set([...(selections.get(-1)?.shown ?? []), ...(selections.get(1)?.shown ?? [])].map((entry) => entry.node.id));
  const second = secondStep(rootNode.id, projection.edges, nodes, first, drawnFirst);
  for (const [column, side] of [[-2, "incoming"], [2, "outgoing"]] as const) {
    selections.set(column, selectColumn(second.filter((entry) => entry.side === side), cap));
  }

  const titles = distinctTitles([rootNode, ...[...selections.values()].flatMap((selection) => selection.shown.map((entry) => entry.node))]);
  const columns = new Map<GraphColumn, StackedColumn>();
  for (const [column, selection] of selections) {
    columns.set(column, stackColumn(selection, column, Math.abs(column) === 1 ? "first" : "second", textScale, titles));
  }

  const rootBox = nodeBox(titles.get(rootNode.id) ?? rootNode.title, GRAPH_GEOMETRY.rootMaxWidth, textScale);
  const root: LaidOutNode = { id: rootNode.id, node: rootNode, label: rootBox.label, role: "root", side: null, column: 0, x: 0, y: 0, width: rootBox.width, height: GRAPH_GEOMETRY.nodeHeight };
  const widthOf = (column: GraphColumn) => columns.get(column)?.width ?? 0;
  const spans = columnSpans({ [-2]: widthOf(-2), [-1]: widthOf(-1), 0: root.width, 1: widthOf(1), 2: widthOf(2) } as Record<GraphColumn, number>);

  const laidOut: LaidOutNode[] = [];
  const captions: LaidOutCaption[] = [];
  const overflow: LaidOutOverflow[] = [];
  for (const [column, stacked] of columns) {
    const span = spans[column];
    for (const item of stacked.nodes) laidOut.push({ ...item, x: alignedX(column, span, item.width) });
    for (const item of stacked.captions) captions.push({ ...item, x: alignedX(column, span, item.width) });
    if (stacked.overflow) overflow.push({ ...stacked.overflow, x: alignedX(column, span, stacked.overflow.width) });
  }

  const drawn = new Set([root.id, ...laidOut.map((item) => item.id)]);
  const edges: LaidOutEdge[] = [];
  let incoming = 0;
  let outgoing = 0;
  projection.edges.forEach((edge, index) => {
    if (edge.from === edge.to) return;
    if (edge.to === root.id) incoming++;
    if (edge.from === root.id) outgoing++;
    if (!drawn.has(edge.from) || !drawn.has(edge.to)) return;
    edges.push({
      id: `edge-${index}`,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      width: edgeWidth(edge),
      secondStep: edge.from !== root.id && edge.to !== root.id,
    });
  });

  return {
    root,
    nodes: laidOut,
    captions,
    overflow,
    edges,
    incoming,
    outgoing,
    truncated: projection.truncated,
    bounds: boundsOf([root, ...laidOut, ...captions, ...overflow]),
  };
}

export interface GraphViewport {
  /** False for a zero-sized box or an empty layout: do not fit or zoom. */
  usable: boolean;
  zoom: number;
  pan: { x: number; y: number };
  padding: number;
}

/**
 * Fits the layout into a `width` × `height` box, never below 0.8 or above 1.15.
 * An axis that does not fit at that zoom is centred on the root instead, so the user pans.
 */
export function computeViewport(layout: NeighborhoodLayout, width: number, height: number, padding = VIEWPORT_PADDING): GraphViewport {
  if (!layout.root || width <= 0 || height <= 0) return { usable: false, zoom: 1, pan: { x: 0, y: 0 }, padding };
  const { bounds, root } = layout;
  const innerWidth = Math.max(1, width - 2 * padding);
  const innerHeight = Math.max(1, height - 2 * padding);
  const fit = Math.min(innerWidth / Math.max(1, bounds.width), innerHeight / Math.max(1, bounds.height));
  const zoom = Math.min(AUTO_ZOOM.max, Math.max(AUTO_ZOOM.min, fit));
  const axis = (size: number, inner: number, low: number, high: number, rootAt: number) =>
    size / 2 - zoom * ((high - low) * zoom <= inner ? (low + high) / 2 : rootAt);
  return {
    usable: true,
    zoom,
    pan: {
      x: axis(width, innerWidth, bounds.x1, bounds.x2, root.x),
      y: axis(height, innerHeight, bounds.y1, bounds.y2, root.y),
    },
    padding,
  };
}

// ---------------------------------------------------------------------------
// Style mapping: meaning is never colour alone.

export type NodeShape = "round-rectangle" | "barrel" | "cut-rectangle" | "tag";
export type NodeBorderStyle = "solid" | "dashed" | "double";
export type LineStyle = "solid" | "dashed" | "dotted";
/** CSS custom properties the graph resolves to colours at runtime. */
export type GraphColorToken = "--fg-muted" | "--fg-subtle" | "--border-strong" | "--info" | "--ok" | "--warn";

export interface NodeKindStyle {
  shape: NodeShape;
  borderStyle: NodeBorderStyle;
  borderWidth: number;
  borderToken: GraphColorToken;
  label: string;
}

export interface EdgeKindStyle {
  lineStyle: LineStyle;
  label: string;
}

export const NODE_KINDS_IN_ORDER: readonly MetaprojectNodeKind[] = ["module", "file", "symbol", "wiki", "spec", "change", "archive"];
export const LINE_STYLES_IN_ORDER: readonly LineStyle[] = ["solid", "dashed", "dotted"];

const NODE_KIND_TREATMENTS: Record<MetaprojectNodeKind, Omit<NodeKindStyle, "label">> = {
  module: { shape: "round-rectangle", borderStyle: "solid", borderWidth: 2, borderToken: "--fg-muted" },
  file: { shape: "round-rectangle", borderStyle: "solid", borderWidth: 1, borderToken: "--border-strong" },
  symbol: { shape: "barrel", borderStyle: "solid", borderWidth: 1, borderToken: "--border-strong" },
  wiki: { shape: "cut-rectangle", borderStyle: "solid", borderWidth: 1, borderToken: "--info" },
  spec: { shape: "tag", borderStyle: "solid", borderWidth: 1, borderToken: "--ok" },
  change: { shape: "tag", borderStyle: "double", borderWidth: 3, borderToken: "--warn" },
  archive: { shape: "tag", borderStyle: "dashed", borderWidth: 1, borderToken: "--fg-muted" },
};

const EDGE_LINE_STYLES: Record<MetaprojectEdgeKind, LineStyle> = {
  imports: "solid",
  calls: "solid",
  asset: "solid",
  describes: "dashed",
  links: "dashed",
  "changes-spec": "dashed",
  "spec-context": "dashed",
  contains: "dotted",
  defines: "dotted",
};

export const LINE_STYLE_LABELS: Record<LineStyle, string> = {
  solid: "Solid line",
  dashed: "Dashed line",
  dotted: "Dotted line",
};

export function nodeKindStyle(kind: MetaprojectNodeKind): NodeKindStyle {
  return { ...NODE_KIND_TREATMENTS[kind], label: NODE_KIND_LABELS[kind] };
}

export function edgeKindStyle(kind: MetaprojectEdgeKind): EdgeKindStyle {
  return { lineStyle: EDGE_LINE_STYLES[kind], label: RELATIONSHIP_KIND_LABELS[kind] };
}

export function edgeKindLabel(kind: MetaprojectEdgeKind): string {
  return RELATIONSHIP_KIND_LABELS[kind];
}

export interface GraphLegend {
  nodeKinds: { kind: MetaprojectNodeKind; label: string }[];
  lines: { style: LineStyle; label: string; kinds: string[] }[];
}

/** The node kinds and line styles present in the projection, in a fixed order. */
export function legendFor(projection: MetaprojectNeighbors): GraphLegend {
  const nodeKinds = new Set(projection.nodes.map((node) => node.kind));
  const edgeKinds = new Set(projection.edges.map((edge) => edge.kind));
  return {
    nodeKinds: NODE_KINDS_IN_ORDER.filter((kind) => nodeKinds.has(kind)).map((kind) => ({ kind, label: NODE_KIND_LABELS[kind] })),
    lines: LINE_STYLES_IN_ORDER.map((style) => ({
      style,
      label: LINE_STYLE_LABELS[style],
      kinds: METAPROJECT_EDGE_KINDS_V2.filter((kind) => edgeKinds.has(kind) && EDGE_LINE_STYLES[kind] === style).map(edgeKindLabel),
    })).filter((line) => line.kinds.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Colours: cytoscape takes no CSS variables and no translucency we want.

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function channel(value: string, scale: number): number {
  return value.endsWith("%") ? (Number.parseFloat(value) / 100) * scale : Number.parseFloat(value);
}

function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? Array.from(hex, (digit) => digit + digit).join("") : hex;
    const byte = (index: number) => Number.parseInt(full.slice(index, index + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (!rgb) return null;
  const [, r = "0", g = "0", b = "0", a] = rgb;
  return { r: channel(r, 255), g: channel(g, 255), b: channel(b, 255), a: a === undefined ? 1 : channel(a, 1) };
}

/**
 * Returns `color` as an opaque `rgb()`, blending a translucent colour over `background`.
 * A colour this parser does not read is returned unchanged.
 */
export function toOpaqueColor(color: string, background: string): string {
  const fg = parseColor(color);
  if (!fg) return color;
  const bg = parseColor(background) ?? { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const alpha = Math.min(1, Math.max(0, fg.a));
  const mix = (front: number, back: number) => Math.round(front * alpha + back * (1 - alpha));
  return `rgb(${mix(fg.r, bg.r)}, ${mix(fg.g, bg.g)}, ${mix(fg.b, bg.b)})`;
}
