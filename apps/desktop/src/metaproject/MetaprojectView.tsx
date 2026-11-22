import cytoscape from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  METAPROJECT_NODE_LIMIT,
  type MetaprojectCatalog,
  type MetaprojectDetail,
  type MetaprojectDirection,
  type MetaprojectEdgeKind,
  type MetaprojectHit,
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
import { requestMetaproject } from "../platform/metaproject";
import "./metaproject.css";

type Request = (
  cwd: string,
  request: MetaprojectRequest,
) => Promise<MetaprojectResponse>;
const KINDS: MetaprojectEdgeKind[] = [
  "imports",
  "asset",
  "describes",
  "links",
  "contains",
  "defines",
  "calls",
];
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
}: {
  text: string;
  nodes: MetaprojectNode[];
  source: string;
  select: (id: string) => void;
}) {
  const html = useMemo(() => renderRepositoryMarkdown(text), [text]);
  return (
    <div
      className="md"
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

function RelationshipList({
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
          const evidence = edge.evidence?.join(" · ");
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
}) {
  return <Explorer key={props.cwd} {...props} />;
}

function Explorer({
  cwd,
  onRebuild,
  request = requestMetaproject,
}: {
  cwd: string;
  onRebuild: () => Promise<boolean>;
  request?: Request;
}) {
  const [catalog, setCatalog] = useState<MetaprojectCatalog | null>(null);
  const [selection, setSelection] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"graph" | "wiki">("graph");
  const [direction, setDirection] = useState<MetaprojectDirection>("both");
  const [depth, setDepth] = useState<1 | 2>(1);
  const [kinds, setKinds] = useState<MetaprojectEdgeKind[]>(
    KINDS.filter((kind) => kind !== "calls" && kind !== "defines"),
  );
  const [searchResult, setSearchResult] = useState<{
    query: string;
    snapshotId: string;
    hits: MetaprojectHit[];
  } | null>(null);
  const [snapshotMismatch, setSnapshotMismatch] = useState(false);
  const [detail, setDetail] = useState<MetaprojectDetail | null>(null);
  const [projection, setProjection] = useState<MetaprojectNeighbors | null>(
    null,
  );
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [searchError, setSearchError] = useState<{ query: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [revision, setRevision] = useState(0);
  const project = useRef(0);
  const loaded = useRef(false);
  const searchInFlight = useRef<Promise<MetaprojectResponse> | null>(null);
  const content = useRef<HTMLElement>(null);
  const graphIndex = useMemo(
    () => catalog && indexMetaprojectGraph(catalog.nodes, catalog.edges),
    [catalog],
  );
  const selectedNode = graphIndex?.byId.get(selection);
  const searchQuery = query.trim();
  useEffect(() => {
    const generation = ++project.current;
    setError("");
    if (!loaded.current) setLoading(true);
    void (async () => {
      try {
        const result = (await request(cwd, {
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
  }, [cwd, request, revision]);
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
        const pending = Promise.resolve().then(() => request(cwd, {
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
  }, [catalog, cwd, request, searchQuery]);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [mode, selection]);
  useEffect(() => {
    setDetail(null);
    setProjection(null);
    setDetailError("");
    if (!catalog || !selection) return;
    if (selectedNode && selectedNode.kind !== "wiki" && selectedNode.kind !== "symbol") {
      setDetail({ schemaVersion: catalog.schemaVersion, snapshotId: catalog.snapshotId, node: selectedNode });
      return;
    }
    let active = true;
    void (async () => {
      try {
        const result = (await request(cwd, {
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
      }
    })();
    return () => {
      active = false;
    };
  }, [catalog, cwd, request, selectedNode, selection]);
  useEffect(() => {
    setProjection(null);
    if (!catalog || !selection) return;
    const neighborsRequest = { action: "neighbors", id: selection, depth, direction, kinds } as const;
    if (
      graphIndex && selectedNode &&
      !catalog.truncated &&
      selectedNode.kind !== "symbol" &&
      !kinds.includes("calls") &&
      !kinds.includes("defines")
    ) {
      setProjection(projectMetaprojectGraph(graphIndex, catalog, neighborsRequest));
      return;
    }
    if (catalog.graph === "missing") return;
    let active = true;
    void (async () => {
      try {
        const result = (await request(cwd, neighborsRequest)) as MetaprojectNeighbors;
        if (active) {
          if (result.snapshotId !== catalog.snapshotId)
            setSnapshotMismatch(true);
          else if (result.root === selection) setProjection(result);
        }
      } catch (cause) {
        if (active) setDetailError(errMessage(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [graphIndex, selectedNode, catalog, cwd, request, selection, depth, direction, kinds]);
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
  const results = useMemo(() => {
    const needle = searchQuery.toLowerCase();
    const exact: MetaprojectHit[] = [];
    const local: MetaprojectHit[] = [];
    for (const node of catalog?.nodes ?? []) {
      const title = node.title.toLowerCase();
      const path = node.path.toLowerCase();
      if (needle && (title === needle || path === needle)) exact.push({ node });
      else if (title.includes(needle) || path.includes(needle)) local.push({ node });
    }
    const remote = new Map(hits.map(hit => [hit.node.id, hit]));
    const ranked = new Map<string, MetaprojectHit>();
    for (const batch of [exact, hits, local]) {
      for (const hit of batch) {
        if (!ranked.has(hit.node.id)) ranked.set(hit.node.id, remote.get(hit.node.id) ?? hit);
        if (ranked.size === METAPROJECT_NODE_LIMIT) return [...ranked.values()];
      }
    }
    return [...ranked.values()];
  }, [catalog, hits, searchQuery]);
  const select = useMemo(() => (id: string) => setSelection(id), []);
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
      {detail.markdown && (
        <RepositoryMarkdown text={detail.markdown} nodes={nodes} source={detail.node.path} select={select} />
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
        </div>
      </header>
      {loading && <div className="inline-banner tone-neutral" role="status">Loading project knowledge…</div>}
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
      {catalog && (
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
              {searchFailure && <p role="alert">Search failed. {searchFailure}</p>}
              <ul>
                {results.map((hit) => (
                  <li key={hit.node.id}>
                    <button
                      className="metaproject-row"
                      aria-current={
                        selection === hit.node.id ? "true" : undefined
                      }
                      onClick={() => select(hit.node.id)}
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
              {!results.length && (
                searching
                  ? <p role="status">Searching project knowledge…</p>
                  : !searchFailure && !snapshotMismatch && <p>{searchQuery ? "No results." : "No indexed project knowledge."}</p>
              )}
            </nav>
            <section className="metaproject-content" ref={content} aria-label={mode === "wiki" ? "Wiki article" : "Relationship graph"}>
              {detailError && (
                <div className="inline-banner tone-warn" role="alert">
                  <span>{detailError}</span>
                  <button
                    className="btn btn-sm"
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    Retry
                  </button>
                </div>
              )}
              {mode === "wiki" && detailPanel}
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
                      {KINDS.map((kind) => (
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
                  {currentProjection && catalog.graph !== "missing" && (
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
              {mode === "graph" && detailPanel}
              {!selection && <p>Select an item to explore it.</p>}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
