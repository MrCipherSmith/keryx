// Session-scoped inspectable subagent log (flow 162).
//
// Unlike WorkerFleet, individual entries are never dropped one at a time: the
// sidebar list and the inspector modal need every child from the CURRENT
// scope (the running turn, or the session since the last `/clear`/`/new`) to
// stay clickable, so a single finished spawn_subagent never silently
// disappears mid-turn. `apply({kind: "remove"})` stays a no-op for that
// reason. The whole store IS reset in bulk via `clear()` — at each new parent
// turn (so subagents from an EARLIER turn stop cluttering the list once a
// fresh one starts, spawning or not) and on `/clear`/`/new` (a full session
// reset). Without either, entries accumulated for the rest of the shell
// process's life: nothing ever called `clear()` or emitted `remove`.

import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { humanFleetPhase, type FleetWorkerStatus } from "./worker-fleet";
import type { SubagentFleetEvent, SubagentWorkKind } from "./subagent-bridge";

export type SubagentWorkEvent = {
  at: number;
  kind: SubagentWorkKind;
  text: string;
};

/** Keep the inspector usable without retaining a full child transcript. */
export const MAX_SUBAGENT_EVENTS = 200;
/** Clip one log line; tool results already preview at 400. */
export const MAX_SUBAGENT_EVENT_CHARS = 2_000;

export type SubagentStoreHint = { id: string; kind: "upsert" | "log" | "remove" };

export type SubagentSession = {
  id: string;
  label: string;
  status: FleetWorkerStatus;
  detail?: string;
  model?: string;
  task?: string;
  startedAt: number;
  endedAt?: number;
  events: SubagentWorkEvent[];
};

const STATUS_GLYPH: Record<FleetWorkerStatus, string> = {
  queued: "○",
  running: "◐",
  done: "●",
  failed: "✗",
  blocked: "◼",
};

const WORK_LABEL: Record<SubagentWorkKind, string> = {
  task: "task",
  text: "text",
  reasoning: "think",
  tool: "tool",
  result: "result",
  system: "sys",
};

function clip(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const sec = Math.round(ms / 1000);
  if (sec < 1) {
    return "<1s";
  }
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) {
    return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
  }
  const hours = Math.floor(min / 60);
  const minRem = min % 60;
  return minRem === 0 ? `${hours}h` : `${hours}h ${minRem}m`;
}

export function formatSubagentRow(session: SubagentSession, width = SIDEBAR_TEXT_WIDTH): string {
  const glyph = STATUS_GLYPH[session.status];
  const phase = humanFleetPhase(session.status, session.detail);
  const budget = Math.max(4, width - glyph.length - 1);
  const labelBudget = Math.min(12, budget);
  const label = clip(session.label, labelBudget);
  const used = glyph.length + 1 + label.length;
  const detBudget = width - used - 1;
  const det = detBudget >= 3 && phase.length > 0 ? ` ${clip(phase, detBudget)}` : "";
  return clip(`${glyph} ${label}${det}`, width);
}

export function formatSubagentListHeader(count: number): string {
  return `Subagents ${count}`;
}

export function formatSubagentList(sessions: readonly SubagentSession[], width = SIDEBAR_TEXT_WIDTH): string {
  const lines = [formatSubagentListHeader(sessions.length)];
  if (sessions.length === 0) {
    lines.push(clip("(none)", width));
    return lines.join("\n");
  }
  for (const session of sessions) {
    lines.push(formatSubagentRow(session, width));
  }
  return lines.join("\n");
}

export function formatSubagentWork(session: SubagentSession): string {
  const lines: string[] = [];
  const task = session.task?.trim() ?? "";
  if (task.length > 0) {
    lines.push("Task");
    lines.push(`  ${task}`);
    lines.push("");
  }
  lines.push("Work");
  let workRows = 0;
  for (const event of session.events) {
    if (event.kind === "task") {
      continue;
    }
    workRows += 1;
    if (event.kind === "text") {
      lines.push(event.text);
      continue;
    }
    const tag = WORK_LABEL[event.kind];
    lines.push(`[${tag}] ${event.text}`);
  }
  if (workRows === 0) {
    lines.push("  (no events yet)");
  }
  return lines.join("\n");
}

export function formatSubagentMeta(session: SubagentSession, now = Date.now()): string {
  const end = session.endedAt ?? now;
  const rows: Array<[string, string]> = [
    ["Id", session.id],
    ["Label", session.label],
    ["Status", session.status],
    ["Detail", session.detail ?? "—"],
    ["Model", session.model ?? "—"],
    ["Elapsed", formatElapsed(end - session.startedAt)],
    ["Task", session.task ?? "—"],
  ];
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

export class SubagentSessionStore {
  private readonly sessions = new Map<string, SubagentSession>();
  private readonly listeners = new Set<(hint: SubagentStoreHint) => void>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  apply(event: SubagentFleetEvent): void {
    if (event.kind === "remove") {
      return;
    }
    if (event.kind === "log") {
      const current = this.sessions.get(event.id);
      if (current === undefined) {
        return;
      }
      this.appendLog(current, event.entry.kind, event.entry.text);
      this.emit({ id: event.id, kind: "log" });
      return;
    }

    const prev = this.sessions.get(event.id);
    const terminal = prev?.status === "done" || prev?.status === "failed";
    const incomingActive = event.status === "running" || event.status === "queued";
    const status = terminal && incomingActive && prev !== undefined ? prev.status : event.status;
    const startedAt = prev?.startedAt ?? this.now();
    const taskIn = event.task ?? prev?.task;
    const taskClipped =
      taskIn !== undefined && taskIn.length > MAX_SUBAGENT_EVENT_CHARS
        ? `${taskIn.slice(0, MAX_SUBAGENT_EVENT_CHARS)}…`
        : taskIn;
    const next: SubagentSession = {
      id: event.id,
      label: event.label,
      status,
      startedAt,
      events: prev?.events ?? [],
      ...(event.detail !== undefined
        ? { detail: event.detail }
        : prev?.detail !== undefined
          ? { detail: prev.detail }
          : {}),
      ...(event.model !== undefined
        ? { model: event.model }
        : prev?.model !== undefined
          ? { model: prev.model }
          : {}),
      ...(taskClipped !== undefined ? { task: taskClipped } : {}),
    };
    if (status === "done" || status === "failed") {
      next.endedAt = prev?.endedAt ?? this.now();
    } else if (prev?.endedAt !== undefined) {
      next.endedAt = prev.endedAt;
    }
    const task = next.task?.trim() ?? "";
    if (task.length > 0 && !next.events.some((item) => item.kind === "task")) {
      next.events = [{ at: this.now(), kind: "task", text: task }, ...next.events];
    }
    this.sessions.set(event.id, next);
    this.emit({ id: event.id, kind: "upsert" });
  }

  get(id: string): SubagentSession | undefined {
    return this.sessions.get(id);
  }

  list(): SubagentSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Drop every tracked subagent at once (new turn / `/clear` / `/new`). A
   * no-op — no listener notification — when already empty, so a turn that
   * never spawns a subagent does not repaint the sidebar for nothing.
   */
  clear(): void {
    if (this.sessions.size === 0) {
      return;
    }
    this.sessions.clear();
    this.emit({ id: "*", kind: "remove" });
  }

  subscribe(listener: (hint: SubagentStoreHint) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private appendLog(session: SubagentSession, kind: SubagentWorkKind, text: string): void {
    const clipped = text.length > MAX_SUBAGENT_EVENT_CHARS ? `${text.slice(0, MAX_SUBAGENT_EVENT_CHARS)}…` : text;
    session.events.push({ at: this.now(), kind, text: clipped });
    if (session.events.length <= MAX_SUBAGENT_EVENTS) {
      return;
    }
    const task = session.events.find((item) => item.kind === "task");
    const rest = session.events.filter((item) => item !== task);
    const keep = rest.slice(-(MAX_SUBAGENT_EVENTS - (task !== undefined ? 1 : 0)));
    session.events = task !== undefined ? [task, ...keep] : keep;
  }

  private emit(hint: SubagentStoreHint): void {
    for (const listener of this.listeners) {
      try {
        listener(hint);
      } catch {
        // never break callers
      }
    }
  }
}
