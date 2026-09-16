// Session-scoped background job store (flow 173, T4/T5). Structural mirror of
// `subagent-session.ts`'s `SubagentSessionStore` (apply/get/list/subscribe),
// fed by `job-bridge.ts`'s `BackgroundJobEvent` stream — the SAME
// discriminated union `background-job-registry.ts` already exports and fires
// via its `onEvent` hook, not a new shape.
//
// DELIBERATE DIVERGENCE from `SubagentSessionStore` (this flow's AC9,
// description.md: "entries do NOT clear on a new turn/`/clear` — a
// background job is explicitly meant to outlive the turn that started it. It
// clears only on explicit kill or session exit"): `SubagentSessionStore`
// exposes a bulk `clear()` that `tui-shell.ts` calls at a fresh parent turn
// AND on `/clear`/`/new`. A `BackgroundJobStore` with an equivalent `clear()`
// would invite exactly that same call site to be added later, silently
// reintroducing the bug this flow's whole design exists to avoid — so this
// store has NO `clear()` at all, only `removeAll()`, a distinctly named
// session-TEARDOWN sweep meant to be called from exactly one place (the real
// session-exit path, alongside `JobRegistry.sweepAll()`).
//
// A finished (`completed`/`failed`/`killed`) job's entry is NOT auto-removed
// on its own exit event — it stays listed/inspectable (status flips,
// `exitCode`/`endedAt`/`killReason` populate) until `removeAll()`. This is the
// flow's resolved design decision: the human very likely wants to see a
// finished job's final output/exit code in the inspector after it completes,
// not have it vanish the instant it exits.
//
// PHASE GATING (flow 263, AC8): every `shell_exec` is now a task, so most
// tasks are short foreground commands the sidebar must never show. A `start`
// event only records a hidden PENDING entry — not listed, not `get`-able, no
// hint. Output for a pending entry is retained silently. The task becomes
// visible on its `phase: "background"` event (a `background:true` start gets
// one right after `start`; a foreground task only if it outlives its yield),
// which emits the `start` hint exactly once. A task that exits while still
// pending is dropped silently; with no pending entry left to promote, a stray
// late `phase` for it is a no-op. Once visible, entries behave as before.

import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import type { BackgroundJobEvent, KillReason } from "../harness/tool/builtin/background-job-registry";

export type BackgroundJobStatus = "running" | "completed" | "failed" | "killed";

export type BackgroundJobEntry = {
  jobId: string;
  command: string;
  pid: number;
  status: BackgroundJobStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  killReason?: KillReason;
  output: string;
};

/** Bounded ring, TUI-display bound (distinct from the registry's own kill-rail `MAX_BACKGROUND_OUTPUT_BYTES`). */
export const MAX_BACKGROUND_JOB_OUTPUT_CHARS = 20_000;

export type BackgroundJobStoreHint = { id: string; kind: "start" | "output" | "exit" };

const STATUS_GLYPH: Record<BackgroundJobStatus, string> = {
  running: "◐",
  completed: "●",
  failed: "▲",
  killed: "✗",
};

function appendBounded(output: string, chunk: string): string {
  const combined = output + chunk;
  return combined.length > MAX_BACKGROUND_JOB_OUTPUT_CHARS
    ? combined.slice(-MAX_BACKGROUND_JOB_OUTPUT_CHARS)
    : combined;
}

function clip(s: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

export function formatJobListHeader(count: number): string {
  return `Background Jobs ${count}`;
}

export function formatJobRow(entry: BackgroundJobEntry, width = SIDEBAR_TEXT_WIDTH): string {
  const glyph = STATUS_GLYPH[entry.status];
  const budget = Math.max(1, width - glyph.length - 1);
  const cmd = clip(entry.command, budget);
  return clip(`${glyph} ${cmd}`, width);
}

export function formatJobMeta(entry: BackgroundJobEntry, now = Date.now()): string {
  const rows: Array<[string, string]> = [
    ["Id", entry.jobId],
    ["Pid", String(entry.pid)],
    ["Status", entry.status],
    ["Command", entry.command],
    ["Started", entry.startedAt],
    ["Ended", entry.endedAt ?? "—"],
    ["Exit code", entry.exitCode !== undefined ? String(entry.exitCode) : "—"],
  ];
  if (entry.killReason !== undefined) {
    rows.push(["Kill reason", entry.killReason]);
  }
  void now;
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

export function formatJobOutput(entry: BackgroundJobEntry): string {
  return entry.output.length > 0 ? entry.output : "(no output yet)";
}

export class BackgroundJobStore {
  /** Visible (promoted) entries — the only ones `get`/`list` expose. */
  private readonly jobs = new Map<string, BackgroundJobEntry>();
  /** Started but not yet promoted by a `phase` event — hidden, no hints. */
  private readonly pending = new Map<string, BackgroundJobEntry>();
  private readonly listeners = new Set<(hint: BackgroundJobStoreHint) => void>();

  apply(event: BackgroundJobEvent): void {
    switch (event.type) {
      case "start":
        this.pending.set(event.jobId, {
          jobId: event.jobId,
          command: event.command,
          pid: event.pid,
          status: "running",
          startedAt: event.startedAt,
          output: "",
        });
        return;
      case "phase": {
        const entry = this.pending.get(event.jobId);
        if (entry === undefined) {
          // Already visible (repeat), dropped (exited while pending, so no
          // pending entry is left to promote), or unknown — safe no-op.
          return;
        }
        this.pending.delete(event.jobId);
        this.jobs.set(event.jobId, entry);
        this.emit({ id: event.jobId, kind: "start" });
        return;
      }
      case "output": {
        const hidden = this.pending.get(event.jobId);
        if (hidden !== undefined) {
          hidden.output = appendBounded(hidden.output, event.chunk);
          return;
        }
        const current = this.jobs.get(event.jobId);
        if (current === undefined) {
          return;
        }
        current.output = appendBounded(current.output, event.chunk);
        this.emit({ id: event.jobId, kind: "output" });
        return;
      }
      case "exit": {
        if (this.pending.delete(event.jobId)) {
          // Exited while still foreground: dropped silently, never listed.
          return;
        }
        const current = this.jobs.get(event.jobId);
        if (current === undefined) {
          return;
        }
        current.status = event.status;
        current.endedAt = event.endedAt;
        if (event.exitCode !== undefined) {
          current.exitCode = event.exitCode;
        }
        if (event.killReason !== undefined) {
          current.killReason = event.killReason;
        }
        this.emit({ id: event.jobId, kind: "exit" });
        return;
      }
    }
  }

  get(jobId: string): BackgroundJobEntry | undefined {
    return this.jobs.get(jobId);
  }

  list(): BackgroundJobEntry[] {
    return [...this.jobs.values()];
  }

  subscribe(listener: (hint: BackgroundJobStoreHint) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Session-TEARDOWN sweep ONLY (see this file's header comment) — purges
   * every tracked job, including still-running ones. Never call this from a
   * per-turn or `/clear`/`/new` code path; that is exactly the bug this
   * store's deliberate lack of `clear()` exists to prevent.
   */
  removeAll(): void {
    this.pending.clear();
    if (this.jobs.size === 0) {
      return;
    }
    const ids = [...this.jobs.keys()];
    this.jobs.clear();
    for (const id of ids) {
      this.emit({ id, kind: "exit" });
    }
  }

  private emit(hint: BackgroundJobStoreHint): void {
    for (const listener of this.listeners) {
      try {
        listener(hint);
      } catch {
        // never break callers
      }
    }
  }
}
