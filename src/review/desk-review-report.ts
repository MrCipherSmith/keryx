import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isNotFound } from "../lib/fs";
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
const overlayPath = ".metaproject/review-publish-template.md";
const placeholder = "{{review}}";
const projectSkills = ".metaproject/project-skills/orchestration";
const baseTemplate = ".metaproject/skills/gdskills/review/review-orchestrator/templates/review-report.md";
const slotNames = ["pre-verdict", "after-verdict", "verified-clean", "how-run"] as const;
type SlotName = typeof slotNames[number];
type ReportSlots = Partial<Record<SlotName, string>>;
type ReviewOverlay =
  | { kind: "wrapper"; source: string; requiresApproval: boolean }
  | { kind: "slots"; source: string; id: string; names: SlotName[]; requiresApproval: boolean; rereadDiscussion: boolean };
export const DESK_TEMPLATE_SELECTION = "publication-template.json";
export function reportTemplateFingerprint(overlay: ReviewOverlay | undefined): string {
  return createHash("sha256").update(overlay?.source ?? "").digest("hex");
}

async function templateExists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if (!isNotFound(error)) throw error; return false; }
}

export async function scopedFile(root: string, relative: string, limit: number): Promise<string | undefined> {
  const target = path.join(root, relative);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > limit || await realpath(target) !== path.join(await realpath(root), relative)) return;
    return await readFile(target, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function projectReviewOverlay(cwd: string): Promise<{ overlay?: ReviewOverlay; overlayWarning?: string }> {
  try {
    const packages = await readdir(path.join(cwd, projectSkills), { withFileTypes: true }).catch(error => {
      if (!isNotFound(error)) throw error;
      return [];
    });
    const imported = (await Promise.all(packages.filter(entry => entry.isDirectory()).map(async ({ name }) => {
      const relative = `${projectSkills}/${name}/templates/report-overlay.md`;
      const source = await scopedFile(cwd, relative, 32 * 1024);
      if (source === undefined && !await templateExists(path.join(cwd, relative))) return;
      return { source, name };
    }))).filter(entry => entry !== undefined);
    if (imported.length > 1) return { overlayWarning: "More than one project review overlay is installed." };
    const entry = imported[0];
    if (entry) {
      const yaml = /^```ya?ml\s*\r?\n([\s\S]*?)^\s*```\s*$/m.exec(entry.source ?? "")?.[1];
      const meta = object(yaml && Bun.YAML.parse(yaml));
      const source = entry.source;
      const declared: unknown[] = Array.isArray(meta?.slots) ? meta.slots : [];
      const names = slotNames.filter(name => declared.includes(name));
      const headings = [...(source ?? "").matchAll(/^## slot:\s*(\S+)\s*$/gm)].map(match => match[1]);
      if (!source || meta?.extends !== "review-orchestrator" || meta.overlay !== entry.name || !names.length ||
          names.length !== declared.length || headings.length !== names.length || names.some(name => headings.filter(heading => heading === name).length !== 1)) {
        return { overlayWarning: "The project report overlay has invalid Keryx slot declarations." };
      }
      const base = await scopedFile(cwd, baseTemplate, 128 * 1024);
      if (!base || names.some(name => base.split(`<!-- slot:${name} -->`).length !== 2)) {
        return { overlayWarning: "The base Keryx template does not have the required overlay slots." };
      }
      const rules = meta.requires_rules ?? [];
      if (!Array.isArray(rules) || !(await Promise.all(rules.map(rule =>
        typeof rule === "string" && /^(?:[\w-]+\/)*[\w.-]+\.mdc$/.test(rule) &&
        scopedFile(cwd, `.metaproject/rules/project/${rule}`, 128 * 1024)))).every(Boolean)) {
        return { overlayWarning: "The project report overlay is missing a required project rule." };
      }
      return { overlay: { kind: "slots", source, id: entry.name, names,
        requiresApproval: meta.requires_approval === true || /post only after they approve that body/i.test(source),
        rereadDiscussion: meta.reread_discussion === true || /re-read the head and the whole thread/i.test(source) } };
    }
    const source = await scopedFile(cwd, overlayPath, 8192);
    if (source?.split(placeholder).length === 2) return { overlay: { kind: "wrapper", source, requiresApproval: false } };
    return await templateExists(path.join(cwd, overlayPath))
      ? { overlayWarning: "The project template must be a readable file with one {{review}} placeholder." } : {};
  } catch {
    return { overlayWarning: "The project template could not be read. The standard report is available." };
  }
}

export function applyReviewOverlay(report: string, overlay: ReviewOverlay | undefined) {
  return overlay?.kind === "wrapper" ? overlay.source.replace(placeholder, () => report) : report;
}

export function projectReportSlots(overlay: ReviewOverlay | undefined, report: string | undefined,
  round: number, verdict: PublicationSettings["verdict"], orchestrated: boolean): ReportSlots {
  if (overlay?.kind !== "slots") return {};
  const slots: ReportSlots = {};
  const block = embeddedReportSlots(report);
  if (block) {
    try {
      const parsed = object(JSON.parse(block));
      const rendered = parsed?.overlay === overlay.id ? object(parsed.slots) : undefined;
      for (const name of overlay.names) {
        const value = text(rendered?.[name]);
        if (value && value.length <= 8192 && !/<\/?(?:details|summary)\b|<!--/i.test(value)) slots[name] = value;
      }
    } catch { /* Older or interrupted runs may not have rendered these optional slots. */ }
  }
  if (overlay.id === "vantage-review") {
    const label = { approve: "Approve", suggestions: "Approve with suggestions", changes: "Request changes", comment: "Comment only" }[verdict];
    slots["after-verdict"] = [
      `**Round ${round} of 3** · ${round === 1 ? "First review" : "Follow-up review"} · ${label}.`,
      round === 3 && "Third round — a fourth means the PR is mis-scoped (split, pair, or back to design).",
      slots["after-verdict"],
    ].filter(Boolean).join("\n\n");
    if (orchestrated) slots["how-run"] = ['- **Orchestrator:** `review-orchestrator` by Keryx.', slots["how-run"]].filter(Boolean).join("\n");
  }
  return slots;
}

export function embeddedReportSlots(report?: string) {
  return /^```json[ \t]+keryx:report-slots[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(report ?? "")?.[1];
}

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
    input.slots?.["verified-clean"] && reviewReportDisclosure("Verified clean", input.slots["verified-clean"]),
    reviewReportDisclosure("How this review was run", [input.howRun, input.slots?.["how-run"]].filter(Boolean).join("\n\n")),
  ].filter(Boolean).join("\n\n");
}

export const STATIC_DESKTOP_REVIEW_EVIDENCE = "static only — did not run: browser or running application";

export function deskReportEvidence(report: string | undefined): string {
  // The required field is in the report header. Ignore later occurrences in findings or tool output.
  const evidence = report?.split("\n", 6).map(line => /^Evidence level:\s*(.+)$/i.exec(line.trim())?.[1]).find(Boolean);
  return evidence?.slice(0, 640) ?? "not recorded.";
}
