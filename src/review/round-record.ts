// Flow 458: the round record `review start|attach` writes beside the package (round.json, prior_findings.json), and the
// small readers every later stage shares. Kept free of heavy imports so verdict, publish and readiness can read it.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";

export const ROUND_FILE = "round.json";
export const PRIOR_FINDINGS_FILE = "prior_findings.json";

export const ROUND_SOURCES = ["local-package", "git-history", "github-block", "github-comments", "flow", "none"] as const;
export type RoundSource = (typeof ROUND_SOURCES)[number];
/** The sources that are searched, in order; `none` is only ever a result. */
export type SearchedSource = Exclude<RoundSource, "none">;
export const SEARCH_ORDER: readonly SearchedSource[] = ["local-package", "git-history", "github-block", "github-comments", "flow"];

export type RoundMode = "first" | "delta" | "fallback-first";

export type SourceAttempt = { source: SearchedSource; result: "found" | "none" | "not-consulted"; detail: string };

export type RoundHunk = { file: string; startLine: number; endLine: number };
export type FixHunk = RoundHunk & { findingIds: string[] };

export type RoundRecord = {
  v: 1;
  round: number;
  source: RoundSource;
  sourcesTried: SourceAttempt[];
  previous: { reviewId: string; reviewedHead: string | null; packagePath?: string | undefined } | null;
  mode: RoundMode;
  range: { base: string | null; head: string | null };
  fixHunks: FixHunk[];
  newHunks: RoundHunk[];
  carried: Array<{ findingId: string; disposition: string }>;
};

export type PriorFinding = {
  id: string;
  reviewer: string;
  severity: string;
  file: string | null;
  line: number | null;
  quote?: string | undefined;
  quoteSha256?: string | undefined;
  symbol?: string | undefined;
  problem: string;
  /** `open` while nothing ended the finding; otherwise the disposition state, or `refuted`. */
  status: string;
  disposition?: string | undefined;
  source: RoundSource;
};

/** sha256 hex of a quote, whitespace-normalised so a re-indented line hashes the same. */
export function quoteSha256(quote: string): string {
  return createHash("sha256").update(quote.replace(/\s+/g, " ").trim()).digest("hex");
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** What became of a finding, in one word: `open`, a disposition state, or `refuted`. */
export function findingStatus(finding: unknown): string {
  const raw = record(finding);
  const state = record(raw?.disposition)?.state;
  if (typeof state === "string" && state !== "" && state !== "unknown") return state;
  if (record(raw?.verification)?.verdict === "refuted") return "refuted";
  const status = raw?.status;
  return typeof status === "string" && status !== "" ? status : "open";
}

export function isOpenStatus(status: string): boolean {
  return status === "open" || status === "unknown";
}

export async function writeRoundRecord(packageDir: string, round: RoundRecord, prior: readonly PriorFinding[]): Promise<void> {
  await writeFileAtomic(path.join(packageDir, ROUND_FILE), `${JSON.stringify(round, null, 2)}\n`);
  await writeFileAtomic(path.join(packageDir, PRIOR_FINDINGS_FILE), `${JSON.stringify(prior, null, 2)}\n`);
}

/** The package's round.json, or undefined when it has none (a package cut before flow 458, or an ingest). */
export function readRoundRecord(packageDir: string): RoundRecord | undefined {
  const raw = readRaw(packageDir);
  if (raw === undefined || readRoundNumber(packageDir) === undefined) return undefined;
  const previous = raw.previous;
  if (!Array.isArray(raw.sourcesTried) || typeof raw.mode !== "string" || typeof raw.source !== "string" || record(raw.range) === undefined) return undefined;
  if (previous !== null && typeof record(previous)?.reviewId !== "string") return undefined;
  return raw as unknown as RoundRecord;
}

/** Just the round number of round.json, read leniently; undefined without a usable one. */
export function readRoundNumber(packageDir: string): number | undefined {
  const raw = readRaw(packageDir);
  return raw?.v === 1 && typeof raw.round === "number" && Number.isInteger(raw.round) && raw.round >= 1 ? raw.round : undefined;
}

function readRaw(packageDir: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(readFileSync(path.join(packageDir, ROUND_FILE), "utf8")));
  } catch {
    return undefined;
  }
}

function attemptText(attempt: SourceAttempt): string {
  return attempt.result === "not-consulted" ? `${attempt.source}: not consulted (${attempt.detail})` : `${attempt.source}: ${attempt.result}`;
}

/** The one line a verdict and `review start` print about the round. */
export function renderRoundLine(round: RoundRecord): string {
  if (round.previous === null) {
    const headless = round.source === "github-comments" ? "; prior findings from PR comments, which carry no head" : "";
    return `round ${round.round} — no previous round found${headless} (sources tried: ${round.sourcesTried.map(attemptText).join(", ")})`;
  }
  const head = round.previous.reviewedHead === null ? "no head" : round.previous.reviewedHead.slice(0, 12);
  const how = round.mode === "delta" ? `delta ${round.range.base?.slice(0, 12) ?? "?"}..${round.range.head?.slice(0, 12) ?? "?"}` : round.mode === "fallback-first" ? "fallback-first: the previous head is not an ancestor of this head (force-push or rebase); full review with prior findings attached" : "first";
  return `round ${round.round} (source: ${round.source}; previous ${round.previous.reviewId} at ${head}; ${how})`;
}
