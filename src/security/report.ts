import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { securityDataRoot } from "./config";
import type {
  SecurityConfig,
  SecurityFinding,
  SecurityGate,
  SecurityReport,
  SecurityReportSummary,
} from "./types";

const SCHEMA_VERSION = 1;

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function summarize(findings: SecurityFinding[]): SecurityReportSummary {
  return {
    total: findings.length,
    bySeverity: tally(findings.map((f) => f.severity)),
    byAction: tally(findings.map((f) => f.action)),
    byCategory: tally(findings.map((f) => f.category)),
  };
}

export function buildReport(
  findings: SecurityFinding[],
  config: SecurityConfig,
  gate: SecurityGate,
  createdAt: string = new Date().toISOString(),
): SecurityReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    mode: config.mode,
    gate,
    rawRetention: config.rawRetention,
    summary: summarize(findings),
    findings,
  };
}

// Strip fields that must never reach a committable artifact (§10a): `hash`
// (even keyed) and any raw value. Findings keep only policy ids, categories,
// severities, masked previews, locations and actions.
function toCommittableFinding(finding: SecurityFinding): SecurityFinding {
  const { hash, ...safe } = finding;
  void hash;
  return safe;
}

export function toCommittableReport(report: SecurityReport): SecurityReport {
  return {
    ...report,
    findings: report.findings.map(toCommittableFinding),
  };
}

export function renderReportMarkdown(report: SecurityReport): string {
  const top = [...report.findings]
    .sort((a, b) => severityRank(b) - severityRank(a))
    .slice(0, 15);

  const counts = (record: Record<string, number>): string => {
    const entries = Object.entries(record);
    return entries.length > 0
      ? entries.map(([k, v]) => `${k}: ${v}`).join(", ")
      : "none";
  };

  return `# Metaproject Security Report

Gate: **${report.gate.toUpperCase()}**
Generated: ${report.createdAt}
Mode: ${report.mode}
Raw retention: ${report.rawRetention}
Schema: ${report.schemaVersion}

## Summary

- total findings: ${report.summary.total}
- by severity: ${counts(report.summary.bySeverity)}
- by action: ${counts(report.summary.byAction)}
- by category: ${counts(report.summary.byCategory)}

## Top Findings

${renderFindings(top)}

> Committable artifacts contain no secret/PII hashes or raw values — only policy
> ids, categories, severities, masked previews, locations and actions.
`;
}

function severityRank(finding: SecurityFinding): number {
  const order: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  return order[finding.severity] ?? 0;
}

function renderFindings(findings: SecurityFinding[]): string {
  if (findings.length === 0) {
    return "- none";
  }
  return findings
    .map((f) => {
      const loc = f.location?.line ? ` (line ${f.location.line})` : "";
      const preview = f.redactedPreview ? ` — ${f.redactedPreview}` : "";
      return `- [${f.severity}] ${f.category}/${f.policyId} → ${f.action}${loc}${preview}`;
    })
    .join("\n");
}

export function artifactsDir(cwd: string): string {
  return path.join(securityDataRoot(cwd), "artifacts");
}

// Write the committable artifacts (latest.md / latest.json). When `storeHashes`
// is enabled a full local-only report (with HMAC hashes) is written under raw/,
// which is gitignored and never committed.
export async function writeSecurityArtifacts(
  cwd: string,
  report: SecurityReport,
  config: SecurityConfig,
): Promise<{ markdownPath: string; jsonPath: string }> {
  const dir = artifactsDir(cwd);
  await mkdir(dir, { recursive: true });

  const committable = toCommittableReport(report);
  const markdown = path.join(dir, "latest.md");
  const json = path.join(dir, "latest.json");
  await writeFile(markdown, renderReportMarkdown(committable), "utf8");
  await writeFile(json, `${JSON.stringify(committable, null, 2)}\n`, "utf8");

  if (config.storeHashes) {
    const rawDir = path.join(securityDataRoot(cwd), "raw");
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      path.join(rawDir, "report.local.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    markdownPath: path.relative(cwd, markdown),
    jsonPath: path.relative(cwd, json),
  };
}
