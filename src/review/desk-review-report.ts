import type { ReportSlots } from "./report-overlay";
export { applyReviewOverlay, DESK_TEMPLATE_SELECTION, embeddedReportSlots, projectReportSlots, projectReviewOverlay,
  reportTemplateFingerprint, scopedFile } from "./report-overlay";
import type { PublicationSettings } from "./desk-publication-types";
import { parseEmbeddedFindings } from "./managed";
import type { VerdictFinding } from "./verdict";

export type DeskReportFinding = {
  id: string;
  severity: "blocker" | "major" | "minor" | "info";
  problem: string;
  file: string | null;
  line: number | null;
  locationClass?: "in-diff" | "pre-existing" | "pr-process";
  question?: boolean;
  evidence?: string;
  impact?: string;
  suggested_fix?: string;
  selectedAnswer?: string;
};

type Revision = { repo: string; head: string };
const labels = { blocker: "Blocker", major: "Major", minor: "Minor" } as const;
const severities = ["blocker", "major", "minor"] as const;
const singleLine = (value: string) => value.trim().replace(/\s+/g, " ");
const safeCode = (value: string) => value.replace(/[\p{Cc}`<>[\]]/gu, "");
const bold = (value: string) => singleLine(value).replace(/[*_]/g, "\\$&");
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function reportFindingMetadata(report: string | undefined) {
  const entries = new Map<string, Record<string, unknown>>();
  if (!report) return entries;
  try {
    const source = parseEmbeddedFindings(report, "report.md");
    for (const item of Array.isArray(source) ? source : [source]) {
      const row = object(item);
      for (const record of Array.isArray(row?.findings) ? row.findings.map(object) : [row]) {
        if (record && typeof record.id === "string" && !entries.has(record.id)) entries.set(record.id, record);
      }
    }
  } catch { /* Older drafts can have unparseable prose or no structured block. */ }
  return entries;
}

export function deskReportFinding(entry: VerdictFinding, raw: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined): DeskReportFinding {
  const file = text(raw?.file ?? raw?.path);
  const line = raw?.line ?? raw?.start_line;
  const locationClass = raw?.location_class ?? metadata?.location_class ?? (file ? "in-diff" : undefined);
  return {
    id: entry.id, severity: entry.severity, problem: text(raw?.problem) || entry.problem,
    file: file || null, line: typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : null,
    ...(locationClass === "in-diff" || locationClass === "pre-existing" || locationClass === "pr-process" ? { locationClass } : {}),
    ...((raw?.publication ?? metadata?.publication) === "question" && { question: true }),
    evidence: text(raw?.evidence), impact: text(raw?.impact), suggested_fix: text(raw?.suggested_fix),
  };
}

export function deskReportRecommendation(complete: boolean, findings: readonly DeskReportFinding[]): PublicationSettings["verdict"] {
  const changed = findings.filter(finding => finding.locationClass !== "pre-existing" && finding.locationClass !== "pr-process");
  if (changed.some(finding => finding.severity === "blocker" || finding.severity === "major")) return "changes";
  if (!complete) return "comment";
  return changed.some(finding => finding.severity !== "info" || finding.question) ? "suggestions" : "approve";
}

export function renderDeskFinding(finding: DeskReportFinding, revision: Revision): string {
  const { file, line, locationClass } = finding;
  const location = file && (line
    ? `[\`${safeCode(file)}:${line}\`](<https://github.com/${revision.repo}/blob/${revision.head}/${file.split("/").map(encodeURIComponent).join("/")}#L${line}>)`
    : `\`${safeCode(file)}\``);
  const position = [location, locationClass === "in-diff" ? "in the diff" : locationClass].filter(Boolean).join(", ");
  const claim = `**${bold(finding.id)}. ${bold(finding.problem)}**${position ? " " + position : ""}`;
  const details = [
    finding.evidence && `Evidence: ${finding.evidence}`,
    finding.impact && `Impact: ${finding.impact}`,
    finding.suggested_fix && `Fix: ${finding.suggested_fix}`,
    finding.selectedAnswer && `**Selected answer:** ${finding.selectedAnswer}`,
  ].filter((part): part is string => !!part);
  return finding.severity === "minor"
    ? "- " + [claim, ...details.map(singleLine)].join(" ")
    : [claim, ...details].join("\n\n");
}

export function reviewReportDisclosure(label: string, content: string, open = false): string {
  return `<details${open ? " open" : ""}><summary><b>${label}</b></summary>\n\n${content}\n\n</details>`;
}

export function renderDeskReviewReport(input: Revision & {
  base: string;
  round: number;
  verdict: PublicationSettings["verdict"];
  findings: readonly DeskReportFinding[];
  bodyFindings?: readonly DeskReportFinding[];
  inlineCount?: number;
  omittedCount?: number;
  evidenceLevel: string;
  coverageNote?: string;
  refuted?: readonly { id: string; decision: string }[];
  howRun: string;
  slots?: ReportSlots;
}): string {
  const { findings, bodyFindings = findings, verdict, round } = input;
  const changed = findings.filter(finding => finding.locationClass !== "pre-existing" && finding.locationClass !== "pr-process");
  const counts = severities.flatMap(severity => {
    const count = changed.filter(finding => finding.severity === severity).length;
    return count ? [`${count} ${labels[severity]}`] : [];
  });
  const questions = bodyFindings.filter(finding => finding.question && finding.locationClass !== "pr-process");
  if (questions.length) counts.push(`${questions.length} ${questions.length === 1 ? "question" : "questions"}`);
  const counted = counts.length ? ` — ${counts.join(", ")}` : "";
  const heading = verdict === "changes" ? `Changes requested${counted}`
    : verdict === "comment" ? `Review comments${counted}`
    : `No blockers, merge-ready${verdict === "suggestions" ? counted : ""}`;
  const format = (rows: readonly DeskReportFinding[]) => rows.map(finding => renderDeskFinding(finding, input)).join("\n\n");
  const groups = severities.flatMap(severity => {
    const rows = bodyFindings.filter(finding => finding.severity === severity &&
      finding.locationClass !== "pre-existing" && finding.locationClass !== "pr-process");
    if (!rows.length) return [];
    return [severity === "minor" && rows.length > 5
      ? reviewReportDisclosure(`Minor (${rows.length})`, format(rows), true)
      : `### ${labels[severity]}\n\n${format(rows)}`];
  });
  const preexisting = bodyFindings.filter(finding => finding.severity !== "info" && finding.locationClass === "pre-existing");
  const scope = bodyFindings.filter(finding => finding.locationClass === "pr-process");
  return [
    input.slots?.["pre-verdict"],
    `**${heading}.**\n\nReviewed \`${input.head.slice(0, 12)}\` against \`${input.base.slice(0, 12)}\` · round ${round}.\n\nEvidence level: ${input.evidenceLevel}`,
    input.slots?.["after-verdict"], input.coverageNote, ...groups,
    questions.length && `### Questions\n\n${questions.map((finding, index) => `${index + 1}. ${singleLine(finding.problem)}`).join("\n")}`,
    !!input.refuted?.length && `### Refuted and narrowed\n\n${input.refuted.map(item => `- **${bold(item.id)}.** ${singleLine(item.decision)}`).join("\n")}`,
    input.inlineCount ? `${input.inlineCount} inline comment(s).` : "",
    input.omittedCount ? `${input.omittedCount} finding(s) without an inline location omitted from this review.` : "",
    preexisting.length && reviewReportDisclosure("Pre-existing (not blocking)", format(preexisting)),
    scope.length && reviewReportDisclosure("Scope", format(scope)),
    input.slots?.["verified-clean"] && reviewReportDisclosure(input.slots["verified-clean"].startsWith("### Vantage mandatory checks") ? "Verification" : "Verified clean", input.slots["verified-clean"]),
    reviewReportDisclosure("How this review was run", [input.howRun, input.slots?.["how-run"]].filter(Boolean).join("\n\n")),
  ].filter(Boolean).join("\n\n");
}

export const STATIC_DESKTOP_REVIEW_EVIDENCE = "static only — did not run: browser or running application";

export function deskReportEvidence(report: string | undefined): string {
  // The required field is in the report header. Ignore later occurrences in findings or tool output.
  const evidence = report?.split("\n", 6).map(line => /^Evidence level:\s*(.+)$/i.exec(line.trim())?.[1]).find(Boolean);
  return evidence?.slice(0, 640) ?? "not recorded.";
}
