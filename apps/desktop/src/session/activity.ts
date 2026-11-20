// Subagents of one session (spec 3.9.4): the shell's fleet events applied to a list. Pure.

export const MAX_SUBAGENT_ENTRIES = 200;
export const MAX_SUBAGENT_ENTRY_CHARS = 2000;

/** `idle`: a terminal `/delegate` run finished a turn; the CLI is still open and waits for the user. */
export type SubagentStatus = "running" | "idle" | "done" | "failed" | (string & {});

/** The status as the user reads it. */
export const statusLabel = (status: string): string => (status === "idle" ? "waiting for you" : status);
export type EntryKind = "task" | "text" | "reasoning" | "tool" | "result" | "system" | (string & {});

export interface SubagentEntry {
  kind: EntryKind;
  text: string;
  /** Public final answer from the parent’s spawn return. */
  returned?: true;
}

export interface Subagent {
  id: string;
  label: string;
  status: SubagentStatus;
  detail?: string;
  model?: string;
  task?: string;
  runtime?: string;
  /** Registry id of an external agent (`claude-cli`). */
  agentId?: string;
  parentToolCallId?: string;
  /** Parent prompt ordinal at the child’s first event. */
  turn?: number;
  startedAt?: number;
  entries: SubagentEntry[];
  entriesTruncated?: true;
}

export type SubagentEvent =
  | {
      kind: "upsert";
      id: string;
      label?: string;
      status?: SubagentStatus;
      detail?: string;
      model?: string;
      task?: string;
      runtime?: string;
      agentId?: string;
      parentToolCallId?: string;
    }
  | { kind: "log"; id: string; entry: SubagentEntry };

/** A turn's `result` is keryx's capped answer (8 KB), so it keeps more than a log line does. */
export const MAX_SUBAGENT_RESULT_CHARS = 9000;

function clip(s: string, max: number = MAX_SUBAGENT_ENTRY_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Applies one event; the same list back when it changed nothing. An upsert merges the fields it carries
 * into the subagent with that id (a new one starts empty). A `text` log entry carries the whole assistant
 * text so far, so it replaces the previous entry when that one is also `text`; every other entry appends.
 */
export function applySubagentEvent(list: readonly Subagent[], ev: unknown, birth?: { turn: number; startedAt?: number }): readonly Subagent[] {
  const e = ev as Record<string, unknown> | null;
  if (!e || typeof e !== "object" || typeof e.id !== "string" || e.id === "") return list;
  const id = e.id;
  const idx = list.findIndex((s) => s.id === id);
  const prev: Subagent = idx >= 0 ? list[idx]! : { id, label: id, status: "running", entries: [], ...birth };
  let next: Subagent;
  if (e.kind === "upsert") {
    // The client decides a run's end (the process exit); a turn-done line read late must not undo it.
    const ended = prev.status === "done" || prev.status === "failed";
    const status = ended && e.status === "idle" ? prev.status : (str(e.status) ?? prev.status);
    next = {
      ...prev,
      label: str(e.label) ?? prev.label,
      status,
      detail: str(e.detail) ?? prev.detail,
      model: str(e.model) ?? prev.model,
      task: str(e.task) ?? prev.task,
      runtime: str(e.runtime) ?? prev.runtime,
      agentId: str(e.agentId) ?? prev.agentId,
      parentToolCallId: str(e.parentToolCallId) ?? prev.parentToolCallId,
    };
  } else if (e.kind === "log") {
    const entry = e.entry as { kind?: unknown; text?: unknown } | null;
    if (!entry || typeof entry.kind !== "string" || typeof entry.text !== "string") return list;
    const item: SubagentEntry = { kind: entry.kind, text: clip(entry.text, entry.kind === "result" ? MAX_SUBAGENT_RESULT_CHARS : MAX_SUBAGENT_ENTRY_CHARS) };
    const entries = prev.entries.slice();
    const last = entries[entries.length - 1];
    if (item.kind === "text" && last?.kind === "text") entries[entries.length - 1] = item;
    else entries.push(item);
    next = entries.length > MAX_SUBAGENT_ENTRIES
      ? { ...prev, entriesTruncated: true, entries: entries.slice(-MAX_SUBAGENT_ENTRIES) }
      : { ...prev, entries };
  } else {
    return list;
  }
  if (idx < 0) return [...list, next];
  const out = list.slice();
  out[idx] = next;
  return out;
}

/** Only `running` counts: a run waiting for the user is not working. */
export const runningSubagents = (list: readonly Subagent[]): number => list.filter((s) => s.status === "running").length;

/** The subagent a `spawn_subagent` tool call started. */
export function subagentForToolCall(list: readonly Subagent[], toolCallId: string): Subagent | undefined {
  return list.find((s) => s.parentToolCallId === toolCallId);
}

export function isActiveSubagent(agent: Subagent): boolean {
  return agent.status === "running" || agent.status === "idle";
}

/** Creation order breaks ties, including for old history without dates. */
export function sortSubagents(list: readonly Subagent[]): Subagent[] {
  return [...list].reverse().sort((a, b) =>
    Number(isActiveSubagent(b)) - Number(isActiveSubagent(a)) ||
    (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function partitionSubagents(list: readonly Subagent[]): { current: Subagent[]; archived: Subagent[] } {
  const latestTurn = list.reduce((latest, agent) => Math.max(latest, agent.turn ?? 0), 0);
  const current: Subagent[] = [], archived: Subagent[] = [];
  for (const agent of sortSubagents(list)) {
    (isActiveSubagent(agent) || (agent.turn ?? 0) === latestTurn ? current : archived).push(agent);
  }
  return { current, archived };
}

/** Capture only a native child's recorded public return, never its input or arbitrary tool output. */
export function replaySpawn(call: { toolCallId: string; rawOutput?: unknown; status: string }, turn: number, startedAt?: number): Subagent | undefined {
  if (typeof call.rawOutput !== "string") return;
  const output = call.rawOutput;
  const match = /^(?:status:[^\n]*\n)?subagent ([^\n]{1,180}?) \((sub:[\w.-]+)\)(?: |$)/i.exec(output);
  if (!match) return;
  const summary = /\n--- summary ---\n/.exec(output);
  const stopped = /^(?:status:|STATUS:)/.test(output) || call.status === "failed";
  const partial = stopped ? /\n--- (?:last output|submitted result \([\w-]+\)) ---\n/.exec(output) : null;
  const marker = stopped ? partial : summary;
  const result = marker ? output.slice(marker.index + marker[0].length, marker.index + marker[0].length + MAX_SUBAGENT_RESULT_CHARS) : "";
  const reason = stopped ? /^status: ([\w-]+)/i.exec(output)?.[1] : undefined;
  return {
    id: match[2]!, label: match[1]!, turn, startedAt, parentToolCallId: call.toolCallId,
    status: !stopped && summary ? "done" : "failed",
    runtime: "native", detail: reason ?? "from history",
    entries: result ? [{ kind: "result", text: result, returned: true }] : [],
  };
}

/** Restore the public log and retain the call id from the replay (live ACP call ids can differ). */
export function mergeArchivedSubagents(history: readonly Subagent[], archive: readonly Subagent[]): readonly Subagent[] {
  const merged = new Map(history.map(row => [row.id, row]));
  for (const stored of archive) {
    const replay = merged.get(stored.id);
    const returned = replay?.entries.at(-1);
    const entries = returned?.kind === "result" && !stored.entries.some(e => e.text === returned.text)
      ? [...stored.entries, returned].slice(-MAX_SUBAGENT_ENTRIES) : stored.entries;
    merged.set(stored.id, { ...stored, entries, turn: stored.turn ?? replay?.turn, startedAt: stored.startedAt ?? replay?.startedAt,
      parentToolCallId: replay?.parentToolCallId ?? stored.parentToolCallId,
      status: stored.status === "unknown" && replay ? replay.status : stored.status });
  }
  return [...merged.values()];
}
