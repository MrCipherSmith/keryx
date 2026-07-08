export function renderHealthManifest(): string {
  return `# health

Version: 0.1.0

## Purpose

Aggregates code quality signals (lint, type, tests, coverage, dependency audit),
normalizes findings, computes project/module/file metrics, and produces a
deterministic quality gate report.

## Commands

- \`keryx health run [--strict] [--scope ...] [--source ...]\`
- \`keryx health status\`
- \`keryx health gate [--strict-warn]\`
- \`keryx health sources\`
- \`keryx health explain <file-or-module>\`
- \`keryx health baseline update [--scope ...]\`
- \`keryx health trend [--scope <scope-key>] [--limit <n>]\`

## Config

- \`health.config.json\`

## Data

- \`data/health/artifacts/latest.md\`
- \`data/health/artifacts/latest.json\`
- \`health/baselines/scores.json\`

## Skills

- \`skills/health/\`
`;
}

export function renderHealthCoreReadme(): string {
  return `# health Core

Local Code Health service layer.

Responsibilities:

- run/import quality sources through the \`SourceAdapter\` contract;
- normalize findings into the versioned finding schema;
- compute project/module/file metrics, scoring, and the quality gate;
- write layered outputs (Markdown summary, JSON report, raw logs);
- keep an accept-current baseline for regression detection.

Findings are a decoupled contract: gdskills consumes
\`data/health/artifacts/latest.json\` via \`keryx skills learn --from-health\`.
`;
}

export function renderHealthSkillReadme(): string {
  return `---
name: health
description: Use for code quality state - lint, type, test, coverage, dependency, and complexity health of the project, a module, or a file. Read the health report before claiming quality status or gate results.
---

# health Skill

Use this skill when a task needs the code quality state of the project, a
module, or a file: gate status, findings by priority, regressions, coverage, or
complexity hot-spots.

## Workflow

1. Prefer the curated summary \`.metaproject/data/health/artifacts/latest.md\`.
2. If it is stale or missing, run \`keryx health run\` (add \`--strict\` for CI-grade checks).
3. Use \`keryx health explain <file-or-module>\` for a specific scope.
4. Use \`keryx health gate\` for a CI exit code.
5. Treat findings as signals; verify against source code before acting.

## Commands

\`\`\`bash
keryx health status
keryx health run --strict
keryx health gate --strict-warn
keryx health sources
keryx health explain src/example.ts
keryx health baseline update
\`\`\`

## Notes

- Sources are required or optional; missing required sources fail the gate under \`--strict\`.
- Baseline is accept-current on first run; update it explicitly.
- The report is a versioned contract consumed by gdskills.
`;
}
