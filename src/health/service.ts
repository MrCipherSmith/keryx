import path from "node:path";
import { isPathInside, pathExists } from "../lib/fs";
import { readJsonObjectFile } from "../lib/json";
import { loadHealthConfig } from "./config";
import { runHealth } from "./run";
import { writeBaseline } from "./baseline";
import { getCoverage } from "./metrics/coverage";
import { FINDING_ADAPTERS } from "./sources";
import { dataRoot, listSourceFiles, moduleOfFile } from "./util";
import { collectGitProvenance } from "../metrics/provenance";
import { readArtifactPointer } from "../metrics/lifecycle";
import type {
  CodeHealthService,
  GateStatus,
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

/**
 * Validate the shape `gate()`, `status()`, `explain()` and `updateBaseline()`
 * actually read: an object whose `gate` field is itself an object carrying a
 * string `status` and an array `reasons`, AND whose `metrics`, `sources` and
 * `findings` fields are arrays. T50 closed the *value* hole (`gateExitCode`'s
 * default arm now fails closed on an unrecognized `status` string) and T55
 * closed the *shape* hole around `gate` itself (a stored `latest.json`
 * missing the `gate` key, or carrying it as a non-object, made
 * `latest.gate.status` throw a raw `TypeError` instead of the module's own
 * "no report; run `keryx health run` first" refusal — T39 F-004). T55 left
 * `metrics`/`sources`/`findings` unguarded, one field further along the same
 * hole: a stored report with a well-formed `gate` but no `metrics` key (or
 * `metrics` as a non-array) still threw out of `status()` at
 * `latest?.metrics.find` (T57 F-003). Fixed here at the same single choke
 * point, `readLatest`, enumerated by reading all four callers of that
 * function and listing every property access on its return value that was
 * not already null-safe at the access site — `.metrics` (`status()` ×2,
 * `explain()`, `updateBaseline()`), `.sources` (`status()`), `.findings`
 * (`explain()`); see T61-spec.md for the full table. A malformed report is
 * unusable evidence — treated exactly like an absent one — for every caller,
 * not re-guarded per call site. Mirrors `hasRecognizedGate` in
 * `src/security/service.ts` for the identical problem on the security side.
 *
 * Deliberately does not require `status` to be one of the four recognized
 * `GateStatus` values: that is `gateExitCode`'s job, already exhaustive with
 * a blocking default arm (T50) once the shape is sound enough to reach it.
 * Deliberately does not validate element-level shape within `metrics`,
 * `sources` or `findings` (e.g. that every `ScopeMetrics` entry has a `key`)
 * — none of the four readers dereference an element without its own
 * per-element narrowing, so that is out of this guard's scope.
 */
function hasGateShape(value: unknown): value is HealthReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const gate = (value as { gate?: unknown }).gate;
  if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
    return false;
  }
  const status = (gate as { status?: unknown }).status;
  const reasons = (gate as { reasons?: unknown }).reasons;
  if (typeof status !== "string" || !Array.isArray(reasons)) {
    return false;
  }
  const report = value as { metrics?: unknown; sources?: unknown; findings?: unknown };
  return (
    Array.isArray(report.metrics) &&
    Array.isArray(report.sources) &&
    Array.isArray(report.findings)
  );
}

async function readLatest(cwd: string): Promise<HealthReport | null> {
  const file = path.join(dataRoot(cwd), "artifacts", "latest.json");
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    // The stored artifact is read through the shape-aware reader, not a bare
    // `JSON.parse(...) as HealthReport`. The cast promised a type the parse
    // never checked, and the two non-object cases were only handled by
    // accident: `null` made `latest.record` throw a `TypeError` that this
    // `catch` happened to swallow, and a bare string made it `undefined` so
    // `hasGateShape` happened to reject it. Both now fail the shape test
    // before any member is touched (T39 "Judgement calls" #4 — the health hole
    // the reviewer used to show that a fix confined to `readJsonFileOr` would
    // not have reached this file at all). The verdict is unchanged: a report
    // that cannot be read is unusable evidence, treated exactly like an absent
    // one, and `gate()` answers with its own "no report" refusal.
    const read = await readJsonObjectFile(file);
    if (read.state !== "object") return null;
    const latest = read.value;
    const record = latest.record;
    if (typeof record === "string") {
      const pointer = await readArtifactPointer(
        path.join(dataRoot(cwd), "artifacts"),
        await collectGitProvenance(cwd),
      );
      if (pointer.status !== "fresh") return null;
      const recordFile = path.join(dataRoot(cwd), "artifacts", record);
      if (!isPathInside(path.join(dataRoot(cwd), "artifacts"), recordFile)) return null;
      if (!(await pathExists(recordFile))) return null;
      const recordRead = await readJsonObjectFile(recordFile);
      if (recordRead.state !== "object") return null;
      return hasGateShape(recordRead.value) ? recordRead.value : null;
    }
    return hasGateShape(latest) ? latest : null;
  } catch {
    return null;
  }
}

async function detectStatuses(cwd: string): Promise<HealthSourcesResult> {
  const config = await loadHealthConfig(cwd);
  const sourceFiles = await listSourceFiles(cwd, config.ignore.paths);
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

/**
 * Fold a health `GateStatus` into the `keryx health gate --strict-warn`
 * exit code. Exhaustive over `GateStatus` (`"pass" | "warn" | "incomplete"
 * | "fail"`, `./types.ts`), with the default arm on the blocking side: a
 * `status` this fold has not been taught — a stored `latest.json` from an
 * older/newer schema, a hand-edited or corrupted artifact, or a future
 * `GateStatus` member — refuses rather than falling through to a clean
 * `0`. This is reachable at runtime and not just type-theoretically:
 * `readLatest` above parses that file with an unchecked `as HealthReport`
 * cast, so an unrecognized `status` string reaches this function unvalidated.
 *
 * Mirrors `runExitCode` (`src/commands/health.ts`), `isPassGate`
 * (`src/commands/security.ts`), the switch in `runGate`
 * (`src/security/service.ts`) and `securityFlowGate`
 * (`src/security/guard.ts`) in *shape* only: health keeps its own
 * `GateStatus` vocabulary, not `SecurityGate` — no cross-module import.
 *
 * `fail` (an established threshold violation) and `incomplete` (a required
 * check that is missing, skipped, unparsed or unfinished) block
 * unconditionally, independent of `strictWarn` — policies.md never makes
 * either of those two contingent on strict mode, only "strict CI accepts
 * only PASS" is. `warn` blocks only when `strictWarn` is set, matching the
 * pre-existing behavior pinned by `health-incomplete.test.ts`'s "stored
 * warning exits zero normally and nonzero under strict-warn" case; the
 * `warn` status itself is still returned to the caller unchanged by
 * `gate()` below (never relabeled `pass`), so "an optional/soft skip warns
 * and is never signed as passed" holds independent of the exit code.
 * `pass` never blocks. The default arm blocks in both strict and
 * non-strict calls, the same as `fail`/`incomplete` already do, because
 * "an unrecognized or newly added value fails closed" carries no
 * strict-only qualifier.
 *
 * Exported so `service-gate-exit.test.ts` can drive every `GateStatus`
 * value directly, including a corrupted/unrecognized one written straight
 * into a `latest.json` fixture and read back through the real
 * `readLatest()` parse path — `computeGate` (`./gate.ts`) only ever
 * produces one of the four recognized values by the time a freshly
 * generated report reaches this method, so a stored artifact is the
 * genuine way an unrecognized value arrives here.
 */
export function gateExitCode(status: GateStatus, strictWarn: boolean): number {
  switch (status) {
    case "pass":
      return 0;
    case "warn":
      return strictWarn ? 1 : 0;
    case "fail":
    case "incomplete":
      return 1;
    default:
      return 1;
  }
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
      const decliningScopes = latest
        ? latest.metrics.filter((m) => m.regression_score > 0).length
        : 0;
      const regressedScopes = latest
        ? latest.metrics.filter((m) => m.trend === "regressed").length
        : 0;
      return {
        enabled,
        lastRunAt: latest?.generatedAt ?? null,
        gate: latest?.gate.status ?? null,
        sources:
          latest?.sources.map((s) => ({ source: s.source, status: s.status })) ??
          [],
        projectScore: project?.health_score ?? null,
        regressions: decliningScopes,
        decliningScopes,
        regressedScopes,
      };
    },

    async gate(input: HealthGateInput): Promise<HealthGateResult> {
      const latest = await readLatest(input.cwd);
      if (!latest) {
        return {
          status: "fail",
          exitCode: 1,
          reasons: ["no report; run `keryx health run` first"],
        };
      }
      const status = latest.gate.status;
      const exitCode = gateExitCode(status, Boolean(input.strictWarn));
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
