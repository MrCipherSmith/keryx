// Backfilled decisions: historical questions imported into the journal after the
// fact (`keryx decisions import <file.jsonl>`), as the "before" arm of a comparison
// with the live records. The recommendation in them was written down once the
// answer was known, so every one is marked `backfilled`, is never blind, and is
// kept apart from the live records by the report and by every lookup.
//
// One line of the input file is one decision:
//   {"id","at","flow","stage","question","options":[{"id","label"}],
//    "recommendation":{"optionId","reason"}|null,"source","answer":{"choice","other"?}|null,"reason"?}
//
// The file is validated whole before anything is written: one bad line writes
// nothing. An id already in the journal is skipped (reported, never duplicated),
// so the same file can be imported twice.

import { DEFAULT_STAGE } from "./journal";
import { appendRecords, readRecords } from "./store";
import { oneLine } from "./text";
import type { AnswerRecord, DecisionOption, DecisionRecommendation, DecisionRecord, OpenRecord, ReasonRecord } from "./types";

export interface BackfillEntry {
  id: string;
  at: string;
  flow: string | null;
  stage: string;
  question: string;
  options: DecisionOption[];
  recommendation: DecisionRecommendation | null;
  source?: string;
  answer: { choice: string; other: boolean } | null;
  reason?: string;
}

export interface ImportCounts {
  /** Decisions written (or that would be written, on a dry run). */
  imported: number;
  /** Decisions whose id is already in the journal (or earlier in the same file). */
  skipped: number;
  /** Imported decisions that carry a recommendation. */
  withRecommendation: number;
  /** Imported decisions that carry an answer. */
  answered: number;
  /** Imported decisions with a recommendation whose answer is not the recommended option. */
  deviations: number;
}

export interface ImportResult extends ImportCounts {
  dryRun: boolean;
  skippedIds: string[];
}

export interface ImportParseError {
  line: number;
  message: string;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function parseEntry(raw: unknown): BackfillEntry | string {
  if (!isObject(raw)) return "a decision must be a JSON object";
  const id = raw["id"];
  if (!isString(id) || id.trim().length === 0) return "needs a non-empty string id";
  const at = raw["at"];
  if (!isString(at) || !Number.isFinite(Date.parse(at))) return `${id}: "at" must be an ISO date`;
  const flow = raw["flow"] === undefined ? null : raw["flow"];
  if (flow !== null && !isString(flow)) return `${id}: "flow" must be a string or null`;
  const stageRaw = raw["stage"];
  if (stageRaw !== undefined && !isString(stageRaw)) return `${id}: "stage" must be a string`;
  const question = raw["question"];
  if (!isString(question) || oneLine(question).length === 0) return `${id}: needs a question`;
  const optionsRaw = raw["options"];
  if (!Array.isArray(optionsRaw) || optionsRaw.length < 2) return `${id}: needs at least two options`;
  const options: DecisionOption[] = [];
  const ids = new Set<string>();
  for (const item of optionsRaw) {
    if (!isObject(item) || !isString(item["id"]) || item["id"].trim().length === 0) return `${id}: every option needs an id`;
    const optionId = item["id"];
    if (ids.has(optionId)) return `${id}: duplicate option id: ${optionId}`;
    ids.add(optionId);
    const label = isString(item["label"]) && item["label"].length > 0 ? item["label"] : optionId;
    options.push({ id: optionId, label, ...(isString(item["description"]) && item["description"].length > 0 ? { description: item["description"] } : {}) });
  }

  let recommendation: DecisionRecommendation | null = null;
  const recRaw = raw["recommendation"];
  if (recRaw !== undefined && recRaw !== null) {
    if (!isObject(recRaw) || !isString(recRaw["optionId"])) return `${id}: "recommendation" needs an optionId`;
    if (!ids.has(recRaw["optionId"])) return `${id}: the recommended option "${recRaw["optionId"]}" is not one of the options`;
    recommendation = { optionId: recRaw["optionId"], reason: isString(recRaw["reason"]) ? oneLine(recRaw["reason"]) : "" };
  }

  let answer: BackfillEntry["answer"] = null;
  const answerRaw = raw["answer"];
  if (answerRaw !== undefined && answerRaw !== null) {
    if (!isObject(answerRaw) || !isString(answerRaw["choice"]) || answerRaw["choice"].trim().length === 0) return `${id}: "answer" needs a choice`;
    const other = answerRaw["other"] === true;
    if (!other && !ids.has(answerRaw["choice"].trim())) {
      return `${id}: the answer "${answerRaw["choice"]}" is not one of the options (use "other": true for the human's own words)`;
    }
    answer = { choice: other ? oneLine(answerRaw["choice"]) : answerRaw["choice"].trim(), other };
  }

  const sourceRaw = raw["source"];
  if (sourceRaw !== undefined && !isString(sourceRaw)) return `${id}: "source" must be a string`;
  const reasonRaw = raw["reason"];
  if (reasonRaw !== undefined && reasonRaw !== null && !isString(reasonRaw)) return `${id}: "reason" must be a string`;
  const reason = isString(reasonRaw) ? oneLine(reasonRaw) : "";
  const source = isString(sourceRaw) ? oneLine(sourceRaw) : "";

  return {
    id,
    at,
    flow,
    stage: isString(stageRaw) && stageRaw.trim().length > 0 ? oneLine(stageRaw) : DEFAULT_STAGE,
    question: oneLine(question),
    options,
    recommendation,
    ...(source.length > 0 ? { source } : {}),
    answer,
    ...(reason.length > 0 ? { reason } : {}),
  };
}

/** Parse the whole file; every line that is not a decision is named, with its line number. */
export function parseBackfill(text: string): { entries: BackfillEntry[]; errors: ImportParseError[] } {
  const entries: BackfillEntry[] = [];
  const errors: ImportParseError[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push({ line: index + 1, message: "not valid JSON" });
      return;
    }
    const entry = parseEntry(parsed);
    if (typeof entry === "string") errors.push({ line: index + 1, message: entry });
    else entries.push(entry);
  });
  return { entries, errors };
}

/** The records of one backfilled decision: open, then the answer, then the reason, all stamped with the time the question was asked. */
export function backfillRecords(entry: BackfillEntry): DecisionRecord[] {
  const open: OpenRecord = {
    kind: "open",
    id: entry.id,
    at: entry.at,
    flow: entry.flow,
    stage: entry.stage,
    question: entry.question,
    options: entry.options,
    recommendation: entry.recommendation,
    // never blind: the human saw the options in order, with the recommendation marked when there was one
    mode: "ordinary",
    order: entry.options.map((option) => option.id),
    showMark: entry.recommendation !== null,
    irreversible: false,
    backfilled: true,
    ...(entry.source !== undefined ? { source: entry.source } : {}),
  };
  const records: DecisionRecord[] = [open];
  if (entry.answer !== null) {
    const answer: AnswerRecord = {
      kind: "answer",
      id: entry.id,
      at: entry.at,
      seq: 1,
      choice: entry.answer.choice,
      timeToAnswerMs: 0,
      changed: false,
      ...(entry.answer.other ? { other: true } : {}),
    };
    records.push(answer);
  }
  if (entry.reason !== undefined) {
    const reason: ReasonRecord = { kind: "reason", id: entry.id, at: entry.at, reason: entry.reason };
    records.push(reason);
  }
  return records;
}

/**
 * Import a file of backfilled decisions. Throws, writing nothing, when any line is
 * invalid (the message names every bad line). An id already in the journal is
 * skipped. With `dryRun` nothing is written.
 */
export async function importBackfill(cwd: string, text: string, options: { dryRun?: boolean } = {}): Promise<ImportResult> {
  const { entries, errors } = parseBackfill(text);
  if (errors.length > 0) {
    const shown = errors.slice(0, 20).map((error) => `line ${error.line}: ${error.message}`);
    const more = errors.length > shown.length ? [`... and ${errors.length - shown.length} more`] : [];
    throw new Error(`nothing was imported; ${errors.length} line${errors.length === 1 ? "" : "s"} could not be read:\n${[...shown, ...more].join("\n")}`);
  }
  const known = new Set((await readRecords(cwd)).filter((record) => record.kind === "open").map((record) => record.id));
  const result: ImportResult = { dryRun: options.dryRun === true, imported: 0, skipped: 0, withRecommendation: 0, answered: 0, deviations: 0, skippedIds: [] };
  const toWrite: DecisionRecord[] = [];
  for (const entry of entries) {
    if (known.has(entry.id)) {
      result.skipped += 1;
      result.skippedIds.push(entry.id);
      continue;
    }
    known.add(entry.id);
    result.imported += 1;
    if (entry.recommendation !== null) result.withRecommendation += 1;
    if (entry.answer !== null) {
      result.answered += 1;
      if (entry.recommendation !== null && entry.answer.choice !== entry.recommendation.optionId) result.deviations += 1;
    }
    toWrite.push(...backfillRecords(entry));
  }
  if (!result.dryRun) await appendRecords(cwd, toWrite);
  return result;
}

export function renderImportResult(result: ImportResult): string {
  const lines = [
    `${result.dryRun ? "Dry run, nothing written. " : ""}Imported: ${result.imported}, skipped: ${result.skipped}, with recommendation: ${result.withRecommendation}, answered: ${result.answered}, deviations: ${result.deviations}`,
  ];
  if (result.skippedIds.length > 0) {
    const shown = result.skippedIds.slice(0, 20).map((id) => oneLine(id, 80));
    lines.push(`Skipped (already in the journal): ${shown.join(", ")}${result.skippedIds.length > shown.length ? `, ... and ${result.skippedIds.length - shown.length} more` : ""}`);
  }
  return lines.join("\n");
}
