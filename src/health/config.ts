import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { HealthConfig } from "./types";

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  schemaVersion: 1,
  sources: {
    eslint: { mode: "auto", required: true },
    typescript: { mode: "auto", required: true },
    tests: { mode: "auto", required: false },
    coverage: { mode: "import", required: false },
    dependencyAudit: { mode: "auto", required: false },
    sonarqube: { mode: "disabled", required: false },
    complexity: { mode: "auto", required: false },
  },
  metrics: {
    coverageTarget: 80,
    coverageSoftFloor: 60,
    complexityThreshold: 10,
    churnWindowDays: 90,
  },
  scoring: {
    priorityWeights: { P0: 100, P1: 20, P2: 5, P3: 1 },
    coverageWeight: 1,
    complexityWeight: 2,
    normalizePerLoc: 1000,
  },
  gate: {
    failOnPriorities: ["P0"],
    failOnRegressionDrop: 10,
    warnOnRegressionDrop: 3,
    failOnMissingRequiredSource: true,
  },
};

export function configPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "health.config.json");
}

export async function loadHealthConfig(cwd: string): Promise<HealthConfig> {
  const file = configPath(cwd);
  if (!(await pathExists(file))) {
    return DEFAULT_HEALTH_CONFIG;
  }

  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<HealthConfig>;
  const base = DEFAULT_HEALTH_CONFIG;
  return {
    schemaVersion: parsed.schemaVersion ?? base.schemaVersion,
    sources: { ...base.sources, ...(parsed.sources ?? {}) },
    metrics: { ...base.metrics, ...(parsed.metrics ?? {}) },
    scoring: {
      ...base.scoring,
      ...(parsed.scoring ?? {}),
      priorityWeights: {
        ...base.scoring.priorityWeights,
        ...(parsed.scoring?.priorityWeights ?? {}),
      },
    },
    gate: { ...base.gate, ...(parsed.gate ?? {}) },
  };
}

export function renderHealthConfig(): string {
  return `${JSON.stringify(DEFAULT_HEALTH_CONFIG, null, 2)}\n`;
}
