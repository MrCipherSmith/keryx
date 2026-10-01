// Flow 364 (AC1) — what a flow is for and where it stands, for the governance
// report: the stated effect and a one-line work summary. Pure over text the
// caller already read; no model, no clock, no write.

import {
  OUTCOME_HINT,
  flowDeliveryStatementFrom,
  outcomeBulletsFrom,
  proseOutsideFences,
  sectionOf,
} from "../flow/description-intent";
import type { FlowState } from "../flow/types";
import type { FlowEffect, FlowWorkSummary } from "./types";

/** `description` is `undefined` when the file could not be read. */
export function summarizeEffect(description: string | undefined): FlowEffect {
  if (description === undefined) return { stated: false, reason: "unreadable" };
  const bullets = outcomeBulletsFrom(description);
  if (bullets === null) return { stated: false, reason: "no-section" };
  const first = bullets[0];
  if (first !== undefined) return { stated: true, text: first, bullets };
  // Review L-002: no `-`/`*` bullets is not "only the hint". A numbered list or
  // prose is still a stated effect; only the untouched hint, or nothing, is not.
  const lines = proseOutsideFences(sectionOf(description, /^outcome criteri(?:a|on)$/i) ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0);
  const stated = lines.filter((line) => line !== OUTCOME_HINT).map((line) => line.replace(/^\d+[.)]\s+/, ""));
  if (stated.length > 0) return { stated: true, text: stated[0] ?? "", bullets: stated };
  return { stated: false, reason: lines.length > 0 ? "hint-only" : "empty-section" };
}

export function summarizeWork(flow: Pick<FlowState, "tasks">, description: string | undefined): FlowWorkSummary {
  const open = flow.tasks.filter((task) => task.status !== "done");
  return {
    statement: description === undefined ? null : flowDeliveryStatementFrom(description),
    tasksDone: flow.tasks.length - open.length,
    tasksTotal: flow.tasks.length,
    openTasks: open.map((task) => `${task.id} ${task.title}`),
  };
}

/** The `effect:` line, for the markdown report and the TUI alike. */
export function renderEffectLine(effect: FlowEffect | undefined): string {
  if (effect === undefined) return "effect: not recorded (report predates this field — re-run it)";
  if (effect.stated) {
    return effect.bullets.length > 1 ? `effect: ${effect.text} (+${effect.bullets.length - 1} more)` : `effect: ${effect.text}`;
  }
  const why = {
    "no-section": "no Outcome criteria section",
    "hint-only": "only the template hint",
    "empty-section": "the Outcome criteria section is empty",
    unreadable: "description.md unreadable",
  }[effect.reason];
  return `effect: not stated (${why})`;
}

/** The `summary:` line: the statement, then task progress, then what is still open. */
export function renderSummaryLine(summary: FlowWorkSummary | undefined): string {
  if (summary === undefined) return "summary: not recorded (report predates this field — re-run it)";
  const progress = `tasks ${summary.tasksDone}/${summary.tasksTotal}`;
  const open = summary.openTasks.length > 0 ? `; open: ${summary.openTasks.join(", ")}` : "";
  return `summary: ${summary.statement ?? "no statement in description.md"} — ${progress}${open}`;
}
