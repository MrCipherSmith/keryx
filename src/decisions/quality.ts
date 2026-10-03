// Flow 400 (AC12): the quality of a recommendation, rated after the decision is closed.
//
// Two raters, kept apart because they are not the same kind of evidence:
//   human  the operator's own rating (`keryx decisions rate <id> good|bad|unclear`).
//          This is the main measure.
//   model  a model rates the same decision in a CLEAN context (`rate --blind-model`):
//          it gets the question and the options as the human saw them, with the
//          recommendation mark stripped, and no conversation history, no reason and no
//          human choice. A model may be the very model that wrote the recommendation, so
//          its agreement is a self-assessment and is always labelled so.
//
// The ratings live in their own append-only file next to the journal
// (`quality.jsonl`, mode 0600), never inside it: a reader of the decision journal does
// not have to know about them. A rating is never edited; a new one for the same decision
// and rater replaces the earlier one in the matrix (the latest wins).
//
// Nothing here calls a model on its own. `rateBlindModel` takes the call as a function,
// and a record says `cleanContext: true` only when that function reported that the call
// carried no earlier messages.

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decisionsDir, journalRoot, readRecords } from "./store";
import { oneLine } from "./text";
import type { AnswerRecord, DecisionOption, OpenRecord } from "./types";

export type Quality = "good" | "bad" | "unclear";
export type Rater = "human" | "model";

export const QUALITIES: readonly Quality[] = ["good", "bad", "unclear"];

export interface QualityRecord {
  /** 1 for the first rating of this decision by this rater, 2 for the next, and so on. */
  seq: number;
  decisionId: string;
  rater: Rater;
  quality: Quality;
  note?: string;
  /** Which model rated (a label the caller gives); set when `rater` is "model". */
  model?: string;
  /** Set on a model rating: true only when the call carried no earlier messages. */
  cleanContext?: boolean;
  /** Set on a model rating: whether the model picked the option the agent recommended. */
  modelAgree?: boolean;
  at: string;
}

export const MODEL_LABEL = "model self-assessment";

export function isQuality(value: unknown): value is Quality {
  return value === "good" || value === "bad" || value === "unclear";
}

export function qualityFile(root: string): string {
  return path.join(decisionsDir(root), "quality.jsonl");
}

function isQualityRecord(value: unknown): value is QualityRecord {
  if (value === null || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["decisionId"] === "string" &&
    typeof rec["at"] === "string" &&
    typeof rec["seq"] === "number" &&
    (rec["rater"] === "human" || rec["rater"] === "model") &&
    isQuality(rec["quality"])
  );
}

export async function appendQuality(cwd: string, record: QualityRecord): Promise<void> {
  const root = await journalRoot(cwd);
  await mkdir(decisionsDir(root), { recursive: true });
  await appendFile(qualityFile(root), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Every readable rating, in file order. A damaged line is left out; a missing file is an empty list. */
export async function readQuality(cwd: string): Promise<QualityRecord[]> {
  let raw: string;
  try {
    raw = await readFile(qualityFile(await journalRoot(cwd)), "utf8");
  } catch {
    return [];
  }
  const out: QualityRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isQualityRecord(parsed)) out.push(parsed);
    } catch {
      // a damaged line is dropped, as in the decision journal
    }
  }
  return out;
}

interface Closed {
  open: OpenRecord;
  answers: AnswerRecord[];
}

async function closedDecisions(cwd: string): Promise<Map<string, Closed>> {
  const map = new Map<string, Closed>();
  for (const record of await readRecords(cwd)) {
    if (record.kind === "open") {
      if (!map.has(record.id)) map.set(record.id, { open: record, answers: [] });
    } else if (record.kind === "answer") {
      map.get(record.id)?.answers.push(record);
    }
  }
  return map;
}

async function nextSeq(cwd: string, decisionId: string, rater: Rater): Promise<number> {
  return (await readQuality(cwd)).filter((r) => r.decisionId === decisionId && r.rater === rater).length + 1;
}

export interface RateInput {
  cwd: string;
  id: string;
  quality: Quality;
  note?: string | undefined;
  now?: (() => Date) | undefined;
}

/** The human's rating of a closed decision's recommendation. Throws when the decision is unknown or not answered yet. */
export async function rateDecision(input: RateInput): Promise<QualityRecord> {
  const decision = (await closedDecisions(input.cwd)).get(input.id);
  if (decision === undefined) throw new Error(`no decision with id ${input.id}`);
  if (decision.answers.length === 0) throw new Error(`decision ${input.id} is not answered yet; rate it once it is closed`);
  const note = input.note === undefined ? "" : oneLine(input.note);
  const record: QualityRecord = {
    seq: await nextSeq(input.cwd, input.id, "human"),
    decisionId: input.id,
    rater: "human",
    quality: input.quality,
    ...(note.length > 0 ? { note } : {}),
    at: (input.now ?? (() => new Date()))().toISOString(),
  };
  await appendQuality(input.cwd, record);
  return record;
}

// ---------------------------------------------------------------- the blind model rating

/** What a model call is given. `history` is always empty: the call is a fresh one. */
export interface ModelCallRequest {
  system: string;
  user: string;
  history: readonly never[];
}

export interface ModelCallResult {
  text: string;
  /** How many earlier messages the call really carried. 0 for a fresh call; anything else makes the rating not clean. */
  historyMessages: number;
}

/** The seam: tests pass a fake, the command passes `commandModelCall`. */
export type ModelCallFn = (request: ModelCallRequest) => Promise<ModelCallResult>;

const MARK_PATTERNS: readonly RegExp[] = [
  /\s*[([]\s*(?:recommended|recommend|рекомендуется|рекомендую|рекомендовано|рекомендованный)[^)\]]*[)\]]/giu,
  /^\s*[★⭐✓✔]\s*/u,
  /\s*[★⭐]\s*$/u,
  /\brecommended\s*:\s*/giu,
];

/** A label, description or question without the textual forms of the recommendation mark. */
export function stripRecommendationMark(text: string): string {
  let out = text;
  for (const pattern of MARK_PATTERNS) out = out.replace(pattern, " ");
  return oneLine(out, 600);
}

export interface BlindPrompt {
  system: string;
  user: string;
  /** Option ids in the order the numbers 1..n were given: the answer is mapped back through it. */
  ids: string[];
}

/**
 * The question and the options as the human saw them (the display order), numbered, with no
 * recommendation, no reason, no mark and no choice. Numbers rather than ids, so an id cannot hint.
 */
export function buildBlindPrompt(open: Pick<OpenRecord, "question" | "options" | "order">): BlindPrompt {
  const byId = new Map<string, DecisionOption>(open.options.map((option) => [option.id, option]));
  const shown = open.order.map((id) => byId.get(id)).filter((option): option is DecisionOption => option !== undefined);
  const options = shown.length === open.options.length ? shown : open.options;
  const lines = options.map((option, index) => {
    const label = stripRecommendationMark(option.label);
    const description = option.description === undefined ? "" : stripRecommendationMark(option.description);
    return `${index + 1}. ${label}${description.length > 0 ? ` - ${description}` : ""}`;
  });
  return {
    system:
      "You are choosing between options for a software decision. You see only the question and the options. " +
      "Answer with the number of the option you would pick on its merits, and nothing else; answer 0 if you cannot tell.",
    user: `Question: ${stripRecommendationMark(open.question)}\n\nOptions:\n${lines.join("\n")}\n\nYour answer (a number):`,
    ids: options.map((option) => option.id),
  };
}

/** The option id the model's answer names, "unclear" for 0 or no readable number. */
export function parseModelChoice(text: string, ids: readonly string[]): string {
  const match = /\d+/.exec(text);
  if (match === null) return "unclear";
  const n = Number(match[0]);
  return Number.isInteger(n) && n >= 1 && n <= ids.length ? (ids[n - 1] as string) : "unclear";
}

export interface BlindModelInput {
  cwd: string;
  /** The label the rating is filed under (a model name the caller gives). */
  model: string;
  call: ModelCallFn;
  /** Only decisions opened at or after this time. */
  since?: Date | undefined;
  /** Only this decision. */
  id?: string | undefined;
  limit?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface BlindModelResult {
  rated: QualityRecord[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Have a model rate each closed decision that carries a recommendation, in a clean context. A decision
 * this model already rated is skipped, so the run can be repeated. Backfilled decisions are left out: their
 * recommendation was written after the answer was known. A failing call skips that decision and goes on.
 */
export async function rateBlindModel(input: BlindModelInput): Promise<BlindModelResult> {
  const now = input.now ?? (() => new Date());
  const decisions = await closedDecisions(input.cwd);
  const existing = await readQuality(input.cwd);
  const rated: QualityRecord[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const model = oneLine(input.model, 80);
  for (const { open, answers } of decisions.values()) {
    if (input.id !== undefined && open.id !== input.id) continue;
    if (open.backfilled === true) continue;
    if (input.since !== undefined && Date.parse(open.at) < input.since.getTime()) continue;
    if (answers.length === 0 || open.recommendation === null) {
      if (input.id !== undefined) skipped.push({ id: open.id, reason: answers.length === 0 ? "not answered yet" : "no recommendation to rate" });
      continue;
    }
    if (existing.some((r) => r.decisionId === open.id && r.rater === "model" && r.model === model)) continue;
    if (input.limit !== undefined && rated.length >= input.limit) break;
    const prompt = buildBlindPrompt(open);
    let reply: ModelCallResult;
    try {
      reply = await input.call({ system: prompt.system, user: prompt.user, history: [] });
    } catch (cause) {
      skipped.push({ id: open.id, reason: oneLine(cause instanceof Error ? cause.message : String(cause), 120) });
      continue;
    }
    const choice = parseModelChoice(reply.text, prompt.ids);
    const agree = choice === open.recommendation.optionId;
    const record: QualityRecord = {
      seq: existing.filter((r) => r.decisionId === open.id && r.rater === "model").length + 1,
      decisionId: open.id,
      rater: "model",
      quality: choice === "unclear" ? "unclear" : agree ? "good" : "bad",
      model,
      cleanContext: reply.historyMessages === 0,
      modelAgree: agree,
      at: now().toISOString(),
    };
    await appendQuality(input.cwd, record);
    existing.push(record);
    rated.push(record);
  }
  return { rated, skipped };
}

/**
 * The model call the command uses: a shell command that reads the prompt on stdin and writes the
 * answer on stdout (for example `claude -p`). Each call is a new process with only that prompt, so it
 * carries no conversation history. Project instructions the tool loads by itself are not history.
 */
export function commandModelCall(command: string, timeoutMs = 120_000): ModelCallFn {
  return (request) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the model command timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ text: stdout, historyMessages: request.history.length });
        else reject(new Error(`the model command exited with ${code}: ${oneLine(stderr, 120)}`));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(`${request.system}\n\n${request.user}\n`);
    });
}

// ---------------------------------------------------------------- the matrix

export type MatrixColumn = Quality | "notRated";

export interface QualityMatrix {
  /** Human rating of a decision (rows) against the model's self-assessment of it (columns), counts. */
  humanVsModel: Record<Quality, Record<MatrixColumn, number>>;
  /** Decisions with a human rating. */
  humanRated: number;
  /** Decisions with a model rating: a self-assessment, never the main measure. */
  modelRated: number;
  /** Model ratings made in a clean context. */
  modelClean: number;
  /** Human rating against whether the human followed the recommendation (first answer). */
  byChoice: Record<"followed" | "deviated", Record<Quality, number>>;
}

function emptyRow(): Record<MatrixColumn, number> {
  return { good: 0, bad: 0, unclear: 0, notRated: 0 };
}

/**
 * Fold the ratings into the matrix. `followed` maps a decision id to whether the human followed the
 * recommendation (null or absent: no recommendation or no answer). Only the ids in `followed`'s key set
 * or `known` are counted, so a rating of a decision that is left out of the report is left out here too.
 */
export function buildQualityMatrix(ratings: readonly QualityRecord[], known: ReadonlyMap<string, boolean | null>): QualityMatrix {
  const human = new Map<string, QualityRecord>();
  const model = new Map<string, QualityRecord>();
  for (const rating of ratings) {
    if (!known.has(rating.decisionId)) continue;
    const target = rating.rater === "human" ? human : model;
    const earlier = target.get(rating.decisionId);
    if (earlier === undefined || Date.parse(rating.at) >= Date.parse(earlier.at)) target.set(rating.decisionId, rating);
  }
  const matrix: QualityMatrix = {
    humanVsModel: { good: emptyRow(), bad: emptyRow(), unclear: emptyRow() },
    humanRated: human.size,
    modelRated: model.size,
    modelClean: [...model.values()].filter((r) => r.cleanContext === true).length,
    byChoice: { followed: { good: 0, bad: 0, unclear: 0 }, deviated: { good: 0, bad: 0, unclear: 0 } },
  };
  for (const [id, rating] of human) {
    matrix.humanVsModel[rating.quality][model.get(id)?.quality ?? "notRated"] += 1;
    const followed = known.get(id);
    if (followed === true) matrix.byChoice.followed[rating.quality] += 1;
    else if (followed === false) matrix.byChoice.deviated[rating.quality] += 1;
  }
  return matrix;
}

export function renderQualityMatrix(matrix: QualityMatrix): string[] {
  if (matrix.humanRated === 0 && matrix.modelRated === 0) return ["Recommendation quality: no ratings yet (keryx decisions rate <id> good|bad|unclear)."];
  const pad = (value: string | number, width: number): string => String(value).padStart(width);
  const lines = [
    "Recommendation quality (the human rating is the measure):",
    `  human rated: ${matrix.humanRated}`,
    `  ${MODEL_LABEL}: ${matrix.modelRated} rated, ${matrix.modelClean} in a clean context. The model may be the one that wrote the recommendation, so its agreement is inflated and says nothing about the human's view.`,
    `  matrix, human rating (rows) against ${MODEL_LABEL} (columns):`,
    `               ${pad("good", 6)}${pad("bad", 6)}${pad("unclear", 9)}${pad("not rated", 11)}`,
  ];
  for (const quality of QUALITIES) {
    const row = matrix.humanVsModel[quality];
    lines.push(`    ${quality.padEnd(10)}${pad(row.good, 6)}${pad(row.bad, 6)}${pad(row.unclear, 9)}${pad(row.notRated, 11)}`);
  }
  lines.push(
    `  human rating by what the human did: followed ${QUALITIES.map((q) => `${q} ${matrix.byChoice.followed[q]}`).join(", ")}; deviated ${QUALITIES.map((q) => `${q} ${matrix.byChoice.deviated[q]}`).join(", ")}`,
  );
  return lines;
}
