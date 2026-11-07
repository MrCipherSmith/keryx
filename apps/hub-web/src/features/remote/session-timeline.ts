import type { InfiniteData } from "@tanstack/react-query";
import type { Control } from "../../api/remote";

/**
 * A command invocation kept for the chat. `anchor` is the session's latest `historyCursor` when the
 * command was invoked (the session record's cursor, or the loaded pages if they are ahead): a position
 * in the Hub's own message order, not a clock, and not just the pages this tab has paged in.
 */
export type CommandEntry = { outcome: Control["CommandOutcome"]; invokedAt: string; anchor: number };

/** How the command panel reports an outcome: the outcome, when it was invoked, and its placement anchor. */
export type CommandOutcomeListener = (outcome: Control["CommandOutcome"], invokedAt: string, anchor?: number) => void;

export type TimelineEntry =
  | { kind: "message"; message: Control["SessionMessage"] }
  | { kind: "outcome"; item: CommandEntry };

/** The one key History reads its pages from; the command panel reads the same cache at invoke time. */
export function historyQueryKey(scopeKey: number, projectId: string, sessionId: string) {
  return [scopeKey, projectId, "remote", "history", sessionId, "workspace"] as const;
}

/** Highest `historyCursor` among the loaded pages (0 when nothing is loaded yet). */
export function latestHistoryCursor(data: InfiniteData<Control["HistoryPage"]> | undefined): number {
  let latest = 0;
  data?.pages.forEach(page => page.messages.forEach(message => {
    if (message.historyCursor > latest) latest = message.historyCursor;
  }));
  return latest;
}

/**
 * Interleave command outcomes with messages by the Hub's message order. An outcome goes after the
 * last message whose `historyCursor` is at or below its `anchor`; outcomes with the same anchor keep
 * the order they were given. The browser clock and the machine clock are never compared.
 */
export function mergeTimeline(ordered: Control["SessionMessage"][], outcomes: CommandEntry[]): TimelineEntry[] {
  const byAnchor = [...outcomes].sort((a, b) => a.anchor - b.anchor);
  const timeline: TimelineEntry[] = [];
  let next = 0;
  for (const message of ordered) {
    while (next < byAnchor.length && byAnchor[next].anchor < message.historyCursor)
      timeline.push({ kind: "outcome", item: byAnchor[next++] });
    timeline.push({ kind: "message", message });
  }
  while (next < byAnchor.length) timeline.push({ kind: "outcome", item: byAnchor[next++] });
  return timeline;
}

type RunEvent = import("../../../../../src/remote-control/protocol").FrameOf<"run-event">["payload"];

/** Keep streaming across model rounds as each completed message arrives through session history. */
export function pendingAssistantText(runId: string, events: readonly RunEvent[], messages: readonly Control["SessionMessage"][]) {
  let text = "";
  const chunks = events.flatMap(event => {
    if (event.kind !== "log" || event.stream !== "assistant") return [];
    text += event.text;
    return [{ time: Date.parse(event.observedAt), end: text.length }];
  });
  let offset = 0;
  let older = 0;
  let through = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || message.runId !== runId || !message.text) continue;
    const time = Date.parse(message.createdAt);
    // Both timestamps come from the machine. Match text at equal timestamps so that
    // deltas from the next round in the same millisecond are not dropped.
    while (older < chunks.length && chunks[older].time < time) older++;
    through = Math.max(through, older);
    while (through < chunks.length && chunks[through].time === time) through++;
    const before = chunks[older - 1]?.end ?? 0;
    const boundary = chunks[through - 1]?.end ?? 0;
    const match = text.indexOf(message.text, offset);
    const end = match + message.text.length;
    offset = Math.max(offset, before, match >= 0 && end <= boundary ? end : 0);
  }
  return text.slice(offset).trimStart();
}
