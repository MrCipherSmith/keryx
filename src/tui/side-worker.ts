// Side workers: answer user messages while the main agent turn is still busy.
//
// Not a slash command — any non-control input during `busy` spawns a parallel
// read-mostly agent with a snapshot of main status + recent conversation.
// Side Q/A must NOT be written into the main session history.

import type { NormalizedMessage } from "../harness/provider/types";

export const SIDE_WORKER_ID_PREFIX = "side:";

export function isSideWorkerId(id: string): boolean {
  return id.startsWith(SIDE_WORKER_ID_PREFIX);
}

export interface MainSnapshot {
  /** Live phase string (e.g. "running shell_exec", "thinking"). */
  phase: string;
  /** Main fleet detail if any. */
  mainDetail?: string;
  /** Elapsed busy seconds (optional). */
  elapsedSec?: number;
}

/**
 * Build the user prompt for a side worker. Includes a live snapshot of the main
 * agent so the side answer can reference "what is happening now".
 */
export function buildSideWorkerPrompt(opts: {
  question: string;
  snapshot: MainSnapshot;
  recentHistory: readonly NormalizedMessage[];
  maxRecent?: number;
}): string {
  const maxRecent = opts.maxRecent ?? 10;
  const recent = opts.recentHistory.slice(-maxRecent);
  const lines: string[] = [
    "## Live main-agent state (read-only snapshot)",
    `phase: ${opts.snapshot.phase || "unknown"}`,
  ];
  if (opts.snapshot.mainDetail !== undefined && opts.snapshot.mainDetail.length > 0) {
    lines.push(`detail: ${opts.snapshot.mainDetail}`);
  }
  if (opts.snapshot.elapsedSec !== undefined) {
    lines.push(`elapsed: ${opts.snapshot.elapsedSec.toFixed(1)}s`);
  }
  lines.push(
    "",
    "## Recent main conversation (truncated; for context only)",
  );
  if (recent.length === 0) {
    lines.push("(empty)");
  } else {
    for (const m of recent) {
      const body = m.content.length > 400 ? `${m.content.slice(0, 397)}…` : m.content;
      lines.push(`### ${m.role}`, body, "");
    }
  }
  lines.push(
    "## Your task",
    "Answer the user's SIDE question below. Do NOT continue or take over the main task.",
    "Be brief. Prefer facts already visible above; use read-only tools only if essential.",
    "If the question is about what the main agent is doing, use the live snapshot.",
    "",
    "## Side question",
    opts.question.trim(),
  );
  return lines.join("\n");
}

/** System instruction for a side worker (no shell / no long plans). */
export function buildSideWorkerSystemInstruction(providerId: string, modelId: string): string {
  return (
    "You are a keryx SIDE worker answering a user question while the MAIN agent is busy.\n" +
    "Rules:\n" +
    "- Answer ONLY the side question; do not continue the main task.\n" +
    "- Do not call shell_exec or any mutating tool. Read-only tools only if needed.\n" +
    "- Be concise (prefer bullets). Lead with the answer.\n" +
    `- Provider/model: ${providerId}/${modelId}.\n`
  );
}

/** Short label for the Workers panel. */
export function sideWorkerLabel(seq: number): string {
  return `side-${seq}`;
}
