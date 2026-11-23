import cytoscape from "cytoscape";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetaprojectNeighbors } from "../../../../src/integrations/metaproject-explorer-contract";
import { Icon } from "../components/Icon";
import {
  GRAPH_GEOMETRY,
  NODE_KINDS_IN_ORDER,
  computeViewport,
  edgeKindStyle,
  layoutNeighborhood,
  legendFor,
  nodeKindStyle,
  toOpaqueColor,
  type GraphColorToken,
  type GraphSide,
  type NeighborhoodLayout,
} from "./graphLayout";
import "./graph.css";

/** Builds the cytoscape instance. Only tests pass one: happy-dom has no 2D canvas. */
export type CytoscapeFactory = (options: cytoscape.CytoscapeOptions) => cytoscape.Core;

export interface RelationshipGraphProps {
  /** root = the selected node */
  projection: MetaprojectNeighbors;
  /** A newer projection is loading: keep rendering, mark aria-busy, dim. */
  busy?: boolean;
  /** A node was tapped. */
  onSelect: (id: string) => void;
  /** A "+N more" entry was tapped. */
  onShowHidden?: (side: "incoming" | "outgoing") => void;
  /** Test seam; the app always uses core cytoscape. */
  createCytoscape?: CytoscapeFactory;
}

const USER_ZOOM = { min: 0.3, max: 2.5, step: 1.25 } as const;

type ThemeToken = GraphColorToken | "--fg" | "--accent" | "--bg-selected" | "--bg-surface" | "--bg-sunken";
const THEME_TOKENS: readonly ThemeToken[] = ["--fg", "--fg-muted", "--fg-subtle", "--border-strong", "--info", "--ok", "--warn", "--accent", "--bg-selected", "--bg-surface", "--bg-sunken"];

interface GraphTheme {
  colors: Partial<Record<ThemeToken, string>>;
  font: string;
  textScale: number;
}

function readTextScale(): number {
  if (typeof document === "undefined") return 1;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-scale"));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Resolves each token to an opaque colour cytoscape can read. A probe element turns any CSS
 * colour syntax into `rgb()`/`rgba()`; translucent values are blended over the canvas background.
 */
function readTheme(host: HTMLElement): GraphTheme {
  const probe = document.createElement("span");
  probe.hidden = true;
  host.append(probe);
  const hostStyle = getComputedStyle(host);
  const rootStyle = getComputedStyle(document.documentElement);
  const raw = (token: string) => hostStyle.getPropertyValue(token).trim() || rootStyle.getPropertyValue(token).trim();
  const resolve = (token: ThemeToken): string => {
    const authored = raw(token);
    if (!authored) return "";
    probe.style.color = "";
    probe.style.color = `var(${token})`;
    const computed = getComputedStyle(probe).color.trim();
    return computed && !computed.includes("var(") ? computed : authored;
  };
  const resolved = new Map(THEME_TOKENS.map((token) => [token, resolve(token)]));
  probe.remove();
  const background = resolved.get("--bg-sunken") ?? "";
  const colors: Partial<Record<ThemeToken, string>> = {};
  for (const [token, value] of resolved) if (value) colors[token] = toOpaqueColor(value, background);
  const font = raw("--font");
  return { colors, font, textScale: readTextScale() };
}

/** Drops properties whose token did not resolve, so cytoscape keeps its default instead of an invalid value. */
function defined(style: Record<string, string | number | undefined>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(style)) if (value !== undefined && value !== "") result[key] = value;
  return result;
}

function graphStyle(theme: GraphTheme): cytoscape.StylesheetJson {
  const c = theme.colors;
  const scale = theme.textScale;
  const sheet: { selector: string; style: Record<string, string | number> }[] = [
    {
      selector: "node.graph-node",
      style: defined({
        shape: "data(shape)",
        width: "data(width)",
        height: "data(height)",
        label: "data(label)",
        "font-size": GRAPH_GEOMETRY.labelFontSize * scale,
        "font-family": theme.font || undefined,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "none",
        color: c["--fg"],
        "background-color": c["--bg-surface"],
        "border-width": "data(borderWidth)",
        "border-style": "data(borderStyle)",
        "border-color": c["--border-strong"],
      }),
    },
    ...NODE_KINDS_IN_ORDER.map((kind) => ({
      selector: `node.kind-${kind}`,
      style: defined({ "border-color": c[nodeKindStyle(kind).borderToken] }),
    })),
    {
      selector: "node.root",
      style: defined({ "border-color": c["--accent"], "background-color": c["--bg-selected"], "font-weight": 600 }),
    },
    {
      selector: "node.caption",
      style: defined({
        shape: "rectangle",
        width: "data(width)",
        height: "data(height)",
        label: "data(label)",
        "font-size": GRAPH_GEOMETRY.captionFontSize * scale,
        "font-family": theme.font || undefined,
        "font-weight": 600,
        "text-valign": "center",
        "text-halign": "center",
        color: c["--fg-muted"],
        "background-opacity": 0,
        "border-width": 0,
        events: "no",
      }),
    },
    {
      selector: "node.overflow",
      style: defined({
        shape: "round-rectangle",
        width: "data(width)",
        height: "data(height)",
        label: "data(label)",
        "font-size": GRAPH_GEOMETRY.captionFontSize * scale,
        "font-family": theme.font || undefined,
        "text-valign": "center",
        "text-halign": "center",
        color: c["--fg-muted"],
        "background-color": c["--bg-surface"],
        "border-width": 1,
        "border-style": "dashed",
        "border-color": c["--fg-muted"],
      }),
    },
    {
      selector: "edge",
      style: defined({
        width: "data(width)",
        "line-style": "data(lineStyle)",
        "line-color": c["--fg-subtle"],
        "target-arrow-color": c["--fg-subtle"],
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        "curve-style": "bezier",
      }),
    },
    { selector: "edge.second-step", style: { opacity: 0.45 } },
    { selector: ".faded", style: { opacity: 0.18 } },
    {
      selector: "edge.highlight",
      style: defined({ opacity: 1, "line-color": c["--accent"], "target-arrow-color": c["--accent"] }),
    },
    { selector: "node.graph-node.highlight", style: defined({ "border-color": c["--accent"] }) },
  ];
  // The stylesheet is assembled from typed constants above; cytoscape's per-property unions
  // cannot express `data(...)` mappers on every key, so the record is widened here once.
  return sheet as unknown as cytoscape.StylesheetJson;
}

function graphElements(layout: NeighborhoodLayout): cytoscape.ElementDefinition[] {
  if (!layout.root) return [];
  const nodes = [layout.root, ...layout.nodes].map((item) => {
    const style = nodeKindStyle(item.node.kind);
    return {
      group: "nodes" as const,
      data: { id: item.id, label: item.label, shape: style.shape, borderStyle: style.borderStyle, borderWidth: item.role === "root" ? Math.max(2, style.borderWidth) : style.borderWidth, width: item.width, height: item.height },
      position: { x: item.x, y: item.y },
      classes: `graph-node kind-${item.node.kind}${item.role === "root" ? " root" : ""}`,
    };
  });
  const captions = layout.captions.map((item) => ({
    group: "nodes" as const,
    data: { id: `__${item.id}`, label: item.text, width: item.width, height: item.height },
    position: { x: item.x, y: item.y },
    classes: "caption",
  }));
  const overflow = layout.overflow.map((item) => ({
    group: "nodes" as const,
    data: { id: `__${item.id}`, label: item.text, side: item.side, width: item.width, height: item.height },
    position: { x: item.x, y: item.y },
    classes: "overflow",
  }));
  const edges = layout.edges.map((item) => ({
    group: "edges" as const,
    data: { id: item.id, source: item.from, target: item.to, width: item.width, lineStyle: edgeKindStyle(item.kind).lineStyle },
    classes: item.secondStep ? "second-step" : "",
  }));
  return [...nodes, ...captions, ...overflow, ...edges];
}

function isSide(value: unknown): value is GraphSide {
  return value === "incoming" || value === "outgoing";
}

export function RelationshipGraph({ projection, busy = false, onSelect, onShowHidden, createCytoscape }: RelationshipGraphProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<cytoscape.Core | null>(null);
  const factory = useRef<CytoscapeFactory>(createCytoscape ?? cytoscape);
  const selectRef = useRef(onSelect);
  const showHiddenRef = useRef(onShowHidden);
  selectRef.current = onSelect;
  showHiddenRef.current = onShowHidden;
  const [textScale, setTextScale] = useState(readTextScale);
  const layout = useMemo(() => layoutNeighborhood(projection, { textScale }), [projection, textScale]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const legend = useMemo(() => legendFor(projection), [projection]);

  /** Fits the current layout; a zero-sized (hidden) container is left alone. */
  const fit = useCallback(() => {
    const cy = graph.current;
    const viewport = container.current;
    if (!cy || !viewport) return;
    const target = computeViewport(layoutRef.current, viewport.clientWidth, viewport.clientHeight);
    if (!target.usable) return;
    cy.resize();
    cy.viewport({ zoom: target.zoom, pan: target.pan });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const cy = graph.current;
    const viewport = container.current;
    if (!cy || !viewport || !viewport.clientWidth || !viewport.clientHeight) return;
    const level = Math.min(USER_ZOOM.max, Math.max(USER_ZOOM.min, cy.zoom() * factor));
    cy.zoom({ level, renderedPosition: { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 } });
  }, []);

  useEffect(() => {
    const viewport = container.current;
    const themeHost = host.current;
    if (!viewport || !themeHost) return;
    const cy = factory.current({
      container: viewport,
      elements: [],
      style: graphStyle(readTheme(themeHost)),
      layout: { name: "preset" },
      minZoom: USER_ZOOM.min,
      maxZoom: USER_ZOOM.max,
      boxSelectionEnabled: false,
      autoungrabify: true,
      autounselectify: true,
    });
    graph.current = cy;
    cy.on("tap", "node.graph-node", (event) => selectRef.current(event.target.id()));
    cy.on("tap", "node.overflow", (event) => {
      const side: unknown = event.target.data("side");
      if (isSide(side)) showHiddenRef.current?.(side);
    });
    cy.on("mouseover", "node.graph-node, node.overflow", (event) => {
      viewport.style.cursor = "pointer";
      if (!event.target.hasClass("graph-node")) return;
      const near = event.target.closedNeighborhood();
      cy.elements().not(near).not("node.caption").addClass("faded");
      near.addClass("highlight");
    });
    cy.on("mouseout", "node.graph-node, node.overflow", () => {
      viewport.style.cursor = "";
      cy.elements().removeClass("faded highlight");
    });

    const refreshTheme = () => {
      cy.style(graphStyle(readTheme(themeHost)));
      setTextScale(readTextScale());
    };
    const themeObserver = new MutationObserver(refreshTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "style"] });
    const scheme = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    scheme?.addEventListener("change", refreshTheme);
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    resizeObserver?.observe(viewport);
    return () => {
      resizeObserver?.disconnect();
      scheme?.removeEventListener("change", refreshTheme);
      themeObserver.disconnect();
      graph.current = null;
      cy.destroy();
    };
  }, [fit]);

  useEffect(() => {
    const cy = graph.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(graphElements(layout));
    });
    fit();
  }, [layout, fit]);

  const root = layout.root?.node;
  return (
    <div className={`metaproject-rgraph${busy ? " is-busy" : ""}`} ref={host} aria-busy={busy || undefined}>
      <div className="metaproject-rgraph-header">
        <p className="metaproject-rgraph-caption">
          <strong className="metaproject-rgraph-title" title={root?.path}>{root?.title ?? "No node selected"}</strong>
          <span> · {layout.incoming} incoming · {layout.outgoing} outgoing</span>
          {layout.truncated && (
            <>
              <span> · </span>
              <span className="badge badge-warn">limited</span>
            </>
          )}
        </p>
        <div className="metaproject-rgraph-zoom" role="group" aria-label="Graph zoom">
          <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(USER_ZOOM.step)}>
            <Icon name="plus" size={14} />
          </button>
          <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / USER_ZOOM.step)}>
            <span aria-hidden="true">−</span>
          </button>
          <button type="button" className="icon-btn" aria-label="Fit graph" title="Fit graph" onClick={fit}>
            <Icon name="target" size={14} />
          </button>
        </div>
      </div>
      <div className="metaproject-rgraph-stage">
        <div className="metaproject-rgraph-canvas" aria-hidden="true">
          <div className="metaproject-rgraph-viewport" ref={container} />
        </div>
      </div>
      {(legend.nodeKinds.length > 0 || legend.lines.length > 0) && (
        <ul className="metaproject-rgraph-legend" aria-label="Graph legend">
          {legend.nodeKinds.map((item) => (
            <li key={item.kind}>
              <span className={`metaproject-rgraph-swatch is-${item.kind}`} aria-hidden="true" />
              {item.label}
            </li>
          ))}
          {legend.lines.map((item) => (
            <li key={item.style}>
              <span className={`metaproject-rgraph-line is-${item.style}`} aria-hidden="true" />
              {item.label}: {item.kinds.join(", ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
