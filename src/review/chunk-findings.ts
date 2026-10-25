// What a chunk pass found, and how it reaches the round. `chunks merge` wrote the findings to chunk-pass.json and nothing
// read them again; this module is the one reader: `chunks merge` prints them, `review ingest` brings them in, and
// `review complete` names the ones still missing.

import path from "node:path";
import { readJsonFileOr } from "../lib/json";
import { type ChunkFinding, type ChunkPass, computeChunkPass } from "./chunks";
import type { ReviewFindingClassScope, ReviewFindingConfidence, ReviewFindingSeverity, StructuredReviewFinding } from "./types";

/** `review-regression/chunk-001`: the reviewer a pass finding is recorded under. `source` is an enum, so the origin lives here. */
export const chunkPassReviewer = (base: string, chunk: string): string => `${base}/${chunk}`;

const NOT_STATED = "(not stated by the chunk pass)";

/** The part of a finding two readers compare to decide it is the same site. */
export type SiteRef = { file?: unknown; line?: unknown; problem?: unknown; title?: unknown };

const siteFile = (ref: SiteRef): string => (typeof ref.file === "string" ? ref.file : "");
const siteLine = (ref: SiteRef): number | undefined => (typeof ref.line === "number" ? ref.line : undefined);
const siteText = (ref: SiteRef): string => String(ref.problem ?? ref.title ?? "");

/** Same `file:line`; when either has no line, the same file and the same words. */
export function sameSite(a: SiteRef, b: SiteRef): boolean {
  if (siteFile(a) !== siteFile(b)) return false;
  const la = siteLine(a);
  const lb = siteLine(b);
  if (la !== undefined && lb !== undefined) return la === lb;
  if (la !== undefined || lb !== undefined) return false;
  return siteText(a) !== "" && siteText(a) === siteText(b);
}

/** Pass findings that no entry of `round` covers. `round` undefined means no findings.json yet: all of them are missing. */
export function passFindingsNotInRound(pass: ChunkPass | null, round: readonly SiteRef[] | undefined): ChunkFinding[] {
  if (pass === null) return [];
  return pass.findings.filter((finding) => round === undefined || !round.some((entry) => sameSite(entry, finding)));
}

/** The findings of the round as recorded; undefined when the package holds no findings.json. */
export async function readRoundSites(packageDir: string): Promise<SiteRef[] | undefined> {
  const parsed = await readJsonFileOr<unknown>(path.join(packageDir, "findings.json"), undefined);
  return Array.isArray(parsed) ? (parsed as SiteRef[]) : undefined;
}

export type PassNotInRound = { pass: ChunkPass; missing: ChunkFinding[] };

/** The live pass of a package and what of it the round does not hold. Null when the package has no chunk plan. */
export async function passNotInRound(packageDir: string): Promise<PassNotInRound | null> {
  const pass = await computeChunkPass(packageDir);
  if (pass === null) return null;
  return { pass, missing: passFindingsNotInRound(pass, await readRoundSites(packageDir)) };
}

export const chunkOf = (finding: ChunkFinding): string => {
  const chunks = finding.chunks;
  return Array.isArray(chunks) && typeof chunks[0] === "string" ? chunks[0] : "chunk";
};

export const describePassFinding = (finding: ChunkFinding): string => {
  const where = finding.file === undefined ? "(no file)" : `${finding.file}${typeof finding.line === "number" ? `:${finding.line}` : ""}`;
  return `${String(finding.id ?? finding.title ?? "(no id)")} ${String(finding.severity ?? "?")} ${where} [${chunkOf(finding)}]`;
};

const SEVERITY_ALIASES: Record<string, ReviewFindingSeverity> = {
  blocker: "blocker",
  critical: "blocker",
  major: "major",
  high: "major",
  minor: "minor",
  medium: "minor",
  low: "info",
  info: "info",
};

const text = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim() !== "" ? value : fallback);

const validClassScope = (value: unknown): ReviewFindingClassScope | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { sites, enumeration_method: method } = value as { sites?: unknown; enumeration_method?: unknown };
  if (!Array.isArray(sites) || sites.length === 0 || !sites.every((site) => typeof site === "string")) return undefined;
  if (typeof method !== "string" || method.trim() === "") return undefined;
  return { sites: sites as string[], enumeration_method: method };
};

/**
 * One pass finding as a finding of the round. The id carries the chunk, so findings of different chunks cannot collide
 * with each other or with the report's own R-001. A major or blocker the pass did not enumerate gets a class_scope that
 * says so, because the schema requires one and an invented enumeration would be a claim nobody made.
 */
export function passFindingToRound(finding: ChunkFinding, base: string): StructuredReviewFinding & { class_scope_present?: boolean; summary: string } {
  const chunk = chunkOf(finding);
  const severity = SEVERITY_ALIASES[String(finding.severity ?? "").toLowerCase()] ?? "info";
  const confidence = (["high", "medium", "low"] as const).includes(finding.confidence as ReviewFindingConfidence)
    ? (finding.confidence as ReviewFindingConfidence)
    : "low";
  const problem = text(finding.problem, text(finding.title, NOT_STATED));
  const record: StructuredReviewFinding & { class_scope_present?: boolean; summary: string } = {
    id: `${chunk}-${text(finding.id, "finding")}`.replace(/#/g, "_"),
    reviewer: chunkPassReviewer(base, chunk),
    severity,
    problem,
    impact: text(finding.impact, NOT_STATED),
    suggested_fix: text(finding.suggested_fix, NOT_STATED),
    evidence: text(finding.evidence, NOT_STATED),
    confidence,
    summary: text(finding.title, problem.split("\n")[0]?.slice(0, 120) ?? problem),
  };
  if (typeof finding.file === "string") record.file = finding.file;
  if (typeof finding.line === "number") record.line = finding.line;
  if (typeof finding.quote === "string" && finding.quote !== "") record.quote = finding.quote;
  if (typeof finding.symbol === "string") record.symbol = finding.symbol;
  const own = validClassScope(finding.class_scope);
  if (own !== undefined) {
    record.class_scope = own;
  } else if (severity === "blocker" || severity === "major") {
    const site = typeof finding.file === "string" ? `${finding.file}${typeof finding.line === "number" ? `:${finding.line}` : ""}` : NOT_STATED;
    record.class_scope = {
      sites: [site],
      enumeration_method: `NOT ENUMERATED: reported by chunk pass ${chunk} of ${base}, which names this one site and did not list the others that hold the shape. The class is open until someone enumerates it.`,
    };
  }
  if (record.class_scope !== undefined) record.class_scope_present = true;
  return record;
}

export type InjectedPass = {
  findings: Array<StructuredReviewFinding & { class_scope_present?: boolean; summary: string }>;
  /** Pass findings the report already holds at the same site. */
  alreadyReported: ChunkFinding[];
};

/** The pass findings an ingest brings in: those the report does not already carry at the same site. */
export function injectablePassFindings(pass: ChunkPass | null, reported: readonly SiteRef[]): InjectedPass {
  const result: InjectedPass = { findings: [], alreadyReported: [] };
  if (pass === null) return result;
  for (const finding of pass.findings) {
    if (reported.some((entry) => sameSite(entry, finding))) result.alreadyReported.push(finding);
    else result.findings.push(passFindingToRound(finding, pass.reviewer));
  }
  return result;
}

export const MISSING_SECTION_HEADING = "## Chunk pass findings not in the round";
const MISSING_SECTION = /^## Chunk pass findings not in the round[^\n]*\n[\s\S]*?(?=^## (?!#)|$(?![\s\S]))/m;

const oneLine = (value: unknown, limit: number): string => {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/** The report.md section naming the pass findings the round does not hold. */
export function renderMissingSection(missing: readonly ChunkFinding[]): string {
  const rows = missing.map((finding) => `- ${describePassFinding(finding)} — ${oneLine(finding.problem ?? finding.title, 200)}`);
  return [
    MISSING_SECTION_HEADING,
    "",
    "A chunk pass raised these and `findings.json` does not hold them. `keryx review ingest --review-id <id>` brings them in; until then this round does not account for them.",
    "",
    ...rows,
    "",
  ].join("\n");
}

/** Put the section into `report`, replacing one already there; with nothing missing, remove it. */
export function upsertMissingSection(report: string, missing: readonly ChunkFinding[]): string {
  const without = MISSING_SECTION.test(report) ? report.replace(MISSING_SECTION, "").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n") : report;
  if (missing.length === 0) return without;
  return `${without.trimEnd()}\n\n${renderMissingSection(missing)}`;
}

/** The warning `review complete` prints for pass findings the round does not hold. */
export function missingWarning(missing: readonly ChunkFinding[]): string {
  return `${missing.length} chunk-pass finding(s) are not in findings.json: ${missing.map(describePassFinding).join("; ")}. Run \`keryx review ingest --review-id <id>\` to bring them in, or name them in the report; this close does not refuse.`;
}
