import cytoscape from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MetaprojectCatalog,
  MetaprojectDetail,
  MetaprojectDirection,
  MetaprojectEdge,
  MetaprojectEdgeKind,
  MetaprojectHit,
  MetaprojectNeighbors,
  MetaprojectNode,
  MetaprojectRequest,
  MetaprojectResponse,
  MetaprojectSearch,
} from "../../../../src/integrations/metaproject-explorer-contract";
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
  "describes",
  "links",
  "contains",
  "defines",
  "calls",
];

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
    if (!container.current) return;
    const theme = getComputedStyle(container.current);
    const color = (token: string, fallback: string) =>
      theme.getPropertyValue(token).trim() || fallback;
    const neighbors = projection.nodes.filter((node) => node.id !== selected);
    const positions = new Map(neighbors.map((node, index) => [node.id, index]));
    const graph = cytoscape({
      container: container.current,
      elements: [
        ...projection.nodes.map((node) => {
          const index = positions.get(node.id) ?? 0;
          const angle = (2 * Math.PI * index) / Math.max(neighbors.length, 1);
          return {
            data: {
              id: node.id,
              label: node.title,
              selected: node.id === selected,
            },
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
          selector: 'node[selected = "true"]',
          style: {
            "background-color": color("--accent", "#67b5a4"),
            width: 38,
            height: 38,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1,
            "line-color": color("--border", "#738798"),
            "target-arrow-color": color("--border", "#738798"),
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
          },
        },
      ],
      layout: { name: "preset", fit: true, padding: 36 },
    });
    graph.on("tap", "node", (event) => select(event.target.id()));
    return () => graph.destroy();
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
  const [searchError, setSearchError] = useState("");
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [revision, setRevision] = useState(0);
  const project = useRef(0);
  const loaded = useRef(false);
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
    if (!catalog || !query.trim()) {
      setSearchResult(null);
      setSearchError("");
      return;
    }
    setSearchResult(null);
    setSearchError("");
    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = (await request(cwd, {
            action: "search",
            query: query.trim(),
          })) as MetaprojectSearch;
          if (active) {
            if (result.snapshotId !== catalog.snapshotId)
              setSnapshotMismatch(true);
            else {
              setSearchResult({
                query: query.trim(),
                snapshotId: result.snapshotId,
                hits: result.hits,
              });
              setSearchError("");
            }
          }
        } catch (cause) {
          if (active) setSearchError(errMessage(cause));
        }
      })();
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [catalog, cwd, query, request]);
  useEffect(() => {
    setDetail(null);
    setProjection(null);
    setDetailError("");
    if (!catalog || !selection) return;
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
  }, [catalog, cwd, request, selection]);
  const adjacency = useMemo(() => {
    const index = new Map<string, MetaprojectEdge[]>();
    for (const edge of catalog?.edges ?? [])
      for (const id of [edge.from, edge.to]) {
        const adjacent = index.get(id);
        if (adjacent) adjacent.push(edge);
        else index.set(id, [edge]);
      }
    return index;
  }, [catalog]);
  useEffect(() => {
    setProjection(null);
    if (!catalog || !selection) return;
    const selectedNode = catalog.nodes.find((node) => node.id === selection);
    if (
      selectedNode &&
      !catalog.truncated &&
      selectedNode.kind !== "symbol" &&
      !kinds.includes("calls") &&
      !kinds.includes("defines")
    ) {
      const ids = new Set([selection]);
      const edges = new Set<(typeof catalog.edges)[number]>();
      let frontier = [selection];
      for (let step = 0; step < depth; step++) {
        const next: string[] = [];
        for (const id of frontier)
          for (const edge of adjacency.get(id) ?? []) {
            if (
              !kinds.includes(edge.kind) ||
              (direction === "incoming" && edge.to !== id) ||
              (direction === "outgoing" && edge.from !== id)
            )
              continue;
            edges.add(edge);
            const other = edge.from === id ? edge.to : edge.from;
            if (!ids.has(other) && ids.size < 200) {
              ids.add(other);
              next.push(other);
            }
          }
        frontier = next;
      }
      const boundedEdges = [...edges].filter(
        (edge) => ids.has(edge.from) && ids.has(edge.to),
      );
      setProjection({
        schemaVersion: catalog.schemaVersion,
        snapshotId: catalog.snapshotId,
        root: selection,
        nodes: catalog.nodes.filter((node) => ids.has(node.id)),
        edges: boundedEdges.slice(0, 400),
        truncated: ids.size >= 200 || boundedEdges.length > 400,
      });
      return;
    }
    if (catalog.graph === "missing") return;
    let active = true;
    void (async () => {
      try {
        const result = (await request(cwd, {
          action: "neighbors",
          id: selection,
          depth,
          direction,
          kinds,
        })) as MetaprojectNeighbors;
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
  }, [adjacency, catalog, cwd, request, selection, depth, direction, kinds]);
  const hits =
    searchResult?.query === query.trim() &&
    searchResult.snapshotId === catalog?.snapshotId
      ? searchResult.hits
      : [];
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
    const needle = query.trim().toLowerCase();
    const local = (catalog?.nodes ?? [])
      .filter(
        (node) =>
          !needle ||
          `${node.title} ${node.path}`.toLowerCase().includes(needle),
      )
      .map((node) => ({ node }) as MetaprojectHit);
    return [
      ...new Map([...local, ...hits].map((hit) => [hit.node.id, hit])).values(),
    ].slice(0, 200);
  }, [catalog, hits, query]);
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
  return (
    <section className="metaproject" aria-label="Metaproject explorer">
      <header className="metaproject-header">
        <h2>Metaproject</h2>
        <input
          aria-label="Search project knowledge"
          placeholder="Search names, paths and wiki text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div role="group" aria-label="View">
          <button
            className="btn btn-sm"
            aria-pressed={mode === "graph"}
            onClick={() => setMode("graph")}
          >
            Graph
          </button>
          <button
            className="btn btn-sm"
            aria-pressed={mode === "wiki"}
            onClick={() => setMode("wiki")}
          >
            Wiki
          </button>
        </div>
      </header>
      {loading && <p role="status">Loading project knowledge…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="btn btn-sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      )}
      {snapshotMismatch && (
        <p role="alert">
          Project knowledge changed while loading.{" "}
          <button
            className="btn btn-sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh catalog
          </button>
        </p>
      )}
      {catalog && (
        <>
          {catalog.graph !== "ready" && (
            <div className="metaproject-notice" role="status">
              Graph {catalog.graph}. {catalog.graphReason}{" "}
              <button
                className="btn btn-sm"
                disabled={rebuilding}
                onClick={() => void rebuild()}
              >
                {rebuilding ? "Rebuilding…" : "Rebuild graph"}
              </button>
            </div>
          )}
          {catalog.truncated && (
            <p>Catalog is limited; search for more results.</p>
          )}
          <div className="metaproject-panes">
            <nav className="metaproject-list" aria-label="Search results">
              <h3>{query ? "Results" : "Catalog"}</h3>
              {searchError && <p role="alert">Search: {searchError}</p>}
              <ul>
                {results.map((hit) => (
                  <li key={hit.node.id}>
                    <button
                      aria-current={
                        selection === hit.node.id ? "true" : undefined
                      }
                      onClick={() => select(hit.node.id)}
                    >
                      <strong>{hit.node.title}</strong>
                      <span>
                        {hit.node.kind} · {hit.node.path}
                      </span>
                      {hit.snippet && (
                        <small>
                          {hit.section ? `${hit.section}: ` : ""}
                          {hit.snippet}
                        </small>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {!results.length && <p>No results.</p>}
            </nav>
            <main className="metaproject-content">
              {detailError && (
                <p role="alert">
                  {detailError}{" "}
                  <button
                    className="btn btn-sm"
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    Retry
                  </button>
                </p>
              )}
              {mode === "graph" && (
                <>
                  <div className="metaproject-controls">
                    <label>
                      Direction{" "}
                      <select
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
                  {projection && catalog.graph !== "missing" && (
                    <Graph
                      projection={projection}
                      selected={selection}
                      select={select}
                    />
                  )}
                </>
              )}
              {projection && (
                <>
                  {projection.truncated && (
                    <p>Relationship projection is limited.</p>
                  )}
                  <h3>Relationships</h3>
                  <ul className="metaproject-relations">
                    {projection.edges.map((edge, index) => {
                      const from = nodes.find((item) => item.id === edge.from);
                      const to = nodes.find((item) => item.id === edge.to);
                      return from && to ? (
                        <li
                          key={`${edge.from}-${edge.to}-${edge.kind}-${index}`}
                        >
                          <button
                            onClick={() =>
                              select(edge.from === selection ? to.id : from.id)
                            }
                          >
                            {from.title} → {edge.kind} → {to.title}
                            <span>{edge.evidence?.join(" · ")}</span>
                          </button>
                        </li>
                      ) : null;
                    })}
                  </ul>
                  {!projection.edges.length && (
                    <p>No relationships for these filters.</p>
                  )}
                </>
              )}
              {detail && (
                <article>
                  <h2>{detail.node.title}</h2>
                  <p>
                    {[
                      detail.node.kind,
                      detail.node.pageType,
                      detail.node.status,
                      detail.node.path,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {detail.markdown ? (
                    <RepositoryMarkdown
                      text={detail.markdown}
                      nodes={nodes}
                      source={detail.node.path}
                      select={select}
                    />
                  ) : (
                    <p>No wiki content for this item.</p>
                  )}
                </article>
              )}
              {!selection && <p>Select an item to explore it.</p>}
            </main>
          </div>
        </>
      )}
    </section>
  );
}
