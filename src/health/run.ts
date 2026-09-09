import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { collectGitProvenance } from "../metrics/provenance";
import { loadHealthConfig } from "./config";
import { computeGate } from "./gate";
import { computeMetrics } from "./scopes";
import { loadBaseline, writeBaseline } from "./baseline";
import { getChurn } from "./metrics/churn";
import { rankHotspots } from "./metrics/hotspot";
import { readWikiFreshnessMetric } from "./metrics/wiki-freshness";
import { getComplexityFindings } from "./metrics/complexity-findings";
import { getCoverage } from "./metrics/coverage";
import { renderReportMarkdown } from "./report";
import { loadSkillOwnership } from "./skills";
import { analyzeSourceFiles } from "./source-analysis";
import { FINDING_ADAPTERS, NoImportError } from "./sources";
import { makeFinding } from "./sources/helpers";
import {
  commandExists,
  dataRoot,
  listSourceFilesWithReasons,
  matchesAnyPattern,
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
  const { files: sourceFiles, incompleteReasons: sourceFileIncompleteReasons } =
    await listSourceFilesWithReasons(cwd, config.ignore.paths);
  const sourceAnalysis = await analyzeSourceFiles(cwd, sourceFiles);
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

  // AFC-09 (flow 234 T26): the project-wide source-file walk above survives
  // an unreadable subdirectory now, but a directory it could not read must
  // never be silently indistinguishable from a directory with no source
  // files -- that would let this run report clean coverage over a tree it
  // never actually saw. Mirrors `tests.ts`'s own `tests-context-incomplete`
  // finding (same rule-key shape, same P0/error, same blocking-priority
  // convention) for the identical problem one layer over
  // (`src/testing/service.ts`'s `listProjectFiles`/`walk`).
  if (sourceFileIncompleteReasons.length > 0) {
    findings.push(
      makeFinding({
        source: "sourceFiles",
        severity: "error",
        priority: "P0",
        category: "source-discovery",
        message: `Source file discovery is incomplete, so this run cannot certify full-tree coverage: ${sourceFileIncompleteReasons.join("; ")}`,
        ruleKey: "source-files-incomplete",
        file: null,
        line: null,
        suggestedAction: "Make the listed paths readable (fix permissions or remove the obstruction), then re-run `keryx health run`.",
        command: null,
        toolVersion: null,
        rawLog: null,
      }),
    );
  }

  const adapterOutcomes = await Promise.all(
    FINDING_ADAPTERS.map((adapter) => {
      const cfg = config.sources[adapter.id] ?? { mode: "auto", required: false };
      if (filter && !filter.has(adapter.id)) {
        return filteredOutcome(adapter.id, cfg);
      }
      return runAdapter(adapter, ctx, cfg, stamp);
    }),
  );
  for (const outcome of adapterOutcomes) {
    const filteredFindings = filterIgnoredFindings(outcome.findings, config);
    sourceInfos.push({ ...outcome.info, findings: filteredFindings.length });
    findings.push(...filteredFindings);
  }

  const coverage = await getCoverage(cwd);
  const coverageCfg = config.sources.coverage ?? { mode: "import", required: false };
  if (filter && !filter.has("coverage")) {
    if (coverageCfg.required) sourceInfos.push(filteredInfo("coverage", coverageCfg));
  } else {
    const cfg = coverageCfg;
    const status = cfg.mode === "disabled" ? "skipped" : coverage.status;
    sourceInfos.push({
      source: "coverage",
      status,
      mode: cfg.mode,
      required: cfg.required,
      imported: true,
      command: null,
      toolVersion: null,
      findings: 0,
      execution: status === "available" ? "completed" : "not-run",
      parse: status === "available" ? "parsed" : "not-run",
      exitCode: null,
    });
  }
  const complexityCfg = config.sources.complexity ?? { mode: "auto", required: false };
  if (filter && !filter.has("complexity")) {
    if (complexityCfg.required) sourceInfos.push(filteredInfo("complexity", complexityCfg));
  } else {
    const cfg = complexityCfg;
    const enabled = cfg.mode !== "disabled" && sourceFiles.length > 0;
    const complexityFindings = enabled
      ? await getComplexityFindings(cwd, sourceFiles, config, sourceAnalysis)
      : [];
    const filteredComplexityFindings = filterIgnoredFindings(complexityFindings, config);
    findings.push(...filteredComplexityFindings);
    sourceInfos.push({
      source: "complexity",
      status: cfg.mode === "disabled" ? "skipped" : sourceFiles.length > 0 ? "available" : "skipped",
      mode: cfg.mode,
      required: cfg.required,
      imported: false,
      command: "builtin: cyclomatic (token-based)",
      toolVersion: null,
      findings: filteredComplexityFindings.length,
      execution: enabled ? "completed" : "not-run",
      parse: enabled ? "parsed" : "not-run",
      exitCode: null,
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
    sourceAnalysis,
  });
  const projectMetrics = metrics.find((m) => m.key === "project");
  const gate = computeGate({
    findings,
    projectMetrics,
    sources: sourceInfos,
    config,
    strict,
  });

  // D1: project-level hotspot ranking (churn×complexity, desc). Additive and
  // nullable; deterministic (reuses the already-loaded churn + source analysis).
  const hotspots = rankHotspots(sourceFiles, churn, sourceAnalysis);
  // LWG-15: read the LAST freshness report; never recompute here. Running a
  // graph traversal inside `health run` would make a fast command slow and
  // couple two subsystems that today share only a file. An absent or damaged
  // report yields a not-measured status, never a number.
  const wikiFreshness = await readWikiFreshnessMetric(cwd);

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
    hotspots,
    wikiFreshness,
    ...(input.runId
      ? {
          runId: input.runId,
          provenance: input.provenance ?? await collectGitProvenance(cwd),
        }
      : {}),
  };

  const paths = await writeOutputs(cwd, report, config, stamp);

  // Accept-current baseline on the first run (none exists yet).
  if (baseline.size === 0) {
    await writeBaseline(cwd, metrics, report.generatedAt);
  }

  return { report, markdownPath: paths.markdownPath, jsonPath: paths.jsonPath };
}

function filterIgnoredFindings(findings: Finding[], config: HealthConfig): Finding[] {
  return findings.filter((finding) => {
    if (!finding.file) {
      return true;
    }
    return !matchesAnyPattern(finding.file, config.ignore.paths);
  });
}

// T62 F-005: `SourceRunInfo.error` flows into `computeGate`'s reasons
// (`gate.ts:78-79`), which are written into the committable
// `.metaproject/data/health/artifacts/latest.json` and, through the flow
// completion gate, into `flow.json`'s durable history. A caught
// `error.message` is unconstrained free text and routinely embeds an
// absolute filesystem path (adapters here read config files, spawn tools,
// and parse their output). `safeErrorCode` mirrors
// `src/flow/review-gate.ts`'s `safeFsErrorCode` (duplicated, not imported --
// that module is a different ownership boundary): it surfaces only a Node
// errno-shaped code (`ENOENT`, `EACCES`, ...), a closed, non-secret,
// non-path token, and never the message itself.
function safeErrorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    return /^[A-Z][A-Z0-9]{2,15}$/.test(code) ? code : undefined;
  }
  return undefined;
}

function errorCodeSuffix(error: unknown): string {
  const code = safeErrorCode(error);
  return code ? ` (${code})` : "";
}

// T70 F-002: `validation?.error` below is adapter-supplied text -- the return
// value of the optional `SourceAdapter.validate()` extension point
// (`types.ts:224`), not a caught exception -- but it flows into the exact
// same `SourceRunInfo.error` field the three catch arms above write into,
// and through it into `computeGate`'s `gate.reasons` (`gate.ts:78-79`) and
// the committable artifact, identically. `validate()` is a public seam:
// nothing requires a future or third-party adapter's error text to avoid a
// path or a credential, the same shape the three catch arms were closed
// against. Restrict what passes through to the closed, non-secret
// vocabulary the two shipped adapters that implement `validate()` already
// return (`sources/eslint.ts:122,124`; `sources/dependency-audit.ts:28,36,97`
// -- `:145` only ever forwards one of the latter three, never fabricates new
// text). Anything else -- no shipped adapter reaches this today, but any
// adapter added later could -- falls back to the same constant this branch
// already used as its `??` default.
const KNOWN_VALIDATION_ERRORS = new Set<string>([
  "ESLint JSON format was not recognized",
  "ESLint JSON parse failed",
  "dependency audit JSON contains an invalid or unsupported entry",
  "dependency audit JSON parse failed",
  "dependency audit JSON format was not recognized",
]);

function safeValidationError(error: string | undefined): string {
  return error !== undefined && KNOWN_VALIDATION_ERRORS.has(error)
    ? error
    : "source output format was not recognized";
}

// Exported (only) so this module's own focused tests can drive a source
// adapter's throwing paths directly and deterministically -- see
// health-truthful-gate.test.ts's F-005 regressions. Mocking the whole
// `./sources` module for that purpose was tried and rejected: Bun's
// `mock.module` replaces the shared module registry for the rest of the
// process, and it corrupted an unrelated `runHealth()` call in
// `provenance.test.ts` when both files ran in the same `bun test` invocation
// (reproduced with either file ordered first). No other caller outside this
// module's tests uses this export; `runHealth` above remains the only
// production entry point.
export async function runAdapter(
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
    execution: "not-run" as const,
    parse: "not-run" as const,
    exitCode: null,
  };

  if (cfg.mode === "disabled") {
    return { info: { ...base, status: "skipped" }, findings: [] };
  }

  let status;
  try {
    status = await adapter.detect(ctx);
  } catch (error) {
    return {
      info: {
        ...base,
        status: "configured-but-failed",
        execution: "failed",
        error: `source detection failed${errorCodeSuffix(error)}`,
      },
      findings: [],
    };
  }
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
          if (adapter.id === "tests") {
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
        execution: "failed",
        error: `source execution failed${errorCodeSuffix(error)}`,
      },
      findings: [],
    };
  }

  const rawPath = await writeRaw(ctx.cwd, adapter.id, raw.content, stamp);
  const persistedRaw = { ...raw, rawPath };
  let findings: Finding[];
  try {
    findings = adapter.parse(persistedRaw, ctx);
  } catch (error) {
    return {
      info: {
        ...base,
        status: "configured-but-failed",
        imported: raw.imported,
        command: raw.command,
        toolVersion: raw.toolVersion,
        execution: raw.exitCode === 0 ? "completed" : "failed",
        parse: "failed",
        exitCode: raw.exitCode,
        error: `source parse failed${errorCodeSuffix(error)}`,
      },
      findings: [],
    };
  }
  const validation = adapter.validate?.(persistedRaw);
  const parseFailed = validation?.valid === false;
  const executionFailed = raw.exitCode !== 0 && findings.length === 0;
  if (parseFailed || executionFailed) {
    return {
      info: {
        ...base,
        status: "configured-but-failed",
        imported: raw.imported,
        command: raw.command,
        toolVersion: raw.toolVersion,
        findings: findings.length,
        execution: executionFailed ? "failed" : "completed",
        parse: parseFailed ? "failed" : "parsed",
        exitCode: raw.exitCode,
        error: parseFailed
          ? safeValidationError(validation?.error)
          : `source command exited ${raw.exitCode} without recognized findings`,
      },
      findings,
    };
  }
  return {
    info: {
      ...base,
      status: "available",
      imported: raw.imported,
      command: raw.command,
      toolVersion: raw.toolVersion,
      findings: findings.length,
      execution: "completed",
      parse: "parsed",
      exitCode: raw.exitCode,
    },
    findings,
  };
}

function filteredOutcome(
  source: SourceRunInfo["source"],
  cfg: SourceConfig,
): { info: SourceRunInfo; findings: Finding[] } {
  return { info: filteredInfo(source, cfg), findings: [] };
}

function filteredInfo(source: string, cfg: SourceConfig): SourceRunInfo {
  return {
    source,
    status: "skipped",
    mode: cfg.mode,
    required: cfg.required,
    imported: false,
    command: null,
    toolVersion: null,
    findings: 0,
    execution: "not-run",
    parse: "not-run",
    exitCode: null,
    error: "excluded by source filter",
  };
}

// Exported (only) so this module's own focused tests can drive the
// artifact-writing hop directly and deterministically -- see
// health-truthful-gate.test.ts's F-004 end-to-end regressions, which build a
// `HealthReport` from the real `runAdapter` + `computeGate` (already
// production functions, exercised by the F-005/F-002 unit tests above) and
// need to reach the persisted `latest.{json,md}` and the service-read gate
// without mocking the shared `./sources` module -- the same cross-file
// registry hazard `runAdapter`'s own export comment documents (reproduced
// again while writing this test: `mock.module("./sources", ...)` still
// corrupts an unrelated `provenance.test.ts` assertion in this process, in
// either file order, even with a synchronous same-test restore). No other
// caller outside this module's tests uses this export; `runHealth` above
// remains the only production entry point and calls it exactly as before.
export async function writeOutputs(
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
  if (report.runId) {
    const runJson = path.join(artifacts, "runs", `${report.runId}.json`);
    const runMarkdown = path.join(artifacts, "runs", `${report.runId}.md`);
    if (await pathExists(runJson)) throw new Error(`immutable health run already exists: ${report.runId}`);
    await writeFileAtomic(runJson, serialized);
    await writeFileAtomic(runMarkdown, renderReportMarkdown(report, config));
    await writeFileAtomic(
      json,
      `${JSON.stringify({
        run_id: report.runId,
        commit: report.provenance?.commit ?? null,
        branch: report.provenance?.branch ?? null,
        worktree: report.provenance?.worktree ?? null,
        generated_at: report.generatedAt,
        record: path.posix.join("runs", `${report.runId}.json`),
      }, null, 2)}\n`,
    );
  } else {
    await writeFile(json, serialized, "utf8");
  }
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
