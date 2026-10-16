import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { readRoundRecord, renderRoundLine } from "./round-record";
import { isEmptyOutput, isReviewerResult, parseReviewResult } from "./ledger";
import { mergeVerifications, verificationClaims } from "./verification";
import { readRunProfile } from "./run-profile";
import { testsNotRunWarning } from "./tests-to-run";
import { promoteParentExecutions } from "./verify-run";
import type { StructuredReviewFinding, VerificationSource } from "./types";

/**
 * An interim verdict: what a review round says so far, read from whatever the package holds.
 *
 * The verdict of a round is ready once the reviewers and the verifier are done, but the managed round only yields it
 * after ingest, the mutation pass, the ledger and `complete`. This reads the package as it stands at any point of that
 * sequence and depends on none of those steps having run.
 */
export const VERDICT_FILE = "verdict-interim.md";
/** The verifier results a package may hold; applied (annotate mode) before the verdict counts anything. */
export const VERIFICATIONS_FILE = path.join("research-evidence", "verifications.json");
/** Dispositions that say the finding was fixed: it is no longer an open blocker or major. */
const RESOLVED_DISPOSITIONS: ReadonlySet<string> = new Set(["acted-on", "fixed"]);

const SEVERITIES = ["blocker", "major", "minor", "info"] as const;
type Severity = (typeof SEVERITIES)[number];

export type VerdictFinding = {
  id: string;
  reviewer: string;
  severity: Severity;
  problem: string;
  /** `file:line` (or the finding's own location text) when the finding names one. */
  location?: string | undefined;
  /** `confirmed`, `unverifiable`, or `none` when nobody checked it. */
  verification: "confirmed" | "unverifiable" | "none";
};

export type InterimVerdict = {
  /** `ingested round` reads `findings.json`; `raw reviewer results` reads `raw/`; `none` means the package held neither. */
  source: "ingested round" | "raw reviewer results" | "none";
  /** Findings that count: refuted and dismissed ones are already out. */
  counts: Record<Severity, number>;
  total: number;
  verified: number;
  unverified: number;
  refuted: number;
  dismissed: number;
  /** Findings whose disposition says they were acted on (fixed); not counted as open. */
  resolved: number;
  /** Verifier claims read from the package and applied, or `undefined` when it holds none. */
  verifierClaims: number | undefined;
  /** Where the raw reviewer results were read from. */
  rawDir: string;
  open: VerdictFinding[];
  /** Open minor findings, listed one by one (owner decision 2026-10-16: minors are to be addressed, not only counted). */
  minors: VerdictFinding[];
  reportedReviewers: string[];
  /** Reviewers the package expects that have produced no result. `undefined` when the package does not say who was expected. */
  pendingReviewers: string[] | undefined;
  /** True when only an ingested round is present: a pending reviewer may have run clean. */
  pendingAmbiguous: boolean;
  /** Raw files that held no parsable reviewer result. */
  unreadable: string[];
  headline: string;
  /** How the round runs (`<package>/run-profile.json`): `attended (default)`, `unattended (--unattended)`, ...; undefined for a package without one. */
  runMode?: string | undefined;
  /** Flow 458: `round N (source: …)` or `round 1 — no previous round found (sources tried: …)`, from round.json; undefined without one. */
  round?: string | undefined;
  /** A warning when `tests-to-run.json` lists tests and no `keryx review verify-run` record exists: "N tests listed to run; none recorded as run". */
  testsNotRun?: string | undefined;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The first line of a problem statement, trimmed to a length one terminal line holds. */
function oneLine(value: string): string {
  const first = (value.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

/** `file:line` from the finding's own fields: `location`, else `file` (or `path`) with `line` (or `start_line`). */
function locationOf(record: Record<string, unknown>): string | undefined {
  const given = text(record.location);
  if (given !== undefined) return oneLine(given);
  const file = text(record.file) ?? text(record.path);
  if (file === undefined) return undefined;
  const line = typeof record.line === "number" ? record.line : typeof record.start_line === "number" ? record.start_line : text(record.line);
  return line === undefined ? file : `${file}:${line}`;
}

function severityOf(value: unknown): Severity {
  const normalised = typeof value === "string" ? value.toLowerCase() : "";
  return (SEVERITIES as readonly string[]).includes(normalised) ? (normalised as Severity) : "info";
}

type Loose = { record: Record<string, unknown>; fallbackReviewer: string; index: number };

/** Findings of one record, as the verdict counts them. `kept` is false for a refuted or dismissed finding. */
function classify(loose: Loose): { finding: VerdictFinding; state: "kept" | "refuted" | "dismissed" | "resolved" } {
  const { record, fallbackReviewer, index } = loose;
  const verification = text(object(record.verification)?.verdict);
  const disposition = text(object(record.disposition)?.state);
  const finding: VerdictFinding = {
    id: text(record.id) ?? `${fallbackReviewer}#${index + 1}`,
    reviewer: text(record.reviewer) ?? fallbackReviewer,
    severity: severityOf(record.severity),
    problem: oneLine(text(record.problem) ?? text(record.summary) ?? text(record.title) ?? "(no problem statement)"),
    ...(locationOf(record) === undefined ? {} : { location: locationOf(record) }),
    verification: verification === "confirmed" ? "confirmed" : verification === "unverifiable" ? "unverifiable" : "none",
  };
  if (verification === "refuted") return { finding, state: "refuted" };
  if (disposition !== undefined && disposition.startsWith("dismissed")) return { finding, state: "dismissed" };
  if (disposition !== undefined && RESOLVED_DISPOSITIONS.has(disposition)) return { finding, state: "resolved" };
  return { finding, state: "kept" };
}

async function rawResults(dir: string): Promise<{ results: Array<{ name: string; reviewer: string; findings: Array<Record<string, unknown>> }>; unreadable: string[] }> {
  const results: Array<{ name: string; reviewer: string; findings: Array<Record<string, unknown>> }> = [];
  const unreadable: string[] = [];
  if (!existsSync(dir)) return { results, unreadable };
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".txt")).sort()) {
    const body = await readFile(path.join(dir, name), "utf8");
    if (isEmptyOutput(body)) continue;
    const parsed = parseReviewResult(body);
    if (parsed === undefined || !isReviewerResult(parsed)) {
      if (/REVIEW_RESULT/i.test(body)) unreadable.push(`${path.basename(dir)}/${name}`);
      continue;
    }
    results.push({ name, reviewer: text(parsed.reviewer) ?? name.replace(/\.txt$/, ""), findings: (parsed.findings ?? []).filter((entry) => object(entry) !== undefined) });
  }
  return { results, unreadable };
}

/** Reviewers the package says were expected: the run entries of the manifest's coverage, and `research.json`'s dispatch selection. */
async function expectedReviewers(packageDir: string): Promise<string[] | undefined> {
  const names = new Set<string>();
  const manifest = object(await readJson(path.join(packageDir, "manifest.json")));
  if (Array.isArray(manifest?.coverage)) {
    for (const entry of manifest.coverage) {
      const record = object(entry);
      const reviewer = text(record?.reviewer);
      if (reviewer !== undefined && record?.status === "run") names.add(reviewer);
    }
  }
  const dispatch = object(object(await readJson(path.join(packageDir, "research.json")))?.dispatch);
  if (Array.isArray(dispatch?.selected)) for (const entry of dispatch.selected) if (text(entry) !== undefined) names.add((entry as string).trim());
  names.delete("review-orchestrator");
  return names.size === 0 ? undefined : [...names].sort();
}

export type VerdictOptions = {
  /** Directory of raw reviewer results; default `<package>/raw`. */
  rawDir?: string | undefined;
};

/** Verifier results the package holds, applied as annotations: a `refuted` claim excludes the finding from the counts. */
async function applyVerifierClaims(packageDir: string, entries: Loose[]): Promise<number | undefined> {
  const source = await readJson(path.join(packageDir, VERIFICATIONS_FILE));
  if (source === undefined) return undefined;
  let claims;
  try {
    // A claim citing a `keryx review verify-run` record of its finding in this package ran in the parent (flow 457).
    claims = promoteParentExecutions(verificationClaims(source as VerificationSource), packageDir);
  } catch {
    return undefined;
  }
  const pending = entries.filter((entry) => object(entry.record.verification) === undefined);
  const subjects = pending.map((entry) => ({ ...entry.record, id: text(entry.record.id) ?? `${entry.fallbackReviewer}#${entry.index + 1}`, reviewer: text(entry.record.reviewer) ?? entry.fallbackReviewer }) as unknown as StructuredReviewFinding);
  const merged = mergeVerifications(subjects, claims, { mode: "annotate" });
  merged.retained.forEach((finding, position) => {
    const entry = pending[position];
    if (entry !== undefined && finding.verification !== undefined) entry.record = { ...entry.record, verification: finding.verification };
  });
  return merged.counts.applied;
}

export async function computeVerdict(packageDir: string, options: VerdictOptions = {}): Promise<InterimVerdict> {
  const rawDir = options.rawDir ?? path.join(packageDir, "raw");
  const ingested = await readJson(path.join(packageDir, "findings.json"));
  const raws = await rawResults(rawDir);
  const useRound = Array.isArray(ingested);

  const loose: Loose[] = [];
  if (useRound) {
    (ingested as unknown[]).forEach((entry, index) => {
      const record = object(entry);
      if (record !== undefined) loose.push({ record, fallbackReviewer: "review-orchestrator", index });
    });
  } else {
    for (const result of raws.results) result.findings.forEach((record, index) => loose.push({ record, fallbackReviewer: result.reviewer, index }));
  }

  const verifierClaims = await applyVerifierClaims(packageDir, loose);
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, info: 0 };
  const open: VerdictFinding[] = [];
  const minors: VerdictFinding[] = [];
  let verified = 0;
  let unverified = 0;
  let refuted = 0;
  let dismissed = 0;
  let resolved = 0;
  for (const entry of loose) {
    const { finding, state } = classify(entry);
    if (state === "refuted") { refuted += 1; continue; }
    if (state === "dismissed") { dismissed += 1; continue; }
    if (state === "resolved") { resolved += 1; continue; }
    counts[finding.severity] += 1;
    if (finding.verification === "confirmed") verified += 1;
    else unverified += 1;
    if (finding.severity === "blocker" || finding.severity === "major") open.push(finding);
    else if (finding.severity === "minor") minors.push(finding);
  }
  minors.sort((a, b) => a.id.localeCompare(b.id));
  open.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.id.localeCompare(b.id));

  const reported = new Set<string>(raws.results.map((result) => result.reviewer));
  if (useRound) for (const entry of loose) reported.add(text(entry.record.reviewer) ?? "review-orchestrator");
  const expected = await expectedReviewers(packageDir);
  const pendingReviewers = expected?.filter((reviewer) => !reported.has(reviewer));

  const total = counts.blocker + counts.major + counts.minor + counts.info;
  const source: InterimVerdict["source"] = useRound ? "ingested round" : raws.results.length > 0 ? "raw reviewer results" : "none";
  const headline =
    source === "none" ? "no reviewer results in the package yet"
    : total === 0 ? "no findings"
    : `${counts.blocker > 0 ? `${counts.blocker} open blocker(s): do not merge`
      : counts.major > 0 ? `${counts.major} open major(s): resolve or justify before merge`
      : "no open blockers or majors"}${counts.minor > 0 ? `; ${counts.minor} minor to address` : ""}`;
  // An ingested round lists only reviewers that raised a finding; one that ran clean is indistinguishable from one that never ran.
  const pendingAmbiguous = useRound && raws.results.length === 0;
  const profile = readRunProfile(packageDir);
  const runMode = profile === undefined ? undefined : `${profile.mode} (${profile.declaredVia})`;
  const testsNotRun = testsNotRunWarning(packageDir);
  const roundRecord = readRoundRecord(packageDir);
  const round = roundRecord === undefined ? undefined : renderRoundLine(roundRecord);
  return { source, counts, total, verified, unverified, refuted, dismissed, resolved, verifierClaims, rawDir, open, minors, reportedReviewers: [...reported].sort(), pendingReviewers, pendingAmbiguous, unreadable: raws.unreadable, headline, ...(runMode === undefined ? {} : { runMode }), ...(testsNotRun === undefined ? {} : { testsNotRun }), ...(round === undefined ? {} : { round }) };
}

function findingLine(finding: VerdictFinding): string {
  return `- ${finding.id} [${finding.severity}]${finding.location === undefined ? "" : ` ${finding.location}`} (${finding.reviewer}, ${finding.verification === "confirmed" ? "verified" : "unverified"}): ${finding.problem}`;
}

export function renderVerdict(verdict: InterimVerdict, reviewId: string): string {
  const lines = [`# Interim verdict: ${reviewId}`, "", `verdict: ${verdict.headline}`, `source: ${verdict.source}`];
  if (verdict.round !== undefined) lines.push(verdict.round);
  if (verdict.runMode !== undefined) lines.push(`run mode: ${verdict.runMode}`);
  if (verdict.testsNotRun !== undefined) lines.push(`warning: ${verdict.testsNotRun}`);
  if (verdict.total === 0 && verdict.source !== "none") lines.push("findings: none");
  else lines.push(`findings: ${verdict.total} (${SEVERITIES.map((severity) => `${verdict.counts[severity]} ${severity}`).join(", ")})`);
  lines.push(`verified: ${verdict.verified}, unverified: ${verdict.unverified}`);
  lines.push(`excluded: ${verdict.refuted} refuted, ${verdict.dismissed} dismissed, ${verdict.resolved} acted on (fixed)`);
  if (verdict.verifierClaims !== undefined) lines.push(`verifier results applied: ${verdict.verifierClaims} claim(s) from ${VERIFICATIONS_FILE}`);
  if (verdict.source === "raw reviewer results" || verdict.pendingAmbiguous) lines.push(`raw results read from: ${verdict.rawDir}`);
  lines.push(`reviewers reported: ${verdict.reportedReviewers.length === 0 ? "none" : verdict.reportedReviewers.join(", ")}`);
  lines.push(verdict.pendingReviewers === undefined
    ? "reviewers not reported: unknown (the package does not record who was expected)"
    : `${verdict.pendingAmbiguous ? "reviewers with no findings or not reported" : "reviewers not reported"}: ${verdict.pendingReviewers.length === 0 ? "none" : verdict.pendingReviewers.join(", ")}`);
  for (const file of verdict.unreadable) lines.push(`unreadable result: ${file}`);
  if (verdict.open.length > 0) {
    lines.push("", "## Open blockers and majors", "");
    for (const finding of verdict.open) lines.push(findingLine(finding));
  }
  if (verdict.minors.length > 0) {
    lines.push("", "## Minor findings to address", "");
    for (const finding of verdict.minors) lines.push(findingLine(finding));
  }
  lines.push("", "Interim: written before ledger, mutation pass and `complete`; it does not replace the completion gate.");
  return `${lines.join("\n")}\n`;
}

/** Compute the interim verdict of a package, write `verdict-interim.md` into it, and return both. */
export async function writeVerdict(packageDir: string, reviewId: string, options: VerdictOptions = {}): Promise<{ verdict: InterimVerdict; markdown: string; file: string }> {
  const verdict = await computeVerdict(packageDir, options);
  const markdown = renderVerdict(verdict, reviewId);
  const file = path.join(packageDir, VERDICT_FILE);
  await writeFileAtomic(file, markdown);
  return { verdict, markdown, file };
}
