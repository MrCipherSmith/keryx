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
//   - a stage or a model name is kept only when it looks like a plain identifier,
//     otherwise it becomes "other".

import { createHash } from "node:crypto";
import { effectiveArm, isLegacy } from "./legacy";
import { readQuality, type Quality, type QualityRecord, type Rater } from "./quality";
import { readJournal } from "./store";
import type { AnswerRecord, DecisionRecord, OpenRecord } from "./types";

export interface ExportRating {
  rater: Rater;
  quality: Quality;
  /** A model rating only: the label is "model self-assessment", never a human view. */
  model?: string;
  cleanContext?: boolean;
  modelAgree?: boolean;
  at: string;
}

export interface ExportRow {
  /** A short hash of the decision id. */
  ref: string;
  openedAt: string;
  arm: "A" | "B" | "C" | "D";
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

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;
const plain = (value: string): string => (PLAIN.test(value) ? value : "other");

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
  return open.channel === undefined || open.channel.trim().length === 0 ? "tui" : plain(open.channel.trim().toLowerCase());
}

export function buildExport(records: readonly DecisionRecord[], quality: readonly QualityRecord[] = [], options: ExportOptions = {}): ExportRow[] {
  const opens: OpenRecord[] = [];
  const answers = new Map<string, AnswerRecord[]>();
  const seen = new Set<string>();
  for (const record of records) {
    if (record.kind === "open") {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      opens.push(record);
    } else if (record.kind === "answer") {
      const list = answers.get(record.id) ?? [];
      list.push(record);
      answers.set(record.id, list);
    }
  }
  const rows: ExportRow[] = [];
  for (const open of opens) {
    const legacy = open.backfilled === true || isLegacy(open);
    if (options.excludeLegacy === true && legacy) continue;
    if (options.since !== undefined && Date.parse(open.at) < options.since.getTime()) continue;
    const list = [...(answers.get(open.id) ?? [])].sort((a, b) => a.seq - b.seq);
    const first = list[0];
    const chosen = first === undefined || first.other === true ? null : indexOf(open, first.choice);
    const recommendedIndex = indexOf(open, open.recommendation?.optionId);
    rows.push({
      ref: exportRef(open.id),
      openedAt: open.at,
      arm: effectiveArm(open),
      seed: open.seed ?? null,
      preselected: open.preselected ?? null,
      order: open.order.map((id) => indexOf(open, id)).filter((at): at is number => at !== null),
      optionCount: open.options.length,
      channel: exportChannel(open),
      forced: open.forced === true,
      legacy,
      backfilled: open.backfilled === true,
      stage: plain(open.stage),
      hasRecommendation: open.recommendation !== null,
      recommendedIndex,
      answered: first !== undefined,
      answeredAt: first?.at ?? null,
      timeToAnswerMs: first === undefined || open.backfilled === true ? null : first.timeToAnswerMs,
      chosenIndex: chosen,
      other: first?.other === true,
      deviation: first === undefined || open.recommendation === null ? null : first.choice !== open.recommendation.optionId,
      changes: Math.max(0, list.length - 1),
      ratings: quality
        .filter((rating) => rating.decisionId === open.id)
        .map((rating) => ({
          rater: rating.rater,
          quality: rating.quality,
          ...(rating.model !== undefined ? { model: plain(rating.model) } : {}),
          ...(rating.cleanContext !== undefined ? { cleanContext: rating.cleanContext } : {}),
          ...(rating.modelAgree !== undefined ? { modelAgree: rating.modelAgree } : {}),
          at: rating.at,
        })),
    });
  }
  return rows;
}

export type ExportFormat = "jsonl" | "json";

export function renderExport(rows: readonly ExportRow[], format: ExportFormat = "jsonl"): string {
  if (format === "json") return JSON.stringify(rows, null, 2);
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

/** Read the journal and the ratings and build the export. */
export async function loadExport(cwd: string, options: ExportOptions = {}): Promise<ExportRow[]> {
  const { records } = await readJournal(cwd);
  return buildExport(records, await readQuality(cwd), options);
}
