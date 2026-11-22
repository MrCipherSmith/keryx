import cytoscape from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  rankMetaprojectSearchHits,
  METAPROJECT_EDGE_KINDS,
  METAPROJECT_EDGE_KINDS_V2,
  type MetaprojectCatalog,
  type MetaprojectDetail,
  type MetaprojectDetailV2,
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
import { errMessage } from "../lib/format";
import { openExternal } from "../platform/commands";
import { negotiateMetaproject, requestMetaproject, requestMetaprojectV2 } from "../platform/metaproject";
import { OpenSpecView, type OpenSpecLocation } from "./OpenSpecView";
import "./metaproject.css";

type Request = (
  cwd: string,
  request: MetaprojectRequest,
) => Promise<MetaprojectResponse>;
const EMPTY_HITS: readonly MetaprojectHit[] = [];
const GRAPH_PADDING = 36;

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
    });
    graph.on("tap", "node", (event) => select(event.target.id()));
    const observer = new ResizeObserver(() => {
      if (viewport.clientWidth && viewport.clientHeight) graph.resize().fit(undefined, GRAPH_PADDING);
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      graph.destroy();
    };
  }, [projection, selected, select]);
  return (
    <div className="metaproject-graph" ref={container} aria-hidden="true" />
  );
}

function RepositoryMarkdown({
  text,
  nodes,
  source,
  select,
  fragment,
}: {
  text: string;
  nodes: MetaprojectNode[];
  source: string;
  select: (id: string) => void;
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
        const path = href.split("#")[0];
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
        const parts = (
          source.slice(0, source.lastIndexOf("/") + 1) + path
        ).split("/");
        const resolved: string[] = [];
        for (const part of parts) {
          if (part === "..") resolved.pop();
          else if (part && part !== ".") resolved.push(part);
        }
        const node = nodes.find((item) => item.path === resolved.join("/"));
        if (node) select(node.id);
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

export function MetaprojectView(props: {
  cwd: string;
  onRebuild: () => Promise<boolean>;
  request?: Request;
  requestV2?: (cwd: string, request: MetaprojectRequestV2) => Promise<MetaprojectV2Response>;
}) {
  return <Explorer key={props.cwd} {...props} />;
}

function Explorer({
  cwd,
  onRebuild,
  request = requestMetaproject,
  requestV2,
}: {
  cwd: string;
  onRebuild: () => Promise<boolean>;
  request?: Request;
  requestV2?: (cwd: string, request: MetaprojectRequestV2) => Promise<MetaprojectV2Response>;
}) {
  const [catalog, setCatalog] = useState<MetaprojectCatalog | null>(null);
  const [selection, setSelection] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"graph" | "wiki" | "openspec">("graph");
  const [protocol, setProtocol] = useState<1 | 2 | null>(requestV2 ? 2 : request === requestMetaproject ? null : 1);
  const archiveSelection = useRef(false);
  const [protocolError, setProtocolError] = useState("");
  useEffect(() => {
    if (requestV2 || request !== requestMetaproject) return;
    let active = true;
    void negotiateMetaproject(cwd).then(value => { if (active) setProtocol(value); }).catch(cause => { if (active) setProtocolError(errMessage(cause)); });
    return () => { active = false; };
  }, [cwd, request, requestV2]);
  const read: Request = useMemo(() => protocol === 2
    ? ((root, input) => (requestV2 ?? requestMetaprojectV2)(root, { ...input, version: 2, ...(input.action === "neighbors" && archiveSelection.current ? { includeArchive: true } : {}) }) as unknown as Promise<MetaprojectResponse>)
    : request, [protocol, request, requestV2]);
  const [openLocation, setOpenLocation] = useState<OpenSpecLocation | null>(null);
  const [wikiFragment, setWikiFragment] = useState<string | undefined>();
  archiveSelection.current = openLocation?.collection === "archive" && openLocation.id === selection;
  const [direction, setDirection] = useState<MetaprojectDirection>("both");
  const [depth, setDepth] = useState<1 | 2>(1);
  const [kinds, setKinds] = useState<MetaprojectEdgeKind[]>(
    METAPROJECT_EDGE_KINDS.filter((kind) => kind !== "calls" && kind !== "defines"),
  );
  useEffect(() => {
    if (protocol === 2) setKinds(current => [...new Set<MetaprojectEdgeKind>([...current, "changes-spec", "spec-context"])]);
  }, [protocol]);
  const [searchResult, setSearchResult] = useState<{
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
  const searchInFlight = useRef<Promise<MetaprojectResponse> | null>(null);
  const pageInFlight = useRef(false);
  const latestSearch = useRef({ query: "", snapshot: "", generation: 0 });
  const content = useRef<HTMLElement>(null);
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
        setSelection((current) =>
          result.nodes.some((node) => node.id === current)
            ? current
            : result.nodes[0]?.id || "",
        );
      } catch (cause) {
        if (generation === project.current) setError(errMessage(cause));
      } finally {
        if (generation === project.current) setLoading(false);
      }
    })();
    return () => {
      project.current++;
    };
  }, [cwd, read, revision, protocol]);
  useEffect(() => {
    if (!catalog || !searchQuery) {
      setSearchResult(null);
      setSearchError(null);
      return;
    }
    setSearchResult(null);
    setSearchError(null);
    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        const previous = searchInFlight.current;
        if (previous) await previous.catch(() => {});
        if (!active) return;
        const pending = Promise.resolve().then(() => read(cwd, {
            action: "search",
            query: searchQuery,
        }));
        searchInFlight.current = pending;
        try {
          const result = (await pending) as MetaprojectSearch;
          if (active) {
            if (result.snapshotId !== catalog.snapshotId)
              setSnapshotMismatch(true);
            else {
              setSearchResult({
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
  }, [catalog, cwd, read, searchQuery, searchAttempt]);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [mode, selection]);
  useEffect(() => {
    setDetail(null);
    setLoadingDetail(false);
    setDetailError("");
    if (!catalog || !selection) return;
    if (selectedNode && selectedNode.kind !== "wiki" && selectedNode.kind !== "symbol" && selectedNode.kind !== "spec" && selectedNode.kind !== "change" && selectedNode.kind !== "archive") {
      setDetail({ schemaVersion: catalog.schemaVersion, snapshotId: catalog.snapshotId, node: selectedNode });
      return;
    }
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
  }, [catalog, cwd, read, selectedNode, selection]);
  useEffect(() => {
    setProjection(null);
    setRelationshipError("");
    setLoadingRelationships(false);
    if (!catalog || !selection) return;
    const neighborsRequest = { action: "neighbors", id: selection, depth, direction, kinds } as const;
    if (
      protocol !== 2 && graphIndex && selectedNode &&
      !catalog.truncated &&
      selectedNode.kind !== "symbol" &&
      !kinds.includes("calls") &&
      !kinds.includes("defines")
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
  }, [graphIndex, selectedNode, catalog, cwd, read, selection, depth, direction, kinds, protocol]);
  const resolvedSearch =
    searchResult?.query === searchQuery &&
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
  const results = useMemo(
    () => protocol === 2 && searchQuery ? hits : rankMetaprojectSearchHits(searchQuery, catalog?.nodes ?? [], hits),
    [catalog, hits, searchQuery, protocol],
  );
  const select = useMemo(() => (id: string) => setSelection(id), []);
  const openHit = (hit: MetaprojectHit) => {
    const v2 = protocol === 2 ? hit as MetaprojectHitV2 : null;
    if (v2 && (v2.scope === "spec" || v2.scope === "change" || v2.scope === "archive")) {
      setOpenLocation({ id: hit.node.id, collection: v2.scope, ...(v2.source && { artifact: v2.source.path, digest: v2.source.digest }), ...(v2.section && { section: v2.section }) });
      setSelection(hit.node.id); setMode("openspec");
    } else select(hit.node.id);
  };
  const loadMoreSearch = async () => {
    if (protocol !== 2 || !resolvedSearch?.nextCursor || pageInFlight.current) return;
    const cursor = resolvedSearch.nextCursor;
    const generation = latestSearch.current.generation;
    const projectGeneration = project.current;
    pageInFlight.current = true;
    try {
      const page = await (requestV2 ?? requestMetaprojectV2)(cwd, {
        version: 2, action: "search", query: searchQuery, cursor, expectedSnapshotId: resolvedSearch.snapshotId,
      });
      if (!("hits" in page) || generation !== latestSearch.current.generation || projectGeneration !== project.current) return;
      if (page.snapshotId !== resolvedSearch.snapshotId) { setSnapshotMismatch(true); return; }
      setSearchResult(current => current?.nextCursor === cursor && current.snapshotId === page.snapshotId
        ? { query: current.query, snapshotId: current.snapshotId, hits: [...current.hits, ...page.hits], ...(page.nextCursor && { nextCursor: page.nextCursor }) }
        : current);
    } catch (cause) {
      if (generation === latestSearch.current.generation && projectGeneration === project.current)
        setSearchError({ query: searchQuery, message: errMessage(cause) });
    } finally { pageInFlight.current = false; }
  };
  const rebuild = async () => {
    const generation = project.current;
    setRebuilding(true);
    setError("");
    try {
      if ((await onRebuild()) && generation === project.current)
        setRevision((value) => value + 1);
    } catch (cause) {
      if (generation === project.current) setError(errMessage(cause));
    } finally {
      if (generation === project.current) setRebuilding(false);
    }
  };
  const currentProjection = projection?.root === selection ? projection : null;
  const detailPanel = detail?.node.id === selection && (
    <article className="metaproject-article">
      <header className="metaproject-article-header">
        <h2>{detail.node.title}</h2>
        <p className="metaproject-meta">
          {[detail.node.kind, detail.node.pageType, detail.node.status, detail.node.path]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>
      {protocol === 2 && (detail.node.kind === "spec" || detail.node.kind === "change" || detail.node.kind === "archive") && <button className="btn" onClick={() => { setOpenLocation(openLocation?.id === detail.node.id ? openLocation : { id: detail.node.id, collection: detail.node.kind as "spec" | "change" | "archive" }); setMode("openspec"); }}>Open in OpenSpec</button>}
      {(detail as unknown as MetaprojectDetailV2).openSpec?.artifact && (
        <RepositoryMarkdown text={(detail as unknown as MetaprojectDetailV2).openSpec?.artifact?.markdown ?? ""} nodes={nodes} source={(detail as unknown as MetaprojectDetailV2).openSpec?.artifact?.source.path ?? detail.node.path} select={select} />
      )}
      {detail.markdown && (
        <RepositoryMarkdown text={detail.markdown} nodes={nodes} source={detail.node.path} select={select} fragment={wikiFragment} />
      )}
    </article>
  );
  return (
    <section className="flows metaproject" aria-label="Metaproject explorer">
      <header className="flows-toolbar metaproject-header">
        <div className="flows-heading"><h1>Metaproject</h1></div>
        <label className="search-field">
          <Icon name="search" size={14} />
          <input
            type="search"
            aria-label="Search project knowledge"
            placeholder="Search names, paths and wiki text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="segmented" role="group" aria-label="View">
          <button
            aria-pressed={mode === "graph"}
            onClick={() => setMode("graph")}
          >
            <Icon name="branch" size={14} />
            Graph
          </button>
          <button
            aria-pressed={mode === "wiki"}
            onClick={() => setMode("wiki")}
          >
            <Icon name="file" size={14} />
            Wiki
          </button>
          <button aria-pressed={mode === "openspec"} onClick={() => setMode("openspec")}><Icon name="file" size={14} />OpenSpec</button>
        </div>
      </header>
      {protocolError && <div className="inline-banner tone-warn" role="alert">{protocolError}</div>}
      {mode === "openspec" && (protocol === 2 ? <OpenSpecView cwd={cwd} query={query} location={openLocation} onLocation={setOpenLocation} {...(requestV2 && { request: requestV2 })} nodes={nodes} onNavigate={(node, fragment) => { setSelection(node.id); setWikiFragment(fragment); setMode(node.kind === "wiki" ? "wiki" : "graph"); }} onGraph={id => { setSelection(id); setMode("graph"); }} /> : protocol === 1 ? <p role="status">This CLI does not support OpenSpec. Choose a newer CLI in Desktop Settings.</p> : <p role="status">Checking OpenSpec support…</p>)}
      {mode !== "openspec" && loading && <div className="inline-banner tone-neutral" role="status">Loading project knowledge…</div>}
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
          <div className="metaproject-panes">
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
              {currentProjection && mode === "graph" && (
                <section className="metaproject-relationship-section">
                  <h2>Relationships</h2>
                  <RelationshipList projection={currentProjection} select={select} />
                </section>
              )}
              {currentProjection && mode === "wiki" && currentProjection.edges.length > 0 && (
                <details className="metaproject-relationship-section" key={selection}>
                  <summary>Relationships <span className="count-label">{currentProjection.edges.length}</span></summary>
                  <RelationshipList projection={currentProjection} select={select} />
                </details>
              )}
              {mode === "wiki" && loadingRelationships && <p role="status">Loading relationships…</p>}
              {mode === "graph" && detailPanel}
              {mode === "graph" && loadingDetail && <p role="status">Loading item…</p>}
              {!selection && <p>Select an item to explore it.</p>}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
