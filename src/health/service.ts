import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { loadHealthConfig } from "./config";
import { runHealth } from "./run";
import { writeBaseline } from "./baseline";
import { getCoverage } from "./metrics/coverage";
import { FINDING_ADAPTERS } from "./sources";
import { dataRoot, listSourceFiles, moduleOfFile } from "./util";
import type {
  CodeHealthService,
  HealthBaselineInput,
  HealthBaselineResult,
  HealthContext,
  HealthExplainInput,
  HealthExplainResult,
  HealthGateInput,
  HealthGateResult,
  HealthReport,
  HealthSourcesInput,
  HealthSourcesResult,
  HealthStatusInput,
  HealthStatusResult,
  SourceStatus,
} from "./types";

async function readLatest(cwd: string): Promise<HealthReport | null> {
  const file = path.join(dataRoot(cwd), "artifacts", "latest.json");
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as HealthReport;
  } catch {
    return null;
  }
}

async function detectStatuses(cwd: string): Promise<HealthSourcesResult> {
  const config = await loadHealthConfig(cwd);
  const sourceFiles = await listSourceFiles(cwd);
  const ctx: HealthContext = {
    cwd,
    config,
    strict: false,
    scopeSelector: { kind: "project" },
    changedFiles: null,
    sourceFiles,
    moduleOf: moduleOfFile,
  };

  const sources: HealthSourcesResult["sources"] = [];
  for (const adapter of FINDING_ADAPTERS) {
    const cfg = config.sources[adapter.id] ?? { mode: "auto", required: false };
    const status: SourceStatus =
      cfg.mode === "disabled" ? "skipped" : await adapter.detect(ctx);
    sources.push({ source: adapter.id, mode: cfg.mode, required: cfg.required, status });
  }

  const coverage = await getCoverage(cwd);
  const covCfg = config.sources.coverage ?? { mode: "import", required: false };
  sources.push({
    source: "coverage",
    mode: covCfg.mode,
    required: covCfg.required,
    status: covCfg.mode === "disabled" ? "skipped" : coverage.status,
  });

  const cxCfg = config.sources.complexity ?? { mode: "auto", required: false };
  sources.push({
    source: "complexity",
    mode: cxCfg.mode,
    required: cxCfg.required,
    status: cxCfg.mode === "disabled" ? "skipped" : sourceFiles.length > 0 ? "available" : "skipped",
  });

  const snCfg = config.sources.sonarqube ?? { mode: "disabled", required: false };
  sources.push({
    source: "sonarqube",
    mode: snCfg.mode,
    required: snCfg.required,
    status: snCfg.mode === "disabled" ? "skipped" : "missing",
  });

  return { sources };
}

export function createCodeHealthService(): CodeHealthService {
  return {
    run: (input) => runHealth(input),

    async status(input: HealthStatusInput): Promise<HealthStatusResult> {
      const enabled = await pathExists(
        path.join(input.cwd, ".metaproject", "health.config.json"),
      );
      const latest = await readLatest(input.cwd);
      const project = latest?.metrics.find((m) => m.key === "project") ?? null;
      const regressions = latest
        ? latest.metrics.filter((m) => m.regression_score > 0).length
        : 0;
      return {
        enabled,
        lastRunAt: latest?.generatedAt ?? null,
        gate: latest?.gate.status ?? null,
        sources:
          latest?.sources.map((s) => ({ source: s.source, status: s.status })) ??
          [],
        projectScore: project?.health_score ?? null,
        regressions,
      };
    },

    async gate(input: HealthGateInput): Promise<HealthGateResult> {
      const latest = await readLatest(input.cwd);
      if (!latest) {
        return {
          status: "fail",
          exitCode: 1,
          reasons: ["no report; run `gd-metapro health run` first"],
        };
      }
      const status = latest.gate.status;
      const exitCode =
        status === "fail" || (status === "warn" && input.strictWarn) ? 1 : 0;
      return { status, exitCode, reasons: latest.gate.reasons };
    },

    sources: (input: HealthSourcesInput) => detectStatuses(input.cwd),

    async explain(input: HealthExplainInput): Promise<HealthExplainResult> {
      const latest = await readLatest(input.cwd);
      if (!latest) {
        return { target: input.target, found: false, metrics: null, findings: [] };
      }
      const target = input.target;
      const metric =
        latest.metrics.find(
          (m) =>
            m.key === target ||
            m.name === target ||
            m.key === `module:${target}` ||
            m.key === `file:${target}`,
        ) ?? null;
      const findings = latest.findings.filter(
        (f) =>
          f.file === target ||
          f.scope.module === target ||
          (metric?.kind === "module" && f.scope.module === metric.name) ||
          (metric?.kind === "file" && f.file === metric.name),
      );
      return {
        target,
        found: metric !== null,
        metrics: metric,
        findings,
      };
    },

    async updateBaseline(
      input: HealthBaselineInput,
    ): Promise<HealthBaselineResult> {
      const cwd = input.cwd;
      let latest = await readLatest(cwd);
      if (!latest) {
        const result = await runHealth({ cwd });
        latest = result.report;
      }
      const generatedAt = new Date().toISOString();
      const updated = await writeBaseline(
        cwd,
        latest.metrics,
        generatedAt,
        input.scope,
      );
      return {
        updated,
        path: ".metaproject/health/baselines/scores.json",
      };
    },
  };
}
