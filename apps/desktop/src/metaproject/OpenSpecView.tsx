import { useEffect, useRef, useState, type MouseEvent } from "react";
import { renderRepositoryMarkdown } from "../components/Markdown";
import { errMessage } from "../lib/format";
import { openExternal } from "../platform/commands";
import { requestMetaprojectV2 } from "../platform/metaproject";

import type { MetaprojectRequestV2, MetaprojectV2Response, MetaprojectOpenSpecList, MetaprojectDetailV2, MetaprojectSearchV2, MetaprojectOpenSpecHistory, MetaprojectOpenSpecKind, MetaprojectOpenSpecEntry, MetaprojectSourceRef, MetaprojectNode } from "../../../../src/integrations/metaproject-explorer-contract";

type Collection = MetaprojectOpenSpecKind;
type Entry = Pick<MetaprojectOpenSpecEntry, "id">;
type Source = MetaprojectSourceRef;
type List = MetaprojectOpenSpecList;
type Detail = MetaprojectDetailV2;
type Search = MetaprojectSearchV2;
type History = MetaprojectOpenSpecHistory;
type V2Request = (cwd: string, request: MetaprojectRequestV2) => Promise<MetaprojectV2Response>;
export type OpenSpecLocation = { id: string; collection: Collection; artifact?: string; section?: string; digest?: string; fragment?: string };

export function OpenSpecView({ cwd, query, location, onLocation, nodes = [], onNavigate, request = requestMetaprojectV2, onGraph }: { cwd: string; query: string; location?: OpenSpecLocation | null; onLocation?: (location: OpenSpecLocation | null) => void; nodes?: MetaprojectNode[]; onNavigate?: (node: MetaprojectNode, fragment?: string) => void; request?: V2Request; onGraph: (id: string) => void }) {
  const [collection, setCollection] = useState<Collection>(location?.collection ?? "spec");
  const [list, setList] = useState<List | null>(null);
  const [hits, setHits] = useState<Search | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [selected, setSelected] = useState<OpenSpecLocation | null>(location ?? null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const latest = useRef({ query, selected, serial: 0 });
  if (latest.current.query !== query || latest.current.selected !== selected) latest.current = { query, selected, serial: latest.current.serial + 1 };
  const sectionList = useRef<HTMLElement>(null);
  const markdown = useRef<HTMLDivElement>(null);
  useEffect(() => { if (location) { setCollection(location.collection); setSelected(location); } }, [location]);
  const choose = (next: OpenSpecLocation | null) => { setSelected(next); onLocation?.(next); };
  const select = (entry: Entry, source?: Source, section?: string, targetCollection = collection) => choose({ id: entry.id, collection: targetCollection, ...(source && { artifact: source.path, digest: source.digest }), ...(section && { section }) });

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setError(""); setList(null); setHits(null); setDetail(null); setHistory(null);
    void (async () => {
      try {
        const data = await request(cwd, { version: 2, action: "openspec-list", collection }) as List;
        if (current !== generation.current) return;
        setList(data);
      } catch (cause) { if (current === generation.current) setError(errMessage(cause)); }
      finally { if (current === generation.current) setLoading(false); }
    })();
    return () => { generation.current++; };
  }, [cwd, collection, request, revision]);

  useEffect(() => {
    if (!list || !query.trim()) { setHits(null); return; }
    let active = true;
    setHits(null);
    void request(cwd, { version: 2, action: "search", query: query.trim(), scopes: [collection], expectedSnapshotId: list.snapshotId }).then(value => {
      if (active) setHits(value as Search);
    }).catch(cause => { if (active) setError(errMessage(cause)); });
    return () => { active = false; };
  }, [cwd, query, collection, list, request]);

  useEffect(() => {
    if (!list || !selected) return;
    let active = true;
    setDetail(null); setHistory(null); setError("");
    void request(cwd, { version: 2, action: "detail", id: selected.id, ...(selected.artifact ? { artifact: selected.artifact } : {}), ...(selected.section ? { section: selected.section } : {}), ...(selected.digest ? { digest: selected.digest } : {}), expectedSnapshotId: list.snapshotId }).then(value => {
      if (active) setDetail(value as Detail);
    }).catch(cause => { if (active) setError(errMessage(cause)); });
    if (collection === "spec") void request(cwd, { version: 2, action: "openspec-history", id: selected.id, expectedSnapshotId: list.snapshotId }).then(value => {
      if (active) setHistory(value as History);
    }).catch(cause => { if (active) setError(errMessage(cause)); });
    return () => { active = false; };
  }, [cwd, collection, list, selected, request]);

  async function more() {
    if (!list) return;
    const currentGeneration = generation.current;
    const currentSelection = latest.current.serial;
    try {
      if (query.trim() && hits?.nextCursor) {
        const page = await request(cwd, { version: 2, action: "search", query: query.trim(), scopes: [collection], cursor: hits.nextCursor, expectedSnapshotId: list.snapshotId }) as Search;
        if (currentGeneration === generation.current && currentSelection === latest.current.serial && page.snapshotId === list.snapshotId) setHits(current => current ? { ...page, hits: [...current.hits, ...page.hits] } : page);
      } else if (!query.trim() && list.nextCursor) {
        const page = await request(cwd, { version: 2, action: "openspec-list", collection, cursor: list.nextCursor, expectedSnapshotId: list.snapshotId }) as List;
        if (currentGeneration === generation.current && page.snapshotId === list.snapshotId) setList(current => current ? { ...page, entries: [...current.entries, ...page.entries] } : page);
      }
    } catch (cause) { if (currentGeneration === generation.current) setError(errMessage(cause)); }
  }
  async function moreHistory() {
    if (!list || !selected || !history?.nextCursor) return;
    const currentGeneration = generation.current;
    const currentSelection = latest.current.serial;
    try {
      const page = await request(cwd, { version: 2, action: "openspec-history", id: selected.id, cursor: history.nextCursor, expectedSnapshotId: list.snapshotId }) as History;
      if (currentGeneration === generation.current && currentSelection === latest.current.serial && page.snapshotId === list.snapshotId) setHistory(current => current ? { ...page, entries: [...current.entries, ...page.entries] } : page);
    } catch (cause) { if (currentGeneration === generation.current) setError(errMessage(cause)); }
  }
  const artifact = detail?.openSpec?.artifact;
  useEffect(() => {
    if (!artifact || !selected?.section || !sectionList.current) return;
    const target = [...sectionList.current.querySelectorAll<HTMLElement>("[data-section]")].find(element => element.dataset.section === selected.section);
    if (target) { const parent = target.closest("details"); if (parent) parent.open = true; target.focus(); target.scrollIntoView?.({ block: "nearest" }); }
  }, [artifact, selected?.section]);
  function focusFragment(fragment: string) {
    let decoded: string;
    try { decoded = decodeURIComponent(fragment); } catch { return; }
    const seen = new Map<string, number>();
    for (const heading of markdown.current?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6") ?? []) {
      const slug = (heading.textContent ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      if ((count ? `${slug}-${count}` : slug) === decoded) {
        heading.tabIndex = -1; heading.focus(); heading.scrollIntoView?.({ block: "nearest" }); return;
      }
    }
  }
  useEffect(() => { if (artifact && selected?.fragment) focusFragment(selected.fragment); }, [artifact, selected?.fragment]);
  const entries = query.trim() ? (hits?.hits ?? []).map(hit => ({ entry: hit.node, hit })) : (list?.entries ?? []).map(entry => ({ entry, hit: undefined }));
  function followMarkdownLink(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as Element).closest("a");
    if (!link || !artifact || !detail?.openSpec) return;
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      void openExternal(href).catch(() => {});
      return;
    }
    const [relative, fragment] = href.split("#", 2);
    if (!relative) { if (fragment) focusFragment(fragment); return; }
    if (relative.startsWith("/") || relative.includes("\\") || relative.includes("?") || /^[a-z][a-z0-9+.-]*:/i.test(relative)) return;
    const parts = artifact.source.path.split("/").slice(0, -1);
    for (const part of relative.split("/")) {
      if (part === "..") {
        if (!parts.length) return;
        parts.pop();
      } else if (part && part !== ".") parts.push(part);
    }
    const target = detail.openSpec.artifacts.find(item => item.path === parts.join("/"));
    if (target) {
      choose({ id: detail.openSpec.entry.id, collection, artifact: target.path, digest: target.digest, ...(fragment && { fragment }) });
      return;
    }
    const path = parts.join("/");
    const ownerLength = parts[0] === "openspec" && parts[1] === "changes"
      ? (parts[2] === "archive" ? 4 : 3) : 0;
    if (ownerLength && parts.length > ownerLength && list) {
      const ownerPath = parts.slice(0, ownerLength).join("/");
      const ownerKind = parts[2] === "archive" ? "archive" : "change";
      const indexed = nodes.find(item => item.path === ownerPath && item.kind === ownerKind)
        ?? list.entries.find(item => item.path === ownerPath && item.kind === ownerKind);
      const openOwner = (id: string) => {
        setCollection(ownerKind);
        choose({ id, collection: ownerKind, artifact: path, ...(fragment && { fragment }) });
      };
      if (indexed) { openOwner(indexed.id); return; }
      const currentGeneration = generation.current;
      const currentSelection = latest.current.serial;
      void request(cwd, { version: 2, action: "search", query: ownerPath, scopes: [ownerKind], expectedSnapshotId: list.snapshotId }).then(value => {
        if (currentGeneration !== generation.current || currentSelection !== latest.current.serial || !("hits" in value) || value.snapshotId !== list.snapshotId) return;
        const exact = value.hits.find(hit => hit.node.kind === ownerKind && hit.node.path === ownerPath);
        if (exact) openOwner(exact.node.id);
      }).catch(cause => {
        if (currentGeneration === generation.current && currentSelection === latest.current.serial) setError(errMessage(cause));
      });
      return;
    }
    const node = nodes.find(item => item.path === path) ?? list?.entries.find(item => item.path === path);
    if (!node) return;
    if (node.kind === "spec" || node.kind === "change" || node.kind === "archive") {
      setCollection(node.kind);
      choose({ id: node.id, collection: node.kind, ...(fragment && { fragment }) });
    } else onNavigate?.(node, fragment);
  }

  return (
    <div className="openspec-view">
      <div className="metaproject-controls" role="group" aria-label="OpenSpec collection">
        {(["spec", "change", "archive"] as const).map(kind => (
          <button className="btn" key={kind} aria-pressed={collection === kind} onClick={() => { setCollection(kind); choose(null); }}>
            {kind === "spec" ? "Specs" : kind === "change" ? "Changes" : "Archive"}
          </button>
        ))}
        <button className="btn" onClick={() => setRevision(value => value + 1)}>Refresh OpenSpec</button>
      </div>
      {loading && <p role="status">Loading OpenSpec…</p>}
      {error && <div className="inline-banner tone-warn" role="alert">{error} <button className="btn btn-sm" onClick={() => setRevision(value => value + 1)}>Retry</button></div>}
      {list && list.openSpec.availability !== "ready" && <p role="status">OpenSpec {list.openSpec.availability}.{list.openSpec.truncated ? " Results are limited." : ""}</p>}
      {list?.openSpec.diagnostics.map((item, index) => <p className="metaproject-meta" key={`${item.code}-${index}`}>{item.code}: {item.message}</p>)}
      <div className="metaproject-panes">
        <nav className="metaproject-list" aria-label="OpenSpec results">
          <h2>{query.trim() ? "Results" : "Entries"}</h2>
          <ul>
            {entries.map(({ entry, hit }, index) => (
              <li key={`${entry.id}-${hit?.section ?? index}`}>
                <button className="metaproject-row" aria-current={selected?.id === entry.id ? "true" : undefined} onClick={() => select(entry, hit?.source, hit?.section)}>
                  <strong>{entry.title}</strong>
                  <span className="metaproject-meta">{hit?.scope ?? entry.kind} · {entry.path}</span>
                  {hit?.snippet && <small>{hit.snippet}</small>}
                </button>
              </li>
            ))}
          </ul>
          {!loading && !entries.length && <p>{query.trim() ? "No results." : "No entries in this collection."}</p>}
          {(query.trim() ? hits?.nextCursor : list?.nextCursor) && <button className="btn" onClick={() => void more()}>Load more</button>}
        </nav>
        <section className="metaproject-content" aria-label="OpenSpec detail">
          {detail?.openSpec && (
            <article className="metaproject-article">
              <header className="metaproject-article-header">
                <h2>{detail.openSpec.entry.title}</h2>
                <p className="metaproject-meta">{detail.openSpec.entry.kind} · {detail.openSpec.entry.path}</p>
                <button className="btn" onClick={() => onGraph(detail.openSpec!.entry.id)}>Show relationships</button>
              </header>
              {detail.openSpec.artifacts.map(source => (
                <button className="metaproject-row" key={source.path} onClick={() => choose({ id: detail.openSpec!.entry.id, collection, artifact: source.path, digest: source.digest })}>{source.path}</button>
              ))}
              {artifact && (
                <>
                  <p className="metaproject-meta">{artifact.source.path}{artifact.source.startLine ? `:${artifact.source.startLine}${artifact.source.endLine ? `–${artifact.source.endLine}` : ""}` : ""}</p>
                  <div ref={markdown} className="md" dangerouslySetInnerHTML={{ __html: renderRepositoryMarkdown(artifact.markdown) }} onClick={followMarkdownLink} onAuxClick={event => { if ((event.target as Element).closest("a")) event.preventDefault(); }} />
                </>
              )}
              {detail.openSpec.deltas?.length ? (
                <section>
                  <h3>Requirement changes</h3>
                  {detail.openSpec.deltas.map(delta => (
                    <div key={delta.source.path}>
                      <h4>{delta.specPath}</h4>
                      {delta.requirements.map(requirement => (
                        <button
                          className="metaproject-row"
                          key={requirement.section}
                          onClick={() => select(detail.openSpec!.entry, requirement.source, requirement.section)}
                        >
                          {requirement.operation ?? "unresolved"}: {requirement.title}
                          <span className="metaproject-meta">
                            {requirement.source.path}:{requirement.source.startLine}–{requirement.source.endLine} · {requirement.source.digest}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </section>
              ) : null}
              {artifact?.requirements.length ? (
                <section ref={sectionList}>
                  <h3>Requirements</h3>
                  {artifact.requirements.map((requirement, index) => (
                    <details key={`${requirement.section}-${index}`}>
                      <summary data-section={requirement.section} tabIndex={-1}>
                        {requirement.operation ? `${requirement.operation}: ` : ""}{requirement.title}
                        <span className="metaproject-meta"> {requirement.source.path}:{requirement.source.startLine}–{requirement.source.endLine}</span>
                      </summary>
                      <ul>
                        {requirement.scenarios.map(scenario => (
                          <li key={scenario.section} data-section={scenario.section} tabIndex={-1}>
                            {scenario.title} <span className="metaproject-meta">{scenario.source.path}:{scenario.source.startLine}–{scenario.source.endLine}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </section>
              ) : null}
              {detail.relationships?.length ? (
                <section><h3>Relationships</h3>
                  {detail.relationships.map(({ node, edge }, index) => (
                    <button className="metaproject-row" key={`${node.id}-${edge.kind}-${index}`} onClick={() => onGraph(node.id)}>{edge.kind} · {node.title} · {node.path}{edge.provenance?.map(item => <span className="metaproject-meta" key={`${item.path}-${item.index ?? ""}`}>{item.path}{item.index === undefined ? "" : ` (link ${item.index})`} · {item.digest}</span>)}</button>
                  ))}
                </section>
              ) : null}
              {history && (
                <section><h3>Archived changes</h3>
                  {history.entries.length ? history.entries.map(item => (
                    <button className="metaproject-row" key={item.entry.id} onClick={() => { setCollection("archive"); select(item.entry, item.source, undefined, "archive"); }}>{item.entry.title} · {item.source.path}</button>
                  )) : <p>No archived changes.</p>}
                  {history.nextCursor && <button className="btn" onClick={() => void moreHistory()}>Load more history</button>}
                </section>
              )}
            </article>
          )}
          {!selected && <p>Select an entry to read it.</p>}
        </section>
      </div>
    </div>
  );
}
