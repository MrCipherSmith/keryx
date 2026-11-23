import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Icon } from "../components/Icon";
import { renderRepositoryMarkdown } from "../components/Markdown";
import { errMessage } from "../lib/format";
import { openExternal, openPullRequest } from "../platform/commands";
import { requestMetaprojectV2 } from "../platform/metaproject";

import type { MetaprojectRequestV2, MetaprojectV2Response, MetaprojectOpenSpecList, MetaprojectDetailV2, MetaprojectSearchV2, MetaprojectOpenSpecHistory, MetaprojectOpenSpecKind, MetaprojectOpenSpecEntry, MetaprojectSourceRef, MetaprojectNode, MetaprojectEdgeKind } from "../../../../src/integrations/metaproject-explorer-contract";

type Collection = MetaprojectOpenSpecKind;
type Entry = Pick<MetaprojectOpenSpecEntry, "id">;
type Source = MetaprojectSourceRef;
type List = MetaprojectOpenSpecList;
type Detail = MetaprojectDetailV2;
type Search = MetaprojectSearchV2;
type History = MetaprojectOpenSpecHistory;
type WorkLink = { label: string; href: string; pullRequest: boolean };
type V2Request = (cwd: string, request: MetaprojectRequestV2) => Promise<MetaprojectV2Response>;
export type OpenSpecLocation = { id: string; collection: Collection; artifact?: string; section?: string; digest?: string; fragment?: string };

function cachePage<T>(cache: Map<string, T>, key: string, page: T) {
  cache.set(key, page);
  if (cache.size > 12) cache.delete(cache.keys().next().value!);
}

export function OpenSpecView({ cwd, active = true, query, collection: controlledCollection, snapshot, location, onLocation, onCollection, onOpen, nodes = [], onNavigate, request = requestMetaprojectV2, onGraph }: {
  cwd: string;
  active?: boolean;
  query: string;
  collection?: Collection;
  snapshot?: string;
  location?: OpenSpecLocation | null;
  onLocation?: (location: OpenSpecLocation | null) => void;
  onCollection?: (collection: Collection) => void;
  onOpen?: (location: OpenSpecLocation) => void;
  nodes?: MetaprojectNode[];
  onNavigate?: (node: MetaprojectNode, fragment?: string) => void;
  request?: V2Request;
  onGraph: (id: string, node?: MetaprojectNode) => void;
}) {
  const [localCollection, setCollection] = useState<Collection>(location?.collection ?? "spec");
  const [localSelection, setSelected] = useState<OpenSpecLocation | null>(location ?? null);
  const collection = controlledCollection ?? localCollection;
  const selected = controlledCollection ? location ?? null : localSelection;
  const [listed, setList] = useState<{ key: string; result: List } | null>(null);
  const [found, setHits] = useState<{ key: string; result: Search } | null>(null);
  const [loaded, setDetail] = useState<{ selection: OpenSpecLocation; result: Detail } | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [searchProblem, setSearchProblem] = useState<{ key: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const pageInFlight = useRef(false);
  const historyInFlight = useRef(false);
  const generation = useRef(0);
  const listCache = useRef(new Map<string, List>());
  const searchCache = useRef(new Map<string, Search>());
  const listKey = JSON.stringify([cwd, snapshot, revision, collection]);
  const list = listed?.key === listKey ? listed.result : null;
  const listSnapshot = list?.snapshotId;
  const searchQuery = query.trim();
  const searchKey = JSON.stringify([listKey, listSnapshot, searchQuery]);
  const hits = found?.key === searchKey ? found.result : null;
  const detail = loaded?.selection === selected && loaded.result.snapshotId === listSnapshot ? loaded.result : null;
  const latest = useRef({ active, searchKey, selected, serial: 0 });
  if (latest.current.active !== active || latest.current.searchKey !== searchKey || latest.current.selected !== selected) {
    latest.current = { active, searchKey, selected, serial: latest.current.serial + 1 };
  }

  const sectionList = useRef<HTMLElement>(null);
  const content = useRef<HTMLElement>(null);
  const markdown = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!controlledCollection && location) { setCollection(location.collection); setSelected(location); }
  }, [controlledCollection, location]);
  const choose = (next: OpenSpecLocation | null) => {
    if (!controlledCollection) setSelected(next);
    // The owner records the document being left, its scroll included, before the new one opens at the top.
    onLocation?.(next);
    if (content.current) content.current.scrollTop = 0;
  };
  const select = (entry: Entry, source?: Source, section?: string) =>
    choose({ id: entry.id, collection, ...(source && { artifact: source.path, digest: source.digest }), ...(section && { section }) });
  const openEntry = (next: OpenSpecLocation) => {
    if (onOpen) onOpen(next);
    else { setCollection(next.collection); choose(next); }
  };
  function changeCollection(kind: Collection) {
    if (kind === collection) return;
    if (onCollection) onCollection(kind);
    else { setCollection(kind); choose(null); }
  }

  useEffect(() => {
    if (!active) return;
    const current = ++generation.current;
    setError(""); setSearchProblem(null);
    const cached = listCache.current.get(listKey);
    if (cached) { setList({ key: listKey, result: cached }); setLoading(false); return; }
    setLoading(true);
    void request(cwd, { version: 2, action: "openspec-list", collection }).then(value => {
      if (current !== generation.current) return;
      const result = value as List;
      cachePage(listCache.current, listKey, result);
      setList({ key: listKey, result });
    }).catch(cause => {
      if (current === generation.current) setError(errMessage(cause));
    }).finally(() => {
      if (current === generation.current) setLoading(false);
    });
    return () => { generation.current++; };
  }, [active, cwd, collection, listKey, request]);

  useEffect(() => {
    if (!active || !listSnapshot || !searchQuery) return;
    const cached = searchCache.current.get(searchKey);
    if (cached) { setHits({ key: searchKey, result: cached }); return; }
    let live = true;
    setSearchProblem(null);
    void request(cwd, { version: 2, action: "search", query: searchQuery, scopes: [collection], expectedSnapshotId: listSnapshot }).then(value => {
      if (!live) return;
      const result = value as Search;
      if (result.snapshotId !== listSnapshot) throw new Error("Project knowledge changed. Refresh OpenSpec and retry.");
      cachePage(searchCache.current, searchKey, result);
      setHits({ key: searchKey, result });
    }).catch(cause => { if (live) setSearchProblem({ key: searchKey, message: errMessage(cause) }); });
    return () => { live = false; };
  }, [active, cwd, searchQuery, collection, listSnapshot, searchKey, request]);

  useEffect(() => {
    if (!active || !listSnapshot || !selected) return;
    let live = true;
    setDetail(null); setHistory(null); setError(""); setOpening(true);
    void request(cwd, { version: 2, action: "detail", id: selected.id, ...(selected.artifact ? { artifact: selected.artifact } : {}), ...(selected.section ? { section: selected.section } : {}), ...(selected.digest ? { digest: selected.digest } : {}), expectedSnapshotId: listSnapshot }).then(value => {
      if (live) setDetail({ selection: selected, result: value as Detail });
    }).catch(cause => { if (live) setError(errMessage(cause)); }).finally(() => { if (live) setOpening(false); });
    if (collection === "spec") void request(cwd, { version: 2, action: "openspec-history", id: selected.id, expectedSnapshotId: listSnapshot }).then(value => {
      if (live) setHistory(value as History);
    }).catch(cause => { if (live) setError(errMessage(cause)); });
    return () => { live = false; };
  }, [active, cwd, collection, listSnapshot, selected, request]);

  async function more() {
    if (!list || pageInFlight.current) return;
    const currentGeneration = generation.current;
    const currentSearch = searchKey;
    pageInFlight.current = true;
    setLoadingPage(true);
    try {
      if (searchQuery && hits?.nextCursor) {
        const page = await request(cwd, { version: 2, action: "search", query: searchQuery, scopes: [collection], cursor: hits.nextCursor, expectedSnapshotId: list.snapshotId }) as Search;
        if (currentGeneration === generation.current && latest.current.active && currentSearch === latest.current.searchKey && page.snapshotId === list.snapshotId) {
          const result = { ...page, hits: [...hits.hits, ...page.hits] };
          cachePage(searchCache.current, searchKey, result);
          setHits({ key: searchKey, result });
        }
      } else if (!searchQuery && list.nextCursor) {
        const page = await request(cwd, { version: 2, action: "openspec-list", collection, cursor: list.nextCursor, expectedSnapshotId: list.snapshotId }) as List;
        if (currentGeneration === generation.current && latest.current.active && currentSearch === latest.current.searchKey && page.snapshotId === list.snapshotId) {
          const result = { ...page, entries: [...list.entries, ...page.entries] };
          cachePage(listCache.current, listKey, result);
          setList({ key: listKey, result });
        }
      }
    } catch (cause) {
      if (currentGeneration === generation.current && currentSearch === latest.current.searchKey) setError(errMessage(cause));
    } finally {
      pageInFlight.current = false;
      setLoadingPage(false);
    }
  }

  async function moreHistory() {
    if (!list || !selected || !history?.nextCursor || historyInFlight.current) return;
    const currentGeneration = generation.current;
    const currentSelection = latest.current.serial;
    historyInFlight.current = true;
    setLoadingHistory(true);
    try {
      const page = await request(cwd, { version: 2, action: "openspec-history", id: selected.id, cursor: history.nextCursor, expectedSnapshotId: list.snapshotId }) as History;
      if (currentGeneration === generation.current && currentSelection === latest.current.serial && page.snapshotId === list.snapshotId) setHistory({ ...page, entries: [...history.entries, ...page.entries] });
    } catch (cause) {
      if (currentGeneration === generation.current && currentSelection === latest.current.serial) setError(errMessage(cause));
    } finally {
      historyInFlight.current = false;
      setLoadingHistory(false);
    }
  }
  const artifact = detail?.openSpec?.artifact;
  const html = useMemo(() => artifact ? renderRepositoryMarkdown(artifact.markdown) : "", [artifact]);
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
        openEntry({ id, collection: ownerKind, artifact: path, ...(fragment && { fragment }) });
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
      openEntry({ id: node.id, collection: node.kind, ...(fragment && { fragment }) });
    } else onNavigate?.(node, fragment);
  }

  const searchError = searchProblem?.key === searchKey ? searchProblem.message : "";
  const searching = Boolean(searchQuery && listSnapshot && !hits && !searchError);
  const entry = detail?.openSpec?.entry;
  const workLinks = useMemo(() => entry?.kind === "change" ? issueLinks(html) : [], [entry?.kind, html]);
  const proposal = entry?.kind === "change" ? detail?.openSpec?.artifacts.find(source => source.path === `${entry.path}/proposal.md`) : undefined;
  const proposalId = entry?.id;
  const proposalLinks = useRef(new Map<string, WorkLink[]>());
  const [proposalWork, setProposalWork] = useState<{ key: string; links: WorkLink[] } | null>(null);
  const proposalKey = proposal && JSON.stringify([cwd, listSnapshot, proposal.path, proposal.digest]);
  useEffect(() => {
    if (!active || !proposalId || !proposal || !proposalKey || !listSnapshot || artifact?.source.path === proposal.path) return;
    const cached = proposalLinks.current.get(proposalKey);
    if (cached) { setProposalWork({ key: proposalKey, links: cached }); return; }
    let live = true;
    void request(cwd, { version: 2, action: "detail", id: proposalId, artifact: proposal.path, digest: proposal.digest, expectedSnapshotId: listSnapshot }).then(result => {
      if (!live || !("node" in result) || result.snapshotId !== listSnapshot || !result.openSpec?.artifact) return;
      const links = issueLinks(renderRepositoryMarkdown(result.openSpec.artifact.markdown));
      cachePage(proposalLinks.current, proposalKey, links);
      setProposalWork({ key: proposalKey, links });
    }).catch(() => {}); // The selected document stays available if its proposal cannot be read.
    return () => { live = false; };
  }, [active, artifact?.source.path, cwd, listSnapshot, proposal, proposalId, proposalKey, request]);
  const links = [...new Map([...workLinks, ...(proposalKey && proposalWork?.key === proposalKey ? proposalWork.links : [])].map(link => [link.href, link])).values()].slice(0, 3);
  if (!active) return null;
  return (
    <div className="openspec-view">
      <div className="metaproject-controls" role="group" aria-label="OpenSpec collection">
        {(["spec", "change", "archive"] as const).map(kind => (
          <button className="btn btn-sm" key={kind} aria-pressed={collection === kind} onClick={() => changeCollection(kind)}>
            {kind === "spec" ? "Specs" : kind === "change" ? "Changes" : "Archive"}
          </button>
        ))}
        <button className="icon-btn" aria-label="Refresh OpenSpec" title="Refresh OpenSpec" onClick={() => setRevision(value => value + 1)}><Icon name="refresh" /></button>
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
          {searching && <p role="status">Searching OpenSpec…</p>}
          {searchError && <p role="alert">{searchError} <button className="btn btn-sm" onClick={() => setRevision(value => value + 1)}>Retry search</button></p>}
          {list && !searching && !searchError && !entries.length && <p>{searchQuery ? "No results." : "No entries in this collection."}</p>}
          {(searchQuery ? hits?.nextCursor : list?.nextCursor) && <button className="btn btn-sm" disabled={loadingPage} onClick={() => void more()}>{loadingPage ? "Loading…" : "Load more"}</button>}
        </nav>
        <section ref={content} className="metaproject-content" aria-label="OpenSpec detail">
          {selected && (loading || opening) && <p role="status">Loading document…</p>}
          {detail?.openSpec && (
            <article className="metaproject-article">
              <header className="metaproject-article-header">
                <h2>{detail.openSpec.entry.title}</h2>
                <p className="metaproject-meta">{detail.openSpec.entry.archiveDate ? `Archived ${detail.openSpec.entry.archiveDate}` : detail.openSpec.entry.kind} · {detail.openSpec.entry.path}</p>
                <div className="metaproject-document-actions">
                  <button className="btn btn-sm" onClick={() => onGraph(detail.openSpec!.entry.id, detail.node ?? detail.openSpec!.entry)}><Icon name="branch" size={14} />View in Graph</button>
                  {links.map(link => <button className="btn btn-sm" key={link.href} onClick={() => void (link.pullRequest ? openPullRequest : openExternal)(link.href).catch(cause => setError(errMessage(cause)))}>{link.label}<Icon name="external" size={14} /></button>)}
                </div>
              </header>
              {detail.relationships?.length ? (
                <section className="metaproject-document-links"><h3>Related documents</h3>
                  {detail.relationships.map(({ node, edge }, index) => (
                    <div className="metaproject-related-document" key={`${node.id}-${edge.kind}-${index}`}>
                      <button className="btn btn-sm" onClick={() => {
                        if (node.kind === "spec" || node.kind === "change" || node.kind === "archive") {
                          openEntry({ id: node.id, collection: node.kind });
                        } else if (onNavigate) onNavigate(node);
                        else onGraph(node.id, node);
                      }}>{relatedLabel(node, edge.kind)}</button>
                      {edge.provenance?.length ? <details><summary>Source</summary>
                        {edge.provenance.map(item => <p className="metaproject-meta" key={`${item.path}-${item.index ?? ""}`}>{item.path}{item.index === undefined ? "" : ` (link ${item.index})`} · {item.digest}</p>)}
                      </details> : null}
                    </div>
                  ))}
                </section>
              ) : null}
              {detail.openSpec.artifacts.length > 1 && <div className="metaproject-artifacts" aria-label="OpenSpec documents">
                {detail.openSpec.artifacts.map(source => (
                  <button className="btn btn-sm" key={source.path} title={source.path} aria-pressed={source.path === artifact?.source.path}
                    onClick={() => choose({ id: detail.openSpec!.entry.id, collection, artifact: source.path, digest: source.digest })}>
                    {source.path.split("/").at(-1) === "spec.md" && entry?.kind !== "spec" ? `Requirements · ${source.path.split("/").at(-2)}` : artifactLabel(source.path)}
                  </button>
                ))}
              </div>}
              {artifact && (
                <>
                  <p className="metaproject-meta">{artifact.source.path}{artifact.source.startLine ? `:${artifact.source.startLine}${artifact.source.endLine ? `–${artifact.source.endLine}` : ""}` : ""}</p>
                  <div ref={markdown} className="md" dangerouslySetInnerHTML={{ __html: html }} onClick={followMarkdownLink} onAuxClick={event => { if ((event.target as Element).closest("a")) event.preventDefault(); }} />
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
              {history && (
                <section><h3>Archived changes</h3>
                  {history.entries.length ? history.entries.map(item => (
                    <button className="metaproject-row" key={item.entry.id} onClick={() => openEntry({ id: item.entry.id, collection: "archive", artifact: item.source.path, digest: item.source.digest })}>{item.entry.title} · {item.source.path}</button>
                  )) : <p>No archived changes.</p>}
                  {history.nextCursor && <button className="btn btn-sm" disabled={loadingHistory} onClick={() => void moreHistory()}>{loadingHistory ? "Loading…" : "Load more history"}</button>}
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

function artifactLabel(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  switch (name) {
    case "proposal.md": return "Proposal";
    case "design.md": return "Design";
    case "tasks.md": return "Tasks";
    case "spec.md": return "Requirements";
    default: return name;
  }
}

function relatedLabel(node: MetaprojectNode, kind: MetaprojectEdgeKind): string {
  if (kind === "changes-spec" && node.kind === "spec") return `Open current spec: ${node.title}`;
  if (node.kind === "spec") return `Open spec: ${node.title}`;
  if (node.kind === "archive") return `Open archived change: ${node.title}`;
  if (node.kind === "change") return `Open change: ${node.title}`;
  if (node.kind === "wiki") return `Open Wiki: ${node.title}`;
  return `View in Graph: ${node.title}`;
}

function issueLinks(html: string) {
  const links = new Map<string, WorkLink>();
  for (const anchor of new DOMParser().parseFromString(html, "text/html").querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    const match = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/(\d+)\/?(?:[#?].*)?$/i.exec(href);
    if (!match || links.has(href)) continue;
    const pullRequest = match[1]?.toLowerCase() === "pull";
    links.set(href, { href, pullRequest, label: `${pullRequest ? "PR" : "Issue"} #${match[2]}` });
    if (links.size === 3) break;
  }
  return [...links.values()];
}
