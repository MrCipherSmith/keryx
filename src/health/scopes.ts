import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { moduleOfFile } from "./util";
import { computeComplexity } from "./metrics/complexity";
import {
  complexityPenalty,
  coveragePenalty,
  healthScore,
  regressionScore,
  riskScore,
  trendOf,
} from "./scoring";
import type { CoverageData } from "./metrics/coverage";
import type { BaselineEntry } from "./baseline";
import type { SkillOwnership } from "./skills";
import type {
  Finding,
  HealthConfig,
  Priority,
  ScopeKind,
  ScopeMetrics,
  ScopeSelector,
  Severity,
} from "./types";

const SEVERITIES: Severity[] = ["error", "warning", "info"];
const PRIORITIES: Priority[] = ["P0", "P1", "P2", "P3"];

export async function computeMetrics(input: {
  cwd: string;
  config: HealthConfig;
  findings: Finding[];
  sourceFiles: string[];
  coverage: CoverageData;
  churn: Map<string, number>;
  baseline: Map<string, BaselineEntry>;
  ownership?: SkillOwnership;
  scopeSelector?: ScopeSelector;
}): Promise<ScopeMetrics[]> {
  const { cwd, config, findings, sourceFiles, coverage, churn, baseline, ownership, scopeSelector } = input;

  const locByFile = new Map<string, number>();
  const complexityByFile = new Map<string, number[]>();
  for (const file of sourceFiles) {
    const abs = path.join(cwd, file);
    if (!(await pathExists(abs))) {
      continue;
    }
    const content = await readFile(abs, "utf8");
    locByFile.set(file, content.split("\n").length);
    complexityByFile.set(file, computeComplexity(content).functions);
  }

  const build = (
    kind: ScopeKind,
    key: string,
    name: string,
    files: string[],
    scopeFindings: Finding[],
    coverageValue: number | null,
  ): ScopeMetrics => {
    const loc = files.reduce((sum, file) => sum + (locByFile.get(file) ?? 0), 0);
    const churnValue = files.reduce(
      (sum, file) => sum + (churn.get(file) ?? 0),
      0,
    );
    const fnComplexities = files.flatMap(
      (file) => complexityByFile.get(file) ?? [],
    );
    const above = fnComplexities.filter(
      (value) => value > config.metrics.complexityThreshold,
    );

    const bySeverity = countBy(scopeFindings, (f) => f.severity, SEVERITIES);
    const byPriority = countBy(scopeFindings, (f) => f.priority, PRIORITIES);
    const bySource = tally(scopeFindings.map((f) => f.source));

    const risk = riskScore(byPriority, config.scoring.priorityWeights);
    const health = healthScore(
      {
        risk,
        coverage: coveragePenalty(coverageValue, config),
        complexity: complexityPenalty(fnComplexities, config),
        loc,
      },
      config,
    );
    const baseHealth = baseline.get(key)?.health_score ?? null;

    return {
      key,
      kind,
      name,
      loc,
      findingCounts: { total: scopeFindings.length, bySeverity, byPriority, bySource },
      coverage: coverageValue,
      churn: churn.size > 0 ? churnValue : null,
      complexity:
        fnComplexities.length > 0
          ? { max: Math.max(...fnComplexities), aboveThreshold: above.length }
          : null,
      health_score: health,
      risk_score: risk,
      trend: trendOf(health, baseHealth),
      regression_score: regressionScore(health, baseHealth),
    };
  };

  const scopes: ScopeMetrics[] = [];

  scopes.push(
    build("project", "project", "project", sourceFiles, findings, coverage.total),
  );

  const modules = new Map<string, string[]>();
  for (const file of sourceFiles) {
    const name = moduleOfFile(file);
    if (!name) {
      continue;
    }
    modules.set(name, [...(modules.get(name) ?? []), file]);
  }
  for (const [name, files] of [...modules.entries()].sort()) {
    const modFindings = findings.filter(
      (f) => f.file && moduleOfFile(f.file) === name,
    );
    scopes.push(
      build(
        "module",
        `module:${name}`,
        name,
        files,
        modFindings,
        averageCoverage(files, coverage),
      ),
    );
  }

  // Component scopes: directory-level granularity below the module (e.g.
  // src/health/metrics). Only emitted for nested directories that differ from
  // their module. Semantic entity/store detection is deferred to Phase 3.
  const components = new Map<string, string[]>();
  for (const file of sourceFiles) {
    const dir = path.posix.dirname(file);
    if (dir === "." || dir === moduleOfFile(file)) {
      continue;
    }
    components.set(dir, [...(components.get(dir) ?? []), file]);
  }
  for (const [name, files] of [...components.entries()].sort()) {
    const compFindings = findings.filter(
      (f) => f.file && path.posix.dirname(f.file) === name,
    );
    scopes.push(
      build(
        "component",
        `component:${name}`,
        name,
        files,
        compFindings,
        averageCoverage(files, coverage),
      ),
    );
  }

  const findingFiles = findings.map((f) => f.file).filter((f): f is string => Boolean(f));
  const scopedFiles =
    scopeSelector?.kind === "file" && sourceFiles.includes(scopeSelector.path)
      ? [scopeSelector.path]
      : [];
  const filesToReport = [...new Set([...findingFiles, ...scopedFiles])].sort();
  for (const file of filesToReport) {
    scopes.push(
      build(
        "file",
        `file:${file}`,
        file,
        [file],
        findings.filter((f) => f.file === file),
        coverage.byFile.get(file) ?? null,
      ),
    );
  }

  if (ownership) {
    for (const skill of ownership.skills) {
      const ownedFiles = sourceFiles.filter(
        (file) => ownership.skillForFile(file) === skill,
      );
      if (ownedFiles.length === 0) {
        continue;
      }
      scopes.push(
        build(
          "skill",
          `skill:${skill}`,
          skill,
          ownedFiles,
          findings.filter((f) => f.scope.skill === skill),
          averageCoverage(ownedFiles, coverage),
        ),
      );
    }
  }

  return scopes;
}

function averageCoverage(
  files: string[],
  coverage: CoverageData,
): number | null {
  const values = files
    .map((file) => coverage.byFile.get(file))
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) {
    return null;
  }
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function countBy<T, K extends string>(
  items: T[],
  key: (item: T) => K,
  keys: K[],
): Record<K, number> {
  const result = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const item of items) {
    result[key(item)] += 1;
  }
  return result;
}

function tally(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}
