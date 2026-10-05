// Flow 404: the text of `sync-status.md`, the one page that says where the Part 1 materials stand. Pure
// functions over already-computed data: nothing here reads a file or runs a process, so the sync can compute
// the whole page in memory before it writes anything.

import type { DecisionsReport } from "../decisions/service";

export const STATUS_TITLE = "# Текущее состояние / Live status";
/** The one isolated line a second run with no new data is allowed to change. */
export const RUN_LABEL = "Запуск (run, UTC): ";
const STATE_LABEL = "Состояние (status): ";
const LAST_OK_LABEL = "Последний успешный запуск (last successful run, UTC): ";
const STATE_OK = "ok";

/** `2026-10-05 03:52 UTC`: minute resolution, so two runs in the same minute write the same page. */
export function formatRunTime(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface StatusInput {
  runAt: Date;
  head: string;
  /** The keys and values of the frozen snapshot, `part1-counts.json`. */
  snapshot: Record<string, unknown>;
  /** The counts the unchanged script produced now. */
  latest: Record<string, unknown>;
  report: DecisionsReport;
  contributionRows: number;
}

function cell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "null";
  else if (typeof value === "object") {
    text = Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => `${key}: ${typeof inner === "object" && inner !== null ? JSON.stringify(inner) : String(inner)}`)
      .join(", ");
  } else text = String(value);
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

/** Every key of the snapshot, then any key only the new run has. */
function countsTable(snapshot: Record<string, unknown>, latest: Record<string, unknown>): string[] {
  const base = typeof snapshot.commit === "string" ? snapshot.commit : "snapshot";
  const keys = [...Object.keys(snapshot), ...Object.keys(latest).filter((key) => !(key in snapshot))];
  const rows = keys.map((key) => `| ${key} | ${cell(snapshot[key])} | ${cell(latest[key])} |`);
  return [`| Ключ (key) | снимок ${base} | сейчас |`, "| --- | --- | --- |", ...rows];
}

function tally(label: string, value: { answered: number; matched: number }): string {
  return `- ${label}: ${value.matched} из ${value.answered} (matched of answered)`;
}

function journalSummary(report: DecisionsReport): string[] {
  const withReason = report.deviations.filter((row) => row.reason !== undefined && row.reason.length > 0).length;
  const { threshold, counts, met } = report.progress.perArm;
  const arms = Object.entries(counts)
    .map(([arm, count]) => `${arm} ${count}/${threshold}`)
    .join(", ");
  const ac11 = report.progress.ac11;
  return [
    `- Решений (decisions): ${report.total}; с рекомендацией (with a recommendation): ${report.total - report.withoutRecommendation}`,
    tally("Совпадения, обычный режим (matches, normal)", report.byMode.ordinary),
    tally("Совпадения, частично слепой режим (matches, partial)", report.byMode.partial),
    tally("Совпадения, слепой режим (matches, blind)", report.byMode.blind),
    `- Отклонения (deviations): ${report.deviations.length}; с причиной (with a reason): ${withReason}; без причины (without a reason): ${report.deviations.length - withReason}`,
    `- Исключено как необратимые (excluded-irreversible): ${report.ineligible.decisions}`,
    `- Прогресс к порогу P7 (${threshold} обратимых вопросов на плечо, reversible questions per arm): ${arms}; порог достигнут (met): ${met ? "да (yes)" : "нет (no)"}`,
    `- Прогресс к AC11 флоу 392 (progress to AC11 of flow 392): решений ${ac11.decisions}/${ac11.decisionsTarget}, слепых ${ac11.blind}/${ac11.blindTarget}; ${ac11.met ? "выполнено (met)" : "не выполнено (not met)"}`,
  ];
}

export function renderStatus(input: StatusInput): string {
  const base = typeof input.snapshot.commit === "string" ? input.snapshot.commit : "snapshot";
  return [
    STATUS_TITLE,
    "",
    `${RUN_LABEL}${formatRunTime(input.runAt)}`,
    "",
    `${STATE_LABEL}${STATE_OK}`,
    `HEAD: ${input.head}`,
    `Строк в contribution-log.md (rows): ${input.contributionRows}`,
    "",
    `## Счётчики: снимок ${base} / сейчас (counts: snapshot / now)`,
    "",
    ...countsTable(input.snapshot, input.latest),
    "",
    "## Журнал решений (decisions journal)",
    "",
    ...journalSummary(input.report),
    "",
  ].join("\n");
}

/** The value after `label` on its own line, or null. */
function lineValue(text: string, label: string): string | null {
  for (const line of text.split("\n")) if (line.startsWith(label)) return line.slice(label.length).trim();
  return null;
}

/** The run time written in a status page, or null when there is none (the TUI shows it). */
export function readRunLine(text: string): string | null {
  return lineValue(text, RUN_LABEL);
}

export function isFailureStatus(text: string): boolean {
  const state = lineValue(text, STATE_LABEL);
  return state !== null && state !== STATE_OK;
}

/**
 * The page after a failed run: the reason in one line, when the last good run was, and the data of that run
 * kept below so the page stays useful. The `-latest` data files are not touched by a failed run.
 */
export function renderFailureStatus(input: { runAt: Date; reason: string; previous: string | null }): string {
  const { previous } = input;
  let lastOk: string | null = null;
  let body = "";
  if (previous !== null) {
    lastOk = isFailureStatus(previous) ? lineValue(previous, LAST_OK_LABEL) : readRunLine(previous);
    const at = previous.indexOf("\n## ");
    if (at >= 0) body = previous.slice(at + 1).trimEnd();
  }
  const lines = [
    STATUS_TITLE,
    "",
    `${RUN_LABEL}${formatRunTime(input.runAt)}`,
    "",
    `${STATE_LABEL}ошибка (failed): ${input.reason}`,
    `${LAST_OK_LABEL}${lastOk ?? "нет (none)"}`,
    "",
  ];
  if (body.length > 0) lines.push("Ниже данные последнего успешного запуска (below: data of the last successful run).", "", body, "");
  return lines.join("\n");
}

/** A failure reason as one short line: no stack, no path of this checkout, no more than 160 characters. */
export function reasonLine(error: unknown, root: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const first = (raw.split("\n")[0] ?? "").split(root).join(".").replace(/\s+/g, " ").trim();
  return (first.length > 160 ? `${first.slice(0, 157)}...` : first) || "unknown error";
}
