import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isNotFound } from "../lib/fs";
import { resolveMainCheckoutRoot } from "../lib/git-worktrees";
import type { PublicationSettings } from "./desk-publication-types";
import { stripMachineFences } from "./machine-fences";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const overlayPath = ".metaproject/review-publish-template.md";
const placeholder = "{{review}}";
const projectSkills = ".metaproject/project-skills/orchestration";
const baseTemplate = ".metaproject/skills/gdskills/review/review-orchestrator/templates/review-report.md";
const slotNames = ["pre-verdict", "after-verdict", "verified-clean", "how-run"] as const;
type SlotName = typeof slotNames[number];
export type ReportSlots = Partial<Record<SlotName, string>>;
export type ReviewOverlay =
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

/** A linked checkout can use the installed review controls of its own clone's main checkout. */
export async function mainReviewRoot(cwd: string): Promise<string | undefined> {
  const main = await resolveMainCheckoutRoot(cwd);
  if (main && main !== await realpath(cwd) && await scopedFile(main, ".metaproject/index.md", 128 * 1024)) return main;
}

export async function projectReviewOverlay(cwd: string): Promise<{ overlay?: ReviewOverlay; overlayWarning?: string }> {
  const local = await readProjectReviewOverlay(cwd);
  if (local.overlay || local.overlayWarning) return local;
  const main = await mainReviewRoot(cwd);
  return main ? readProjectReviewOverlay(main) : local;
}

async function readProjectReviewOverlay(cwd: string): Promise<{ overlay?: ReviewOverlay; overlayWarning?: string }> {
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

const VANTAGE_CHECKS = [
  "Owner intent", "Testing gate", "Wire types", "User guide", "Shared UI contract",
  "i18n", "Siblings", "Live run", "E2E label",
] as const;

function readReportSlots(overlay: Extract<ReviewOverlay, { kind: "slots" }>, report: string | undefined): ReportSlots {
  const slots: ReportSlots = {};
  const block = embeddedReportSlots(report);
  if (!block) return slots;
  try {
    const parsed = object(JSON.parse(block));
    const rendered = parsed?.overlay === overlay.id ? object(parsed.slots) : undefined;
    for (const name of overlay.names) {
      const value = text(rendered?.[name]);
      if (value && value.length <= 8192 && !/<\/?(?:details|summary)\b|<!--/i.test(value)) slots[name] = value;
    }
  } catch { /* Older reports may not carry a valid block. */ }
  return slots;
}

/** Keep recorded evidence and account for every check the Vantage template requires. */
function vantageChecks(source: string | undefined): string {
  const recorded = new Map<string, string>();
  for (const line of source?.split(/\r?\n/) ?? []) {
    const match = /^\s*[-*]\s+(?:\*\*)?([^*:—]+?)(?:\*\*)?\s*(?:—|:)\s*(.+)$/.exec(line);
    if (match?.[1] && match[2]) recorded.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  return "### Vantage mandatory checks\n\n" + VANTAGE_CHECKS.map(name =>
    `- ${name} — ${recorded.get(name.toLowerCase()) ?? "Not verified in this round."}`,
  ).join("\n");
}

export function projectReportSlots(overlay: ReviewOverlay | undefined, report: string | undefined,
  round: number, verdict: PublicationSettings["verdict"], orchestrated: boolean): ReportSlots {
  if (overlay?.kind !== "slots") return {};
  const slots = readReportSlots(overlay, report);
  if (overlay.id === "vantage-review") {
    slots["verified-clean"] = vantageChecks(slots["verified-clean"]);
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
  return slotsFence.exec(report ?? "")?.[1];
}

const slotsFence = /^```(?:json[ \t]+)?keryx:report-slots[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;
const savedSlotMarker = /^<!-- \/?keryx:project-report-slot:[\w-]+ -->\r?\n?/gm;

/** Persist each visible section and its evidence so ingest and Desktop publication read the same report. */
export function retainProjectReportOverlay(overlay: ReviewOverlay | undefined, report: string): string {
  if (overlay?.kind !== "slots") return report;
  const slots = readReportSlots(overlay, report);
  if (overlay.id === "vantage-review") slots["verified-clean"] = vantageChecks(slots["verified-clean"]);
  if (!Object.keys(slots).length) return report;

  let rendered = report.replace(slotsFence, "").trimEnd();
  for (const name of overlay.names) {
    const content = slots[name];
    if (!content) continue;
    const start = `<!-- keryx:project-report-slot:${name} -->`;
    const end = `<!-- /keryx:project-report-slot:${name} -->`;
    const block = `${start}\n${content}\n${end}`;
    const previous = new RegExp(`^${start}\\r?\\n[\\s\\S]*?^${end}$`, "m");
    const slot = `<!-- slot:${name} -->`;
    if (previous.test(rendered)) rendered = rendered.replace(previous, () => block);
    else if (rendered.includes(slot)) rendered = rendered.replace(slot, () => block);
    else rendered += "\n\n" + block;
  }
  const metadata = "```json keryx:report-slots\n" + JSON.stringify({ overlay: overlay.id, slots }, null, 2) + "\n```";
  return rendered + "\n\n" + metadata;
}

/** What a person reads: no `keryx:*` machine block (findings, premises, verifications, slots) and no slot markers. */
export function publicProjectReport(report: string): string {
  return stripMachineFences(report.replace(slotsFence, "").replace(savedSlotMarker, "")).trim();
}
