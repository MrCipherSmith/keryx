// What a chunk run will cost, said before it starts. A run at or under the ceiling goes through; a run over it needs a yes.
// The ceiling is 25 passes of 40 files (1,000 files) unless `routing.config.json` carries `reviewChunks.maxPasses`.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { CHUNK_REVIEWER, CHUNK_TIER, computeChunkPass, ensureChunkPlan } from "./chunks";
import { DEFAULT_BLAST_RADIUS_MAX_FILES } from "./blast-radius";

export const CHUNK_ESTIMATE_FILE = "chunk-estimate.json";
/** The file automatic review mode (flow 429) leaves in its package; `commands/automatic-review.ts` takes its name from here. */
export const AUTOMATIC_REVIEW_DISCLOSURE_FILE = "automatic-run-inputs.json";
export const DEFAULT_MAX_PASSES = 25;
const MAX_PASSES_LIMIT = 100;
/** Tokens a pass spends on the reviewer's own prompt and the answer, beyond the chunk text. */
const PASS_PROMPT_TOKENS = 3_000;
const PASS_OUTPUT_TOKENS = 1_500;
const BYTES_PER_TOKEN = 4;

export type ChunkLimits = {
  maxPasses: number;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  secondsPerPass: number;
  source: "default" | "routing.config.json";
};

export const DEFAULT_CHUNK_LIMITS: ChunkLimits = { maxPasses: DEFAULT_MAX_PASSES, inputUsdPerMTok: 3, outputUsdPerMTok: 15, secondsPerPass: 150, source: "default" };

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** `reviewChunks` in the project's `routing.config.json`; any field it leaves out, or sets badly, keeps its default. */
export async function readChunkLimits(projectRoot: string): Promise<ChunkLimits> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectRoot, "routing.config.json"), "utf8")) as { reviewChunks?: Record<string, unknown> };
    const own = parsed?.reviewChunks;
    if (own === null || typeof own !== "object") return { ...DEFAULT_CHUNK_LIMITS };
    const limits: ChunkLimits = { ...DEFAULT_CHUNK_LIMITS, source: "routing.config.json" };
    if (positive(own.maxPasses)) limits.maxPasses = Math.min(Math.floor(own.maxPasses), MAX_PASSES_LIMIT);
    if (positive(own.inputUsdPerMTok)) limits.inputUsdPerMTok = own.inputUsdPerMTok;
    if (positive(own.outputUsdPerMTok)) limits.outputUsdPerMTok = own.outputUsdPerMTok;
    if (positive(own.secondsPerPass)) limits.secondsPerPass = own.secondsPerPass;
    return limits;
  } catch {
    return { ...DEFAULT_CHUNK_LIMITS };
  }
}

export type ChunkEstimate = {
  tier: string;
  reviewer: string;
  /** Chunks still to run. */
  chunks: number;
  files: number;
  bytes: number;
  tokens: { input: number; output: number };
  costUsd: number;
  seconds: number;
  maxPasses: number;
  /** maxPasses × the per-pass file cap. */
  ceilingFiles: number;
  overCeiling: boolean;
  limitsSource: ChunkLimits["source"];
  /** Identifies the chunks this estimate covers; an answer given to another plan does not carry over. */
  planKey: string;
};

export async function estimateChunkRun(packageDir: string, projectRoot: string, limits?: ChunkLimits): Promise<ChunkEstimate | null> {
  const plan = await ensureChunkPlan(packageDir, projectRoot);
  if (plan === null) return null;
  const pass = await computeChunkPass(packageDir);
  const open = new Set((pass?.chunks ?? []).filter((chunk) => chunk.state !== "done").map((chunk) => chunk.id));
  const remaining = plan.chunks.filter((chunk) => open.has(chunk.id));
  const effective = limits ?? (await readChunkLimits(projectRoot));
  const bytes = remaining.reduce((sum, chunk) => sum + chunk.bytes, 0);
  const input = remaining.reduce((sum, chunk) => sum + Math.ceil(Math.max(chunk.bytes, 0) / BYTES_PER_TOKEN) + PASS_PROMPT_TOKENS, 0);
  const output = remaining.length * PASS_OUTPUT_TOKENS;
  const costUsd = Math.round(((input * effective.inputUsdPerMTok + output * effective.outputUsdPerMTok) / 1_000_000) * 100) / 100;
  return {
    tier: CHUNK_TIER,
    reviewer: CHUNK_REVIEWER,
    chunks: remaining.length,
    files: remaining.reduce((sum, chunk) => sum + chunk.files.length, 0),
    bytes,
    tokens: { input, output },
    costUsd,
    seconds: remaining.length * effective.secondsPerPass,
    maxPasses: effective.maxPasses,
    ceilingFiles: effective.maxPasses * DEFAULT_BLAST_RADIUS_MAX_FILES,
    overCeiling: remaining.length > effective.maxPasses,
    limitsSource: effective.source,
    planKey: createHash("sha256").update(remaining.map((chunk) => `${chunk.id}:${chunk.files.join(",")}`).join("|")).digest("hex").slice(0, 16),
  };
}

export type ChunkMode = "automatic" | "interactive";
export type ChunkDecision = "proceed" | "ask-once" | "wait-for-yes";

export type ChunkAnswer = { value: "yes" | "no"; quote: string; at: string };

export type ChunkEstimateRecord = {
  schemaVersion: 1;
  estimate: ChunkEstimate;
  mode: ChunkMode;
  decision: ChunkDecision;
  /** True once the operator has been asked about this run. */
  asked: boolean;
  answer?: ChunkAnswer;
};

/** Automatic review mode (flow 429) leaves its disclosure file in the package; any other run is interactive. */
export function chunkModeOf(packageDir: string, override?: string): ChunkMode {
  if (override === "automatic" || override === "interactive") return override;
  return existsSync(path.join(packageDir, AUTOMATIC_REVIEW_DISCLOSURE_FILE)) ? "automatic" : "interactive";
}

export function decisionFor(estimate: Pick<ChunkEstimate, "overCeiling">, mode: ChunkMode): ChunkDecision {
  if (!estimate.overCeiling) return "proceed";
  return mode === "automatic" ? "ask-once" : "wait-for-yes";
}

export async function readChunkEstimate(packageDir: string): Promise<ChunkEstimateRecord | undefined> {
  try {
    return JSON.parse(await readFile(path.join(packageDir, CHUNK_ESTIMATE_FILE), "utf8")) as ChunkEstimateRecord;
  } catch {
    return undefined;
  }
}

/** Records the estimate and the decision it leads to. An answer survives only while the estimate covers the same chunks. */
export async function recordChunkEstimate(packageDir: string, estimate: ChunkEstimate, mode: ChunkMode): Promise<ChunkEstimateRecord> {
  const previous = await readChunkEstimate(packageDir);
  const same = previous?.estimate.planKey === estimate.planKey;
  const decision = decisionFor(estimate, mode);
  const record: ChunkEstimateRecord = {
    schemaVersion: 1,
    estimate,
    mode,
    decision,
    asked: decision !== "proceed",
    ...(same && previous?.answer !== undefined ? { answer: previous.answer } : {}),
  };
  await writeFileAtomic(path.join(packageDir, CHUNK_ESTIMATE_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function answerChunkEstimate(packageDir: string, value: "yes" | "no", quote: string, now: Date = new Date()): Promise<ChunkEstimateRecord> {
  const previous = await readChunkEstimate(packageDir);
  if (previous === undefined) throw new Error("No chunk estimate is recorded; run `keryx review chunks estimate` first.");
  if (quote.trim() === "") throw new Error("The answer needs the operator's own words (--quote).");
  const record: ChunkEstimateRecord = { ...previous, asked: true, answer: { value, quote: quote.trim(), at: now.toISOString() } };
  await writeFileAtomic(path.join(packageDir, CHUNK_ESTIMATE_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Why `chunks next` may not hand out a chunk yet: empty when the run is under the ceiling or the operator said yes. */
export async function chunkRunBlocker(packageDir: string, projectRoot: string): Promise<string | undefined> {
  const estimate = await estimateChunkRun(packageDir, projectRoot);
  if (estimate === null || !estimate.overCeiling) return undefined;
  const record = await readChunkEstimate(packageDir);
  const answered = record?.estimate.planKey === estimate.planKey ? record.answer : undefined;
  if (answered?.value === "yes") return undefined;
  const dir = path.relative(process.cwd(), packageDir) || ".";
  const size = `${estimate.chunks} passes of at most ${DEFAULT_BLAST_RADIUS_MAX_FILES} files (${estimate.files} files) exceed the ceiling of ${estimate.maxPasses} passes (${estimate.ceilingFiles} files)`;
  if (answered?.value === "no") return `${size}, and the operator answered no. Nothing runs.`;
  return `${size}. Run \`keryx review chunks estimate --package ${dir}\` to record the estimate, then \`keryx review chunks estimate --package ${dir} --answer yes --quote "<operator quote>"\` once the operator agrees.`;
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;
const minutes = (seconds: number): string => (seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`);

export function renderChunkEstimate(record: ChunkEstimateRecord): string[] {
  const { estimate, mode, decision, answer } = record;
  const lines = [
    `chunk run (${estimate.reviewer}, ${estimate.tier} tier): ${estimate.chunks} chunk(s), ${estimate.files} file(s)`,
    `estimate: ~${estimate.tokens.input} input + ~${estimate.tokens.output} output tokens, ~${money(estimate.costUsd)}, ~${minutes(estimate.seconds)}`,
    `ceiling: ${estimate.maxPasses} passes of ${DEFAULT_BLAST_RADIUS_MAX_FILES} files (${estimate.ceilingFiles} files), from ${estimate.limitsSource === "default" ? "the default" : "routing.config.json reviewChunks.maxPasses"}`,
  ];
  if (decision === "proceed") lines.push(`${mode}: at or under the ceiling; the run goes ahead without a question`);
  else if (decision === "ask-once") lines.push("automatic: over the ceiling; the operator is asked once before any chunk runs");
  else lines.push("interactive: over the ceiling; the run waits for the operator's yes");
  if (answer !== undefined) lines.push(`answer: ${answer.value} — "${answer.quote}" (${answer.at})`);
  return lines;
}
