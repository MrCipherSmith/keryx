import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { EmptyState, useEscape } from "../components/ui";
import { errMessage } from "../lib/format";
import { openExternal } from "../platform/commands";
import { negotiateMetaproject, requestMetaproject, requestMetaprojectV2 } from "../platform/metaproject";
import { OpenSpecView, type OpenSpecLocation } from "./OpenSpecView";
import { NodeDetailsPanel } from "./NodeDetailsPanel";
import { RelationshipGraph, type CytoscapeFactory } from "./RelationshipGraph";
import { RelationshipList } from "./RelationshipList";
import { RELATIONSHIP_KIND_LABELS } from "./labels";
import { useExplorerNavigation } from "./useExplorerNavigation";
import "./metaproject.css";

type Request = (
  cwd: string,
  request: MetaprojectRequest,
) => Promise<MetaprojectResponse>;
const EMPTY_HITS: readonly MetaprojectHit[] = [];
const DOCUMENT_EDGES = ["describes", "links"] as const;
const sameLocation = (left: OpenSpecLocation | null, right: OpenSpecLocation | null) =>
  left === right || (left !== null && right !== null && left.id === right.id && left.collection === right.collection &&
    left.artifact === right.artifact && left.section === right.section && left.digest === right.digest && left.fragment === right.fragment);

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

type Negotiate = (cwd: string) => Promise<1 | 2>;

export function MetaprojectView(props: {
  cwd: string;
  onRebuild: () => Promise<boolean>;
  onDraft?: (task: string) => Promise<void>;
  request?: Request;
  requestV2?: (cwd: string, request: MetaprojectRequestV2) => Promise<MetaprojectV2Response>;
  /** Protocol negotiation; given, it runs even when `request`/`requestV2` are injected. */
  negotiate?: Negotiate;
  /** Test seam for the graph canvas (happy-dom has none); the app passes nothing. */
  createCytoscape?: CytoscapeFactory;
}) {
  return <Explorer key={props.cwd} {...props} />;
}

/** Every relationship kind except the symbol layer (`defines`, `calls`). */
const SYMBOL_KINDS: readonly MetaprojectEdgeKind[] = ["defines", "calls"];
const withoutSymbolKinds = (kinds: readonly MetaprojectEdgeKind[]) => kinds.filter(kind => !SYMBOL_KINDS.includes(kind));
const WIKI_KINDS_V1 = withoutSymbolKinds(METAPROJECT_EDGE_KINDS);
const WIKI_KINDS_V2 = withoutSymbolKinds(METAPROJECT_EDGE_KINDS_V2);
const NO_SYMBOL_LAYER = "Not available: this project's graph has no symbol layer.";
const sameKinds = (left: readonly MetaprojectEdgeKind[], right: readonly MetaprojectEdgeKind[]) =>
  left.length === right.length && left.every(kind => right.includes(kind));

const DIRECTION_LABELS: Record<MetaprojectDirection, string> = { both: "Both", incoming: "Incoming", outgoing: "Outgoing" };
const POPOVER_WIDTH = 320;

/**
 * A non-modal dialog anchored under its button, built on the app's menu surface (`.menu`): focus
 * moves in on open; Escape or a press outside calls `onClose`, which gives focus back to the button.
 */
function FiltersPopover({ id, anchor, onClose, children }: { id: string; anchor: HTMLElement; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const close = useRef(onClose);
  close.current = onClose;
  useEscape(() => close.current());
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    // Right-aligned with the button (it sits at the end of the graph header), kept inside the window.
    const left = Math.max(8, Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8));
    setPosition({ left, top: rect.bottom + 4 });
  }, [anchor]);
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLElement>("select, button:not([disabled])")?.focus();
  }, []);
  useLayoutEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.contains(target)) return;
      close.current();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [anchor]);
  return (
    <div ref={panel} id={id} className="menu metaproject-filters-pop" role="dialog" aria-label="Graph filters"
      style={{ ...position, width: POPOVER_WIDTH }}>
      {children}
    </div>
  );
}

function Explorer({
  cwd,
  onRebuild,
  onDraft,
  request = requestMetaproject,
  requestV2,
  negotiate,
  createCytoscape,
}: {
  cwd: string;
  onRebuild: () => Promise<boolean>;
  onDraft?: (task: string) => Promise<void>;
  request?: Request;
  requestV2?: (cwd: string, request: MetaprojectRequestV2) => Promise<MetaprojectV2Response>;
  negotiate?: Negotiate;
  createCytoscape?: CytoscapeFactory;
}) {
  const symbolReasonId = useId();
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
  const defaultKinds = protocol === 2 ? WIKI_KINDS_V2 : WIKI_KINDS_V1;
  const filtersChanged = direction !== "both" || depth !== 1 || !sameKinds(kinds, defaultKinds);
  const resetFilters = () => { setDirection("both"); setDepth(1); setKinds(defaultKinds); };
  const [revealRelationships, setRevealRelationships] = useState(0);
  // Open or closed is explorer state like the filters: it survives a view or tab switch and is not a history entry.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersAnchor, setFiltersAnchor] = useState<HTMLButtonElement | null>(null);
  const filtersDialogId = useId();
  // The freshness reason is shown on demand; remembering which reason was opened closes it when the text changes.
  const [freshnessReason, setFreshnessReason] = useState<string | null>(null);
  const freshnessReasonId = useId();
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
  // Every node this explorer has shown or opened, so Back to one shows its panel at once even
  // when it is not among the catalog, hits or current projection (for example a lookup result).
  const seenNodes = useRef(new Map<string, MetaprojectNode>());
  const remember = (node: MetaprojectNode) => { seenNodes.current.set(node.id, node); };
  for (const node of nodes) remember(node);
  const activeNode = nodes.find(node => node.id === selection) ?? seenNodes.current.get(selection);
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
    const node = graphNodes.current.find(item => item.id === id) ?? seenNodes.current.get(id);
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
    if (node) remember(node);
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
  // While the next selection's relationships load, the last graph stays on screen, marked busy;
  // a failed read or leaving Graph drops it.
  const lastGraph = useRef<MetaprojectNeighbors | null>(null);
  if (mode !== "graph" || relationshipError) lastGraph.current = null;
  else if (currentProjection) lastGraph.current = currentProjection;
  // A projection for another root means the read for this selection has not started yet.
  const relationshipsLoading = loadingRelationships || (projection !== null && projection.root !== selection);
  const graphProjection = mode !== "graph" ? null : currentProjection ?? (relationshipsLoading ? lastGraph.current : null);
  const graphBusy = graphProjection !== null && graphProjection !== currentProjection;
  const showGraph = catalog !== null && (catalog.graph !== "missing" || protocol === 2);
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selection, mode]);
  const shownTotal = catalog ? mode === "wiki" ? catalog.counts.wiki : catalog.counts.files + catalog.counts.wiki + catalog.counts.modules : 0;
  const listHeading = searchQuery ? `Results · ${results.length}` : `Catalog · ${results.length} of ${Math.max(shownTotal, results.length)}`;
  const showHidden = useCallback(() => {
    setRoute(current => current.mode === "graph" && !current.panelOpen ? { ...current, panelOpen: true } : current);
    setRevealRelationships(value => value + 1);
  }, [setRoute]);
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
  const kindChoices = protocol === 2 ? METAPROJECT_EDGE_KINDS_V2 : METAPROJECT_EDGE_KINDS;
  const kindsOn = kindChoices.filter(kind => kinds.includes(kind) && !(SYMBOL_KINDS.includes(kind) && !catalog?.hasSymbolLayer)).length;
  const changedSettings = (direction !== "both" ? 1 : 0) + (depth !== 1 ? 1 : 0) + (sameKinds(kinds, defaultKinds) ? 0 : 1);
  const filterSummary = `${DIRECTION_LABELS[direction]} · ${depth === 1 ? "1 step" : "2 steps"} · ${kindsOn} of ${kindChoices.length} types`;
  const closeFilters = () => { setFiltersOpen(false); filtersAnchor?.focus(); };
  // One element for the button: in the graph's header when a graph is drawn, otherwise in a slim row of its own.
  const filtersButton = (
    <button ref={setFiltersAnchor} type="button" className="chip-btn metaproject-filters-toggle"
      aria-haspopup="dialog" aria-expanded={filtersOpen} aria-controls={filtersOpen ? filtersDialogId : undefined}
      data-changed={changedSettings ? "true" : undefined} title={filterSummary}
      onClick={() => setFiltersOpen(open => !open)}>
      {changedSettings ? `Filters · ${changedSettings}` : "Filters"}<Icon name="chevronDown" size={12} />
    </button>
  );
  const filters = filtersOpen && filtersAnchor && (
    <FiltersPopover id={filtersDialogId} anchor={filtersAnchor} onClose={closeFilters}>
      <div className="metaproject-filters-pop-row">
        <label className="metaproject-filter">
          <span>Direction</span>
          <select className="select-compact" aria-label="Direction" value={direction}
            onChange={event => setDirection(event.target.value as MetaprojectDirection)}>
            <option value="both">Both</option>
            <option value="incoming">Incoming</option>
            <option value="outgoing">Outgoing</option>
          </select>
        </label>
        <label className="metaproject-filter">
          <span>Depth</span>
          <select className="select-compact" aria-label="Depth" value={depth}
            onChange={event => setDepth(event.target.value === "2" ? 2 : 1)}>
            <option value="1">1 step</option>
            <option value="2">2 steps</option>
          </select>
        </label>
      </div>
      <div className="menu-header">Relationship types · {kindsOn} of {kindChoices.length}</div>
      <div className="metaproject-kind-chips" role="group" aria-label="Relationship types">
        {kindChoices.map(kind => {
          const unavailable = SYMBOL_KINDS.includes(kind) && !catalog?.hasSymbolLayer;
          const on = kinds.includes(kind) && !unavailable;
          return (
            <button key={kind} type="button" className="chip-btn" aria-pressed={on} disabled={unavailable}
              aria-describedby={unavailable ? symbolReasonId : undefined} title={unavailable ? NO_SYMBOL_LAYER : undefined}
              onClick={() => setKinds(current => current.includes(kind) ? current.filter(value => value !== kind) : [...current, kind])}>
              {on && <Icon name="check" size={12} />}{RELATIONSHIP_KIND_LABELS[kind]}
            </button>
          );
        })}
      </div>
      {catalog && !catalog.hasSymbolLayer && <p id={symbolReasonId} className="metaproject-filter-note">{NO_SYMBOL_LAYER}</p>}
      {filtersChanged && (
        <div className="menu-footer metaproject-filters-pop-footer">
          <button type="button" className="btn btn-ghost btn-sm" onClick={resetFilters}>Reset filters</button>
        </div>
      )}
    </FiltersPopover>
  );
  const freshnessOpen = Boolean(catalog?.graphReason) && freshnessReason === catalog?.graphReason;
  const wikiEmptyTitle =searching ? `Searching the Wiki for “${searchQuery}”…`
    : results.length ? `Choose a result for “${searchQuery}”` : `No Wiki page matches “${searchQuery}”`;
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
          <button aria-pressed={mode === "graph"} onClick={() => switchView("graph")}><Icon name="branch" size={14} />Graph</button>
          <button aria-pressed={mode === "wiki"} onClick={() => switchView("wiki")}><Icon name="file" size={14} />Wiki</button>
          <button aria-pressed={mode === "openspec"} onClick={() => switchView("openspec")}><Icon name="file" size={14} />OpenSpec</button>
        </div>
      </header>
      {protocolError && (
        <div className="inline-banner tone-warn" role="alert">
          <span>{protocolError}</span>
          <button className="btn btn-sm" onClick={() => setNegotiation(value => value + 1)}>Retry</button>
        </div>
      )}
      {error && (
        <div className="inline-banner tone-warn" role="alert">
          <span>{error}</span>
          <button className="btn btn-sm" onClick={() => setRevision(value => value + 1)}>Retry</button>
        </div>
      )}
      {snapshotMismatch && (
        <div className="inline-banner tone-warn" role="alert">
          <span>Project knowledge changed while loading.</span>
          <button className="btn btn-sm" onClick={() => setRevision(value => value + 1)}>Refresh catalog</button>
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
      {mode !== "openspec" && catalog && (
        <>
          {catalog.graph !== "ready" && (
            <div className="inline-banner tone-warn metaproject-freshness" role="status">
              <span className="metaproject-freshness-state">Graph is {catalog.graph}.</span>
              {catalog.graphReason && (
                <button type="button" className="btn btn-ghost btn-sm metaproject-freshness-toggle" aria-expanded={freshnessOpen}
                  aria-controls={freshnessReasonId} onClick={() => setFreshnessReason(freshnessOpen ? null : catalog.graphReason ?? null)}>
                  Details<Icon name={freshnessOpen ? "chevronUp" : "chevronDown"} size={12} />
                </button>
              )}
              {freshnessOpen && <p id={freshnessReasonId} className="metaproject-freshness-reason">{catalog.graphReason}</p>}
              <button className="btn metaproject-rebuild" disabled={rebuilding} onClick={() => void rebuild()}>
                {rebuilding ? "Rebuilding…" : "Rebuild graph"}
              </button>
            </div>
          )}
          <div className={`metaproject-panes${mode === "graph" ? " metaproject-graph-panes" : ""}`}>
            <nav className="metaproject-list" aria-label="Search results" ref={list}>
              <h2>{listHeading}</h2>
              {searchFailure && (
                <div className="inline-banner tone-warn" role="alert">
                  <span>Search failed. {searchFailure}</span>
                  <button className="btn btn-sm" onClick={() => setSearchAttempt(value => value + 1)}>Retry search</button>
                </div>
              )}
              <ul>
                {results.map(hit => (
                  <li key={`${hit.node.id}-${hit.section ?? ""}`}>
                    <button className="metaproject-row" aria-current={selection === hit.node.id ? "true" : undefined} onClick={() => openHit(hit)}>
                      <strong>{hit.node.title}</strong>
                      <span className="metaproject-meta">{hit.node.kind} · {hit.node.path}</span>
                      {hit.snippet && (
                        <small className="metaproject-snippet">{hit.section ? `${hit.section}: ` : ""}{hit.snippet}</small>
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
              {(detailError || (mode === "wiki" && relationshipError)) && (
                <div className="inline-banner tone-warn" role="alert">
                  <span>{[detailError, mode === "wiki" ? relationshipError : ""].filter(Boolean).join(" · ")}</span>
                  <button className="btn btn-sm" onClick={() => setRevision(value => value + 1)}>Retry</button>
                </div>
              )}
              {mode === "wiki" && detailPanel}
              {mode === "wiki" && loadingDetail && <p role="status">Loading item…</p>}
              {mode === "graph" && !(graphProjection && showGraph) && <div className="metaproject-filter-strip">{filtersButton}</div>}
              {mode === "graph" && filters}
              {mode === "graph" && relationshipError && !panelOpen && (
                <div className="inline-banner tone-warn" role="alert">
                  <span>{relationshipError}</span>
                  <button className="btn btn-sm" onClick={() => setRevision(value => value + 1)}>Retry</button>
                </div>
              )}
              {mode === "graph" && relationshipsLoading && !graphProjection && <p role="status">Loading relationships…</p>}
              {graphProjection && showGraph && (
                <RelationshipGraph projection={graphProjection} busy={graphBusy} onSelect={select} onShowHidden={showHidden}
                  actions={filtersButton} {...(createCytoscape && { createCytoscape })} />
              )}
              {mode === "graph" && currentProjection && !showGraph && (
                <p className="metaproject-meta">The graph is not built yet. Open the panel's Relationships tab to see this node's links.</p>
              )}
              {currentProjection && mode === "wiki" && currentProjection.edges.length > 0 && (
                <details className="metaproject-relationship-section" key={selection}>
                  <summary>Relationships <span className="count-label">{currentProjection.edges.length}</span></summary>
                  <RelationshipList projection={currentProjection} select={id => {
                    const node = nodes.find(item => item.id === id) ?? seenNodes.current.get(id); if (node) openDocument(node);
                  }} />
                </details>
              )}
              {mode === "wiki" && loadingRelationships && <p role="status">Loading relationships…</p>}
              {!selection && mode === "wiki" && searchQuery ? (
                <EmptyState icon="search" title={wikiEmptyTitle}
                  actions={<button className="btn btn-sm" onClick={() => setRoute(current => ({ ...current, query: "" }))}>Clear search</button>}>
                  {results.length ? "Pick a page from the results to read it." : searching ? "Results appear here as soon as the search finishes." : "Clear the search to read the first Wiki page."}
                </EmptyState>
              ) : !selection && <p>{mode === "wiki" ? "Select a Wiki page to read it." : "Select an item to explore it."}</p>}
            </section>
            {panelOpen && activeNode && <NodeDetailsPanel
              node={activeNode}
              relationships={currentProjection}
              relationshipsPending={relationshipsLoading}
              relationshipsProblem={relationshipError}
              revealRelationships={revealRelationships}
              documents={documents?.root === selection ? documents : null}
              documentsPending={documents?.root !== selection && !snapshotMismatch && !documentProblem}
              documentsProblem={documentProblem || (snapshotMismatch ? "The project index changed. Refresh to look up linked documents." : "")}
              suggestedWiki={suggestedWiki?.root === selection ? suggestedWiki.node : undefined}
              openSpec={protocol === 2}
              readPreview={preview}
              width={panelWidth}
              onResize={setPanelWidth}
              onClose={() => setRoute(current => current.mode === "graph" ? { ...current, panelOpen: false } : current)}
              onSelect={select}
              onOpen={openDocument}
              onFind={kind => kind === "wiki"
                ? visit({ mode: "wiki", query: activeNode.path, selection: "" })
                : visit({ mode: "openspec", query: activeNode.title, collection: "spec", location: null })}
              onDraft={catalog.graph === "ready" && !documents?.truncated ? onDraft : undefined}
              onRetry={() => setRevision(value => value + 1)}
            />}
          </div>
        </>
      )}
    </section>
  );
}
