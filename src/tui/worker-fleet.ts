// Live worker / subagent fleet for the TUI sidebar.
//
// Enrich page workers and (later) harness subagents share this shape so the
// sidebar can render a fleet list with status glyphs (aligned with
// `keryx agents monitor`: ◐ running · ● done · ✗ failed · ○ queued · ◼ blocked).

export type FleetWorkerStatus = "queued" | "running" | "done" | "failed" | "blocked";

export interface FleetWorker {
  /** Stable id (page path, dispatch_id, …). */
  id: string;
  /** Short label for the sidebar (basename / dispatch short id). */
  label: string;
  status: FleetWorkerStatus;
  /** Optional phase or model detail (e.g. "model", "validate", "deepseek/…"). */
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

/** Pure: format workers for a fixed-width sidebar panel. */
export function formatFleetSidebar(workers: readonly FleetWorker[], maxLines = 14): string {
  if (workers.length === 0) {
    return "(idle)";
  }
  // Main agent always first; then by status priority, then label.
  const sorted = [...workers].sort((a, b) => {
    if (a.id === MAIN_AGENT_ID && b.id !== MAIN_AGENT_ID) {
      return -1;
    }
    if (b.id === MAIN_AGENT_ID && a.id !== MAIN_AGENT_ID) {
      return 1;
    }
    const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (so !== 0) {
      return so;
    }
    return a.label.localeCompare(b.label);
  });
  const lines: string[] = [];
  const shown = sorted.slice(0, maxLines);
  for (const w of shown) {
    const g = STATUS_GLYPH[w.status];
    const det = w.detail && w.detail.length > 0 ? ` ${w.detail}` : "";
    // Keep lines short for ~28-char sidebar content width.
    const label = w.label.length > 18 ? `${w.label.slice(0, 15)}…` : w.label;
    lines.push(`${g} ${label}${det}`);
  }
  if (sorted.length > maxLines) {
    lines.push(`… +${sorted.length - maxLines} more`);
  }
  const running = workers.filter((w) => w.status === "running" || w.status === "blocked").length;
  const done = workers.filter((w) => w.status === "done").length;
  const failed = workers.filter((w) => w.status === "failed").length;
  const header = `${running} run · ${done} ok · ${failed} fail`;
  return `${header}\n${lines.join("\n")}`;
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
