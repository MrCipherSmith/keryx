import { Fragment, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { BrandMark } from "../components/BrandMark";
import type { ToolCallContent, ToolKind } from "../acp/types";
import type { CommandItem, DelegateResultItem, Item, TerminalRunItem } from "./reducer";
import type { Subagent } from "./activity";
import { CommandCard } from "./CommandCard";
import { DelegateResultCard } from "./DelegateResultCard";
import { TerminalRunCard } from "./TerminalRunCard";
import { blockText, isUndeliveredRun, streamEndOf } from "./reducer";
import { ContentBlockView } from "./ContentBlockView";
import { formatDuration } from "./duration";
import { Markdown, RunSessionContext } from "../components/Markdown";
import type { PrLinks } from "../components/prLinks";
import { UserMessage } from "./UserMessage";
import type { UserPromptContext } from "./userPrompt";
import { Icon, type IconName } from "../components/Icon";
import { Spinner } from "../components/ui";
import { argLabel, hasRestArgs, primaryInput, quoteArgv, restArgs, visibleProse, visibleText } from "./toolInput";
import { runButtonTitle, runInTerminal, runnableCommand } from "../panels/panelBus";

type ToolItem = Extract<Item, { kind: "tool" }>;
type BlockItem = Extract<Item, { kind: "block" }>;

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

/**
 * Common prefix/suffix trimmed, with two lines of context: a readable change without a diff library.
 * The approval dialog passes `bodyRef` to measure the scroll box, `expanded` to lift its height cap,
 * and `faithful` to escape the path and every line like a call's input and keep them left to right;
 * the read-only transcript shows the text as it is.
 */
export function DiffView({
  path,
  oldText,
  newText,
  bodyRef,
  expanded = false,
  faithful = false,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
  bodyRef?: Ref<HTMLPreElement>;
  expanded?: boolean;
  faithful?: boolean;
}) {
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
    return faithful ? out.map((r) => (r.k === "gap" ? r : { ...r, t: visibleText(r.t) })) : out;
  }, [oldText, newText, faithful]);
  const added = rows.filter((r) => r.k === "add").length;
  const removed = rows.filter((r) => r.k === "del").length;
  return (
    <div className={`diff${faithful ? " is-strict" : ""}`}>
      <div className="diff-head">
        <Icon name="file" size={13} />
        <span className="mono truncate">{faithful ? visibleText(path) : path}</span>
        <span className="grow" />
        <span className="diff-stat add">+{added}</span>
        <span className="diff-stat del">−{removed}</span>
      </div>
      <pre ref={bodyRef} className={`diff-body${expanded ? " is-expanded" : ""}`}>
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
  if (c.type === "content") return <ContentBlockView block={c.content} />;
  if (c.type === "diff") return <DiffView path={c.path} oldText={c.oldText} newText={c.newText} />;
  return (
    <div className="feed-chip is-muted">
      <Icon name="terminal" size={13} /> Terminal {c.terminalId}
    </div>
  );
}

/** The call's text content, joined: raw output that only repeats it is not shown twice. */
export function contentText(content: readonly ToolCallContent[]): string {
  return content
    .map((c) => (c.type === "content" && c.content.type === "text" ? blockText(c.content) : ""))
    .join("")
    .trim();
}

/** The command an `execute` call ran, when it is one command shown exactly as it reads (D-13 Run button). */
export function runnableToolCommand(item: Pick<ToolItem, "toolKind" | "rawInput">): string | null {
  if (item.toolKind !== "execute") return null;
  const raw = item.rawInput;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const v = o["command"] ?? o["cmd"];
  const cmd = typeof v === "string" ? v : Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? quoteArgv(v as string[]) : null;
  if (cmd === null || visibleText(cmd) !== cmd) return null;
  return runnableCommand(cmd);
}

function StatusGlyph({ status }: { status: ToolItem["status"] }) {
  if (status === "in_progress") return <Spinner size={13} />;
  if (status === "completed") return <Icon name="check" size={13} strokeWidth={2.25} />;
  if (status === "failed") return <Icon name="x" size={13} strokeWidth={2.25} />;
  return <Icon name="circle" size={11} />;
}

const ToolRow = memo(function ToolRow({ item, subagentId, onShowSubagent }: { item: ToolItem; subagentId?: string; onShowSubagent?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const raw = useMemo(() => {
    const r = pretty(item.rawOutput);
    return r.trim() === contentText(item.content) ? "" : r;
  }, [item.rawOutput, item.content]);
  const primary = useMemo(() => primaryInput(item.rawInput), [item.rawInput]);
  // The arguments are serialised only once the row is opened; a closed row needs just "are there any".
  const args = useMemo(() => (open ? restArgs(item.rawInput) : []), [open, item.rawInput]);
  const title = useMemo(() => visibleProse(item.title), [item.title]);
  const hasBody = item.content.length > 0 || raw !== "" || hasRestArgs(item.rawInput);
  const dur = item.endedAt !== null ? item.endedAt - item.startedAt : null;
  const runnable = useMemo(() => runnableToolCommand(item), [item]);
  const runSession = useContext(RunSessionContext);
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
          {title}
          {primary && !title.includes(primary.value) ? <span className="tool-target">{primary.value}</span> : null}
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
              <div className="tool-label">
                {primary.label}
                {runnable !== null ? (
                  <button
                    className="tool-run"
                    onClick={() => runInTerminal(runnable, runSession === null ? undefined : { sessionId: runSession })}
                    title={runButtonTitle(runSession !== null)}
                  >
                    <Icon name="play" size={10} /> Run
                  </button>
                ) : null}
              </div>
              <pre className="out-pre mono-strong">{primary.value}</pre>
            </div>
          ) : null}
          {args.map((a) => (
            <div key={a.id} className="tool-section">
              <div className="tool-label">{argLabel(a, primary !== null)}</div>
              <pre className="out-pre">{a.text}</pre>
            </div>
          ))}
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
      {subagentId && onShowSubagent ? (
        <button className="tool-link" onClick={() => onShowSubagent(subagentId)}>
          <Icon name="external" size={12} /> Show subagent
        </button>
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
  | { type: "notice"; item: Extract<Item, { kind: "notice" }> }
  | { type: "userBlock"; item: BlockItem }
  | { type: "agentBlock"; item: BlockItem; first: boolean }
  | { type: "command"; item: CommandItem }
  | { type: "delegate"; item: DelegateResultItem }
  | { type: "terminalRun"; item: TerminalRunItem };

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
    if (it.kind === "command") {
      out.push({ type: "command", item: it });
      continue;
    }
    if (it.kind === "delegate") {
      out.push({ type: "delegate", item: it });
      continue;
    }
    // A delivered run's result starts the agent's follow-up turn, as a user message would; a card whose
    // result has not gone is no turn boundary (the turn it was clicked in may still be writing).
    if (it.kind === "terminalRun") {
      out.push({ type: "terminalRun", item: it });
      if (!isUndeliveredRun(it)) agentTurnOpen = false;
      continue;
    }
    if (it.kind === "block" && it.role === "user") {
      out.push({ type: "userBlock", item: it });
      agentTurnOpen = false;
      continue;
    }
    const first = !agentTurnOpen;
    agentTurnOpen = true;
    if (it.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.type === "tools") last.items.push(it);
      else out.push({ type: "tools", items: [it], first });
    } else if (it.kind === "agent") out.push({ type: "agent", item: it, first });
    else if (it.kind === "block") out.push({ type: "agentBlock", item: it, first });
    else out.push({ type: "thought", item: it, first });
  }
  return out;
}

/**
 * A finished review round's card in the timeline. It sits right after the user message its round started from: the first
 * message containing one of `anchors` (tried in order: the round's head commit, the typed request, the pull request URL).
 * Cards are given oldest round first; a round claims the first matching message after the one the previous round of the
 * same `group` (pull request) claimed, so two rounds on one head land on their own start messages. A card no message
 * matches goes after the last item. Cards sharing a place keep the given (oldest first) order.
 */
export interface ReviewCardSlot {
  key: string;
  group: string;
  anchors: readonly string[];
  node: ReactNode;
}

/** Whether `text` holds `needle` as a whole token: a needle ending in a digit is not followed by another digit. */
function containsAnchor(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    if (!/\d$/.test(needle) || !/\d/.test(text.charAt(at + needle.length))) return true;
  }
  return false;
}

/** The block index each card follows (-1: after the last block). */
export function reviewCardPlacement(blocks: ReadonlyArray<{ type: string; item?: unknown }>, cards: readonly ReviewCardSlot[]): Map<string, number> {
  const placed = new Map<string, number>();
  const claimed = new Map<string, number>();
  for (const card of cards) {
    const after = claimed.get(card.group) ?? -1;
    let at = -1;
    for (const needle of card.anchors) {
      if (!needle.trim()) continue;
      at = blocks.findIndex((block, index) => {
        if (index <= after || block.type !== "user") return false;
        const text = (block.item as { text?: unknown } | undefined)?.text;
        return typeof text === "string" && containsAnchor(text, needle);
      });
      if (at >= 0) break;
    }
    placed.set(card.key, at);
    if (at >= 0) claimed.set(card.group, at);
  }
  return placed;
}

interface Props {
  items: Item[];
  /** Runs a command line a card's view sends; returns when its result is shown. */
  onRunCommand?: (line: string, opts: { display?: string; replaceId: number }) => void | Promise<unknown>;
  onEditMessage?: (text: string, context?: UserPromptContext, replaces?: number) => boolean;
  prLinks?: PrLinks;
  busy: boolean;
  replaying: boolean;
  empty: ReactNode;
  /** Finished review rounds, each placed where its round started. Running rounds are pinned by SessionView instead. */
  reviewCards?: readonly ReviewCardSlot[];
  /** The session's subagents: a tool card whose call spawned one links to it. */
  subagents?: readonly Subagent[];
  onShowSubagent?: (id: string) => void;
  /** The session shown: a Run clicked in this transcript is its run, and its result goes back to it (flow 523). */
  sessionId?: string | null;
}

export function Transcript(props: Props) {
  return (
    <RunSessionContext.Provider value={props.sessionId ?? null}>
      <TranscriptView {...props} />
    </RunSessionContext.Provider>
  );
}

function TranscriptView({ items, busy, replaying, empty, reviewCards = [], onRunCommand, onEditMessage, prLinks, subagents, onShowSubagent }: Props) {
  const spawned = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of subagents ?? []) if (a.parentToolCallId && !m.has(a.parentToolCallId)) m.set(a.parentToolCallId, a.id);
    return m;
  }, [subagents]);
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const stick = useRef(true);
  /** The user just opened or closed something: the growth that follows is theirs, not the stream's. */
  const userGrew = useRef(false);
  const blocks = useMemo(() => toBlocks(items), [items]);
  const placement = useMemo(() => reviewCardPlacement(blocks, reviewCards), [blocks, reviewCards]);
  const cardsAfter = (index: number) => reviewCards.filter(card => placement.get(card.key) === index)
    .map(card => <Fragment key={`review-${card.key}`}>{card.node}</Fragment>);
  // The item the turn streams into: the last before the undelivered Run cards that trail the turn.
  const last = items[streamEndOf(items, busy) - 1];
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

  // A message also grows outside React's renders (streamed Markdown, the settle pass, a code block's
  // chrome): while stuck to the bottom, follow every change of the content's size.
  useEffect(() => {
    const el = ref.current;
    const inner = innerRef.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (userGrew.current) {
        userGrew.current = false;
        return;
      }
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const jump = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const renderBlock = (b: (typeof blocks)[number]) => {
    switch (b.type) {
              case "user":
          return <UserMessage key={b.item.id} message={b.item.text} context={b.item.context} failed={b.item.failed} itemId={b.item.id} source={b.item.source} onEdit={onEditMessage} />;
              case "agent":
                return (
                  <AgentMessage key={b.item.id} first={b.first} text={b.item.text} prLinks={prLinks}
                    streaming={streamingAgent && b.item === last} />
                );
              case "thought":
                return (
                  <div key={b.item.id} className={`turn-agent${b.first ? " turn-start" : ""}`}>
                    {b.first ? <AgentLabel /> : null}
                    <Thought text={b.item.text} live={streamingThought && b.item === last} />
                  </div>
                );
              case "tools":
                return (
                  <div key={`t-${b.items[0]!.id}`} className={`turn-agent${b.first ? " turn-start" : ""}`}>
                    {b.first ? <AgentLabel /> : null}
                    <div className="tool-group">
                      {b.items.map((t) => (
                        <ToolRow key={t.id} item={t} subagentId={spawned.get(t.toolCallId)} onShowSubagent={onShowSubagent} />
                      ))}
                    </div>
                  </div>
                );
              case "delegate":
                return <DelegateResultCard key={b.item.id} item={b.item} />;
              case "terminalRun":
                return <TerminalRunCard key={b.item.id} item={b.item} />;
              case "command":
                return <CommandCard key={b.item.id} item={b.item} onRun={onRunCommand} />;
              case "userBlock":
                return (
                  <div key={b.item.id} className="turn-user">
                    <div className="user-block">
                      <ContentBlockView block={b.item.block} />
                    </div>
                  </div>
                );
              case "agentBlock":
                return (
                  <div key={b.item.id} className={`turn-agent${b.first ? " turn-start" : ""}`}>
                    {b.first ? <AgentLabel /> : null}
                    <ContentBlockView block={b.item.block} />
                  </div>
                );
              case "notice":
                return <NoticeRow key={b.item.id} item={b.item} />;
    }
  };

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={ref} aria-live="off">
        <div
          className="transcript-inner"
          ref={innerRef}
          onClickCapture={(e) => {
            if (!(e.target as HTMLElement).closest(".tool-row, .thought-row, details > summary")) return;
            userGrew.current = true;
            // Only the resize this click causes; a click that changes nothing must not skip a later pin.
            window.setTimeout(() => (userGrew.current = false), 150);
          }}
        >
          {replaying ? (
            <div className="loading-row centered">
              <Spinner /> Loading session…
            </div>
          ) : null}
          {items.length === 0 && reviewCards.length === 0 && !replaying ? empty : null}
          {blocks.map((b, i) => (
            <Fragment key={b.type === "tools" ? `t-${b.items[0]!.id}` : `b-${b.item.id}`}>
              {renderBlock(b)}
              {cardsAfter(i)}
            </Fragment>
          ))}
          {cardsAfter(-1)}
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

const NoticeRow = memo(function NoticeRow({ item }: { item: Extract<Item, { kind: "notice" }> }) {
  const icon: IconName = item.level === "info" ? "info" : "alert";
  if (!item.system) {
    return (
      <div className={`notice notice-${item.level}`} role={item.level === "error" ? "alert" : undefined}>
        <Icon name={icon} size={14} />
        <span>{item.text}</span>
      </div>
    );
  }
  // keryx's own note: its tag as a label, the body as Markdown (a gate report carries a list of reasons).
  return (
    <div className={`notice notice-system notice-${item.level}`} role={item.level === "error" ? "alert" : undefined}>
      <Icon name={icon} size={14} />
      <div className="notice-main">
        {item.system.tag ? <span className="notice-tag">{item.system.tag}</span> : null}
        {item.text ? <Markdown text={item.text} className="notice-md" /> : null}
      </div>
    </div>
  );
});

export function AgentMessage({ text, label, first = true, streaming, prLinks, children }: {
  text: string; label?: string; first?: boolean; streaming?: boolean; prLinks?: PrLinks; children?: ReactNode;
}) {
  return <div className={`turn-agent${first ? " turn-start" : ""}`}>
    {first && <AgentLabel label={label} />}
    <Markdown text={text} prLinks={prLinks} className={streaming ? "is-streaming" : undefined} />
    {children}
  </div>;
}

function AgentLabel({ label }: { label?: string }) {
  return (
    <div className="agent-label" aria-hidden={label === undefined}>
      <BrandMark className="agent-mark" />
      {label ?? "keryx"}
    </div>
  );
}
