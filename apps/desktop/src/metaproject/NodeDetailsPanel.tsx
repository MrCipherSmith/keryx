import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MetaprojectDetail, MetaprojectDetailV2, MetaprojectNeighbors, MetaprojectNode } from "../../../../src/integrations/metaproject-explorer-contract";
import { Icon } from "../components/Icon";
import { EmptyState, Spinner } from "../components/ui";
import { copyText } from "../lib/format";
import { NodeKindBadge, RelationshipList, summarizeRelationships } from "./RelationshipList";
import "./nodePanel.css";

const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 380;
const COMPACT_BELOW = 820;
const RESIZE_STEP = 32;
const PREVIEW_LIMIT = 360;
const COPY_FEEDBACK_MS = 2000;

export const isOpenSpecNode = (node: MetaprojectNode): boolean =>
  node.kind === "spec" || node.kind === "change" || node.kind === "archive";

type Tab = "relationships" | "wiki" | "openspec";
type DocumentTab = Exclude<Tab, "relationships">;
const TABS: readonly Tab[] = ["relationships", "wiki", "openspec"];
const TAB_LABELS: Record<Tab, string> = { relationships: "Relationships", wiki: "Wiki", openspec: "OpenSpec" };
type LinkedDocument = MetaprojectNode & { suggested?: boolean };

// ---- preview text -------------------------------------------------------------------------

/** Lines that describe the page rather than say what it is about. */
const METADATA_LINE = /^(?:covers|version|type|page type|status|updated|last updated|created|date|owner|owners|author|authors|tags|scope|audience|source|sources|related)\s*:/i;
const LIST_MARKER = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+/;

function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`+/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")
    .replace(/\*\*|__/g, "");
}

function cleanLine(line: string): string {
  return stripInline(line.replace(/^\s*(?:>\s?)+/, "").replace(LIST_MARKER, "")).trim();
}

/**
 * The first prose paragraph of a Markdown page as plain text: front matter, headings, rules,
 * tables, code blocks and metadata lines ("Covers:", "Version:", …) are skipped, and blockquote,
 * list, emphasis and code markers are removed. A list is used only when the page has no prose.
 */
export function markdownPreview(markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const blocks: { text: string; list: boolean }[] = [];
  let lines: string[] = [];
  let list = false;
  let fenced = false;
  const flush = () => {
    const text = lines.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ text, list });
    lines = [];
    list = false;
  };
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) { fenced = !fenced; flush(); continue; }
    if (fenced) continue;
    if (/^\s*(?:>\s*)*$/.test(raw) || /^\s*#{1,6}\s/.test(raw) || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(raw) || /^\s*\|/.test(raw)) {
      flush();
      continue;
    }
    const text = cleanLine(raw);
    if (!text || METADATA_LINE.test(text)) continue;
    if (!lines.length) list = LIST_MARKER.test(raw);
    lines.push(text);
  }
  flush();
  const text = (blocks.find(block => !block.list) ?? blocks[0])?.text ?? "";
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT - 1).trimEnd()}…` : text;
}

// ---- linked documents ---------------------------------------------------------------------

function linkedDocuments(node: MetaprojectNode, documents: MetaprojectNeighbors | null, tab: DocumentTab, suggestedWiki?: MetaprojectNode): LinkedDocument[] {
  const neighbors = new Set(documents?.edges.map(edge => edge.from === node.id ? edge.to : edge.from));
  const linked: LinkedDocument[] = [node, ...(documents?.nodes.filter(item => item.id !== node.id && neighbors.has(item.id)) ?? [])]
    .filter(item => tab === "wiki" ? item.kind === "wiki" : isOpenSpecNode(item));
  if (tab === "wiki" && suggestedWiki && !linked.some(item => item.id === suggestedWiki.id)) {
    return [...linked, { ...suggestedWiki, suggested: true }];
  }
  return linked;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="info-row">
    <span className="info-key">{label}</span>
    <span className="info-val">{children}</span>
  </div>;
}

function Problem({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="inline-banner tone-danger metaproject-details-problem" role="alert">
    <span>{message}</span>
    <button type="button" className="btn btn-sm" onClick={onRetry}>Retry</button>
  </div>;
}

function Loading({ children }: { children: string }) {
  return <p className="loading-row metaproject-details-loading" role="status"><Spinner />{children}</p>;
}

// ---- the panel ----------------------------------------------------------------------------

export function NodeDetailsPanel({
  node, relationships, relationshipsPending, relationshipsProblem, revealRelationships,
  documents, documentsPending, documentsProblem, suggestedWiki, openSpec, readPreview,
  width = DEFAULT_WIDTH, onResize, onClose, onSelect, onOpen, onFind, onDraft, onRetry,
}: {
  node: MetaprojectNode;
  relationships: MetaprojectNeighbors | null;
  relationshipsPending: boolean;
  relationshipsProblem: string;
  revealRelationships?: number;
  documents: MetaprojectNeighbors | null;
  documentsPending: boolean;
  documentsProblem: string;
  suggestedWiki?: MetaprojectNode;
  openSpec: boolean;
  readPreview: (id: string) => Promise<MetaprojectDetail>;
  width?: number;
  onResize: (width: number) => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  onOpen: (node: MetaprojectNode) => void;
  onFind: (tab: "wiki" | "openspec") => void;
  onDraft?: (task: string) => Promise<void>;
  onRetry: () => void;
}) {
  const panelId = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [tabChoice, setTab] = useState<{ node: string; value: Tab } | null>(null);
  const tab: Tab = tabChoice?.node === node.id ? tabChoice.value : "relationships";
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);
  const [copied, setCopied] = useState<{ node: string; ok: boolean } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [availableWidth, setAvailableWidth] = useState(0);
  const lastReveal = useRef(revealRelationships);
  const [revealTick, setRevealTick] = useState(0);
  const compact = availableWidth > 0 && availableWidth < COMPACT_BELOW;
  const maxWidth = Math.max(MIN_WIDTH, Math.min(640, (availableWidth || 1180) - 440));
  const currentWidth = Math.min(width, maxWidth);
  const resize = (value: number) => onResize(Math.max(MIN_WIDTH, Math.min(maxWidth, value)));

  // Docked, the panel leaves focus where it is; as a drawer it takes focus and gives it back.
  useLayoutEffect(() => {
    if (!compact) return;
    const before = document.activeElement;
    const aside = panel.current;
    close.current?.focus();
    return () => {
      if (aside?.contains(document.activeElement) && before instanceof HTMLElement && before.isConnected) {
        before.focus({ preventScroll: true });
      }
    };
  }, [compact]);
  useLayoutEffect(() => {
    const host = panel.current?.parentElement;
    if (!host) return;
    const measure = () => setAvailableWidth(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (lastReveal.current === revealRelationships) return;
    lastReveal.current = revealRelationships;
    setTab({ node: node.id, value: "relationships" });
    setRevealTick(value => value + 1);
  }, [revealRelationships, node.id]);
  useEffect(() => {
    if (!revealTick || !body.current) return;
    body.current.scrollTop = 0;
    body.current.scrollIntoView?.({ block: "nearest" });
  }, [revealTick]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const summary = useMemo(() => relationships ? summarizeRelationships(relationships) : null, [relationships]);
  const wikiDocuments = useMemo(() => linkedDocuments(node, documents, "wiki", suggestedWiki), [node, documents, suggestedWiki]);
  const openSpecDocuments = useMemo(() => linkedDocuments(node, documents, "openspec"), [node, documents]);
  const shown = tab === "wiki" ? wikiDocuments : tab === "openspec" && openSpec ? openSpecDocuments : [];
  const firstId = shown[0]?.id;
  useEffect(() => {
    if (!firstId) return;
    let active = true;
    void readPreview(firstId).then(detail => {
      if (!active || detail.node.id !== firstId) return;
      const artifact = (detail as unknown as MetaprojectDetailV2).openSpec?.artifact;
      setPreview({ id: firstId, text: markdownPreview(detail.markdown ?? artifact?.markdown ?? "") });
    }).catch(() => {}); // Links remain usable when the optional preview cannot be read.
    return () => { active = false; };
  }, [firstId, readPreview]);

  async function copyPath() {
    const path = node.path;
    const ok = await copyText(path);
    setCopied({ node: node.id, ok });
  }

  async function draft(kind: DocumentTab) {
    if (!onDraft || drafting) return;
    setDrafting(true);
    setDraftError("");
    try {
      const material = kind === "wiki" ? "Wiki page explaining how this node works" : "OpenSpec change documenting expected behavior";
      await onDraft(`Prepare a draft ${material} for ${JSON.stringify(node.path)} in this checkout. Check existing documents and links first. Show the proposed changes before writing any files.`);
    } catch (cause) {
      setDraftError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDrafting(false);
    }
  }

  function choose(next: Tab, focus = false) {
    setTab({ node: node.id, value: next });
    setDraftError("");
    if (focus) tabList.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  }

  const counts: Record<Tab, number | undefined> = {
    relationships: summary ? summary.incoming + summary.outgoing + summary.secondStep : undefined,
    wiki: documents ? wikiDocuments.filter(item => !item.suggested).length : undefined,
    openspec: documents && openSpec ? openSpecDocuments.length : undefined,
  };
  const relationFact = summary
    ? `${summary.incoming} incoming · ${summary.outgoing} outgoing${summary.truncated ? " · limited" : ""}`
    : relationshipsProblem ? "Unavailable" : relationshipsPending ? "Loading…" : "—";
  const copyState = copied?.node === node.id ? copied.ok ? "Copied" : "Could not copy" : "";

  function relationshipBody() {
    return <>
      {relationshipsProblem && <Problem message={relationshipsProblem} onRetry={onRetry} />}
      {!relationships && relationshipsPending && !relationshipsProblem && <Loading>Loading relationships…</Loading>}
      {relationships && <RelationshipList projection={relationships} select={onSelect} />}
      {!relationships && !relationshipsPending && !relationshipsProblem && <p className="metaproject-rel-note">Relationships are not loaded yet.</p>}
    </>;
  }

  function documentBody(kind: DocumentTab) {
    if (kind === "openspec" && !openSpec) {
      return <p className="metaproject-rel-note">This CLI does not support OpenSpec. Choose a newer CLI in Desktop Settings.</p>;
    }
    const wiki = kind === "wiki";
    const list = wiki ? wikiDocuments : openSpecDocuments;
    const where = wiki ? "Wiki" : "OpenSpec";
    return <>
      {list.map((document, index) => <section className="metaproject-details-doc" key={document.id}>
        {document.id !== node.id && <h3>{document.title}</h3>}
        {(document.id !== node.id || document.status) && <p className="metaproject-details-meta">
          {document.status && <span className="badge badge-neutral">{document.status}</span>}
          {document.id !== node.id && <span className="mono">{document.path}</span>}
        </p>}
        {document.suggested && <p className="metaproject-details-meta">Matching component page</p>}
        {preview?.id === document.id && preview.text && <p className="metaproject-details-preview">{preview.text}</p>}
        <div className="metaproject-details-actions">
          <button
            type="button" className={`btn btn-sm ${index === 0 ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onOpen(document)} aria-label={`Open ${document.title} in ${where}`} title={document.path}
          ><Icon name="file" size={14} />Open in {where}</button>
        </div>
      </section>)}
      {documentsPending && <Loading>Looking for linked documents…</Loading>}
      {documentsProblem && <Problem message={documentsProblem} onRetry={onRetry} />}
      {!list.length && !documentsPending && !documentsProblem && <EmptyState
        icon={wiki ? "list" : "checklist"}
        title={wiki ? "No Wiki page is linked to this node." : "No OpenSpec document is linked to this node."}
        actions={<>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => onFind(kind)}>
            <Icon name="search" size={14} />{wiki ? "Find a Wiki page" : "Find an OpenSpec document"}
          </button>
          {onDraft && <button type="button" className="btn btn-sm btn-ghost" disabled={drafting} onClick={() => void draft(kind)}>
            <Icon name="pencil" size={14} />{drafting ? "Opening session…" : wiki ? "Draft Wiki page" : "Draft OpenSpec change"}
          </button>}
        </>}
      >
        <p>{wiki ? "Search the Wiki for a page that covers this path." : "Search OpenSpec for a spec or change that covers this path."}</p>
        {draftError && <p role="alert" className="tone-danger">{draftError}</p>}
      </EmptyState>}
    </>;
  }

  return <aside
    id={panelId} ref={panel} aria-label="Graph node details"
    className={`metaproject-details${compact ? " compact" : ""}`}
    style={compact ? undefined : { width: currentWidth }}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      onClose();
    }}
  >
    {!compact && <div
      className="side-resize metaproject-details-resize" role="separator" tabIndex={0}
      aria-orientation="vertical" aria-label="Resize graph node details" aria-controls={panelId}
      aria-valuenow={currentWidth} aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, x: event.clientX, width: currentWidth };
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start?.pointer === event.pointerId) resize(start.width + start.x - event.clientX);
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => {
        const widths: Record<string, number> = { ArrowLeft: currentWidth + RESIZE_STEP, ArrowRight: currentWidth - RESIZE_STEP, Home: MIN_WIDTH, End: maxWidth };
        const next = Object.hasOwn(widths, event.key) ? widths[event.key] : undefined;
        if (next === undefined) return;
        event.preventDefault();
        resize(next);
      }}
    />}
    <header className="metaproject-details-head">
      <div className="metaproject-details-toprow">
        <NodeKindBadge kind={node.kind} icon />
        <span className="grow" />
        <button ref={close} type="button" className="icon-btn" onClick={onClose} aria-label="Close graph node details" title="Close (Esc)"><Icon name="x" /></button>
      </div>
      <h2>{node.title}</h2>
      <div className="metaproject-details-path">
        <code>{node.path}</code>
        <button type="button" className="icon-btn" onClick={() => void copyPath()} aria-label="Copy path" title="Copy path">
          <Icon name={copyState === "Copied" ? "check" : "copy"} size={14} />
        </button>
        <span className="metaproject-details-copied" role="status">{copyState}</span>
      </div>
    </header>
    <div className="info-section metaproject-details-facts">
      {node.module && <Fact label="Module"><span className="mono">{node.module}</span></Fact>}
      {node.pageType && <Fact label="Page type">{node.pageType}</Fact>}
      {node.status && <Fact label="Status"><span className="badge badge-neutral">{node.status}</span></Fact>}
      {node.line !== undefined && <Fact label="Line">{node.line}</Fact>}
      <Fact label="Relations">{relationFact}</Fact>
    </div>
    <div className="tabs metaproject-details-tabs" role="tablist" aria-label="Node details" ref={tabList}
      onKeyDown={event => {
        const index = TABS.indexOf(tab);
        const targets: Record<string, Tab | undefined> = {
          ArrowLeft: TABS[(index + TABS.length - 1) % TABS.length],
          ArrowRight: TABS[(index + 1) % TABS.length],
          Home: TABS[0],
          End: TABS[TABS.length - 1],
        };
        const target = Object.hasOwn(targets, event.key) ? targets[event.key] : undefined;
        if (!target) return;
        event.preventDefault();
        choose(target, true);
      }}>
      {TABS.map(kind => <button
        key={kind} type="button" role="tab" className="tab" data-tab={kind} id={`${panelId}-${kind}`}
        aria-selected={tab === kind} tabIndex={tab === kind ? 0 : -1} aria-controls={`${panelId}-body`}
        onClick={() => choose(kind)}
      >{TAB_LABELS[kind]}{counts[kind] !== undefined && <span className="tab-count">{counts[kind]}</span>}</button>)}
    </div>
    <div className="metaproject-details-body" role="tabpanel" id={`${panelId}-body`} aria-labelledby={`${panelId}-${tab}`} ref={body}>
      {tab === "relationships" ? relationshipBody() : documentBody(tab)}
    </div>
  </aside>;
}
