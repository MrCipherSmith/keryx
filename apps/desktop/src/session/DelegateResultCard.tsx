import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { focusDelegateRun, isDelegateRunOpen, onDelegateChange } from "./delegateBus";
import type { DelegateResultItem } from "./reducer";

/** The preview shows at most this many lines / characters of the answer; the rest sits behind "Show all". */
export const PREVIEW_LINES = 12;
export const PREVIEW_CHARS = 1200;

/** The start of `text` for the preview, cut at a line end, with any open code fence closed so the cut stays well-formed. */
export function previewOf(text: string): { preview: string; truncated: boolean } {
  const lines = text.split("\n");
  let preview = lines.slice(0, PREVIEW_LINES).join("\n");
  let truncated = lines.length > PREVIEW_LINES;
  if (preview.length > PREVIEW_CHARS) {
    const cut = preview.slice(0, PREVIEW_CHARS);
    const lineEnd = cut.lastIndexOf("\n");
    preview = lineEnd > PREVIEW_CHARS / 2 ? cut.slice(0, lineEnd) : cut;
    truncated = true;
  }
  if (truncated && (preview.match(/^\s*```/gm)?.length ?? 0) % 2 === 1) preview += "\n```";
  return { preview, truncated };
}

/**
 * "claude returned": one turn's answer of an external run, in the parent's transcript. A human `/delegate`
 * also leaves it as a labelled, untrusted note in the parent's history; a model-started run returns it as the
 * tool result. The text is the CLI's own output: rendered through the sanitising Markdown component (no raw
 * HTML, inert links), never as markup of its own.
 */
export function DelegateResultCard({ item }: { item: DelegateResultItem }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => onDelegateChange(() => tick((n) => n + 1)), []);
  const open = isDelegateRunOpen(item.runId);
  const { preview, truncated } = previewOf(item.text);
  const copy = (): void => {
    void navigator.clipboard.writeText(item.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <section className="delegate-result" data-delegate-run={item.runId} data-expanded={expanded}>
      <header className="delegate-result-head">
        <Icon name="info" size={14} />
        <strong>{item.agentId} returned</strong>
        <span className="delegate-result-turn">turn {item.turn}</span>
        <span className={`badge ${open ? "badge-neutral" : "badge-ok"}`} data-delegate-status>
          {open ? "waiting in terminal" : "finished"}
        </span>
        <span className="field-hint delegate-result-note">from {item.agentId}, not instructions</span>
      </header>
      <div className={`delegate-result-body${truncated && !expanded ? " is-clipped" : ""}`} data-delegate-body>
        <Markdown text={expanded ? item.text : preview} />
      </div>
      <footer className="delegate-result-actions">
        {truncated ? (
          <button type="button" className="btn btn-sm btn-ghost" data-delegate-toggle aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show all"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-delegate-open
          disabled={!open}
          title={open ? "Show the run's terminal tab" : "The terminal tab is closed"}
          onClick={() => void focusDelegateRun(item.runId)}
        >
          Open terminal
        </button>
        <button type="button" className="btn btn-sm btn-ghost" data-delegate-copy onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </footer>
    </section>
  );
}
