import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MetaprojectDetail, MetaprojectDetailV2, MetaprojectNeighbors, MetaprojectNode } from "../../../../src/integrations/metaproject-explorer-contract";
import { Icon } from "../components/Icon";

const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 380;
export const isOpenSpecNode = (node: MetaprojectNode) =>
  node.kind === "spec" || node.kind === "change" || node.kind === "archive";

type Tab = "wiki" | "openspec";

export function GraphNodePanel({ node, projection, pending, problem, suggestedWiki, openSpec, readPreview, width = DEFAULT_WIDTH, onResize, onClose, onOpen, onFind, onDraft, onRetry }: {
  node: MetaprojectNode;
  projection: MetaprojectNeighbors | null;
  pending: boolean;
  problem: string;
  suggestedWiki?: MetaprojectNode;
  openSpec: boolean;
  readPreview: (id: string) => Promise<MetaprojectDetail>;
  width?: number;
  onResize: (width: number) => void;
  onClose: () => void;
  onOpen: (node: MetaprojectNode) => void;
  onFind: (tab: Tab) => void;
  onDraft?: (task: string) => Promise<void>;
  onRetry: () => void;
}) {
  const panelId = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [tabChoice, setTab] = useState<{ node: string; value: Tab } | null>(null);
  const tab = tabChoice?.node === node.id ? tabChoice.value : isOpenSpecNode(node) ? "openspec" : "wiki";
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [availableWidth, setAvailableWidth] = useState(0);
  const compact = availableWidth > 0 && availableWidth < 820;
  const maxWidth = Math.max(MIN_WIDTH, Math.min(640, (availableWidth || 1180) - 440));
  const currentWidth = Math.min(width, maxWidth);
  const resize = (value: number) => onResize(Math.max(MIN_WIDTH, Math.min(maxWidth, value)));

  useLayoutEffect(() => {
    const before = document.activeElement;
    const aside = panel.current;
    close.current?.focus();
    return () => {
      if (aside?.contains(document.activeElement) && before instanceof HTMLElement && before.isConnected) {
        before.focus({ preventScroll: true });
      }
    };
  }, []);
  useLayoutEffect(() => {
    const host = panel.current?.parentElement;
    if (!host) return;
    const measure = () => setAvailableWidth(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const documents = useMemo(() => {
    const neighbors = new Set(projection?.edges.map(edge => edge.from === node.id ? edge.to : edge.from));
    const linked = [node, ...(projection?.nodes.filter(item => item.id !== node.id && neighbors.has(item.id)) ?? [])]
      .filter(item => tab === "wiki" ? item.kind === "wiki" : isOpenSpecNode(item));
    if (tab === "wiki" && suggestedWiki && !linked.some(item => item.id === suggestedWiki.id)) {
      return [...linked, { ...suggestedWiki, suggested: true }];
    }
    return linked;
  }, [node, projection, suggestedWiki, tab]);
  const first = documents[0];
  const firstId = first?.id;
  useEffect(() => {
    if (!firstId) return;
    let active = true;
    void readPreview(firstId).then(detail => {
      if (!active || detail.node.id !== firstId) return;
      const artifact = (detail as unknown as MetaprojectDetailV2).openSpec?.artifact;
      const body = detail.markdown ?? artifact?.markdown ?? "";
      const text = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split(/\r?\n\s*\r?\n/)
        .map(block => block.split(/\r?\n/).filter(line => line.trim() && !/^\s*(?:#|---|\x60\x60\x60|Version:|Type:|Status:)/.test(line)).join(" ").trim())
        .find(block => block && !block.startsWith("- "))?.replaceAll("\x60", "").slice(0, 360) ?? "";
      setPreview({ id: firstId, text });
    }).catch(() => {}); // Links remain usable when the optional preview cannot be read.
    return () => { active = false; };
  }, [firstId, readPreview]);

  async function draft() {
    if (!onDraft || drafting) return;
    setDrafting(true);
    setDraftError("");
    try {
      const material = tab === "wiki" ? "Wiki page explaining how this node works" : "OpenSpec change documenting expected behavior";
      await onDraft(`Prepare a draft ${material} for ${JSON.stringify(node.path)} in this checkout. Check existing documents and links first. Show the proposed changes before writing any files.`);
    } catch (cause) {
      setDraftError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDrafting(false);
    }
  }

  return <aside
    id={panelId} ref={panel} aria-label="Graph node details"
    className={`metaproject-node-panel${compact ? " compact" : ""}`}
    style={compact ? undefined : { width: currentWidth }}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      onClose();
    }}
  >
    {!compact && <div
      className="side-resize metaproject-node-resize" role="separator" tabIndex={0}
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
        const widths: Record<string, number> = { ArrowLeft: currentWidth + 32, ArrowRight: currentWidth - 32, Home: MIN_WIDTH, End: maxWidth };
        if (!Object.hasOwn(widths, event.key)) return;
        event.preventDefault();
        resize(widths[event.key]!);
      }}
    />}
    <header className="sheet-head">
      <div className="sheet-head-row">
        <h2>{node.title}</h2>
        <span className="grow" />
        <button ref={close} className="icon-btn" onClick={onClose} aria-label="Close graph node details" title="Close (Esc)"><Icon name="x" /></button>
      </div>
      <p className="metaproject-meta">{node.kind} · {node.path}</p>
    </header>
    <div className="segmented metaproject-node-tabs" role="tablist" aria-label="Node documentation" ref={tabs}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const target = event.key === "Home" ? "wiki" : event.key === "End" ? "openspec" : tab === "wiki" ? "openspec" : "wiki";
        setTab({ node: node.id, value: target });
        tabs.current?.querySelector<HTMLElement>(`[data-tab="${target}"]`)?.focus();
      }}>
      {(["wiki", "openspec"] as const).map(kind => <button
        key={kind} role="tab" data-tab={kind} id={`${panelId}-${kind}`} aria-selected={tab === kind}
        tabIndex={tab === kind ? 0 : -1} aria-controls={`${panelId}-body`}
        onClick={() => { setTab({ node: node.id, value: kind }); setDraftError(""); }}
      >{kind === "wiki" ? "Wiki" : "OpenSpec"}</button>)}
    </div>
    <div className="metaproject-node-body" role="tabpanel" id={`${panelId}-body`} aria-labelledby={`${panelId}-${tab}`}>
      {tab === "openspec" && !openSpec ? <p>This CLI does not support OpenSpec. Choose a newer CLI in Desktop Settings.</p>
        : <>
          {documents.map(document => <section className="metaproject-node-document" key={document.id}>
            {document.id !== node.id && <h3>{document.title}</h3>}
            {(document.id !== node.id || document.status) && <p className="metaproject-meta">
              {[document.status, document.id !== node.id ? document.path : ""].filter(Boolean).join(" · ")}
            </p>}
            {"suggested" in document && <p className="metaproject-meta">Matching component page</p>}
            {preview?.id === document.id && preview.text && <p className="metaproject-node-preview">{preview.text}</p>}
            <button className="btn btn-sm" onClick={() => onOpen(document)}><Icon name="file" size={14} />{tab === "wiki" ? "Open in Wiki" : "Open in OpenSpec"}</button>
          </section>)}
          {pending && <p role="status">Looking for linked documents…</p>}
          {problem && <p role="alert">{problem} <button className="btn btn-sm" onClick={onRetry}>Retry</button></p>}
          {!documents.length && !pending && !problem && <div className="metaproject-node-document">
            <p>{tab === "wiki" ? "No Wiki page is linked to this node." : "No OpenSpec document is linked to this node."}</p>
            <button className="btn btn-sm" onClick={() => onFind(tab)}><Icon name="search" size={14} />{tab === "wiki" ? "Find a Wiki page" : "Find an OpenSpec document"}</button>
            {onDraft && <button className="btn btn-sm" disabled={drafting} onClick={() => void draft()}>
              <Icon name="pencil" size={14} />{drafting ? "Opening session…" : tab === "wiki" ? "Draft Wiki page" : "Draft OpenSpec change"}
            </button>}
            {draftError && <p role="alert">{draftError}</p>}
          </div>}
        </>}
    </div>
  </aside>;
}
