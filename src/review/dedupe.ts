/**
 * Duplicate findings, merged at ingest (flow 458, AC5).
 *
 * One defect reported by several reviewers used to reach the package as several
 * findings — up to seven on one PR — each carrying its own severity, and the
 * operator answered each of them. The merge here keeps one record per defect:
 * the highest severity, every reporter in `reported_by`, every reporter's
 * evidence, and the absorbed ids in `merged_from` so anything that cited one of
 * them can still find the record that carries it.
 *
 * ## What counts as the same finding
 *
 * Conservative on purpose: a wrong merge hides a real finding, a missed merge
 * only costs a second reply. Two findings are duplicates when ALL of:
 *
 * 1. **Different reviewers.** A reviewer that reports two findings at one site
 *    meant two findings.
 * 2. **The same file**, after normalising separators. Never across files, even
 *    when everything else matches — "the same mistake in two files" is two sites.
 * 3. **The same place**: both located lines within {@link LINE_WINDOW}, or the
 *    same quote after collapsing whitespace.
 * 4. **The same mechanism**: an equal `dedupe_key` when both carry one (a
 *    differing pair vetoes the merge), no differing `symbol` or `related_skill`,
 *    and — when no shared key decides it — problem statements whose content
 *    words overlap by at least {@link PROBLEM_SIMILARITY} (Jaccard).
 *
 * Clusters are complete-linkage: a finding joins a cluster only when it is a
 * duplicate of EVERY member, so a chain A~B~C cannot merge A with a C it does not
 * resemble.
 *
 * Never merged: external findings (each one owes its own reply), findings that
 * already carry a disposition (a carried or dismissed record is not this round's
 * report), findings a verifier refuted (the refutation is a measurement), and
 * findings held by a premise judgement (the operator's question stays visible).
 *
 * ## Severity
 *
 * The highest of the merged findings — unless a verifier confirmed any of them,
 * in which case the highest CONFIRMED severity is canonical: the verifier ran
 * something against that claim at that severity, and the unconfirmed
 * re-statements do not outrank it. A premise judge's downgrade outranks both: the
 * downgraded severity is the finding's severity, and a re-statement at the
 * original one does not raise it again.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { isHeldVerdict } from "./premise";
import { REVIEW_FINDING_SEVERITIES, type ReviewFindingSeverity, type StructuredReviewFinding } from "./types";

/** Located lines this far apart (inclusive) are the same place. */
export const LINE_WINDOW = 3;
/** Minimum content-word Jaccard overlap of two problem statements. */
export const PROBLEM_SIMILARITY = 0.5;

export type DuplicateMerge = {
  /** The record that survived: its `global_id`, or `id`. */
  kept: string;
  /** The records folded into it. */
  absorbed: string[];
  reportedBy: string[];
  severity: ReviewFindingSeverity;
  /** `max` over all reporters, `verified` when a confirmed verdict decided it, or `premise` when a judge's downgrade did. */
  severityRule: "max" | "verified" | "premise";
  /** Severities the reporters gave, in reporter order, so drift stays visible. */
  reportedSeverities: ReviewFindingSeverity[];
  /**
   * When a verifier-confirmed severity was kept over a HIGHER one nobody confirmed: that higher severity and who reported
   * it, so the report says the lower severity won on evidence, not by accident.
   */
  outranked?: { severity: ReviewFindingSeverity; reviewer: string; id: string } | undefined;
};

export type MergeDuplicatesResult<T> = {
  findings: T[];
  merges: DuplicateMerge[];
};

/** What a later wave is told about findings an earlier wave already reported. */
export type KnownFinding = {
  id: string;
  global_id?: string | null;
  reviewer?: string;
  severity?: ReviewFindingSeverity;
  file?: string | null;
  line?: number | null;
  quote?: string | null;
  problem?: string;
};

const STOPWORDS = new Set(
  "the and for but not with this that from into when then than are was were has have had can could would should will its it's their there here which what who whose does did doing done any all one two only also each every other same such very more most less least just like been being use used uses using".split(
    " ",
  ),
);

function rank(severity: ReviewFindingSeverity): number {
  // REVIEW_FINDING_SEVERITIES is ordered blocker-first, so a lower index is worse.
  return REVIEW_FINDING_SEVERITIES.length - REVIEW_FINDING_SEVERITIES.indexOf(severity);
}

function keyOf(finding: StructuredReviewFinding): string {
  return finding.global_id ?? finding.id;
}

function normalisePath(file: string | null | undefined): string | null {
  if (typeof file !== "string" || file.trim() === "") {
    return null;
  }
  return path.posix.normalize(file.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
}

function normaliseQuote(quote: string | null | undefined): string | null {
  if (typeof quote !== "string") {
    return null;
  }
  const collapsed = quote.replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed;
}

function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) {
      continue;
    }
    // A crude stem: enough to make `handler`/`handlers` and `call`/`called` one word.
    words.add(raw.replace(/(ing|ed|es|s)$/, "") || raw);
  }
  return words;
}

/** Jaccard overlap of the content words of two problem statements. */
export function problemSimilarity(a: string, b: string): number {
  const left = contentWords(a);
  const right = contentWords(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}

function present(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Whether a finding takes part in the merge at all. */
function mergeable(finding: StructuredReviewFinding): boolean {
  return (
    finding.source !== "external" &&
    finding.disposition === undefined &&
    finding.verification?.verdict !== "refuted" &&
    // Flow 459: a finding held for the operator stays its own record. Folding it into a non-held duplicate would
    // either hide the question or carry a hold onto a finding nobody asked about, silently.
    !isHeldVerdict(finding.premise?.verdict) &&
    normalisePath(finding.file) !== null
  );
}

/** The pairwise rule. Exported so the rule itself is testable without a pipeline. */
export function isDuplicate(a: StructuredReviewFinding, b: StructuredReviewFinding): boolean {
  if (a.reviewer.trim().toLowerCase() === b.reviewer.trim().toLowerCase()) {
    return false;
  }
  const fileA = normalisePath(a.file);
  if (fileA === null || fileA !== normalisePath(b.file)) {
    return false;
  }

  const quoteA = normaliseQuote(a.quote);
  const sameQuote = quoteA !== null && quoteA === normaliseQuote(b.quote);
  const near =
    typeof a.line === "number" && typeof b.line === "number" && Math.abs(a.line - b.line) <= LINE_WINDOW;
  if (!sameQuote && !near) {
    return false;
  }

  for (const field of ["symbol", "related_skill"] as const) {
    const left = present(a[field]);
    const right = present(b[field]);
    if (left !== null && right !== null && left !== right) {
      return false;
    }
  }
  // Two statements naming different code (`loadA` and `loadB`, `user.id` and `user.name`) are two findings, however
  // alike the rest of the words are: unless one's identifiers are all among the other's, never merged.
  const tokensA = codeTokens(a.problem);
  const tokensB = codeTokens(b.problem);
  if (tokensA.size > 0 && tokensB.size > 0 && !subsetOf(tokensA, tokensB) && !subsetOf(tokensB, tokensA)) {
    return false;
  }
  const keyA = present(a.dedupe_key);
  const keyB = present(b.dedupe_key);
  if (keyA !== null && keyB !== null) {
    return keyA === keyB;
  }
  return problemSimilarity(a.problem, b.problem) >= PROBLEM_SIMILARITY;
}

function subsetOf(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
  for (const item of small) if (!large.has(item)) return false;
  return true;
}

const CODE_SPAN = /`([^`\n]+)`/g;
/** dotted.names, camelCase / PascalCase-with-inner-capital, snake_case, and calls `name(` — words that name code. */
const IDENTIFIER = /(?<![\w$.])(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|[a-z][a-z0-9]*[A-Z][\w$]*|[A-Za-z][A-Za-z0-9]*_[\w$]+|[A-Za-z_$][\w$]*(?=\())/g;

/** The identifiers a problem statement names: its code spans, and identifier-shaped words outside them. */
export function codeTokens(problem: string): Set<string> {
  const tokens = new Set<string>();
  const normalise = (token: string): string => token.trim().replace(/\(\)$/, "").replace(/[;,.:]+$/, "");
  for (const match of problem.matchAll(CODE_SPAN)) {
    const token = normalise(match[1]!);
    if (token !== "") tokens.add(token);
  }
  for (const match of problem.replace(CODE_SPAN, " ").matchAll(IDENTIFIER)) {
    const token = normalise(match[0]);
    if (token !== "") tokens.add(token);
  }
  return tokens;
}

/**
 * Merge duplicate findings into one record each. Order is preserved: a merged
 * finding sits where its earliest member was. Input objects are not mutated.
 */
export function mergeDuplicates<T extends StructuredReviewFinding>(findings: readonly T[]): MergeDuplicatesResult<T> {
  const clusters: Array<{ members: T[]; at: number }> = [];
  const order: Array<{ cluster: { members: T[]; at: number } } | { single: T }> = [];
  for (const finding of findings) {
    if (!mergeable(finding)) {
      order.push({ single: finding });
      continue;
    }
    const home = clusters.find((cluster) => cluster.members.every((member) => isDuplicate(member, finding)));
    if (home !== undefined) {
      home.members.push(finding);
      continue;
    }
    const cluster = { members: [finding], at: order.length };
    clusters.push(cluster);
    order.push({ cluster });
  }

  const merges: DuplicateMerge[] = [];
  const out: T[] = [];
  for (const entry of order) {
    if ("single" in entry) {
      out.push(entry.single);
      continue;
    }
    const { members } = entry.cluster;
    if (members.length === 1) {
      out.push(members[0] as T);
      continue;
    }
    const merged = mergeCluster(members);
    out.push(merged.finding);
    merges.push(merged.record);
  }
  return { findings: out, merges };
}

function bestOf<T extends StructuredReviewFinding>(candidates: readonly T[]): T {
  const confidenceRank = { high: 3, medium: 2, low: 1 } as const;
  return [...candidates].sort(
    (a, b) =>
      rank(b.severity) - rank(a.severity) ||
      (confidenceRank[b.confidence] ?? 0) - (confidenceRank[a.confidence] ?? 0),
  )[0] as T;
}

type SeverityRule = DuplicateMerge["severityRule"];

/** How scope.md names each rule, and how it words a member the rule outranked. */
const SEVERITY_RULE_LABEL: Record<SeverityRule, string> = {
  max: "highest reported severity",
  verified: "verifier-confirmed severity",
  premise: "severity downgraded by the premise judge",
};
const OUTRANKED_WORDS: Record<SeverityRule, { kept: string; other: string }> = {
  max: { kept: "the", other: "the" },
  verified: { kept: "the confirmed", other: "the unconfirmed" },
  premise: { kept: "the judge's", other: "the" },
};

/**
 * Which members decide the canonical severity, most authoritative first. A premise judge's downgrade (flow 459) is the
 * severity the finding has, not one more report to take the maximum of: without it a re-statement of the same defect at
 * its original severity would raise it again. Then a verifier's confirmation, then the highest report.
 */
function severityRuleOf<T extends StructuredReviewFinding>(members: readonly T[]): { rule: SeverityRule; decides: (member: T) => boolean } {
  const rules: Array<{ rule: SeverityRule; decides: (member: T) => boolean }> = [
    { rule: "premise", decides: (member) => member.premise?.verdict === "downgraded" },
    { rule: "verified", decides: (member) => member.verification?.verdict === "confirmed" },
  ];
  return rules.find((candidate) => members.some(candidate.decides)) ?? { rule: "max", decides: () => true };
}

function mergeCluster<T extends StructuredReviewFinding>(members: readonly T[]): { finding: T; record: DuplicateMerge } {
  const { rule: severityRule, decides } = severityRuleOf(members);
  const canonical = bestOf(members.filter(decides));
  const others = members.filter((member) => member !== canonical);

  const reportedBy: string[] = [];
  for (const member of [canonical, ...others]) {
    for (const reviewer of [member.reviewer, ...(member.reported_by ?? [])]) {
      if (!reportedBy.includes(reviewer)) {
        reportedBy.push(reviewer);
      }
    }
  }

  const evidence = [
    canonical.evidence,
    ...others
      .filter((member) => present(member.evidence) !== null && member.evidence.trim() !== canonical.evidence.trim())
      .map((member) => `Also reported by ${member.reviewer} (${keyOf(member)}, ${member.severity}): ${member.evidence.trim()}`),
  ].join("\n\n");

  const mergedFrom = [...(canonical.merged_from ?? [])];
  for (const member of others) {
    for (const id of [keyOf(member), ...(member.merged_from ?? [])]) {
      if (!mergedFrom.includes(id)) {
        mergedFrom.push(id);
      }
    }
  }

  // The absorbed statements stay readable: a merge must never lose what another reviewer said the problem was.
  const mergedProblems = [...(canonical.merged_problems ?? [])];
  for (const member of others) {
    for (const problem of [member.problem, ...(member.merged_problems ?? [])]) {
      if (present(problem) !== null && problem.trim() !== canonical.problem.trim() && !mergedProblems.includes(problem)) {
        mergedProblems.push(problem);
      }
    }
  }

  const finding: T = {
    ...canonical,
    evidence,
    reported_by: reportedBy,
    merged_from: mergedFrom,
    ...(mergedProblems.length === 0 ? {} : { merged_problems: mergedProblems }),
  };
  // A carried premise survives the merge (review LG8-003): the canonical record is chosen by severity, and a premise
  // on an absorbed member would otherwise vanish, so the finding would read as unjudged and be judged again. It moves
  // only onto a canonical at the severity it was judged at (review RG2-002): a judgement of a `major` says nothing about
  // a `blocker` re-statement, and a premised record is skipped by the delta judge, so the blocker would never be judged.
  // A `downgraded` premise is already the canonical's own (severityRuleOf), so this reaches only the other verdicts.
  const carriedPremise = canonical.premise ?? others.find((member) => member.premise !== undefined && member.severity === canonical.severity)?.premise;
  if (carriedPremise !== undefined) {
    finding.premise = carriedPremise;
  }
  if (members.some((member) => member.blocking_merge === true)) {
    finding.blocking_merge = true;
  }
  if (members.some((member) => member.learning_candidate === true)) {
    finding.learning_candidate = true;
  }
  const scoped = members.filter((member) => member.class_scope !== undefined);
  if (scoped.length > 0) {
    const base = canonical.class_scope ?? scoped[0]?.class_scope;
    if (base !== undefined) {
      const sites = [...new Set(scoped.flatMap((member) => member.class_scope?.sites ?? []))];
      finding.class_scope = { ...base, sites };
    }
  }

  const higher = severityRule === "max" ? [] : others.filter((member) => !decides(member) && rank(member.severity) > rank(canonical.severity));
  const top = higher.length === 0 ? undefined : bestOf(higher);
  return {
    finding,
    record: {
      kept: keyOf(canonical),
      absorbed: others.map(keyOf),
      reportedBy,
      severity: canonical.severity,
      severityRule,
      reportedSeverities: [canonical, ...others].map((member) => member.severity),
      ...(top === undefined ? {} : { outranked: { severity: top.severity, reviewer: top.reviewer, id: keyOf(top) } }),
    },
  };
}

/** The anchors a later wave needs: one entry per live finding of this round. */
export function knownFindingsFrom(findings: readonly StructuredReviewFinding[]): KnownFinding[] {
  return findings
    .filter((finding) => finding.source !== "external" && finding.disposition === undefined)
    .map((finding) => {
      const known: KnownFinding = { id: finding.id, reviewer: finding.reviewer, severity: finding.severity, problem: finding.problem };
      if (finding.global_id !== undefined) {
        known.global_id = finding.global_id;
      }
      if (finding.file !== undefined) {
        known.file = finding.file;
      }
      if (finding.line !== undefined) {
        known.line = finding.line;
      }
      if (finding.quote !== undefined) {
        known.quote = finding.quote;
      }
      return known;
    });
}

/**
 * `known_findings` for the next wave of a round, read from the package's
 * `findings.json`. A package that has none yet — the first wave — has none known.
 */
export async function knownFindingsForWave(packageDir: string): Promise<KnownFinding[]> {
  let text: string;
  try {
    text = await readFile(path.join(packageDir, "findings.json"), "utf8");
  } catch {
    return [];
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.join(packageDir, "findings.json")} is not an array of findings.`);
  }
  return knownFindingsFrom(parsed as StructuredReviewFinding[]);
}

/** The `## Duplicates merged` block for scope.md; empty when nothing merged. */
export function renderDuplicatesMarkdown(merges: readonly DuplicateMerge[]): string {
  if (merges.length === 0) {
    return "";
  }
  const rows = merges.map((merge) => {
    const words = OUTRANKED_WORDS[merge.severityRule];
    const outranked =
      merge.outranked === undefined ? "" : `; ${words.kept} ${merge.severity} outranks ${words.other} ${merge.outranked.severity} of ${merge.outranked.reviewer} (${merge.outranked.id})`;
    return `- ${merge.kept} kept (${merge.severity}, ${SEVERITY_RULE_LABEL[merge.severityRule]}); absorbed ${merge.absorbed.join(", ")}; reported by ${merge.reportedBy.join(", ")}; reported severities ${merge.reportedSeverities.join("/")}${outranked}`;
  });
  return `\n## Duplicates merged\n\n${rows.join("\n")}\n`;
}
