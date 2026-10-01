// Flow 364 (AC1) — what a flow is for and where it stands, for the governance
// report: the stated effect and a one-line work summary. Pure over text the
// caller already read; no model, no clock, no write.

import { flowDeliveryStatementFrom, outcomeBulletsFrom } from "../flow/description-intent";
import type { FlowState } from "../flow/types";
import type { FlowEffect, FlowWorkSummary } from "./types";

/** `description` is `undefined` when the file could not be read. */
export function summarizeEffect(description: string | undefined): FlowEffect {
  if (description === undefined) return { stated: false, reason: "unreadable" };
  const bullets = outcomeBulletsFrom(description);
  if (bullets === null) return { stated: false, reason: "no-section" };
  const first = bullets[0];
  if (first === undefined) return { stated: false, reason: "hint-only" };
  return { stated: true, text: first, bullets };
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
  const why = { "no-section": "no Outcome criteria section", "hint-only": "only the template hint", unreadable: "description.md unreadable" }[
    effect.reason
  ];
  return `effect: not stated (${why})`;
}

/** The `summary:` line: the statement, then task progress, then what is still open. */
export function renderSummaryLine(summary: FlowWorkSummary | undefined): string {
  if (summary === undefined) return "summary: not recorded (report predates this field — re-run it)";
  const progress = `tasks ${summary.tasksDone}/${summary.tasksTotal}`;
  const open = summary.openTasks.length > 0 ? `; open: ${summary.openTasks.join(", ")}` : "";
  return `summary: ${summary.statement ?? "no statement in description.md"} — ${progress}${open}`;
}
