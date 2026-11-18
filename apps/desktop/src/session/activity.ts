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
  entries: SubagentEntry[];
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
export function applySubagentEvent(list: readonly Subagent[], ev: unknown): readonly Subagent[] {
  const e = ev as Record<string, unknown> | null;
  if (!e || typeof e !== "object" || typeof e.id !== "string" || e.id === "") return list;
  const id = e.id;
  const idx = list.findIndex((s) => s.id === id);
  const prev: Subagent = idx >= 0 ? list[idx]! : { id, label: id, status: "running", entries: [] };
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
    next = { ...prev, entries: entries.length > MAX_SUBAGENT_ENTRIES ? entries.slice(entries.length - MAX_SUBAGENT_ENTRIES) : entries };
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
