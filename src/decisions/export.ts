// Flow 400 (AC14): the export of the journal for analysis outside the repository.
//
// It carries the STRUCTURE of each decision and none of its words: no question, no
// option label or description, no recommendation reason, no human reason, no note, no
// flow name, no source. What is left is what the arms need to be analysed: arm, seed,
// preselected, the display order as positions, channel, forced, legacy, whether the human
// deviated, the quality ratings, and the times.
//
// Anything that could carry text is turned into a number or a flag before it leaves:
//   - the display order is the positions of the options in the order the agent gave them
//     (never the option ids, which are free strings);
//   - the decision id is replaced by a short hash, so a rating can still be joined to its
//     decision without the export repeating an id an importer may have written as prose;
//   - a stage, a channel and a model name are kept only when they match a closed vocabulary
//     (the stage names the code base uses, tui and telegram, a conservative model-id pattern),
//     otherwise they become "other": an identifier-shaped secret is as much a leak as prose.
//
// The allow-list is also enforced at run time, not only by the types. A journal line is a file
// a person can edit, so every exported value is validated: a timestamp must be ISO-8601 UTC, a
// seed and a count must be non-negative integers, an arm one of A, B, C or D, a flag a real
// boolean. An invalid field becomes null; a record whose id or arm is invalid is skipped. The
// counts are returned in the summary (`exportSummaryLine`), never mixed into the rows.

import { createHash } from "node:crypto";
import { ARMS, type Arm } from "./arms";
import { effectiveArm, isLegacy } from "./legacy";
import { QUALITIES, readQuality, type Quality, type QualityRecord, type Rater } from "./quality";
import { readJournal } from "./store";
import type { AnswerRecord, DecisionRecord, OpenRecord } from "./types";

export interface ExportRating {
  rater: Rater;
  quality: Quality;
  /** A model rating only: the label is "model self-assessment", never a human view. */
  model?: string;
  cleanContext?: boolean;
  modelAgree?: boolean;
  /** ISO-8601 UTC, or null when the journal line held anything else. */
  at: string | null;
}

export interface ExportRow {
  /** A short hash of the decision id. */
  ref: string;
  /** ISO-8601 UTC, or null when the journal line held anything else. */
  openedAt: string | null;
  arm: Arm;
  seed: number | null;
  preselected: boolean | null;
  /** The positions (0-based, in the agent's order) of the options in the order the human saw them. */
  order: number[];
  optionCount: number;
  channel: string;
  forced: boolean;
  legacy: boolean;
  backfilled: boolean;
  stage: string;
  hasRecommendation: boolean;
  /** The position of the recommended option, or null. */
  recommendedIndex: number | null;
  answered: boolean;
  answeredAt: string | null;
  timeToAnswerMs: number | null;
  /** The position of the first choice, or null for a free-form answer or no answer. */
  chosenIndex: number | null;
  other: boolean;
  /** True when the first answer is not the recommended option; null without a recommendation or an answer. */
  deviation: boolean | null;
  /** How many answers the decision has beyond the first. */
  changes: number;
  ratings: ExportRating[];
}

export interface ExportOptions {
  /** Only decisions opened at or after this time. */
  since?: Date | undefined;
  excludeLegacy?: boolean | undefined;
}

/** What a field becomes when its value is not in the vocabulary. */
export const OTHER = "other";

/**
 * The stages a question is asked in: the kinds of a flow task, the statuses of a flow (the stage falls back to the
 * status), the sources and the defaults the journal writes itself, and the stage names the docs and the CLI use.
 */
export const EXPORT_STAGES: readonly string[] = [
  "context",
  "implement",
  "test",
  "verify",
  "review",
  "docs",
  "initializing",
  "ready",
  "in-progress",
  "implemented",
  "completing",
  "done",
  "blocked",
  "ask_user",
  "needs_context",
  "unspecified",
  "design",
  "plan",
  OTHER,
];

export const EXPORT_CHANNELS: readonly string[] = ["tui", "telegram", OTHER];

/** A model id as providers write it: lowercase letters, digits, dots and dashes, up to 40 characters. */
export const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,39}$/;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const inVocabulary = (value: unknown, vocabulary: readonly string[]): string => (typeof value === "string" && vocabulary.includes(value) ? value : OTHER);
const exportModel = (value: unknown): string => (typeof value === "string" && MODEL_ID.test(value) ? value : OTHER);

/** What the export dropped or blanked because the journal held something outside the allow-list. */
export interface ExportSummary {
  rows: number;
  /** Records (and ratings) left out: an invalid id or arm, an unknown rater or quality. */
  skipped: number;
  /** Fields of kept records that were present but invalid and were exported as null (or left out). */
  blanked: number;
}

export function exportSummaryLine(summary: ExportSummary): string {
  return `Export: ${summary.rows} decision${summary.rows === 1 ? "" : "s"}, ${summary.skipped} skipped, ${summary.blanked} invalid field${summary.blanked === 1 ? "" : "s"} blanked.`;
}

/** Counts the invalid values met while one export is built. */
class Validator {
  skipped = 0;
  blanked = 0;

  /** A value that must be absent or valid: absent is null without a count, present and invalid is null and counted. */
  private pick<T>(value: unknown, ok: (value: unknown) => value is T): T | null {
    if (value === undefined || value === null) return null;
    if (ok(value)) return value;
    this.blanked += 1;
    return null;
  }

  timestamp(value: unknown): string | null {
    return this.pick(value, (v): v is string => typeof v === "string" && ISO_UTC.test(v) && Number.isFinite(Date.parse(v)));
  }

  count(value: unknown): number | null {
    return this.pick(value, (v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0);
  }

  duration(value: unknown): number | null {
    return this.pick(value, (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  }

  flag(value: unknown): boolean | null {
    return this.pick(value, (v): v is boolean => typeof v === "boolean");
  }
}

export const exportRef = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 12);

/** The fields an export row may carry, in one place so a test can hold the export to it. */
export const EXPORT_FIELDS: readonly (keyof ExportRow)[] = [
  "ref",
  "openedAt",
  "arm",
  "seed",
  "preselected",
  "order",
  "optionCount",
  "channel",
  "forced",
  "legacy",
  "backfilled",
  "stage",
  "hasRecommendation",
  "recommendedIndex",
  "answered",
  "answeredAt",
  "timeToAnswerMs",
  "chosenIndex",
  "other",
  "deviation",
  "changes",
  "ratings",
];

function indexOf(open: OpenRecord, id: string | undefined): number | null {
  if (id === undefined) return null;
  const at = open.options.findIndex((option) => option.id === id);
  return at < 0 ? null : at;
}

function exportChannel(open: OpenRecord): string {
  const raw: unknown = open.channel;
  if (raw === undefined) return "tui";
  if (typeof raw !== "string") return OTHER;
  return raw.trim().length === 0 ? "tui" : inVocabulary(raw.trim().toLowerCase(), EXPORT_CHANNELS);
}

const MODES: readonly unknown[] = ["ordinary", "partial", "blind"];

/** The arm of a record, or null when what the line holds is not an arm: such a record is not exported. */
function exportArm(open: OpenRecord): Arm | null {
  const raw: unknown = open.arm;
  if (raw !== undefined) return typeof raw === "string" && (ARMS as readonly string[]).includes(raw) ? (raw as Arm) : null;
  return MODES.includes(open.mode) ? effectiveArm(open) : null;
}

export function buildExport(records: readonly DecisionRecord[], quality: readonly QualityRecord[] = [], options: ExportOptions = {}): ExportRow[] {
  return buildExportWithSummary(records, quality, options).rows;
}

export function buildExportWithSummary(
  records: readonly DecisionRecord[],
  quality: readonly QualityRecord[] = [],
  options: ExportOptions = {},
): { rows: ExportRow[]; summary: ExportSummary } {
  const check = new Validator();
  const opens: OpenRecord[] = [];
  const answers = new Map<string, AnswerRecord[]>();
  const seen = new Set<string>();
  for (const record of records) {
    if (typeof record.id !== "string" || record.id.length === 0) {
      check.skipped += 1;
      continue;
    }
    if (record.kind === "open") {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      opens.push(record);
    } else if (record.kind === "answer") {
      // the order of the answers is by `seq`: an answer without a usable one cannot be placed, so it is left out
      if (!Number.isInteger(record.seq)) {
        check.skipped += 1;
        continue;
      }
      const list = answers.get(record.id) ?? [];
      list.push(record);
      answers.set(record.id, list);
    }
  }
  const rows: ExportRow[] = [];
  for (const open of opens) {
    const arm = exportArm(open);
    if (arm === null || !Array.isArray(open.options) || !Array.isArray(open.order)) {
      check.skipped += 1;
      continue;
    }
    const legacy = open.backfilled === true || isLegacy(open);
    if (options.excludeLegacy === true && legacy) continue;
    const openedAt = check.timestamp(open.at);
    // a record whose time cannot be read cannot be shown to be inside a --since window
    if (options.since !== undefined && (openedAt === null || Date.parse(openedAt) < options.since.getTime())) continue;
    const list = [...(answers.get(open.id) ?? [])].sort((a, b) => a.seq - b.seq);
    const first = list[0];
    const hasRecommendation = open.recommendation !== null && open.recommendation !== undefined && typeof open.recommendation === "object";
    const recommendedId = hasRecommendation ? open.recommendation?.optionId : undefined;
    const chosen = first === undefined || first.other === true ? null : indexOf(open, typeof first.choice === "string" ? first.choice : undefined);
    rows.push({
      ref: exportRef(open.id),
      openedAt,
      arm,
      seed: check.count(open.seed),
      preselected: check.flag(open.preselected),
      order: open.order.map((id) => indexOf(open, typeof id === "string" ? id : undefined)).filter((at): at is number => at !== null),
      optionCount: open.options.length,
      channel: exportChannel(open),
      forced: open.forced === true,
      legacy,
      backfilled: open.backfilled === true,
      stage: inVocabulary(open.stage, EXPORT_STAGES),
      hasRecommendation,
      recommendedIndex: indexOf(open, typeof recommendedId === "string" ? recommendedId : undefined),
      answered: first !== undefined,
      answeredAt: first === undefined ? null : check.timestamp(first.at),
      timeToAnswerMs: first === undefined || open.backfilled === true ? null : check.duration(first.timeToAnswerMs),
      chosenIndex: chosen,
      other: first?.other === true,
      deviation: first === undefined || !hasRecommendation ? null : first.choice !== recommendedId,
      changes: Math.max(0, list.length - 1),
      ratings: ratingsOf(open.id, quality, check),
    });
  }
  return { rows, summary: { rows: rows.length, skipped: check.skipped, blanked: check.blanked } };
}

function ratingsOf(id: string, quality: readonly QualityRecord[], check: Validator): ExportRating[] {
  const out: ExportRating[] = [];
  for (const rating of quality) {
    if (rating.decisionId !== id) continue;
    if ((rating.rater !== "human" && rating.rater !== "model") || !QUALITIES.includes(rating.quality)) {
      check.skipped += 1;
      continue;
    }
    const cleanContext = check.flag(rating.cleanContext);
    const modelAgree = check.flag(rating.modelAgree);
    out.push({
      rater: rating.rater,
      quality: rating.quality,
      ...(rating.model !== undefined ? { model: exportModel(rating.model) } : {}),
      ...(cleanContext !== null ? { cleanContext } : {}),
      ...(modelAgree !== null ? { modelAgree } : {}),
      at: check.timestamp(rating.at),
    });
  }
  return out;
}

export type ExportFormat = "jsonl" | "json";

export function renderExport(rows: readonly ExportRow[], format: ExportFormat = "jsonl"): string {
  if (format === "json") return JSON.stringify(rows, null, 2);
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

/** Read the journal and the ratings and build the export, with the count of what was dropped or blanked. */
export async function loadExportWithSummary(cwd: string, options: ExportOptions = {}): Promise<{ rows: ExportRow[]; summary: ExportSummary }> {
  const { records } = await readJournal(cwd);
  return buildExportWithSummary(records, await readQuality(cwd), options);
}

/** Read the journal and the ratings and build the export. */
export async function loadExport(cwd: string, options: ExportOptions = {}): Promise<ExportRow[]> {
  return (await loadExportWithSummary(cwd, options)).rows;
}
