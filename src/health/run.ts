import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadHealthConfig } from "./config";
import { computeGate } from "./gate";
import { computeMetrics } from "./scopes";
import { loadBaseline, writeBaseline } from "./baseline";
import { getChurn } from "./metrics/churn";
import { getComplexityFindings } from "./metrics/complexity-findings";
import { getCoverage } from "./metrics/coverage";
import { renderReportMarkdown } from "./report";
import { loadSkillOwnership } from "./skills";
import { FINDING_ADAPTERS, NoImportError } from "./sources";
import {
  commandExists,
  dataRoot,
  listSourceFiles,
  moduleOfFile,
  runCommand,
  writeRaw,
} from "./util";
import type {
  Finding,
  HealthConfig,
  HealthContext,
  HealthReport,
  HealthRunInput,
  HealthRunResult,
  RawSourceResult,
  ScopeSelector,
  SourceAdapter,
  SourceConfig,
  SourceRunInfo,
} from "./types";

export async function runHealth(input: HealthRunInput): Promise<HealthRunResult> {
  const cwd = input.cwd;
  const config = await loadHealthConfig(cwd);
  const selector: ScopeSelector = input.scope ?? { kind: "project" };
  const strict = input.strict ?? false;
  const sourceFiles = await listSourceFiles(cwd);
  const changedFiles = await resolveChanged(cwd, selector);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const ctx: HealthContext = {
    cwd,
    config,
    strict,
    scopeSelector: selector,
    changedFiles,
    sourceFiles,
    moduleOf: moduleOfFile,
  };

  const filter = input.sources ? new Set(input.sources) : null;
  const sourceInfos: SourceRunInfo[] = [];
  const findings: Finding[] = [];

  for (const adapter of FINDING_ADAPTERS) {
    if (filter && !filter.has(adapter.id)) {
      continue;
    }
    const cfg = config.sources[adapter.id] ?? { mode: "auto", required: false };
    const outcome = await runAdapter(adapter, ctx, cfg, stamp);
    sourceInfos.push(outcome.info);
    findings.push(...outcome.findings);
  }

  const coverage = await getCoverage(cwd);
  if (!filter || filter.has("coverage")) {
    const cfg = config.sources.coverage ?? { mode: "import", required: false };
    sourceInfos.push({
      source: "coverage",
      status: cfg.mode === "disabled" ? "skipped" : coverage.status,
      mode: cfg.mode,
      required: cfg.required,
      imported: true,
      command: null,
      toolVersion: null,
      findings: 0,
    });
  }
  if (!filter || filter.has("complexity")) {
    const cfg = config.sources.complexity ?? { mode: "auto", required: false };
    const enabled = cfg.mode !== "disabled" && sourceFiles.length > 0;
    const complexityFindings = enabled
      ? await getComplexityFindings(cwd, sourceFiles, config)
      : [];
    findings.push(...complexityFindings);
    sourceInfos.push({
      source: "complexity",
      status: cfg.mode === "disabled" ? "skipped" : sourceFiles.length > 0 ? "available" : "skipped",
      mode: cfg.mode,
      required: cfg.required,
      imported: false,
      command: "builtin: cyclomatic (token-based)",
      toolVersion: null,
      findings: complexityFindings.length,
    });
  }
  // sonarqube is a real adapter now (handled in the FINDING_ADAPTERS loop).

  // Tag findings with the owning project-skill (gdskills registry) so the
  // report and gdskills `learn --from-health` can work per skill.
  const ownership = await loadSkillOwnership(cwd);
  for (const finding of findings) {
    if (finding.file) {
      finding.scope.skill = ownership.skillForFile(finding.file);
    }
  }

  const churn = await getChurn(cwd, config.metrics.churnWindowDays);
  const baseline = await loadBaseline(cwd);
  const metrics = await computeMetrics({
    cwd,
    config,
    findings,
    sourceFiles,
    coverage,
    churn,
    baseline,
    ownership,
    scopeSelector: selector,
  });
  const projectMetrics = metrics.find((m) => m.key === "project");
  const gate = computeGate({
    findings,
    projectMetrics,
    sources: sourceInfos,
    config,
    strict,
  });

  const report: HealthReport = {
    schemaVersion: config.schemaVersion,
    generatedAt: new Date().toISOString(),
    scope: describeSelector(selector),
    strict,
    gitRef: await currentGitRef(cwd),
    gate,
    sources: sourceInfos,
    metrics,
    findings,
  };

  const paths = await writeOutputs(cwd, report, config, stamp);

  // Accept-current baseline on the first run (none exists yet).
  if (baseline.size === 0) {
    await writeBaseline(cwd, metrics, report.generatedAt);
  }

  return { report, markdownPath: paths.markdownPath, jsonPath: paths.jsonPath };
}

async function runAdapter(
  adapter: SourceAdapter,
  ctx: HealthContext,
  cfg: SourceConfig,
  stamp: string,
): Promise<{ info: SourceRunInfo; findings: Finding[] }> {
  const base = {
    source: adapter.id,
    mode: cfg.mode,
    required: cfg.required,
    imported: false,
    command: null,
    toolVersion: null,
    findings: 0,
  };

  if (cfg.mode === "disabled") {
    return { info: { ...base, status: "skipped" }, findings: [] };
  }

  const status = await adapter.detect(ctx);
  if (status === "skipped" || status === "missing") {
    return { info: { ...base, status }, findings: [] };
  }

  let raw: RawSourceResult;
  try {
    if (cfg.mode === "import") {
      raw = await adapter.import(ctx);
    } else if (cfg.mode === "run") {
      raw = await adapter.run(ctx);
    } else {
      try {
        raw = await adapter.import(ctx);
      } catch (error) {
        if (error instanceof NoImportError) {
          if (ctx.strict) {
            return { info: { ...base, status: "missing" }, findings: [] };
          }
          raw = await adapter.run(ctx);
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    return {
      info: {
        ...base,
        status: "configured-but-failed",
        error: error instanceof Error ? error.message : String(error),
      },
      findings: [],
    };
  }

  const rawPath = await writeRaw(ctx.cwd, adapter.id, raw.content, stamp);
  const findings = adapter.parse({ ...raw, rawPath }, ctx);
  return {
    info: {
      ...base,
      status: "available",
      imported: raw.imported,
      command: raw.command,
      toolVersion: raw.toolVersion,
      findings: findings.length,
    },
    findings,
  };
}

async function writeOutputs(
  cwd: string,
  report: HealthReport,
  config: HealthConfig,
  stamp: string,
): Promise<{ markdownPath: string; jsonPath: string }> {
  const artifacts = path.join(dataRoot(cwd), "artifacts");
  const history = path.join(dataRoot(cwd), "history");
  await mkdir(artifacts, { recursive: true });
  await mkdir(history, { recursive: true });

  const markdown = path.join(artifacts, "latest.md");
  const json = path.join(artifacts, "latest.json");
  const historyJson = path.join(history, `${stamp}.json`);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  await writeFile(markdown, renderReportMarkdown(report, config), "utf8");
  await writeFile(json, serialized, "utf8");
  await writeFile(historyJson, serialized, "utf8");

  return {
    markdownPath: path.relative(cwd, markdown),
    jsonPath: path.relative(cwd, json),
  };
}

async function resolveChanged(
  cwd: string,
  selector: ScopeSelector,
): Promise<string[] | null> {
  if (selector.kind !== "changed" || !commandExists("git")) {
    return null;
  }
  const ref = selector.since ?? "HEAD";
  const result = await runCommand(
    ["git", "diff", "--name-only", ref],
    cwd,
  );
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function currentGitRef(cwd: string): Promise<string | null> {
  if (!commandExists("git")) {
    return null;
  }
  const result = await runCommand(["git", "rev-parse", "--short", "HEAD"], cwd);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function describeSelector(selector: ScopeSelector): string {
  switch (selector.kind) {
    case "project":
      return "project";
    case "module":
      return `module:${selector.name}`;
    case "file":
      return `file:${selector.path}`;
    case "changed":
      return `changed:${selector.since ?? "HEAD"}`;
  }
}
