import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ToolCallContent } from "../acp/types";
import type { Item } from "../session/reducer";
import { blockText } from "../session/reducer";
import { Markdown } from "./Markdown";

type ToolItem = Extract<Item, { kind: "tool" }>;

function pretty(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function ToolContent({ c }: { c: ToolCallContent }) {
  if (c.type === "content") {
    return <pre className="tool-pre">{blockText(c.content).trim()}</pre>;
  }
  if (c.type === "diff") {
    return (
      <div className="tool-diff">
        <div className="tool-diff-path">{c.path}</div>
        {c.oldText ? <pre className="diff-old">{c.oldText}</pre> : null}
        <pre className="diff-new">{c.newText}</pre>
      </div>
    );
  }
  return <pre className="tool-pre">terminal {c.terminalId}</pre>;
}

const STATUS_LABEL: Record<ToolItem["status"], string> = {
  pending: "pending",
  in_progress: "running",
  completed: "done",
  failed: "failed",
};

function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const raw = pretty(item.rawOutput);
  const input = pretty(item.rawInput);
  const hasBody = item.content.length > 0 || raw !== "" || input !== "";
  return (
    <div className={`tool tool-${item.status}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!hasBody}>
        <span className={`dot dot-${item.status}`} aria-hidden />
        <span className="tool-kind">{item.toolKind}</span>
        <span className="tool-title">{item.title}</span>
        {item.autoApproved ? <span className="chip">auto-approved</span> : null}
        <span className="tool-status">{STATUS_LABEL[item.status]}</span>
        {hasBody ? <span className="chev">{open ? "▾" : "▸"}</span> : null}
      </button>
      {open && hasBody ? (
        <div className="tool-body">
          {input ? (
            <>
              <div className="tool-label">Input</div>
              <pre className="tool-pre">{input}</pre>
            </>
          ) : null}
          {item.content.map((c, i) => (
            <ToolContent key={i} c={c} />
          ))}
          {raw ? (
            <>
              <div className="tool-label">Output</div>
              <pre className="tool-pre">{raw}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thought">
      <button className="thought-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "▾" : "▸"} Reasoning
      </button>
      {open ? <div className="thought-body"><Markdown text={text} /></div> : null}
    </div>
  );
}

export function Transcript({ items, busy }: { items: Item[]; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  return (
    <div className="transcript" ref={ref}>
      <div className="transcript-inner">
        {items.length === 0 ? <div className="empty">Ask keryx anything about this project.</div> : null}
        {items.map((it) => {
          switch (it.kind) {
            case "user":
              return <div key={it.id} className="msg msg-user"><div className="bubble">{it.text}</div></div>;
            case "agent":
              return <div key={it.id} className="msg msg-agent"><Markdown text={it.text} /></div>;
            case "thought":
              return <Thought key={it.id} text={it.text} />;
            case "tool":
              return <ToolCard key={it.id} item={it} />;
            case "notice":
              return <div key={it.id} className={`notice notice-${it.level}`}>{it.text}</div>;
          }
        })}
        {busy ? <div className="working" aria-live="polite">Working…</div> : null}
      </div>
    </div>
  );
}
