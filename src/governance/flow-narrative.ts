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
  const { entries, sawHint } = proseEntries(proseOutsideFences(sectionOf(description, /^outcome criteri(?:a|on)$/i) ?? ""));
  if (entries.length > 0) return { stated: true, text: entries[0] ?? "", bullets: entries };
  return { stated: false, reason: sawHint ? "hint-only" : "empty-section" };
}

/**
 * Numbered items and prose paragraphs of a section, continuation lines folded
 * in. Headings, blockquotes, empty list markers and the template hint are not
 * statements (review round 2, defect 1).
 */
function proseEntries(body: string): { entries: string[]; sawHint: boolean } {
  const entries: string[] = [];
  let sawHint = false;
  let open = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      open = false;
      continue;
    }
    const unquoted = line.replace(/^>\s*/, "").replace(/^[-*]\s+/, "");
    if (unquoted === OUTCOME_HINT) {
      sawHint = true;
      open = false;
      continue;
    }
    if (/^#{1,6}(\s|$)/.test(line) || line.startsWith(">") || /^[-*]$/.test(line)) {
      open = false;
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered !== null) {
      entries.push(numbered[1] ?? "");
      open = true;
    } else if (open && entries.length > 0) {
      entries[entries.length - 1] += ` ${line}`;
    } else {
      entries.push(line);
      open = true;
    }
  }
  return { entries: entries.filter((entry) => entry.length > 0), sawHint };
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
