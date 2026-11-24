import { useLayoutEffect, useRef } from "react";
import type { CoordinatorEvent } from "../../../../src/review/desk-run-types";
import { absoluteTime } from "../lib/format";

export type TranscriptEvent = CoordinatorEvent & { at?: string };
type Entry = { kind: "event"; item: TranscriptEvent } | { kind: "tools"; items: TranscriptEvent[] };

function entriesFor(events: TranscriptEvent[]) {
  const entries: Entry[] = [];
  for (const item of events) {
    if (item.kind === "tool" || item.kind === "result") {
      const previous = entries.at(-1);
      if (previous?.kind === "tools") previous.items.push(item);
      else entries.push({ kind: "tools", items: [item] });
    } else if (["message", "question", "answer", "error", "status"].includes(item.kind)) {
      entries.push({ kind: "event", item });
    }
  }
  return entries;
}

function EventTime({ at }: { at?: string }) {
  if (!at) return null;
  return <time dateTime={at} title={absoluteTime(at)}>{new Date(at).toLocaleTimeString()}</time>;
}

function ToolGroup({ items }: { items: TranscriptEvent[] }) {
  const calls = items.filter(item => item.kind === "tool").length;
  const results = items.length - calls;
  return <details className="review-transcript-tools">
    <summary>{calls ? calls + (calls === 1 ? " tool call" : " tool calls") : results + (results === 1 ? " tool result" : " tool results")}</summary>
    <ol>{items.map((item, i) => <li key={i}>
      <header><strong>{item.kind === "tool" ? "Call" : "Result"}</strong><EventTime at={item.at} /></header>
      <div>{item.text}</div>
    </li>)}</ol>
  </details>;
}

export function ReviewTranscript({ actor, events, loading, error, truncated, followLatest = true }: {
  actor: "Coordinator" | "Reviewer"; events: TranscriptEvent[]; loading: boolean; error: string; truncated?: boolean; followLatest?: boolean;
}) {
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const last = events.at(-1);
  useLayoutEffect(() => { if (followLatest) following.current = true; }, [followLatest]);
  useLayoutEffect(() => {
    if (!log.current) return;
    if (!followLatest) log.current.scrollTop = 0;
    else if (following.current) log.current.scrollTop = log.current.scrollHeight;
  }, [events.length, last?.kind, last?.text, last?.at, followLatest]);
  return <section className="review-transcript">
    <h3>Transcript</h3>
    <div ref={log} className="review-session-log" role="log" aria-label={actor + " activity"} aria-live="polite"
      aria-relevant="additions" tabIndex={0} onScroll={e => {
        const node = e.currentTarget;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 20;
      }}>
      {truncated && <p className="review-detail-muted">Showing recent activity.</p>}
      {events.length ? <ol>{entriesFor(events).map((entry, i) => {
        if (entry.kind === "tools") return <li key={i}><ToolGroup items={entry.items} /></li>;
        const { kind, at, text } = entry.item;
        const label = kind === "message" || kind === "question" ? entry.item.reviewer ?? actor : kind === "answer" ? "Answer" : kind === "error" ? "Error" : "Progress";
        return <li key={i} data-kind={kind}><header><strong>{label}</strong><EventTime at={at} /></header><div>{text}</div></li>;
      })}</ol> : <p className="review-detail-muted">{error ? "Activity unavailable." : loading ? "Loading activity…" : "No activity recorded."}</p>}
    </div>
  </section>;
}

export function SessionOutcome({ title, result, reason, state }: { title: string; result?: string; reason?: string; state: string }) {
  return <section className="review-session-outcome" data-state={state} aria-label={title}>
    <h3>{title}</h3>
    {reason && <p>{reason}</p>}
    {result && <div className="review-returned-text" tabIndex={0}>{result}</div>}
  </section>;
}
