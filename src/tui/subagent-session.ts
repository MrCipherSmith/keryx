// Session-scoped inspectable subagent log (flow 162).
//
// Unlike WorkerFleet, this store NEVER drops a spawned child: the sidebar list
// and the inspector modal need every child for the TUI session. `remove` is a
// no-op so a finished spawn_subagent stays clickable.

import { humanFleetPhase, type FleetWorkerStatus } from "./worker-fleet";
import type { SubagentFleetEvent, SubagentWorkKind } from "./subagent-bridge";

export type SubagentWorkEvent = {
  at: number;
  kind: SubagentWorkKind;
  text: string;
};

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

export function formatSubagentRow(session: SubagentSession, width = 26): string {
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

export function formatSubagentList(sessions: readonly SubagentSession[], width = 26): string {
  const lines = [`Subagents ${sessions.length}`];
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
  if (session.events.length === 0) {
    lines.push("  (no events yet)");
    return lines.join("\n");
  }
  for (const event of session.events) {
    if (event.kind === "task") {
      continue;
    }
    if (event.kind === "text") {
      lines.push(event.text);
      continue;
    }
    const tag = WORK_LABEL[event.kind];
    lines.push(`[${tag}] ${event.text}`);
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
  private readonly listeners = new Set<() => void>();
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
      this.emit();
      return;
    }

    const prev = this.sessions.get(event.id);
    const startedAt = prev?.startedAt ?? this.now();
    const next: SubagentSession = {
      id: event.id,
      label: event.label,
      status: event.status,
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
      ...(event.task !== undefined
        ? { task: event.task }
        : prev?.task !== undefined
          ? { task: prev.task }
          : {}),
    };
    if (event.status === "done" || event.status === "failed") {
      next.endedAt = prev?.endedAt ?? this.now();
    } else if (prev?.endedAt !== undefined) {
      next.endedAt = prev.endedAt;
    }
    const task = next.task?.trim() ?? "";
    if (task.length > 0 && !next.events.some((item) => item.kind === "task")) {
      next.events = [{ at: this.now(), kind: "task", text: task }, ...next.events];
    }
    this.sessions.set(event.id, next);
    this.emit();
  }

  get(id: string): SubagentSession | undefined {
    return this.sessions.get(id);
  }

  list(): SubagentSession[] {
    return [...this.sessions.values()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private appendLog(session: SubagentSession, kind: SubagentWorkKind, text: string): void {
    session.events.push({ at: this.now(), kind, text });
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // never break callers
      }
    }
  }
}
