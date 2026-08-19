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
// A naturally-`exited`/`killed` job's entry is NOT auto-removed on its own
// exit event — it stays listed/inspectable (status flips, `exitCode`/
// `endedAt` populate) until `removeAll()`. This is the flow's resolved design
// decision: the human very likely wants to see a finished job's final
// output/exit code in the inspector after it completes, not have it vanish
// the instant it exits.

import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import type { BackgroundJobEvent } from "../harness/tool/builtin/background-job-registry";

export type BackgroundJobStatus = "running" | "exited" | "killed";

export type BackgroundJobEntry = {
  jobId: string;
  command: string;
  pid: number;
  status: BackgroundJobStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  output: string;
};

/** Bounded ring, TUI-display bound (distinct from the registry's own kill-rail `MAX_BACKGROUND_OUTPUT_BYTES`). */
export const MAX_BACKGROUND_JOB_OUTPUT_CHARS = 20_000;

export type BackgroundJobStoreHint = { id: string; kind: "start" | "output" | "exit" };

const STATUS_GLYPH: Record<BackgroundJobStatus, string> = {
  running: "◐",
  exited: "●",
  killed: "✗",
};

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
  void now;
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

export function formatJobOutput(entry: BackgroundJobEntry): string {
  return entry.output.length > 0 ? entry.output : "(no output yet)";
}

export class BackgroundJobStore {
  private readonly jobs = new Map<string, BackgroundJobEntry>();
  private readonly listeners = new Set<(hint: BackgroundJobStoreHint) => void>();

  apply(event: BackgroundJobEvent): void {
    if (event.type === "start") {
      this.jobs.set(event.jobId, {
        jobId: event.jobId,
        command: event.command,
        pid: event.pid,
        status: "running",
        startedAt: event.startedAt,
        output: "",
      });
      this.emit({ id: event.jobId, kind: "start" });
      return;
    }
    const current = this.jobs.get(event.jobId);
    if (current === undefined) {
      // No prior start — safe no-op (a foreign/unknown job's stray event).
      return;
    }
    if (event.type === "output") {
      const combined = current.output + event.chunk;
      current.output =
        combined.length > MAX_BACKGROUND_JOB_OUTPUT_CHARS
          ? combined.slice(-MAX_BACKGROUND_JOB_OUTPUT_CHARS)
          : combined;
      this.emit({ id: event.jobId, kind: "output" });
      return;
    }
    // event.type === "exit"
    current.status = event.status;
    current.endedAt = event.endedAt;
    if (event.exitCode !== undefined) {
      current.exitCode = event.exitCode;
    }
    this.emit({ id: event.jobId, kind: "exit" });
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
