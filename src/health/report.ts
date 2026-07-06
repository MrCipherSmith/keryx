import type {
  Finding,
  HealthConfig,
  HealthReport,
  Priority,
  ScopeMetrics,
} from "./types";

const PRIORITY_ORDER: Priority[] = ["P0", "P1", "P2", "P3"];

export function renderReportMarkdown(
  report: HealthReport,
  _config: HealthConfig,
): string {
  const project = report.metrics.find((m) => m.key === "project");
  const top = [...report.findings]
    .sort(
      (a, b) =>
        PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
    )
    .slice(0, 15);

  return `# Code Health

Gate: **${report.gate.status.toUpperCase()}**
Generated: ${report.generatedAt}
Scope: ${report.scope}${report.strict ? " (strict)" : ""}
Git: ${report.gitRef ?? "n/a"}
Schema: ${report.schemaVersion}

## Gate Reasons

${report.gate.reasons.map((r) => `- ${r}`).join("\n") || "- none"}

## Score Summary

${renderProject(project)}

## Sources

| Source | Status | Mode | Required | Findings | Tool |
|--------|--------|------|----------|----------|------|
${report.sources
  .map(
    (s) =>
      `| ${s.source} | ${s.status} | ${s.mode} | ${s.required ? "yes" : "no"} | ${s.findings} | ${s.toolVersion ?? "-"} |`,
  )
  .join("\n")}

## Top Findings

${renderFindings(top)}

## Affected Scopes

${renderAffected(report.metrics)}

## Skill Scopes

${renderSkills(report.metrics)}

## Next Action

${renderNextAction(report)}
`;
}

function renderProject(project: ScopeMetrics | undefined): string {
  if (!project) {
    return "- No project metrics.";
  }
  const complexity = project.complexity
    ? `max ${project.complexity.max}, ${project.complexity.aboveThreshold} above threshold`
    : "n/a";
  return [
    `- health_score: **${project.health_score}** (trend: ${project.trend}, regression: ${project.regression_score})`,
    `- risk_score: ${project.risk_score}`,
    `- findings: ${project.findingCounts.total} (P0 ${project.findingCounts.byPriority.P0}, P1 ${project.findingCounts.byPriority.P1}, P2 ${project.findingCounts.byPriority.P2})`,
    `- coverage: ${project.coverage ?? "n/a"}${typeof project.coverage === "number" ? "%" : ""}`,
    `- churn: ${project.churn ?? "n/a"}`,
    `- complexity: ${complexity}`,
    `- loc: ${project.loc}`,
  ].join("\n");
}

function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return "- none";
  }
  return findings
    .map(
      (f) =>
        `- [${f.priority}] ${f.source}: ${f.message}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`,
    )
    .join("\n");
}

function renderAffected(metrics: ScopeMetrics[]): string {
  const modules = metrics
    .filter((m) => m.kind === "module" && m.findingCounts.total > 0)
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, 10);
  if (modules.length === 0) {
    return "- none";
  }
  return modules
    .map(
      (m) =>
        `- ${m.name}: score ${m.health_score}, findings ${m.findingCounts.total}, risk ${m.risk_score}`,
    )
    .join("\n");
}

function renderSkills(metrics: ScopeMetrics[]): string {
  const skills = metrics
    .filter((m) => m.kind === "skill")
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, 10);
  if (skills.length === 0) {
    return "- none (no project-skills own findings)";
  }
  return skills
    .map(
      (m) =>
        `- ${m.name}: score ${m.health_score}, findings ${m.findingCounts.total}, risk ${m.risk_score}`,
    )
    .join("\n");
}

function renderNextAction(report: HealthReport): string {
  if (report.gate.status === "fail") {
    return "Resolve P0 findings and regressions before merging.";
  }
  if (report.gate.status === "warn") {
    return "Review warnings; address regressions and low-coverage scopes.";
  }
  return "No blocking issues. Keep the baseline updated with `gd-metapro health baseline update`.";
}
