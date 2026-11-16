import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ToolCallContent, ToolKind } from "../acp/types";
import type { Item } from "./reducer";
import { blockText } from "./reducer";
import { Markdown } from "../components/Markdown";
import { Icon, type IconName } from "../components/Icon";
import { Spinner } from "../components/ui";

type ToolItem = Extract<Item, { kind: "tool" }>;

const KIND_ICON: Record<ToolKind, IconName> = {
  read: "file",
  edit: "pencil",
  delete: "trash",
  move: "move",
  search: "search",
  execute: "terminal",
  think: "sparkle",
  fetch: "globe",
  switch_mode: "shield",
  other: "wand",
};

const STATUS_LABEL: Record<ToolItem["status"], string> = {
  pending: "Waiting",
  in_progress: "Running",
  completed: "Done",
  failed: "Failed",
};

function pretty(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The one-line thing a call acts on: a command, path, URL or query. */
export function primaryInput(raw: unknown): { label: string; value: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return { label: "Input", value: raw };
  const o = raw as Record<string, unknown>;
  const pairs: Array<[string, string]> = [
    ["command", "Command"],
    ["cmd", "Command"],
    ["path", "Path"],
    ["file_path", "Path"],
    ["url", "URL"],
    ["query", "Query"],
    ["pattern", "Pattern"],
  ];
  for (const [k, label] of pairs) {
    const v = o[k];
    if (typeof v === "string") return { label, value: v };
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return { label, value: v.join(" ") };
  }
  return null;
}

/** Common prefix/suffix trimmed, with two lines of context: a readable change without a diff library. */
export function DiffView({ path, oldText, newText }: { path: string; oldText?: string | null; newText: string }) {
  const rows = useMemo(() => {
    const a = (oldText ?? "").split("\n");
    const b = newText.split("\n");
    if (!oldText) return b.map((t) => ({ t, k: "add" as const }));
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const ctx = 2;
    const out: Array<{ t: string; k: "ctx" | "add" | "del" | "gap" }> = [];
    if (pre > ctx) out.push({ t: `… ${pre - ctx} unchanged lines`, k: "gap" });
    for (let i = Math.max(0, pre - ctx); i < pre; i++) out.push({ t: a[i]!, k: "ctx" });
    for (let i = pre; i < a.length - suf; i++) out.push({ t: a[i]!, k: "del" });
    for (let i = pre; i < b.length - suf; i++) out.push({ t: b[i]!, k: "add" });
    for (let i = a.length - suf; i < Math.min(a.length, a.length - suf + ctx); i++) out.push({ t: a[i]!, k: "ctx" });
    if (suf > ctx) out.push({ t: `… ${suf - ctx} unchanged lines`, k: "gap" });
    return out;
  }, [oldText, newText]);
  const added = rows.filter((r) => r.k === "add").length;
  const removed = rows.filter((r) => r.k === "del").length;
  return (
    <div className="diff">
      <div className="diff-head">
        <Icon name="file" size={13} />
        <span className="mono truncate">{path}</span>
        <span className="grow" />
        <span className="diff-stat add">+{added}</span>
        <span className="diff-stat del">−{removed}</span>
      </div>
      <pre className="diff-body">
        {rows.map((r, i) => (
          <div key={i} className={`diff-line diff-${r.k}`}>
            <span className="diff-sign" aria-hidden>
              {r.k === "add" ? "+" : r.k === "del" ? "−" : " "}
            </span>
            {r.t || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function ToolContent({ c }: { c: ToolCallContent }) {
  if (c.type === "content") {
    const t = blockText(c.content).trim();
    return t ? <pre className="out-pre">{t}</pre> : null;
  }
  if (c.type === "diff") return <DiffView path={c.path} oldText={c.oldText} newText={c.newText} />;
  return <pre className="out-pre">terminal {c.terminalId}</pre>;
}

function StatusGlyph({ status }: { status: ToolItem["status"] }) {
  if (status === "in_progress") return <Spinner size={13} />;
  if (status === "completed") return <Icon name="check" size={13} strokeWidth={2.25} />;
  if (status === "failed") return <Icon name="x" size={13} strokeWidth={2.25} />;
  return <Icon name="circle" size={11} />;
}

const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const raw = pretty(item.rawOutput);
  const primary = primaryInput(item.rawInput);
  const input = pretty(item.rawInput);
  const hasBody = item.content.length > 0 || raw !== "" || input !== "";
  const dur = item.endedAt !== null ? item.endedAt - item.startedAt : null;
  return (
    <div className={`tool status-${item.status}${open ? " is-open" : ""}`}>
      <button className="tool-row" onClick={() => setOpen((o) => !o)} aria-expanded={hasBody ? open : undefined} disabled={!hasBody}>
        <span className={`tool-status-glyph status-${item.status}`} title={STATUS_LABEL[item.status]}>
          <StatusGlyph status={item.status} />
        </span>
        <span className="tool-kind-icon" title={item.toolKind}>
          <Icon name={KIND_ICON[item.toolKind] ?? "wand"} size={14} />
        </span>
        <span className="tool-title truncate">
          {item.title}
          {primary && !item.title.includes(primary.value) ? <span className="tool-target">{primary.value}</span> : null}
        </span>
        {item.autoApproved ? (
          <span className="badge badge-ok" title="Allowed by the session's permission mode without asking">
            auto-approved
          </span>
        ) : null}
        {item.status === "failed" ? <span className="badge badge-danger">failed</span> : null}
        {dur !== null && dur >= 0 ? <span className="tool-dur">{formatDuration(dur)}</span> : null}
        {hasBody ? <Icon name={open ? "chevronDown" : "chevronRight"} size={13} className="tool-chev" /> : <span className="tool-chev" />}
      </button>
      {open && hasBody ? (
        <div className="tool-body">
          {primary ? (
            <div className="tool-section">
              <div className="tool-label">{primary.label}</div>
              <pre className="out-pre mono-strong">{primary.value}</pre>
            </div>
          ) : input ? (
            <div className="tool-section">
              <div className="tool-label">Input</div>
              <pre className="out-pre">{input}</pre>
            </div>
          ) : null}
          {item.content.map((c, i) => (
            <ToolContent key={i} c={c} />
          ))}
          {raw ? (
            <div className="tool-section">
              <div className="tool-label">Output</div>
              <pre className="out-pre">{raw}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const Thought = memo(function Thought({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => {
    const line = text.replace(/[#*_`>]/g, "").trim().split("\n").find((l) => l.trim()) ?? "";
    return line.length > 110 ? `${line.slice(0, 110)}…` : line;
  }, [text]);
  return (
    <div className={`thought${open ? " is-open" : ""}`}>
      <button className="thought-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="sparkle" size={13} />
        <span className="thought-label">{live ? "Thinking" : "Reasoning"}</span>
        {!open ? <span className="thought-summary truncate">{summary}</span> : null}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
      </button>
      {open ? (
        <div className="thought-body">
          <Markdown text={text} />
        </div>
      ) : null}
    </div>
  );
});

type Block =
  | { type: "user"; item: Extract<Item, { kind: "user" }> }
  | { type: "agent"; item: Extract<Item, { kind: "agent" }>; first: boolean }
  | { type: "thought"; item: Extract<Item, { kind: "thought" }>; first: boolean }
  | { type: "tools"; items: ToolItem[]; first: boolean }
  | { type: "notice"; item: Extract<Item, { kind: "notice" }> };

function toBlocks(items: Item[]): Block[] {
  const out: Block[] = [];
  let agentTurnOpen = false;
  for (const it of items) {
    if (it.kind === "user") {
      out.push({ type: "user", item: it });
      agentTurnOpen = false;
      continue;
    }
    if (it.kind === "notice") {
      out.push({ type: "notice", item: it });
      continue;
    }
    const first = !agentTurnOpen;
    agentTurnOpen = true;
    if (it.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.type === "tools") last.items.push(it);
      else out.push({ type: "tools", items: [it], first });
    } else if (it.kind === "agent") out.push({ type: "agent", item: it, first });
    else out.push({ type: "thought", item: it, first });
  }
  return out;
}

interface Props {
  items: Item[];
  busy: boolean;
  replaying: boolean;
  empty: ReactNode;
}

export function Transcript({ items, busy, replaying, empty }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const stick = useRef(true);
  const blocks = useMemo(() => toBlocks(items), [items]);
  const last = items[items.length - 1];
  const streamingAgent = busy && last?.kind === "agent";
  const streamingThought = busy && last?.kind === "thought";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stick.current = atBottom;
      setStuck(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  const jump = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={ref} aria-live="off">
        <div className="transcript-inner">
          {replaying ? (
            <div className="loading-row centered">
              <Spinner /> Loading session…
            </div>
          ) : null}
          {items.length === 0 && !replaying ? empty : null}
          {blocks.map((b, i) => {
            const isLast = i === blocks.length - 1;
            switch (b.type) {
              case "user":
                return (
                  <div key={b.item.id} className="turn-user">
                    <div className="user-msg">{b.item.text}</div>
                  </div>
                );
              case "agent":
                return (
                  <div key={b.item.id} className={`turn-agent${b.first ? " turn-start" : ""}`}>
                    {b.first ? <AgentLabel /> : null}
                    <Markdown text={b.item.text} className={isLast && streamingAgent ? "is-streaming" : undefined} />
                  </div>
                );
              case "thought":
                return (
                  <div key={b.item.id} className={`turn-agent${b.first ? " turn-start" : ""}`}>
                    {b.first ? <AgentLabel /> : null}
                    <Thought text={b.item.text} live={isLast && streamingThought} />
                  </div>
                );
              case "tools":
                return (
                  <div key={`t-${b.items[0]!.id}`} className={`turn-agent${b.first ? " turn-start" : ""}`}>
                    {b.first ? <AgentLabel /> : null}
                    <div className="tool-group">
                      {b.items.map((t) => (
                        <ToolRow key={t.id} item={t} />
                      ))}
                    </div>
                  </div>
                );
              case "notice":
                return (
                  <div key={b.item.id} className={`notice notice-${b.item.level}`} role={b.item.level === "error" ? "alert" : undefined}>
                    <Icon name={b.item.level === "error" ? "alert" : b.item.level === "warn" ? "alert" : "info"} size={14} />
                    <span>{b.item.text}</span>
                  </div>
                );
            }
          })}
          {busy && !streamingAgent && !streamingThought ? (
            <div className="working" role="status">
              <span className="working-dots" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              keryx is working
            </div>
          ) : null}
        </div>
      </div>
      {!stuck ? (
        <button className="jump-latest" onClick={jump}>
          <Icon name="arrowDown" size={14} /> Jump to latest
        </button>
      ) : null}
    </div>
  );
}

function AgentLabel() {
  return (
    <div className="agent-label" aria-hidden>
      <span className="agent-mark">k</span>
      keryx
    </div>
  );
}
