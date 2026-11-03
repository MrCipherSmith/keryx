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
