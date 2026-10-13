import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type ComparisonClass = "A" | "B" | "C" | "D" | "E";

export type ReferenceItem = {
  id: string;
  kind: "major" | "cycle" | "minor" | "question";
  text: string;
  locations: { file: string; line?: number | undefined }[];
  identifiers: string[];
  /** Reviewers that could have produced it; the item counts as "role ran" when any of them ran. */
  roles: string[];
  /** The reference got it by running something (a mutant, a probe), not by reading. */
  executionDerived: boolean;
};

export type EvidenceItem = {
  id: string;
  severity?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
  text: string;
};

export type PackageEvidence = {
  ran: string[];
  findings: EvidenceItem[];
  /** Raw observations that were closed without becoming a finding, plus any raw reviewer replies passed in. */
  lost: EvidenceItem[];
  mutationPass: boolean;
};

export type ComparedItem = {
  item: ReferenceItem;
  class: ComparisonClass;
  severity?: string | undefined;
  matched?: string | undefined;
  detail: string;
};

export type Comparison = {
  items: ComparedItem[];
  totals: Record<ComparisonClass, number>;
  reproduced: number;
};

const ROLE_TAGS: [RegExp, string[]][] = [
  [/\bARCH-\d/, ["review-architecture"]],
  [/\bBOSS-\d/, ["code-boss-reviewer"]],
  [/\bR-FE-\d|\bfrontend \(MobX\)/i, ["review-frontend"]],
  [/\bPERF-\d|\bperformance\b/i, ["review-performance"]],
  [/\bDS-[A-Z]*-?\d|\bdesign-system\b/i, ["review-vantage-design-system"]],
  [/\btesting F-\d|testing-practices/i, ["review-testing-practices", "review-vantage-testing"]],
  [/\bconventions F-\d/i, ["review-frontend-conventions", "review-vantage-frontend"]],
  [/\bdomains F-\d/i, ["review-vantage-domains"]],
  [/\bcode-boss\b/i, ["code-boss-reviewer"]],
];

const EXECUTION_WORDS = /\bmutant|\bmutating|\bmutation|\bsurvive|\bkilled\b|\bprobe\b/i;

function locationsOf(text: string): ReferenceItem["locations"] {
  const found: ReferenceItem["locations"] = [];
  const pattern = /`?([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml))(?::(\d+)(?:-(\d+))?)?`?/g;
  for (const match of text.matchAll(pattern)) {
    const line = match[2] === undefined ? undefined : Number(match[2]);
    found.push({ file: match[1]!, line });
    if (match[3] !== undefined) found.push({ file: match[1]!, line: Number(match[3]) });
  }
  return found;
}

function identifiersOf(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/`([A-Za-z_$][\w$.]{3,})`/g)) {
    const value = match[1]!;
    if (!/\.(tsx?|jsx?|css|md|json)$/.test(value)) ids.add(value.toLowerCase());
  }
  return [...ids];
}

function rolesOf(text: string): string[] {
  const roles = new Set<string>();
  for (const [pattern, names] of ROLE_TAGS) if (pattern.test(text)) for (const name of names) roles.add(name);
  return [...roles];
}

function toItem(id: string, kind: ReferenceItem["kind"], text: string): ReferenceItem {
  return {
    id,
    kind,
    text,
    locations: locationsOf(text),
    identifiers: identifiersOf(text),
    roles: rolesOf(text),
    executionDerived: EXECUTION_WORDS.test(text),
  };
}

/** Reads the item list of a review report: a Major table, Cycle paragraphs, Minor and Question bullets. Later sections are not items. */
export function parseReferenceReport(markdown: string): ReferenceItem[] {
  const items: ReferenceItem[] = [];
  let stop = false;
  for (const line of markdown.split("\n")) {
    if (stop) break;
    if (/pre-existing|verified clean|^<details[^>]*><summary><b>(Coverage|Meta)/i.test(line)) {
      stop = true;
      continue;
    }
    const major = /^\|\s*(M\d+)\s*\|(.*)\|\s*$/.exec(line);
    if (major) {
      items.push(toItem(major[1]!, "major", major[2]!));
      continue;
    }
    const cycle = /^\*\*(C\d+)\.\s*(.*)$/.exec(line);
    if (cycle) {
      items.push(toItem(cycle[1]!, "cycle", cycle[2]!));
      continue;
    }
    const bullet = /^-\s+\*\*([mQ]\d+)\.\s*(.*)$/.exec(line);
    if (bullet) items.push(toItem(bullet[1]!, bullet[1]!.startsWith("Q") ? "question" : "minor", bullet[2]!));
  }
  return items;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function rawReplies(inputDir: string): Promise<EvidenceItem[]> {
  const dir = path.join(inputDir, "raw");
  if (!existsSync(dir)) return [];
  const out: EvidenceItem[] = [];
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".txt")).sort()) {
    out.push({ id: `raw/${name}`, text: await readFile(path.join(dir, name), "utf8") });
  }
  return out;
}

export async function loadPackageEvidence(packageDir: string, inputDir?: string): Promise<PackageEvidence> {
  const findingsRaw = await readJson(path.join(packageDir, "findings.json"));
  const findings: EvidenceItem[] = (Array.isArray(findingsRaw) ? findingsRaw : []).map((f: Record<string, unknown>) => ({
    id: asText(f.id),
    severity: asText(f.severity) || undefined,
    file: asText(f.file) || undefined,
    line: typeof f.line === "number" ? f.line : undefined,
    text: [f.problem, f.impact, f.suggested_fix, f.evidence, f.quote, f.file].map(asText).join("\n"),
  }));
  const canonicalIds = new Set(findings.map((f) => f.id));

  const research = (await readJson(path.join(packageDir, "research.json"))) as Record<string, unknown> | undefined;
  const dispatch = research?.dispatch as Record<string, unknown> | undefined;
  const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object") : []);
  const selected: unknown[] = Array.isArray(dispatch?.selected) ? dispatch.selected : [];
  const ran = new Set<string>(selected.filter((s): s is string => typeof s === "string"));
  for (const run of rows(dispatch?.runs)) {
    if (typeof run.reviewer === "string" && run.status !== "not-run") ran.add(run.reviewer);
  }

  const lost: EvidenceItem[] = [];
  for (const o of rows(research?.obligations)) {
    if (o.status === "finding" && canonicalIds.has(asText(o.finding))) continue;
    lost.push({ id: asText(o.id), text: [o.question, o.evidence, o.reason].map(asText).join("\n") });
  }
  if (inputDir !== undefined) lost.push(...(await rawReplies(inputDir)));

  const evidenceDir = path.join(packageDir, "research-evidence");
  const mutationPass = existsSync(evidenceDir) && (await readdir(evidenceDir)).some((n) => /^mutation/i.test(n));
  return { ran: [...ran].sort(), findings, lost, mutationPass };
}

const LINE_WINDOW = 12;

function score(item: ReferenceItem, evidence: EvidenceItem): number {
  const haystack = evidence.text.toLowerCase();
  let points = 0;
  for (const identifier of item.identifiers) if (haystack.includes(identifier)) points += 1;
  for (const loc of item.locations) {
    const base = path.basename(loc.file).toLowerCase();
    if (!haystack.includes(base)) continue;
    if (loc.line === undefined) { points += 1; continue; }
    const near = [...haystack.matchAll(new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`, "g"))].some(
      (m) => Math.abs(Number(m[1]) - loc.line!) <= LINE_WINDOW,
    ) || (evidence.file !== undefined && path.basename(evidence.file).toLowerCase() === base && evidence.line !== undefined && Math.abs(evidence.line - loc.line) <= LINE_WINDOW);
    points += near ? 2 : 1;
  }
  return points;
}

function best(item: ReferenceItem, pool: readonly EvidenceItem[]): EvidenceItem | undefined {
  let top: EvidenceItem | undefined;
  let topScore = 0;
  for (const evidence of pool) {
    const s = score(item, evidence);
    if (s > topScore) { top = evidence; topScore = s; }
  }
  return topScore >= 2 ? top : undefined;
}

export function compareReference(items: readonly ReferenceItem[], evidence: PackageEvidence): Comparison {
  const ran = new Set(evidence.ran);
  const compared: ComparedItem[] = items.map((item) => {
    const kept = best(item, evidence.findings);
    if (kept) return { item, class: "D", severity: kept.severity, matched: kept.id, detail: `kept as ${kept.id}${kept.severity ? ` (${kept.severity})` : ""}` };
    if (item.executionDerived && !evidence.mutationPass)
      return { item, class: "E", detail: "the reference got this by running a mutant or probe; this package has no mutation pass" };
    const dropped = best(item, evidence.lost);
    if (dropped) return { item, class: "C", matched: dropped.id, detail: `seen in ${dropped.id} and not carried into the findings` };
    if (item.roles.length > 0 && !item.roles.some((role) => ran.has(role)))
      return { item, class: "A", detail: `role not run: ${item.roles.join(" or ")}` };
    return { item, class: "B", detail: item.roles.length > 0 ? "its role ran and raised nothing that matches" : "no matching finding; the role is not named in the reference" };
  });
  const totals: Record<ComparisonClass, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const entry of compared) totals[entry.class] += 1;
  return { items: compared, totals, reproduced: totals.D };
}

export function renderComparison(comparison: Comparison): string {
  const lines = ["id   class  detail"];
  for (const entry of comparison.items) lines.push(`${entry.item.id.padEnd(4)} ${entry.class.padEnd(6)} ${entry.detail}`);
  const t = comparison.totals;
  lines.push(
    "",
    `reproduced ${comparison.reproduced} of ${comparison.items.length}`,
    `A role not run ${t.A} | B role ran, finding absent ${t.B} | C lost after the answer ${t.C} | D kept ${t.D} | E execution pass not run ${t.E}`,
  );
  return lines.join("\n");
}
