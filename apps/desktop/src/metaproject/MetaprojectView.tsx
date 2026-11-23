import cytoscape from "cytoscape";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  rankMetaprojectSearchHits,
  METAPROJECT_EDGE_KINDS,
  METAPROJECT_EDGE_KINDS_V2,
  type MetaprojectCatalog,
  type MetaprojectDetail,
  type MetaprojectDirection,
  type MetaprojectEdgeKind,
  type MetaprojectHit,
  type MetaprojectHitV2,
  type MetaprojectSearchV2,
  type MetaprojectRequestV2,
  type MetaprojectV2Response,
  type MetaprojectNeighbors,
  type MetaprojectNode,
  type MetaprojectRequest,
  type MetaprojectResponse,
  type MetaprojectSearch,
} from "../../../../src/integrations/metaproject-explorer-contract";
import { indexMetaprojectGraph, projectMetaprojectGraph } from "../../../../src/integrations/metaproject-projection";
import { Icon } from "../components/Icon";
import { renderRepositoryMarkdown } from "../components/Markdown";
import { EmptyState } from "../components/ui";
import { errMessage } from "../lib/format";
import { openExternal } from "../platform/commands";
import { negotiateMetaproject, requestMetaproject, requestMetaprojectV2 } from "../platform/metaproject";
import { OpenSpecView, type OpenSpecLocation } from "./OpenSpecView";
import { GraphNodePanel } from "./GraphNodePanel";
import { useExplorerNavigation } from "./useExplorerNavigation";
import "./metaproject.css";

type Request = (
  cwd: string,
  request: MetaprojectRequest,
) => Promise<MetaprojectResponse>;
const EMPTY_HITS: readonly MetaprojectHit[] = [];
const GRAPH_PADDING = 36;
const DOCUMENT_EDGES = ["describes", "links"] as const;
const sameLocation = (left: OpenSpecLocation | null, right: OpenSpecLocation | null) =>
  left === right || (left !== null && right !== null && left.id === right.id && left.collection === right.collection &&
    left.artifact === right.artifact && left.section === right.section && left.digest === right.digest && left.fragment === right.fragment);

function Graph({
  projection,
  selected,
  select,
}: {
  projection: MetaprojectNeighbors;
  selected: string;
  select: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = container.current;
    if (!viewport) return;
    const theme = getComputedStyle(viewport);
    const color = (token: string, fallback: string) =>
      theme.getPropertyValue(token).trim() || fallback;
    const neighbors = projection.nodes.filter((node) => node.id !== selected);
    const positions = new Map(neighbors.map((node, index) => [node.id, index]));
    const graph = cytoscape({
      container: viewport,
      elements: [
        ...projection.nodes.map((node) => {
          const index = positions.get(node.id) ?? 0;
          const angle = (2 * Math.PI * index) / Math.max(neighbors.length, 1);
          return {
            data: {
              id: node.id,
              label: node.title,
            },
            classes: node.id === selected ? "root-node" : undefined,
            position:
              node.id === selected
                ? { x: 0, y: 0 }
                : { x: 180 * Math.cos(angle), y: 180 * Math.sin(angle) },
          };
        }),
        ...projection.edges.map((edge, index) => ({
          data: {
            id: `edge-${index}`,
            source: edge.from,
            target: edge.to,
            label: edge.kind,
          },
        })),
      ],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": 11,
            color: color("--fg", "#aebbc9"),
            "background-color": color("--fg-muted", "#678499"),
            "text-wrap": "ellipsis",
            "text-max-width": "110px",
          },
        },
        {
          selector: "node.root-node",
          style: {
            "background-color": color("--accent", "#67b5a4"),
            "border-color": color("--fg", "#aebbc9"),
            "border-width": 2,
            width: 38,
            height: 38,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1,
            "line-color": color("--fg-subtle", "#738798"),
            "target-arrow-color": color("--fg-subtle", "#738798"),
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
          },
        },
      ],
      layout: { name: "preset", fit: true, padding: GRAPH_PADDING },
      maxZoom: 1.8,
    });
    graph.on("tap", "node", (event) => select(event.target.id()));
    function fit() {
      if (viewport?.clientWidth && viewport.clientHeight) graph.resize().fit(graph.elements(), GRAPH_PADDING);
    }
    const firstFrame = requestAnimationFrame(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => {
      cancelAnimationFrame(firstFrame);
      observer.disconnect();
      graph.destroy();
    };
  }, [projection, selected, select]);
  return (
    <div className="metaproject-graph" aria-hidden="true">
      <div className="metaproject-graph-viewport" ref={container} />
    </div>
  );
}

/**
 * The repository path a Markdown link in `source` points at: percent-decoded, relative to the
 * page's folder, or to the repository root when it starts with "/". Null when it cannot be decoded.
 */
function resolveRepositoryPath(source: string, href: string): string | null {
  let path: string;
  try { path = decodeURIComponent(href); } catch { return null; }
  const base = path.startsWith("/") ? "" : source.slice(0, source.lastIndexOf("/") + 1);
  const resolved: string[] = [];
  for (const part of (base + path).split("/")) {
    if (part === "..") resolved.pop();
    else if (part && part !== ".") resolved.push(part);
  }
  return resolved.join("/");
}

function RepositoryMarkdown({
  text,
  source,
  openPath,
  fragment,
}: {
  text: string;
  source: string;
  /** `path` is the resolved repository path, or the raw href when it cannot be decoded. */
  openPath: (path: string, fragment: string | undefined, resolved: boolean) => void;
  fragment?: string;
}) {
  const html = useMemo(() => renderRepositoryMarkdown(text), [text]);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fragment) return;
    let decoded: string;
    try { decoded = decodeURIComponent(fragment); } catch { return; }
    const seen = new Map<string, number>();
    for (const heading of container.current?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6") ?? []) {
      const base = (heading.textContent ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      if ((count ? `${base}-${count}` : base) === decoded) { heading.tabIndex = -1; heading.focus(); heading.scrollIntoView?.({ block: "nearest" }); break; }
    }
  }, [html, fragment]);
  return (
    <div
      className="md"
      ref={container}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const link = (event.target as Element).closest("a");
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) {
          void openExternal(href).catch(() => {});
          return;
        }
        const [path, targetFragment] = href.split("#", 2);
        if (!path && href.startsWith("#")) {
          let fragment: string;
          try {
            fragment = decodeURIComponent(href.slice(1));
          } catch {
            return;
          }
          const seen = new Map<string, number>();
          for (const heading of event.currentTarget.querySelectorAll<HTMLElement>(
            "h1,h2,h3,h4,h5,h6",
          )) {
            const base = (heading.textContent ?? "")
              .trim()
              .toLowerCase()
              .replace(/[^\p{L}\p{N}\s_-]/gu, "")
              .replace(/\s/g, "-");
            const count = seen.get(base) ?? 0;
            seen.set(base, count + 1);
            if ((count ? `${base}-${count}` : base) === fragment) {
              heading.scrollIntoView();
              break;
            }
          }
          return;
        }
        if (!path) return;
        const resolved = resolveRepositoryPath(source, path);
        openPath(resolved ?? path, targetFragment, resolved !== null);
      }}
      onAuxClick={(event) => {
        if ((event.target as Element).closest("a")) event.preventDefault();
      }}
    />
  );
}

export function RelationshipList({
  projection,
  select,
}: {
  projection: MetaprojectNeighbors;
  select: (id: string) => void;
}) {
  const nodes = new Map(projection.nodes.map(node => [node.id, node]));
  return (
    <>
      {projection.truncated && <p role="status">Relationship projection is limited.</p>}
      {projection.edges.length === 0 && <p>No relationships for these filters.</p>}
      <ul className="metaproject-relations">
        {projection.edges.map((edge, index) => {
          const from = nodes.get(edge.from);
          const to = nodes.get(edge.to);
          if (!from || !to) return null;
          const label = `${from.title} → ${edge.kind} → ${to.title}`;
          const evidence = [
            ...(edge.evidence ?? []),
            ...(edge.provenance ?? []).map(item => `${item.path}${item.index === undefined ? "" : ` (link ${item.index})`} · ${item.digest}`),
          ].join(" · ");
          const adjacent = from.id === projection.root ? to : to.id === projection.root ? from : null;
          return (
            <li key={`${edge.from}-${edge.to}-${edge.kind}-${index}`}>
              {adjacent ? (
                <button className="metaproject-row" onClick={() => select(adjacent.id)} title={adjacent.path}>
                  {label}
                  {evidence && <span className="metaproject-meta">{evidence}</span>}
                </button>
              ) : (
                <div className="metaproject-row">
                  {label}
                  {evidence && <span className="metaproject-meta">{evidence}</span>}
                  <div className="metaproject-relation-actions">
                    <button className="btn" onClick={() => select(from.id)} title={from.path}>Open {from.title}</button>
                    {to.id !== from.id && (
                      <button className="btn" onClick={() => select(to.id)} title={to.path}>Open {to.title}</button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

type Negotiate = (cwd: string) => Promise<1 | 2>;

export function MetaprojectView(props: {
  cwd: string;
  onRebuild: () => Promise<boolean>;
  onDraft?: (task: string) => Promise<void>;
  request?: Request;
  requestV2?: (cwd: string, request: MetaprojectRequestV2) => Promise<MetaprojectV2Response>;
  /** Protocol negotiation; given, it runs even when `request`/`requestV2` are injected. */
  negotiate?: Negotiate;
}) {
  return <Explorer key={props.cwd} {...props} />;
}

/** Every relationship kind except the symbol layer (`defines`, `calls`). */
const withoutSymbolKinds = (kinds: readonly MetaprojectEdgeKind[]) => kinds.filter(kind => kind !== "calls" && kind !== "defines");
const WIKI_KINDS_V1 = withoutSymbolKinds(METAPROJECT_EDGE_KINDS);
const WIKI_KINDS_V2 = withoutSymbolKinds(METAPROJECT_EDGE_KINDS_V2);

function Explorer({
  cwd,
  onRebuild,
  onDraft,
  request = requestMetaproject,
  requestV2,
  negotiate,
}: {
  cwd: string;
  onRebuild: () => Promise<boolean>;
  onDraft?: (task: string) => Promise<void>;
  request?: Request;
  requestV2?: (cwd: string, request: MetaprojectRequestV2) => Promise<MetaprojectV2Response>;
  negotiate?: Negotiate;
}) {
  const [catalog, setCatalog] = useState<MetaprojectCatalog | null>(null);
  const { route, setRoute, visit, navigate, switchView, back, canGoBack, root } = useExplorerNavigation();
  const { mode, query } = route;
  const [panelWidth, setPanelWidth] = useState(380);
  const negotiates = Boolean(negotiate) || (!requestV2 && request === requestMetaproject);
  const [protocol, setProtocol] = useState<1 | 2 | null>(negotiates ? null : requestV2 ? 2 : 1);
  const archiveSelection = useRef(false);
  const [protocolError, setProtocolError] = useState("");
  const [negotiation, setNegotiation] = useState(0);
  useEffect(() => {
    if (!negotiates) return;
    let active = true;
    void (negotiate ?? negotiateMetaproject)(cwd).then(value => {
      if (!active) return;
      setProtocolError("");
      setProtocol(value);
    }).catch(cause => { if (active) setProtocolError(errMessage(cause)); });
    return () => { active = false; };
  }, [cwd, negotiate, negotiates, negotiation]);
  const read: Request = useMemo(() => protocol === 2
    ? ((root, input) => (requestV2 ?? requestMetaprojectV2)(root, { ...input, version: 2, ...(input.action === "neighbors" && archiveSelection.current ? { includeArchive: true } : {}) }) as unknown as Promise<MetaprojectResponse>)
    : request, [protocol, request, requestV2]);
  // The first Wiki page stands in for a missing selection only while nothing is searched.
  const selection = route.mode === "graph" ? route.selection || catalog?.nodes[0]?.id || ""
    : route.mode === "wiki" ? route.selection || (route.query.trim() ? "" : catalog?.nodes.find(node => node.kind === "wiki")?.id || "") : "";
  const shownSelection = useRef(selection);
  shownSelection.current = selection;
  archiveSelection.current = route.mode === "graph" && Boolean(route.archive);
  const [direction, setDirection] = useState<MetaprojectDirection>("both");
  const [depth, setDepth] = useState<1 | 2>(1);
  const [kinds, setKinds] = useState<MetaprojectEdgeKind[]>(WIKI_KINDS_V1);
  useEffect(() => {
    if (protocol === 2) setKinds(current => [...new Set<MetaprojectEdgeKind>([...current, "changes-spec", "spec-context"])]);
  }, [protocol]);
  // Wiki reads a page's relationships with fixed defaults; only Graph applies its filters.
  const relationDepth = mode === "wiki" ? 1 : depth;
  const relationDirection = mode === "wiki" ? "both" : direction;
  const relationKinds = mode === "wiki" ? protocol === 2 ? WIKI_KINDS_V2 : WIKI_KINDS_V1 : kinds;
  const [searchResult, setSearchResult] = useState<{
    mode: "graph" | "wiki";
    query: string;
    snapshotId: string;
    hits: MetaprojectHit[];
    nextCursor?: string;
  } | null>(null);
  const [snapshotMismatch, setSnapshotMismatch] = useState(false);
  const [detail, setDetail] = useState<MetaprojectDetail | null>(null);
  const [projection, setProjection] = useState<MetaprojectNeighbors | null>(
    null,
  );
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [relationshipError, setRelationshipError] = useState("");
  const [searchError, setSearchError] = useState<{ query: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingRelationships, setLoadingRelationships] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const [revision, setRevision] = useState(0);
  const project = useRef(0);
  const loaded = useRef(false);
  const loadedSnapshot = useRef<string>();
  const searchInFlight = useRef<Promise<MetaprojectResponse> | null>(null);
  const pageInFlight = useRef(false);
  const latestSearch = useRef({ query: "", snapshot: "", generation: 0 });
  const content = useRef<HTMLElement>(null);
  const searchCache = useRef(new Map<string, NonNullable<typeof searchResult>>());
  const activeMode = useRef(mode);
  activeMode.current = mode;
  const [documents, setDocuments] = useState<MetaprojectNeighbors | null>(null);
  const [documentProblem, setDocumentProblem] = useState("");
  const panelOpen = route.mode === "graph" && route.panelOpen;
  const graphIndex = useMemo(
    () => catalog && indexMetaprojectGraph(catalog.nodes, catalog.edges),
    [catalog],
  );
  const selectedNode = graphIndex?.byId.get(selection);
  const searchQuery = query.trim();
  if (latestSearch.current.query !== searchQuery || latestSearch.current.snapshot !== catalog?.snapshotId) {
    latestSearch.current = { query: searchQuery, snapshot: catalog?.snapshotId ?? "", generation: latestSearch.current.generation + 1 };
  }
  useEffect(() => {
    if (protocol === null) return;
    const generation = ++project.current;
    setError("");
    if (!loaded.current) setLoading(true);
    void (async () => {
      try {
        const result = (await read(cwd, {
          action: "catalog",
        })) as MetaprojectCatalog;
        if (generation !== project.current) return;
        loaded.current = true;
        setCatalog(result);
        setSnapshotMismatch(false);
        if (loadedSnapshot.current && loadedSnapshot.current !== result.snapshotId && !result.truncated) {
          setRoute(current => current.mode !== "openspec" && !result.nodes.some(node => node.id === current.selection)
            ? { ...current, selection: "" } : current);
        }
        loadedSnapshot.current = result.snapshotId;
      } catch (cause) {
        if (generation === project.current) setError(errMessage(cause));
      } finally {
        if (generation === project.current) setLoading(false);
      }
    })();
    return () => {
      project.current++;
    };
  }, [cwd, read, revision, protocol, setRoute]);
  useEffect(() => {
    if (!catalog || !searchQuery || mode === "openspec") return;
    const key = JSON.stringify([catalog.snapshotId, mode, searchQuery]);
    const cached = searchCache.current.get(key);
    setSearchError(null);
    if (cached) { setSearchResult(cached); return; }
    setSearchResult(null);
    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        const previous = searchInFlight.current;
        if (previous) await previous.catch(() => {});
        if (!active) return;
        const pending = Promise.resolve().then(() => protocol === 2 && mode === "wiki"
          ? (requestV2 ?? requestMetaprojectV2)(cwd, { version: 2, action: "search", query: searchQuery, scopes: ["wiki"] }) as unknown as Promise<MetaprojectResponse>
          : read(cwd, { action: "search", query: searchQuery }));
        searchInFlight.current = pending;
        try {
          const result = (await pending) as MetaprojectSearch;
          if (active) {
            if (result.snapshotId !== catalog.snapshotId)
              setSnapshotMismatch(true);
            else {
              setSearchResult({
                mode,
                query: searchQuery,
                snapshotId: result.snapshotId,
                hits: result.hits,
                ...((result as unknown as MetaprojectSearchV2).nextCursor && { nextCursor: (result as unknown as MetaprojectSearchV2).nextCursor }),
              });
              setSearchError(null);
            }
          }
        } catch (cause) {
          if (active) setSearchError({ query: searchQuery, message: errMessage(cause) });
        } finally {
          if (searchInFlight.current === pending) searchInFlight.current = null;
        }
      })();
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [catalog, cwd, mode, protocol, read, requestV2, searchQuery, searchAttempt]);
  useEffect(() => {
    if (!searchResult) return;
    const cache = searchCache.current;
    cache.set(JSON.stringify([searchResult.snapshotId, searchResult.mode, searchResult.query]), searchResult);
    if (cache.size > 12) cache.delete(cache.keys().next().value!);
  }, [searchResult]);
  useEffect(() => {
    setDetail(null);
    setLoadingDetail(false);
    setDetailError("");
    if (!catalog || !selection || mode !== "wiki") return;
    let active = true;
    setLoadingDetail(true);
    void (async () => {
      try {
        const result = (await read(cwd, {
          action: "detail",
          id: selection,
        })) as MetaprojectDetail;
        if (active) {
          if (result.snapshotId !== catalog.snapshotId)
            setSnapshotMismatch(true);
          else if (result.node.id === selection) setDetail(result);
        }
      } catch (cause) {
        if (active) setDetailError(errMessage(cause));
      } finally {
        if (active) setLoadingDetail(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [catalog, cwd, mode, read, selection]);
  useEffect(() => {
    setProjection(null);
    setRelationshipError("");
    setLoadingRelationships(false);
    if (!catalog || !selection || mode === "openspec") return;
    const neighborsRequest = { action: "neighbors", id: selection, depth: relationDepth, direction: relationDirection, kinds: relationKinds } as const;
    if (
      protocol !== 2 && graphIndex && selectedNode &&
      !catalog.truncated &&
      selectedNode.kind !== "symbol" &&
      !relationKinds.includes("calls") &&
      !relationKinds.includes("defines")
    ) {
      setProjection(projectMetaprojectGraph(graphIndex, catalog, neighborsRequest));
      return;
    }
    if (catalog.graph === "missing" && protocol !== 2) return;
    let active = true;
    setLoadingRelationships(true);
    void (async () => {
      try {
        const result = (await read(cwd, neighborsRequest)) as MetaprojectNeighbors;
        if (active) {
          if (result.snapshotId !== catalog.snapshotId)
            setSnapshotMismatch(true);
          else if (result.root === selection) setProjection(result);
        }
      } catch (cause) {
        if (active) setRelationshipError(errMessage(cause));
      } finally {
        if (active) setLoadingRelationships(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [graphIndex, selectedNode, catalog, cwd, mode, read, selection, relationDepth, relationDirection, relationKinds, protocol]);
  useEffect(() => {
    setDocuments(null);
    setDocumentProblem("");
    if (!catalog || !selection || !panelOpen) return;
    const input: Extract<MetaprojectRequest, { action: "neighbors" }> = {
      action: "neighbors", id: selection, depth: 1, direction: "both",
      kinds: protocol === 2 ? [...DOCUMENT_EDGES, "spec-context", "changes-spec"] : [...DOCUMENT_EDGES],
    };
    if (protocol === 1 && graphIndex && !catalog.truncated && selectedNode) {
      setDocuments(projectMetaprojectGraph(graphIndex, catalog, input));
      return;
    }
    let active = true;
    void read(cwd, input).then(result => {
      if (!active || !("root" in result) || result.root !== selection) return;
      if (result.snapshotId !== catalog.snapshotId) setSnapshotMismatch(true);
      else setDocuments(result);
    }).catch(cause => { if (active) setDocumentProblem(errMessage(cause)); });
    return () => { active = false; };
  }, [catalog, cwd, graphIndex, panelOpen, protocol, read, selectedNode, selection]);
  const preview = useCallback(async (id: string) => {
    const result = await read(cwd, { action: "detail", id });
    if (!("node" in result) || result.snapshotId !== catalog?.snapshotId) throw new Error("Preview is no longer current.");
    return result;
  }, [catalog?.snapshotId, cwd, read]);
  const resolvedSearch =
    searchResult?.mode === mode && searchResult.query === searchQuery &&
    searchResult.snapshotId === catalog?.snapshotId
      ? searchResult
      : null;
  const hits = resolvedSearch?.hits ?? EMPTY_HITS;
  const searchFailure = searchError?.query === searchQuery ? searchError.message : "";
  const searching = Boolean(searchQuery && !resolvedSearch && !searchFailure && !snapshotMismatch);
  const nodes = useMemo(
    () => [
      ...new Map(
        [
          ...(catalog?.nodes ?? []),
          ...hits.map((hit) => hit.node),
          ...(projection?.nodes ?? []),
        ].map((node) => [node.id, node]),
      ).values(),
    ],
    [catalog, hits, projection],
  );
  const results = useMemo(() => {
    const results = protocol === 2 && searchQuery ? hits : rankMetaprojectSearchHits(searchQuery, catalog?.nodes ?? [], hits);
    return mode === "wiki" ? results.filter(hit => hit.node.kind === "wiki") : results;
  }, [catalog, hits, mode, searchQuery, protocol]);
  const knownSelection = useRef<MetaprojectNode>();
  const activeNode = nodes.find(node => node.id === selection) ?? (knownSelection.current?.id === selection ? knownSelection.current : undefined);
  const [suggestedWiki, setSuggestedWiki] = useState<{ root: string; node: MetaprojectNode } | null>(null);
  const modulePath = activeNode?.kind === "module" ? activeNode.path : undefined;
  useEffect(() => {
    if (!panelOpen || !modulePath || !catalog) return;
    let active = true;
    void read(cwd, { action: "search", query: modulePath }).then(result => {
      if (!active || !("hits" in result) || result.snapshotId !== catalog.snapshotId) return;
      const match = result.hits.find(({ node }) => node.kind === "wiki" && node.pageType === "component" && node.title === `Module ${modulePath}`);
      setSuggestedWiki(match ? { root: selection, node: match.node } : null);
    }).catch(() => {});
    return () => { active = false; };
  }, [catalog, cwd, modulePath, panelOpen, read, selection]);
  const graphNodes = useRef(nodes);
  graphNodes.current = nodes;
  const select = useCallback((id: string) => {
    const node = graphNodes.current.find(item => item.id === id);
    if (node) knownSelection.current = node;
    const archive = node?.kind === "archive";
    if (id === shownSelection.current) {
      // Re-selecting the shown node only opens its panel; it is not a new history entry.
      setRoute(current => current.mode === "graph" && !current.panelOpen
        ? { ...current, selection: id, panelOpen: true, archive } : current);
      return;
    }
    navigate(current => current.mode === "graph" ? { ...current, selection: id, panelOpen: true, archive } : null);
  }, [navigate, setRoute]);
  const openSpec = (location: OpenSpecLocation) =>
    visit({ mode: "openspec", query: "", collection: location.collection, location });
  const viewInGraph = (id: string, node?: MetaprojectNode) => {
    if (node) knownSelection.current = node;
    visit({ mode: "graph", query: "", selection: id, panelOpen: true, archive: node?.kind === "archive" });
  };
  const openDocument = (node: MetaprojectNode, fragment?: string) => {
    switch (node.kind) {
      case "wiki": visit({ mode: "wiki", query: "", selection: node.id, fragment }); break;
      case "spec":
      case "change":
      case "archive": openSpec({ id: node.id, collection: node.kind, fragment }); break;
      default: viewInGraph(node.id, node);
    }
  };
  const openHit = (hit: MetaprojectHit) => {
    if (mode === "wiki") {
      if (hit.node.id === selection) return;
      navigate(current => current.mode === "wiki" ? { ...current, selection: hit.node.id, fragment: undefined } : null, { resetContent: true });
      return;
    }
    const v2 = protocol === 2 ? hit as MetaprojectHitV2 : null;
    if (v2?.source && v2.section && (v2.scope === "spec" || v2.scope === "change" || v2.scope === "archive")) {
      openSpec({ id: hit.node.id, collection: v2.scope, artifact: v2.source.path, digest: v2.source.digest, section: v2.section });
    } else select(hit.node.id);
  };
  const loadMoreSearch = async () => {
    if (protocol !== 2 || !resolvedSearch?.nextCursor || pageInFlight.current) return;
    const cursor = resolvedSearch.nextCursor;
    const generation = latestSearch.current.generation;
    const projectGeneration = project.current;
    const searchMode = resolvedSearch.mode;
    pageInFlight.current = true;
    try {
      const page = await (requestV2 ?? requestMetaprojectV2)(cwd, {
        version: 2, action: "search", query: searchQuery, cursor, expectedSnapshotId: resolvedSearch.snapshotId,
        ...(searchMode === "wiki" && { scopes: ["wiki"] }),
      });
      if (!("hits" in page) || generation !== latestSearch.current.generation || projectGeneration !== project.current || searchMode !== activeMode.current) return;
      if (page.snapshotId !== resolvedSearch.snapshotId) { setSnapshotMismatch(true); return; }
      setSearchResult(current => current?.nextCursor === cursor && current.snapshotId === page.snapshotId
        ? { mode: searchMode, query: current.query, snapshotId: current.snapshotId, hits: [...current.hits, ...page.hits], ...(page.nextCursor && { nextCursor: page.nextCursor }) }
        : current);
    } catch (cause) {
      if (generation === latestSearch.current.generation && projectGeneration === project.current)
        setSearchError({ query: searchQuery, message: errMessage(cause) });
    } finally { pageInFlight.current = false; }
  };
  // A rebuild outlives catalog reloads; only leaving the explorer (unmount, or a project
  // change, which remounts it) stops it from writing state.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const rebuild = async () => {
    setRebuilding(true);
    setError("");
    try {
      if ((await onRebuild()) && mounted.current) setRevision((value) => value + 1);
    } catch (cause) {
      if (mounted.current) setError(errMessage(cause));
    } finally {
      if (mounted.current) setRebuilding(false);
    }
  };
  const [unresolvedLink, setUnresolvedLink] = useState<{ selection: string; path: string; message: string } | null>(null);
  const openPath = (path: string, fragment: string | undefined, resolved: boolean) => {
    const from = selection;
    const unresolved = (message: string) => setUnresolvedLink({ selection: from, path, message });
    setUnresolvedLink(null);
    if (!resolved) { unresolved(`The link ${path} is not a valid repository path.`); return; }
    const loaded = nodes.find(item => item.path === path);
    if (loaded) { openDocument(loaded, fragment); return; }
    const snapshotId = catalog?.snapshotId;
    const generation = project.current;
    const current = () => generation === project.current && shownSelection.current === from && activeMode.current === "wiki";
    void (async () => {
      try {
        const result = await read(cwd, { action: "search", query: path });
        if (!current()) return;
        if (!("hits" in result)) throw new Error(`The lookup of ${path} returned no search results.`);
        if (result.snapshotId !== snapshotId) { setSnapshotMismatch(true); return; }
        const target = result.hits.find(hit => hit.node.path === path)?.node;
        if (target) openDocument(target, fragment);
        else unresolved(`No indexed project file at ${path}.`);
      } catch (cause) {
        if (current()) unresolved(`Could not look up ${path}: ${errMessage(cause)}`);
      }
    })();
  };
  const currentProjection = projection?.root === selection ? projection : null;
  const detailPanel = detail?.node.id === selection && detail.node.kind === "wiki" && (
    <article className="metaproject-article">
      <header className="metaproject-article-header">
        <h2>{detail.node.title}</h2>
        <p className="metaproject-meta">
          {[detail.node.pageType, detail.node.status, detail.node.path].filter(Boolean).join(" · ")}
        </p>
        <button className="btn btn-sm" onClick={() => viewInGraph(detail.node.id, detail.node)}><Icon name="branch" size={14} />View in Graph</button>
      </header>
      {unresolvedLink?.selection === selection && (
        <p className="metaproject-meta" role="status">{unresolvedLink.message}</p>
      )}
      {detail.markdown && (
        <RepositoryMarkdown text={detail.markdown} source={detail.node.path} openPath={openPath}
          fragment={route.mode === "wiki" ? route.fragment : undefined} />
      )}
    </article>
  );
  return (
    <section className="flows metaproject" ref={root} aria-label="Metaproject explorer">
      <header className="flows-toolbar metaproject-header">
        <div className="flows-heading"><h1>Metaproject</h1></div>
        {canGoBack && <button className="btn btn-sm" onClick={back}><Icon name="arrowLeft" size={14} />Back</button>}
        <label className="search-field">
          <Icon name="search" size={14} />
          <input
            type="search"
            aria-label="Search project knowledge"
            placeholder={mode === "openspec" ? "Search OpenSpec" : mode === "wiki" ? "Search Wiki" : "Search names, paths and wiki text"}
            value={query}
            onChange={event => { const query = event.target.value; setRoute(current => ({ ...current, query })); }}
          />
        </label>
        <div className="segmented" role="group" aria-label="View">
          <button
            aria-pressed={mode === "graph"}
            onClick={() => switchView("graph")}
          >
            <Icon name="branch" size={14} />
            Graph
          </button>
          <button
            aria-pressed={mode === "wiki"}
            onClick={() => switchView("wiki")}
          >
            <Icon name="file" size={14} />
            Wiki
          </button>
          <button aria-pressed={mode === "openspec"} onClick={() => switchView("openspec")}><Icon name="file" size={14} />OpenSpec</button>
        </div>
      </header>
      {protocolError && (
        <div className="inline-banner tone-warn" role="alert">
          <span>{protocolError}</span>
          <button className="btn btn-sm" onClick={() => setNegotiation(value => value + 1)}>Retry</button>
        </div>
      )}
      {protocol === 2 && <OpenSpecView
        cwd={cwd}
        active={route.mode === "openspec"}
        query={route.mode === "openspec" ? route.query : ""}
        location={route.mode === "openspec" ? route.location : null}
        collection={route.mode === "openspec" ? route.collection : "spec"}
        snapshot={catalog?.snapshotId}
        onLocation={location => navigate(current => current.mode === "openspec" && !sameLocation(current.location, location)
          ? { ...current, location } : null, { resetContent: true })}
        onCollection={collection => setRoute(current => current.mode === "openspec" ? { ...current, collection, location: null } : current)}
        onOpen={openSpec}
        {...(requestV2 && { request: requestV2 })}
        nodes={nodes}
        onNavigate={openDocument}
        onGraph={(id, node) => viewInGraph(id, node)}
      />}
      {mode === "openspec" && protocol !== 2 && !protocolError && <p role="status">{protocol === 1
        ? "This CLI does not support OpenSpec. Choose a newer CLI in Desktop Settings."
        : "Checking OpenSpec support…"}</p>}
      {mode !== "openspec" && loading && !protocolError && <div className="inline-banner tone-neutral" role="status">Loading project knowledge…</div>}
      {error && (
        <div className="inline-banner tone-warn" role="alert">
          <span>{error}</span>
          <button
            className="btn btn-sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {snapshotMismatch && (
        <div className="inline-banner tone-warn" role="alert">
          <span>Project knowledge changed while loading.</span>
          <button
            className="btn btn-sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh catalog
          </button>
        </div>
      )}
      {mode !== "openspec" && catalog && (
        <>
          {catalog.graph !== "ready" && (
            <div className="inline-banner tone-warn" role="status">
              <span>Graph {catalog.graph}. {catalog.graphReason}</span>
              <button
                className="btn metaproject-rebuild"
                disabled={rebuilding}
                onClick={() => void rebuild()}
              >
                {rebuilding ? "Rebuilding…" : "Rebuild graph"}
              </button>
            </div>
          )}
          {catalog.truncated && (
            <div className="inline-banner tone-neutral" role="status">Catalog is limited. Search for more results.</div>
          )}
          <div className={`metaproject-panes${mode === "graph" ? " metaproject-graph-panes" : ""}`}>
            <nav className="metaproject-list" aria-label="Search results">
              <h2>{searchQuery ? "Results" : "Catalog"}</h2>
              {searchFailure && (
                <div className="inline-banner tone-warn" role="alert">
                  <span>Search failed. {searchFailure}</span>
                  <button className="btn btn-sm" onClick={() => setSearchAttempt(value => value + 1)}>
                    Retry search
                  </button>
                </div>
              )}
              <ul>
                {results.map((hit) => (
                  <li key={`${hit.node.id}-${hit.section ?? ""}`}>
                    <button
                      className="metaproject-row"
                      aria-current={
                        selection === hit.node.id ? "true" : undefined
                      }
                      onClick={() => openHit(hit)}
                    >
                      <strong>{hit.node.title}</strong>
                      <span className="metaproject-meta">
                        {hit.node.kind} · {hit.node.path}
                      </span>
                      {hit.snippet && (
                        <small className="metaproject-snippet">
                          {hit.section ? `${hit.section}: ` : ""}
                          {hit.snippet}
                        </small>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {resolvedSearch?.nextCursor && <button className="btn" onClick={() => void loadMoreSearch()}>Load more results</button>}
              {!results.length && (
                searching
                  ? <p role="status">Searching project knowledge…</p>
                  : !searchFailure && !snapshotMismatch && <p>{searchQuery ? "No results." : "No indexed project knowledge."}</p>
              )}
            </nav>
            <section className="metaproject-content" ref={content} aria-label={mode === "wiki" ? "Wiki article" : "Relationship graph"}>
              {(detailError || relationshipError) && (
                <div className="inline-banner tone-warn" role="alert">
                  <span>{[detailError, relationshipError].filter(Boolean).join(" · ")}</span>
                  <button
                    className="btn btn-sm"
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    Retry
                  </button>
                </div>
              )}
              {mode === "wiki" && detailPanel}
              {mode === "wiki" && loadingDetail && <p role="status">Loading item…</p>}
              {mode === "graph" && (
                <>
                  <div className="metaproject-controls">
                    <label>
                      Direction{" "}
                      <select
                        className="select-compact"
                        value={direction}
                        onChange={(event) =>
                          setDirection(
                            event.target.value as MetaprojectDirection,
                          )
                        }
                      >
                        <option value="both">Both</option>
                        <option value="incoming">Incoming</option>
                        <option value="outgoing">Outgoing</option>
                      </select>
                    </label>
                    <label>
                      Depth{" "}
                      <select
                        className="select-compact"
                        value={depth}
                        onChange={(event) =>
                          setDepth(event.target.value === "2" ? 2 : 1)
                        }
                      >
                        <option value="1">1 step</option>
                        <option value="2">2 steps</option>
                      </select>
                    </label>
                    <fieldset>
                      <legend>Relationship types</legend>
                      {(protocol === 2 ? METAPROJECT_EDGE_KINDS_V2 : METAPROJECT_EDGE_KINDS).map((kind) => (
                        <label key={kind}>
                          <input
                            type="checkbox"
                            checked={kinds.includes(kind)}
                            onChange={(event) =>
                              setKinds((current) =>
                                event.target.checked
                                  ? [...current, kind]
                                  : current.filter((value) => value !== kind),
                              )
                            }
                          />
                          {kind}
                        </label>
                      ))}
                    </fieldset>
                  </div>
                  {loadingRelationships && <p role="status">Loading relationships…</p>}
                  {currentProjection && (catalog.graph !== "missing" || protocol === 2) && (
                    <Graph
                      projection={currentProjection}
                      selected={selection}
                      select={select}
                    />
                  )}
                </>
              )}
              {currentProjection && mode === "graph" && currentProjection.edges.length === 0 && (
                <p className="metaproject-meta">No relationships for these filters.</p>
              )}
              {currentProjection && mode === "graph" && currentProjection.edges.length > 0 && (
                <section className="metaproject-relationship-section">
                  <h2>Relationships</h2>
                  <RelationshipList projection={currentProjection} select={select} />
                </section>
              )}
              {currentProjection && mode === "wiki" && currentProjection.edges.length > 0 && (
                <details className="metaproject-relationship-section" key={selection}>
                  <summary>Relationships <span className="count-label">{currentProjection.edges.length}</span></summary>
                  <RelationshipList projection={currentProjection} select={id => {
                    const node = nodes.find(item => item.id === id); if (node) openDocument(node);
                  }} />
                </details>
              )}
              {mode === "wiki" && loadingRelationships && <p role="status">Loading relationships…</p>}
              {!selection && mode === "wiki" && searchQuery ? (
                <EmptyState icon="search" title={results.length ? `Choose a result for “${searchQuery}”` : `No Wiki page matches “${searchQuery}”`}
                  actions={<button className="btn btn-sm" onClick={() => setRoute(current => ({ ...current, query: "" }))}>Clear search</button>}>
                  {results.length ? "Pick a page from the results to read it." : searching ? "Searching the Wiki…" : "Clear the search to read the first Wiki page."}
                </EmptyState>
              ) : !selection && <p>{mode === "wiki" ? "Select a Wiki page to read it." : "Select an item to explore it."}</p>}
            </section>
            {panelOpen && activeNode && <GraphNodePanel
              node={activeNode}
              projection={documents?.root === selection ? documents : null}
              pending={documents?.root !== selection && !snapshotMismatch && !documentProblem}
              suggestedWiki={suggestedWiki?.root === selection ? suggestedWiki.node : undefined}
              problem={documentProblem || (snapshotMismatch ? "The project index changed. Refresh to look up linked documents." : "")}
              openSpec={protocol === 2}
              readPreview={preview}
              width={panelWidth}
              onResize={setPanelWidth}
              onClose={() => setRoute(current => current.mode === "graph" ? { ...current, panelOpen: false } : current)}
              onOpen={openDocument}
              onDraft={catalog.graph === "ready" && !documents?.truncated ? onDraft : undefined}
              onFind={kind => kind === "wiki"
                ? visit({ mode: "wiki", query: activeNode.path, selection: "" })
                : visit({ mode: "openspec", query: activeNode.title, collection: "spec", location: null })}
              onRetry={() => setRevision(value => value + 1)}
            />}
          </div>
        </>
      )}
    </section>
  );
}
