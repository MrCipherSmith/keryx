// The two files an autonomous run leaves: `summary.json` for a program, `report.md` for a person.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTONOMOUS_EXIT, AUTONOMOUS_PROFILE_ID, AUTONOMOUS_STATUSES, type AutonomousStatus } from "./autonomous-profile";
import { REVIEW_PACKAGE_STATUSES, type ReviewPackageStatus } from "./types";

export interface FindingCounts {
  blocker: number;
  major: number;
  minor: number;
  info: number;
}

export interface AutonomousSummary {
  readonly schemaVersion: 1;
  readonly profile: typeof AUTONOMOUS_PROFILE_ID;
  readonly target: { readonly kind: "pr"; readonly ref: string; readonly repository: string; readonly number: number; readonly head: string | null };
  readonly status: AutonomousStatus;
  readonly exitCode: number;
  readonly reason: string;
  /** The last phase the run was seen in. */
  readonly phase: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationSeconds: number;
  readonly attempts: number;
  readonly rounds: number;
  readonly tokens: number;
  readonly package: { readonly id: string; readonly status: ReviewPackageStatus; readonly path: string } | null;
  readonly findings: FindingCounts;
  readonly floorRefusals: number;
  readonly autoAnswers: {
    readonly count: number;
    readonly last?: { readonly question: string; readonly answer: string; readonly basis: string };
  };
}

export function countFindings(findings: unknown): FindingCounts {
  const counts: FindingCounts = { blocker: 0, major: 0, minor: 0, info: 0 };
  if (!Array.isArray(findings)) return counts;
  for (const finding of findings) {
    const severity = (finding as { severity?: unknown } | null)?.severity;
    if (severity === "blocker" || severity === "major" || severity === "minor" || severity === "info") counts[severity] += 1;
  }
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isCount = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isText = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/** Every problem with a parsed summary; empty means it honours the schema. */
export function validateSummary(value: unknown): string[] {
  if (!isRecord(value)) return ["summary: must be an object"];
  const problems: string[] = [];
  if (value["schemaVersion"] !== 1) problems.push("schemaVersion: must be 1");
  if (value["profile"] !== AUTONOMOUS_PROFILE_ID) problems.push(`profile: must be ${AUTONOMOUS_PROFILE_ID}`);
  const status = value["status"];
  if (!AUTONOMOUS_STATUSES.includes(status as AutonomousStatus)) {
    problems.push(`status: must be one of ${AUTONOMOUS_STATUSES.join(", ")}`);
  } else if (value["exitCode"] !== AUTONOMOUS_EXIT[status as AutonomousStatus]) {
    problems.push(`exitCode: must be ${AUTONOMOUS_EXIT[status as AutonomousStatus]} for status ${String(status)}`);
  }
  if (typeof value["exitCode"] !== "number") problems.push("exitCode: must be a number");
  for (const key of ["reason", "phase", "startedAt", "finishedAt"]) if (!isText(value[key])) problems.push(`${key}: must be a non-empty string`);
  for (const key of ["durationSeconds", "attempts", "rounds", "tokens", "floorRefusals"]) if (!isCount(value[key])) problems.push(`${key}: must be a non-negative integer`);
  const target = value["target"];
  if (!isRecord(target) || target["kind"] !== "pr" || !isText(target["ref"]) || !isText(target["repository"]) || !isCount(target["number"])) {
    problems.push("target: must be { kind: pr, ref, repository, number, head }");
  } else if (target["head"] !== null && typeof target["head"] !== "string") {
    problems.push("target.head: must be a string or null");
  }
  const pkg = value["package"];
  if (pkg !== null) {
    if (!isRecord(pkg) || !isText(pkg["id"]) || !isText(pkg["path"]) || !REVIEW_PACKAGE_STATUSES.includes(pkg["status"] as ReviewPackageStatus)) {
      problems.push("package: must be null or { id, status, path }");
    }
  }
  const findings = value["findings"];
  if (!isRecord(findings) || !["blocker", "major", "minor", "info"].every((k) => isCount(findings[k]))) {
    problems.push("findings: must count blocker, major, minor and info");
  }
  const answers = value["autoAnswers"];
  if (!isRecord(answers) || !isCount(answers["count"])) problems.push("autoAnswers: must be { count, last? }");
  return problems;
}

export function renderReport(summary: AutonomousSummary): string {
  const { findings } = summary;
  const lines = [
    `# Autonomous review: ${summary.target.ref}`,
    "",
    `- Status: **${summary.status}** (exit ${summary.exitCode})`,
    `- Why: ${summary.reason}`,
    `- Last phase: ${summary.phase}`,
    `- Head: ${summary.target.head ?? "not resolved"}`,
    `- Started ${summary.startedAt}, finished ${summary.finishedAt} (${summary.durationSeconds} s, attempt ${summary.attempts})`,
    `- Rounds: ${summary.rounds}, tokens: ${summary.tokens}`,
    `- Package: ${summary.package === null ? "none opened" : `${summary.package.id} (${summary.package.status}) at ${summary.package.path}`}`,
    `- Findings: ${findings.blocker} blocker, ${findings.major} major, ${findings.minor} minor, ${findings.info} info`,
    `- Refusals at a floor: ${summary.floorRefusals}`,
    `- Questions answered automatically: ${summary.autoAnswers.count}`,
  ];
  if (summary.autoAnswers.last !== undefined) {
    const last = summary.autoAnswers.last;
    lines.push(`- Last automatic answer: "${last.question}" -> ${last.answer} (${last.basis})`);
  }
  if (summary.status !== "complete") {
    lines.push("", "The package is kept. Start the same command again on the same head to resume it.");
  }
  return `${lines.join("\n")}\n`;
}

function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

export function writeSummary(dir: string, summary: AutonomousSummary): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeAtomic(path.join(dir, "report.md"), renderReport(summary));
}
