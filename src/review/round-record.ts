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
  /** merge-base of the target's base and this head, when known: a delta round's slice never cuts more than merge-base..head. */
  mergeBase?: string | null | undefined;
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

/**
 * What `review start` stamps into manifest.json beside round.json (flow 458): sha256 of round.json and prior_findings.json
 * as written, so slice, ledger and complete refuse a round record edited afterwards; and the target's normalised key and
 * the base ref its merge-base was read from, so a later round matches this one however the target was spelled.
 */
export type RoundStamp = { roundSha256: string; priorFindingsSha256: string; targetKey?: string | undefined; targetBase?: string | undefined };

const sha256Of = (body: string | Buffer): string => createHash("sha256").update(body).digest("hex");

function fileSha(file: string): string | undefined {
  try {
    return sha256Of(readFileSync(file));
  } catch {
    return undefined;
  }
}

export async function writeRoundRecord(
  packageDir: string,
  round: RoundRecord,
  prior: readonly PriorFinding[],
  identity: { targetKey?: string | undefined; targetBase?: string | undefined } = {},
): Promise<void> {
  const roundBody = `${JSON.stringify(round, null, 2)}\n`;
  const priorBody = `${JSON.stringify(prior, null, 2)}\n`;
  await writeFileAtomic(path.join(packageDir, ROUND_FILE), roundBody);
  await writeFileAtomic(path.join(packageDir, PRIOR_FINDINGS_FILE), priorBody);
  const manifestFile = path.join(packageDir, "manifest.json");
  let manifest: Record<string, unknown> | undefined;
  try {
    manifest = record(JSON.parse(readFileSync(manifestFile, "utf8")));
  } catch {
    manifest = undefined;
  }
  if (manifest === undefined) return;
  const stamp: RoundStamp = {
    roundSha256: sha256Of(roundBody),
    priorFindingsSha256: sha256Of(priorBody),
    ...(identity.targetKey === undefined ? {} : { targetKey: identity.targetKey }),
    ...(identity.targetBase === undefined ? {} : { targetBase: identity.targetBase }),
  };
  await writeFileAtomic(manifestFile, `${JSON.stringify({ ...manifest, roundRecord: stamp }, null, 2)}\n`);
}

/** sha256 of the files that identify a finished round: what the local round registry records and compares. */
export type PackageHashes = { manifestSha256: string; findingsSha256: string | null; roundRecordSha256: string | null };

/** The hashes of three package files given as text (from disk or from a commit); a missing manifest gives undefined. */
export function packageHashesOf(files: { manifest: string | undefined; findings: string | undefined; round: string | undefined }): PackageHashes | undefined {
  if (files.manifest === undefined) return undefined;
  return {
    manifestSha256: sha256Of(files.manifest),
    findingsSha256: files.findings === undefined ? null : sha256Of(files.findings),
    roundRecordSha256: files.round === undefined ? null : sha256Of(files.round),
  };
}

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** The hashes of a package directory on disk, and its parsed manifest; undefined without a readable manifest. */
export function packageFacts(packageDir: string): { hashes: PackageHashes; manifest: Record<string, unknown> } | undefined {
  const manifestText = readText(path.join(packageDir, "manifest.json"));
  let manifest: Record<string, unknown> | undefined;
  try {
    manifest = manifestText === undefined ? undefined : record(JSON.parse(manifestText));
  } catch {
    manifest = undefined;
  }
  const hashes = packageHashesOf({ manifest: manifestText, findings: readText(path.join(packageDir, "findings.json")), round: readText(path.join(packageDir, ROUND_FILE)) });
  return manifest === undefined || hashes === undefined ? undefined : { hashes, manifest };
}

/** The stamp `review start` left in manifest.json, or undefined (a package cut before it, or an ingest). */
export function readRoundStamp(packageDir: string): RoundStamp | undefined {
  try {
    return roundStampOf(JSON.parse(readFileSync(path.join(packageDir, "manifest.json"), "utf8")));
  } catch {
    return undefined;
  }
}

/** The `roundRecord` stamp of a parsed manifest, or undefined. */
export function roundStampOf(manifest: unknown): RoundStamp | undefined {
  const stamp = record(record(manifest)?.roundRecord);
  if (stamp === undefined || typeof stamp.roundSha256 !== "string" || typeof stamp.priorFindingsSha256 !== "string") return undefined;
  return stamp as unknown as RoundStamp;
}

/**
 * Why the package's round record cannot be trusted any more, or undefined. A package whose manifest carries the stamp of
 * `review start` must still hold round.json and prior_findings.json byte for byte as written: an edit that narrows the
 * round (drops a fix hunk, marks a prior finding closed) is refused by slice, ledger build and complete.
 */
export function roundRecordTampered(packageDir: string): string | undefined {
  const stamp = readRoundStamp(packageDir);
  if (stamp === undefined) return undefined;
  const changed: string[] = [];
  if (fileSha(path.join(packageDir, ROUND_FILE)) !== stamp.roundSha256) changed.push(ROUND_FILE);
  if (fileSha(path.join(packageDir, PRIOR_FINDINGS_FILE)) !== stamp.priorFindingsSha256) changed.push(PRIOR_FINDINGS_FILE);
  if (changed.length === 0) return undefined;
  return (
    `${changed.join(" and ")} of ${packageDir} changed after \`keryx review start\` wrote ${changed.length === 1 ? "it" : "them"} (the sha256 in manifest.json roundRecord no longer matches). ` +
    "The round record decides what the round reviews and is never edited by hand: start a new round with `keryx review start`"
  );
}

/** The package's round.json, or undefined when it has none (a package cut before flow 458, or an ingest). A malformed one is refused. */
export function readRoundRecord(packageDir: string): RoundRecord | undefined {
  const raw = readRaw(packageDir);
  if (raw === undefined || readRoundNumber(packageDir) === undefined) return undefined;
  const problem = roundRecordProblem(raw);
  if (problem !== undefined) throw new Error(`${path.join(packageDir, ROUND_FILE)} is malformed (${problem}); re-run \`keryx review start\``);
  return raw as unknown as RoundRecord;
}

const isHunk = (value: unknown): boolean => {
  const hunk = record(value);
  return hunk !== undefined && typeof hunk.file === "string" && Number.isInteger(hunk.startLine) && Number.isInteger(hunk.endLine);
};

const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");

/** What is wrong with a round.json's shape, or undefined. Every array field is checked entry by entry. */
export function roundRecordProblem(raw: Record<string, unknown>): string | undefined {
  if (!Array.isArray(raw.sourcesTried) || !raw.sourcesTried.every((entry) => typeof record(entry)?.source === "string" && typeof record(entry)?.result === "string")) return "sourcesTried is not a list of attempts";
  if (raw.mode !== "first" && raw.mode !== "delta" && raw.mode !== "fallback-first") return "mode is not first, delta or fallback-first";
  if (typeof raw.source !== "string" || !(ROUND_SOURCES as readonly string[]).includes(raw.source)) return "source is not a known source";
  const range = record(raw.range);
  if (range === undefined || !(range.base === null || typeof range.base === "string") || !(range.head === null || typeof range.head === "string")) return "range is not {base, head}";
  if (raw.previous !== null && typeof record(raw.previous)?.reviewId !== "string") return "previous is neither null nor a round";
  if (!Array.isArray(raw.fixHunks) || !raw.fixHunks.every((hunk) => isHunk(hunk) && isStringList(record(hunk)?.findingIds))) return "fixHunks is not a list of hunks with findingIds";
  if (!Array.isArray(raw.newHunks) || !raw.newHunks.every(isHunk)) return "newHunks is not a list of hunks";
  if (!Array.isArray(raw.carried) || !raw.carried.every((entry) => typeof record(entry)?.findingId === "string" && typeof record(entry)?.disposition === "string")) return "carried is not a list of {findingId, disposition}";
  if (raw.mergeBase !== undefined && raw.mergeBase !== null && typeof raw.mergeBase !== "string") return "mergeBase is not a commit";
  return undefined;
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

/** What a delta round concluded about one prior finding after reading the fix: the vocabulary of `prior_findings_status` in the reviewer input. */
export const PRIOR_DISPOSITIONS = ["closed", "open", "partial", "regressed", "withdrawn"] as const;
export type PriorDisposition = (typeof PRIOR_DISPOSITIONS)[number];

export function isPriorDisposition(value: unknown): value is PriorDisposition {
  return typeof value === "string" && (PRIOR_DISPOSITIONS as readonly string[]).includes(value);
}

/** The slice kinds of a delta round: a FIX slice answers prior findings, a NEW slice is code no prior finding touched. */
export type SliceKind = "fix" | "new";

/** The package's prior_findings.json, or [] when it has none or it is unreadable. */
export function readPriorFindings(packageDir: string): PriorFinding[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(packageDir, PRIOR_FINDINGS_FILE), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is PriorFinding => record(entry) !== undefined && typeof (entry as PriorFinding).id === "string") : [];
  } catch {
    return [];
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
