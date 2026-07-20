// Live agent / worker fleet for the TUI sidebar (Activity panel).
//
// Main agent + enrich page workers share this shape. Status glyphs match
// `keryx agents monitor`: ◐ running · ● done · ✗ failed · ○ ready · ◼ blocked.
// Formatting prioritizes human-readable "what is happening / what do I do?"

export type FleetWorkerStatus = "queued" | "running" | "done" | "failed" | "blocked";

export interface FleetWorker {
  /** Stable id (page path, dispatch_id, …). */
  id: string;
  /** Short label for the sidebar (basename / dispatch short id). */
  label: string;
  status: FleetWorkerStatus;
  /** Phase key or short phrase (e.g. "thinking", "approval", "model"). */
  detail?: string;
  /** Optional provider/model line. */
  model?: string;
}

const STATUS_GLYPH: Record<FleetWorkerStatus, string> = {
  queued: "○",
  running: "◐",
  done: "●",
  failed: "✗",
  blocked: "◼",
};

const STATUS_ORDER: Record<FleetWorkerStatus, number> = {
  running: 0,
  blocked: 1,
  queued: 2,
  failed: 3,
  done: 4,
};

/** Stable id for the interactive shell's primary agent slot. */
export const MAIN_AGENT_ID = "agent:main";

/** Truncate for ~28-char sidebar width. */
function clip(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Turn a raw status+detail into a short human phrase for the sidebar.
 * Accepts both new phrases and legacy keys ("approval", "streaming", …).
 */
export function humanFleetPhase(status: FleetWorkerStatus, detail?: string): string {
  const d = (detail ?? "").trim();
  const key = d.toLowerCase();

  if (status === "blocked") {
    if (key === "approval" || key.includes("shell") || key.includes("permission")) {
      return "shell permission";
    }
    if (key === "ask" || key.includes("question") || key.includes("answer")) {
      return "answer a question";
    }
    return d.length > 0 ? d : "waiting for you";
  }

  if (status === "queued") {
    if (d.length === 0 || key === "idle" || key === "ready" || key === "queued") {
      return "ready";
    }
    return d;
  }

  if (status === "running") {
    if (key === "thinking") return "thinking…";
    if (key === "streaming") return "writing reply…";
    if (key === "waiting" || key === "waiting for model") return "waiting on model…";
    if (key === "shell") return "running shell…";
    if (key === "denied") return "shell denied · continuing";
    if (key === "force-all") return "enrich (all pages)…";
    if (key === "drafts") return "enrich (drafts)…";
    if (/^\d+\/\d+$/.test(d)) return `enrich ${d}`;
    if (key.startsWith("err:")) return `tool error · ${d.slice(4)}`;
    if (key.startsWith("running ")) return d;
    // Bare tool name from onToolCall
    if (d.length > 0 && !d.includes(" ")) {
      return `tool: ${d}`;
    }
    return d.length > 0 ? d : "working…";
  }

  if (status === "done") {
    if (d.length === 0 || key === "idle") return "turn finished";
    if (key.includes("ok") || key.includes("fail")) return d; // e.g. 3ok/1fail
    return d;
  }

  if (status === "failed") {
    if (key === "budget") return "stopped · budget";
    if (key === "error") return "error";
    return d.length > 0 ? d : "failed";
  }

  return d.length > 0 ? d : status;
}

/** One-line headline for the main agent (what is the session doing?). */
export function mainHeadline(status: FleetWorkerStatus): string {
  switch (status) {
    case "blocked":
      return "⚠ Waiting for you";
    case "running":
      return "◐ Working…";
    case "failed":
      return "✗ Failed";
    case "done":
      return "● Done";
    case "queued":
      return "○ Ready";
  }
}

/**
 * Pure: format workers for the Activity sidebar panel.
 * Main agent first (headline + phase + action hint when blocked), then swarm.
 */
export function formatFleetSidebar(workers: readonly FleetWorker[], maxLines = 14): string {
  if (workers.length === 0) {
    return "○ Ready\n(no agents)";
  }

  const main = workers.find((w) => w.id === MAIN_AGENT_ID);
  const others = workers.filter((w) => w.id !== MAIN_AGENT_ID);

  const lines: string[] = [];

  if (main !== undefined) {
    lines.push(mainHeadline(main.status));
    const phase = humanFleetPhase(main.status, main.detail);
    lines.push(`  ${clip(phase, 26)}`);
    if (main.status === "blocked") {
      lines.push("  ↑ pick menu above input");
    }
  } else {
    lines.push("○ Ready");
  }

  const waiting = workers.filter((w) => w.status === "blocked").length;
  const busy = workers.filter((w) => w.status === "running").length;
  const done = workers.filter((w) => w.status === "done").length;
  const failed = workers.filter((w) => w.status === "failed").length;

  // Swarm / multi-worker section
  if (others.length > 0) {
    lines.push("");
    const parts: string[] = [];
    if (waiting > 0) {
      parts.push(`${waiting} wait`);
    }
    parts.push(`${busy} busy`);
    parts.push(`${done} ok`);
    if (failed > 0) {
      parts.push(`${failed} fail`);
    }
    lines.push(`Fleet  ${parts.join(" · ")}`);

    const sorted = [...others].sort((a, b) => {
      const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (so !== 0) {
        return so;
      }
      return a.label.localeCompare(b.label);
    });

    // Reserve room for main block (~3–4 lines) + fleet header.
    const room = Math.max(2, maxLines - lines.length);
    const shown = sorted.slice(0, room);
    for (const w of shown) {
      const g = STATUS_GLYPH[w.status];
      const phase = humanFleetPhase(w.status, w.detail);
      const label = clip(w.label, 12);
      const det = phase.length > 0 ? ` ${clip(phase, 12)}` : "";
      lines.push(`${g} ${label}${det}`);
    }
    if (sorted.length > shown.length) {
      lines.push(`… +${sorted.length - shown.length} more`);
    }
  } else if (waiting > 0 || busy > 0 || done > 0 || failed > 0) {
    // Solo main: compact counters only when not trivial idle.
    if (main !== undefined && main.status !== "queued") {
      const parts: string[] = [];
      if (waiting > 0) parts.push(`${waiting} wait`);
      if (busy > 0) parts.push(`${busy} busy`);
      if (done > 0) parts.push(`${done} ok`);
      if (failed > 0) parts.push(`${failed} fail`);
      if (parts.length > 0) {
        lines.push(parts.join(" · "));
      }
    }
  }

  return lines.join("\n");
}

/** Short path for sidebar labels: `components/src-foo.md` → `src-foo`. */
export function shortWorkerLabel(pathOrId: string): string {
  const base = pathOrId.split("/").pop() ?? pathOrId;
  return base.replace(/\.md$/i, "");
}

/**
 * Mutable fleet registry with change listeners (TUI paints on notify).
 * Thread-safe only for single-threaded JS (same as the rest of the shell).
 */
export class WorkerFleet {
  private readonly workers = new Map<string, FleetWorker>();
  private readonly listeners = new Set<() => void>();

  clear(): void {
    this.workers.clear();
    this.emit();
  }

  /** Remove one worker by id (no-op if missing). */
  remove(id: string): void {
    if (this.workers.delete(id)) {
      this.emit();
    }
  }

  /**
   * Drop workers matching `pred`. Use to clear enrich pages without wiping
   * main / side workers.
   */
  clearMatching(pred: (w: FleetWorker) => boolean): void {
    let changed = false;
    for (const [id, w] of this.workers) {
      if (pred(w)) {
        this.workers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  /** Insert or merge a worker by id. */
  upsert(partial: Partial<FleetWorker> & Pick<FleetWorker, "id" | "label" | "status">): void {
    const prev = this.workers.get(partial.id);
    const next: FleetWorker = {
      id: partial.id,
      label: partial.label ?? prev?.label ?? partial.id,
      status: partial.status,
      ...(partial.detail !== undefined
        ? { detail: partial.detail }
        : prev?.detail !== undefined
          ? { detail: prev.detail }
          : {}),
      ...(partial.model !== undefined
        ? { model: partial.model }
        : prev?.model !== undefined
          ? { model: prev.model }
          : {}),
    };
    this.workers.set(partial.id, next);
    this.emit();
  }

  list(): FleetWorker[] {
    return [...this.workers.values()];
  }

  get(id: string): FleetWorker | undefined {
    return this.workers.get(id);
  }

  /** Subscribe to changes; returns unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
